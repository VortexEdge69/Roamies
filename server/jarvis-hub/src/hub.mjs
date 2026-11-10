#!/usr/bin/env node
// Jarvis Hub: the always-on centre of your Jarvis setup, meant to run on your VPS behind HTTPS (Caddy).
//
//  - One memory (facts, commitments, reminders) merged from every device      /v1/memory
//  - Conversation history uploaded by the desktop, to carry on anywhere        /v1/sessions
//  - Live link to every device: memory changes, "say this", wake arbitration   /v1/live      (WebSocket)
//  - Its own brain for the phone, web and pendant, sharing that memory         /v1/chat
//  - Speech to text, and a streaming endpoint for the DIY mic pendant          /v1/transcribe, /v1/audio
//  - The web/phone client (installable PWA)                                     /
//
// Every API call needs a device token (`npm run device add <name>`), as `Authorization: Bearer <token>`.
// WebSockets may send it as the subprotocol `bearer.<token>` instead (browsers can't set headers).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const ENV_FILE = process.env.HUB_ENV_FILE || path.join(import.meta.dirname, '..', '.env');
try { process.loadEnvFile(ENV_FILE); } catch {}

const db = await import('./db.mjs');
const { chat, brainReady } = await import('./brain.mjs');
const { transcribe, pcmToWav, rms, sttReady } = await import('./stt.mjs');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1'; // behind Caddy; set 0.0.0.0 only for LAN testing
const WEB = path.join(import.meta.dirname, '..', 'web');
const MAX_JSON = 8 * 1024 * 1024, MAX_AUDIO = 12 * 1024 * 1024, MAX_PENDANT_SECONDS = 30;
const VERSION = '0.1.0';

// ---------- small helpers ----------

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(code === 401 ? { 'www-authenticate': 'Bearer realm="jarvis"' } : {}) });
  res.end(JSON.stringify(body));
};
const readBody = (req, limit) => new Promise((resolve, reject) => {
  const chunks = []; let size = 0;
  req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});
const readJsonBody = async (req) => { const b = await readBody(req, MAX_JSON); try { return JSON.parse(b.toString('utf8') || 'null'); } catch { throw Object.assign(new Error('bad json'), { code: 400 }); } };

// Failed-auth throttle per IP (Caddy passes the real one in X-Forwarded-For).
const fails = new Map();
const ipOf = (req) => (HOST === '127.0.0.1' && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress || '?';
const throttled = (ip) => { const f = fails.get(ip); return f && f.n >= 20 && Date.now() - f.at < 10 * 60_000; };
const failed = (ip) => { const f = fails.get(ip); fails.set(ip, f && Date.now() - f.at < 10 * 60_000 ? { n: f.n + 1, at: f.at } : { n: 1, at: Date.now() }); };

// The token can come as X-Jarvis-Token (works behind an nginx auth_basic, which owns the Authorization header),
// as "Authorization: Bearer …", or for WebSockets as the subprotocol "bearer.<token>".
function tokenFrom(req) {
  const x = req.headers['x-jarvis-token'];
  if (typeof x === 'string' && x.trim()) return db.cleanToken(x);
  const h = req.headers.authorization;
  if (h && /^Bearer\s/i.test(h)) return db.cleanToken(h);
  const proto = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim()).find((s) => s.startsWith('bearer.'));
  return proto ? proto.slice(7) : null;
}
function auth(req) {
  const ip = ipOf(req);
  if (throttled(ip)) return { error: 429 };
  const dev = db.deviceForToken(tokenFrom(req));
  if (!dev) { failed(ip); return { error: 401 }; }
  db.markSeen(dev);
  return { dev };
}

// ---------- live connections ----------

/** ws → { dev, name, kind, canSpeak, canRun, at } */
const clients = new Map();
const online = () => [...clients.values()];
const desktops = () => online().filter((c) => c.canRun);
function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(msg, except = null) { for (const ws of clients.keys()) if (ws !== except) send(ws, msg); }
function sendTo(name, msg) {
  let n = 0;
  for (const [ws, c] of clients) if (c.name === name) { send(ws, msg); n++; }
  return n;
}
const presence = () => broadcast({ type: 'presence', devices: online().map(({ name, kind, canSpeak, canRun }) => ({ name, kind, canSpeak, canRun })) });

/** Which device should speak a reply: HUB_SPEAKER if it's online, else the asker if it can speak, else a desktop. */
function speakerFor(askerName) {
  const all = online().filter((c) => c.canSpeak);
  const pick = all.find((c) => c.name === process.env.HUB_SPEAKER) ?? all.find((c) => c.name === askerName) ?? all.find((c) => c.kind === 'desktop') ?? all.at(-1);
  return pick?.name ?? null;
}

/** Hands a request to the most recently connected desktop. */
function runOnDesktop(text, from) {
  const d = desktops().sort((a, b) => b.at - a.at)[0];
  if (!d) return false;
  return sendTo(d.name, { type: 'prompt', text, from }) > 0;
}

// Wake-word arbitration: when several devices hear "Jarvis" at once, the one that heard it best answers.
let wakeRound = null;
function onWake(ws, score) {
  const c = clients.get(ws);
  if (!c) return;
  if (!wakeRound) {
    wakeRound = { entries: [] };
    setTimeout(() => {
      const r = wakeRound; wakeRound = null;
      const winner = r.entries.sort((a, b) => b.score - a.score || a.at - b.at)[0];
      for (const ws of clients.keys()) send(ws, { type: ws === winner.ws ? 'wake_granted' : 'wake_yield', by: winner.name }); // the rest stay quiet
    }, 450);
  }
  wakeRound.entries.push({ ws, name: c.name, score: Number(score) || 0, at: Date.now() });
}

async function afterMemoryChange(fromName) {
  broadcast({ type: 'memory', rev: db.memoryRev(), from: fromName });
}

async function handleChat(text, { device, kind, voice, asker }) {
  const ctx = { device, kind, voice, desktopOnline: desktops().length > 0, runOnDesktop: (t) => runOnDesktop(t, device) };
  const { reply, memoryChanged, notesChanged } = await chat(text, ctx);
  if (memoryChanged) await afterMemoryChange('hub');
  if (notesChanged) broadcast({ type: 'notes', from: 'hub' });
  broadcast({ type: 'turn', from: device, user: text, reply }, asker);
  return reply;
}

// ---------- reminders when no desktop is around ----------
// The desktop Roamies fires reminders itself. When no desktop is connected, the hub fires them instead and
// asks the phone/web client (or whatever can speak) to say them. remindedAt syncs, so nothing fires twice.
async function remindTick() {
  if (desktops().length || !online().length) return;
  const now = Date.now();
  const due = db.getMemory().commitments.filter((c) => c.status === 'open' && c.due && c.due <= now && !c.remindedAt);
  if (!due.length) return;
  await db.editMemory((m) => {
    for (const d of due) {
      const c = m.commitments.find((x) => x.id === d.id);
      if (!c) continue;
      c.remindedAt = now; c.updatedAt = now;
      if (c.kind === 'reminder') { c.status = 'done'; c.doneAt = now; }
    }
  });
  await afterMemoryChange('hub');
  const name = process.env.HUB_USER_NAME || 'sir';
  const text = due.length === 1 ? `Reminder, ${name}: ${due[0].text}.` : `${due.length} reminders, ${name}: ${due.map((d) => d.text).join('; ')}.`;
  broadcast({ type: 'reminder', items: due.map(({ id, text: t, due: d }) => ({ id, text: t, due: d })), text });
  const speaker = speakerFor(null);
  if (speaker) sendTo(speaker, { type: 'say', text });
}
setInterval(() => remindTick().catch((e) => console.error('[hub] reminders', e)), 15_000);

// ---------- HTTP ----------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
async function serveStatic(req, res, p) {
  const rel = p === '/' ? 'index.html' : p.slice(1);
  if (!/^[a-z0-9._-]+$/i.test(rel)) return json(res, 404, { error: 'not found' });
  try {
    const body = await readFile(path.join(WEB, rel));
    res.writeHead(200, {
      'content-type': MIME[path.extname(rel)] ?? 'application/octet-stream',
      'cache-control': rel === 'sw.js' || rel === 'index.html' ? 'no-cache' : 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; connect-src 'self' wss: ws:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; media-src 'self' blob:",
      'referrer-policy': 'no-referrer',
    });
    res.end(body);
  } catch { json(res, 404, { error: 'not found' }); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://hub');
  const p = url.pathname;
  try {
    if (p === '/health') return json(res, 200, { ok: true, version: VERSION, brain: brainReady(), stt: sttReady(), online: online().length, devices: db.listDevices().length, devicesProblem: !!db.devicesProblem() });
    if (!p.startsWith('/v1/')) return req.method === 'GET' ? serveStatic(req, res, p) : json(res, 405, { error: 'method not allowed' });

    const a = auth(req);
    if (a.error) return json(res, a.error, { error: a.error === 429 ? 'too many failed attempts; wait 10 minutes' : 'bad or missing device token' });
    const me = a.dev.name;

    if (p === '/v1/me' && req.method === 'GET') return json(res, 200, { device: me, kind: a.dev.kind, brain: brainReady(), stt: sttReady(), devices: online().map((c) => ({ name: c.name, kind: c.kind })) });

    if (p === '/v1/memory' && req.method === 'GET') return json(res, 200, { doc: db.getMemory(), rev: db.memoryRev() });
    if (p === '/v1/memory/merge' && req.method === 'POST') {
      const { doc, changed } = await db.mergeIn(await readJsonBody(req));
      if (changed) await afterMemoryChange(me);
      return json(res, 200, { doc, rev: db.memoryRev(), changed });
    }

    if (p === '/v1/sessions' && req.method === 'GET') return json(res, 200, { sessions: await db.listSessions() });
    if (p === '/v1/sessions/latest' && req.method === 'GET') return json(res, 200, { session: await db.latestSession() });
    const sm = /^\/v1\/sessions\/([^/]+)$/.exec(p);
    if (sm && req.method === 'GET') { const s = db.getSession(decodeURIComponent(sm[1])); return s ? json(res, 200, { session: s }) : json(res, 404, { error: 'not found' }); }
    if (sm && req.method === 'PUT') {
      const s = await db.putSession(decodeURIComponent(sm[1]), { ...(await readJsonBody(req)), device: me });
      broadcast({ type: 'session', id: s.id, from: me });
      return json(res, 200, { ok: true });
    }

    if (p === '/v1/chat' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const text = String(body?.text ?? '').trim().slice(0, 4000);
      if (!text) return json(res, 400, { error: 'text required' });
      if (body.target === 'desktop') { const sent = runOnDesktop(text, me); return json(res, sent ? 200 : 409, sent ? { sent: true } : { error: 'desktop offline' }); }
      const reply = await handleChat(text, { device: me, kind: a.dev.kind, voice: !!body.voice, asker: null });
      return json(res, 200, { reply });
    }

    if (p === '/v1/transcribe' && req.method === 'POST') {
      const audio = await readBody(req, MAX_AUDIO);
      const mime = String(req.headers['content-type'] || 'audio/wav').split(';')[0];
      const ext = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav' }[mime];
      if (!ext && mime !== 'application/octet-stream') return json(res, 415, { error: `unsupported audio type ${mime}` });
      const file = ext ? audio : pcmToWav(audio, Number(url.searchParams.get('rate')) || 16000);
      return json(res, 200, { text: await transcribe(file, { filename: `audio.${ext ?? 'wav'}`, mime: ext ? mime : 'audio/wav' }) });
    }

    if (p === '/v1/say' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const text = String(body?.text ?? '').trim().slice(0, 2000);
      if (!text) return json(res, 400, { error: 'text required' });
      const target = body.target || speakerFor(me);
      const n = target ? sendTo(String(target), { type: 'say', text, from: me }) : 0;
      return json(res, n ? 200 : 409, n ? { sent: target } : { error: 'no device to speak on' });
    }

    if (p === '/v1/brain' && req.method === 'GET') return json(res, 200, await db.brainView());
    if (p === '/v1/notes' && req.method === 'GET') return json(res, 200, { notes: db.listNotes() });
    if (p === '/v1/notes' && req.method === 'POST') {
      const note = await db.saveNote(await readJsonBody(req) ?? {});
      broadcast({ type: 'notes', from: me });
      return json(res, 200, { note });
    }
    const nm = /^\/v1\/notes\/(n[0-9a-f]{8})$/.exec(p);
    if (nm && req.method === 'PUT') {
      const note = await db.saveNote({ ...(await readJsonBody(req) ?? {}), id: nm[1] });
      broadcast({ type: 'notes', from: me });
      return json(res, 200, { note });
    }
    if (nm && req.method === 'DELETE') {
      const ok = await db.deleteNote(nm[1]);
      if (ok) broadcast({ type: 'notes', from: me });
      return json(res, ok ? 200 : 404, ok ? { ok } : { error: 'no such note' });
    }

    if (p === '/v1/devices' && req.method === 'GET') return json(res, 200, { devices: db.listDevices(), online: online().map((c) => c.name) });

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    const code = typeof e.code === 'number' ? e.code : 500;
    if (code === 500) console.error('[hub]', req.method, p, e);
    return json(res, code, { error: code === 500 ? String(e?.message ?? e).slice(0, 300) : e.message });
  }
});

// ---------- WebSockets ----------

const live = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, handleProtocols: (set) => (set.has('jarvis.v1') ? 'jarvis.v1' : false) });
const audio = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, handleProtocols: (set) => (set.has('jarvis.v1') ? 'jarvis.v1' : false) });

server.on('upgrade', (req, socket, head) => {
  const p = new URL(req.url, 'http://hub').pathname;
  const target = p === '/v1/live' ? live : p === '/v1/audio' ? audio : null;
  const a = target ? auth(req) : { error: 404 };
  if (a.error) { socket.write(`HTTP/1.1 ${a.error} ${a.error === 401 ? 'Unauthorized' : a.error === 429 ? 'Too Many Requests' : 'Not Found'}\r\n\r\n`); socket.destroy(); return; }
  target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req, a.dev));
});

live.on('connection', (ws, req, dev) => {
  const c = { dev, name: dev.name, kind: dev.kind, canSpeak: false, canRun: false, at: Date.now() };
  clients.set(ws, c);
  let alive = true;
  const ping = setInterval(() => { if (!alive) return ws.terminate(); alive = false; ws.ping(); }, 30_000);
  ws.on('pong', () => { alive = true; });
  ws.on('message', async (data, isBinary) => {
    if (isBinary) return;
    let m; try { m = JSON.parse(String(data)); } catch { return; }
    if (m.type === 'hello') {
      c.kind = String(m.kind ?? dev.kind).slice(0, 20); c.canSpeak = !!m.canSpeak; c.canRun = !!m.canRun;
      send(ws, { type: 'welcome', device: c.name, rev: db.memoryRev(), brain: brainReady(), stt: sttReady() });
      presence();
    } else if (m.type === 'wake') onWake(ws, m.score);
    else if (m.type === 'turn') broadcast({ type: 'turn', from: c.name, user: String(m.user ?? '').slice(0, 4000), reply: String(m.reply ?? '').slice(0, 8000) }, ws);
    else if (m.type === 'chat' && typeof m.text === 'string') {
      // Chat over the socket (the web client uses this): reply comes back on the same socket.
      const id = m.id ?? null;
      try {
        const reply = await handleChat(m.text.slice(0, 4000), { device: c.name, kind: c.kind, voice: !!m.voice, asker: ws });
        send(ws, { type: 'reply', id, text: reply });
      } catch (e) { send(ws, { type: 'error', id, error: String(e?.message ?? e).slice(0, 300) }); }
    } else if (m.type === 'say' && typeof m.text === 'string') {
      const target = m.target || speakerFor(c.name);
      if (target) sendTo(String(target), { type: 'say', text: m.text.slice(0, 2000), from: c.name });
    } else if (m.type === 'prompt' && typeof m.text === 'string') {
      if (!runOnDesktop(m.text.slice(0, 4000), c.name)) send(ws, { type: 'error', error: 'desktop offline' });
    }
  });
  ws.on('close', () => { clearInterval(ping); clients.delete(ws); presence(); });
});

// The mic pendant: send {"type":"start","rate":16000}, then binary 16-bit mono PCM frames, then {"type":"end"}.
// The hub transcribes, answers (or hands it to the desktop with HUB_PENDANT_ROUTE=desktop) and has a device that
// can speak say the reply. It sends back {"type":"heard"}, then {"type":"reply"} so the pendant can blink its LED.
audio.on('connection', (ws, req, dev) => {
  let chunks = [], size = 0, rate = 16000, busy = false;
  ws.on('message', async (data, isBinary) => {
    if (isBinary) {
      if (size > rate * 2 * MAX_PENDANT_SECONDS) return;
      chunks.push(Buffer.from(data)); size += data.length;
      return;
    }
    let m; try { m = JSON.parse(String(data)); } catch { return; }
    if (m.type === 'start') { chunks = []; size = 0; rate = [8000, 16000, 22050, 24000, 44100, 48000].includes(m.rate) ? m.rate : 16000; send(ws, { type: 'listening' }); return; }
    if (m.type !== 'end' || busy) return;
    busy = true;
    const pcm = Buffer.concat(chunks); chunks = []; size = 0;
    try {
      if (pcm.length < rate * 0.3 || rms(pcm) < 0.004) { send(ws, { type: 'heard', text: '' }); return; }
      const text = await transcribe(pcmToWav(pcm, rate));
      send(ws, { type: 'heard', text });
      if (!text) return;
      if (process.env.HUB_PENDANT_ROUTE === 'desktop' && runOnDesktop(text, dev.name)) { send(ws, { type: 'reply', text: '', routed: 'desktop' }); return; }
      const reply = await handleChat(text, { device: dev.name, kind: 'pendant', voice: true, asker: null });
      send(ws, { type: 'reply', text: reply });
      const speaker = speakerFor(dev.name);
      if (speaker && speaker !== dev.name) sendTo(speaker, { type: 'say', text: reply, from: dev.name });
    } catch (e) {
      console.error('[hub] pendant', e?.message ?? e);
      send(ws, { type: 'error', error: String(e?.message ?? e).slice(0, 200) });
    } finally { busy = false; }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Jarvis Hub ${VERSION} on http://${HOST}:${PORT}  data: ${db.DATA}  brain: ${brainReady() ? 'on' : 'off (no API key)'}  speech-to-text: ${sttReady() ? 'on' : 'off'}`);
  if (!db.listDevices().length) console.log('No devices yet. Add one:  npm run device add desktop');
});

const shutdown = () => { server.close(); for (const ws of clients.keys()) ws.close(1001); db.flush().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
