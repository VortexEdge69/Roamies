// Jarvis Hub sync: keeps this computer's memory (commitments, reminders, facts) and conversations in step with
// the hub on your VPS (server/jarvis-hub), so every device (desktop, phone, pendant) shares one brain.
//
// Local-first: everything keeps working offline. Changes are pushed when the hub is reachable, and pulled when
// another device changes something (the hub says so over a WebSocket) or on reconnect.
//
// Turned on by either:
//   - env ROAMIES_HUB_URL + ROAMIES_HUB_TOKEN, or
//   - ~/.gg/sidekick/hub.json  { "url": "https://jarvis.example.com", "token": "<device token>", "name": "desktop" }
// Off (and silent) when neither is set.
import os from 'node:os';
import path from 'node:path';
import { DIR, applyRemoteMemory, memorySnapshot, onMemorySaved, readJson } from './store.mjs';

const MIN_BACKOFF = 2_000, MAX_BACKOFF = 60_000;

export function hubConfig(env = process.env) {
  const file = readJson(path.join(DIR, 'hub.json')) ?? {};
  const url = String(env.ROAMIES_HUB_URL || file.url || '').trim().replace(/\/+$/, '');
  const token = String(env.ROAMIES_HUB_TOKEN || file.token || '').trim();
  if (!url || !token || !/^https?:\/\//.test(url)) return null;
  // Tokens only ever go over HTTPS, except to this machine or the local network while testing.
  const host = new URL(url).hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(host) || host.endsWith('.local');
  if (url.startsWith('http://') && !local) { console.error('[sync] hub url must be https:// (got http:// for a public host); sync is off'); return null; }
  return { url, token, name: String(file.name || env.ROAMIES_HUB_NAME || os.hostname()).slice(0, 40) };
}

/**
 * Starts syncing. `hooks`:
 *   onMemory()            memory changed from another device (refresh menus/lists)
 *   onSay(text)           another device asked this one to speak a line
 *   onPrompt(text, from)  another device (pendant, phone) handed this desktop a request to run
 *   onWake(event)         wake-word arbitration events ({ type: 'wake_granted' | 'wake_yield', by })
 *   log(kind, data)
 * Returns { pushSession(session), latestSession(), wake(), status(), stop() } or null when sync is off.
 */
export function startSync(hooks = {}, cfg = hubConfig()) {
  if (!cfg) return null;
  const log = hooks.log ?? (() => {});
  const headers = { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json', 'x-device': cfg.name };
  let stopped = false, ws = null, backoff = MIN_BACKOFF, online = false, dirty = true, pushTimer = null, pulling = null;
  const sessionQueue = new Map();

  const api = async (method, p, body) => {
    const res = await fetch(cfg.url + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`${method} ${p} → ${res.status}`);
    return res.status === 204 ? null : res.json();
  };

  // Push our memory; the hub merges and answers with the merged doc, which we merge back.
  async function pushMemory() {
    if (stopped) return;
    try {
      dirty = false;
      const merged = await api('POST', '/v1/memory/merge', memorySnapshot());
      if (await applyRemoteMemory(merged.doc)) hooks.onMemory?.();
      online = true;
    } catch (e) {
      dirty = true; online = false;
      log('sync_push_failed', { error: String(e?.message ?? e).slice(0, 200) });
    }
  }
  const schedulePush = (ms = 1500) => { clearTimeout(pushTimer); pushTimer = setTimeout(() => { pushMemory().then(flushSessions); }, ms); };

  async function pullMemory() {
    if (pulling) return pulling;
    pulling = (async () => {
      try {
        const remote = await api('GET', '/v1/memory');
        if (await applyRemoteMemory(remote.doc)) hooks.onMemory?.();
        online = true;
        if (dirty) await pushMemory();
      } catch (e) {
        online = false;
        log('sync_pull_failed', { error: String(e?.message ?? e).slice(0, 200) });
      } finally { pulling = null; }
    })();
    return pulling;
  }

  async function flushSessions() {
    for (const [id, s] of [...sessionQueue]) {
      try { await api('PUT', `/v1/sessions/${encodeURIComponent(id)}`, s); sessionQueue.delete(id); }
      catch (e) { log('sync_session_failed', { id, error: String(e?.message ?? e).slice(0, 200) }); return; }
    }
  }

  const unhook = onMemorySaved(() => { dirty = true; schedulePush(); });

  function connect() {
    if (stopped) return;
    const wsUrl = cfg.url.replace(/^http/, 'ws') + '/v1/live';
    try {
      // Node 22's WebSocket can't set headers, so the token goes as a subprotocol (never in the URL, which gets logged).
      ws = new WebSocket(wsUrl, ['jarvis.v1', `bearer.${cfg.token}`]);
    } catch (e) { log('sync_ws_error', { error: String(e?.message ?? e) }); return retry(); }
    ws.onopen = () => {
      backoff = MIN_BACKOFF; online = true;
      ws.send(JSON.stringify({ type: 'hello', name: cfg.name, kind: 'desktop', canSpeak: true, canRun: true }));
      log('sync_connected', { url: cfg.url });
      pullMemory().then(flushSessions);
    };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.type === 'memory' && m.from !== cfg.name) pullMemory();
      else if (m.type === 'say' && typeof m.text === 'string') hooks.onSay?.(m.text.slice(0, 2000));
      else if (m.type === 'prompt' && typeof m.text === 'string') hooks.onPrompt?.(m.text.slice(0, 4000), String(m.from ?? 'another device'));
      else if (m.type === 'wake_granted' || m.type === 'wake_yield') hooks.onWake?.(m);
      else if (m.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
    };
    ws.onclose = () => { online = false; ws = null; retry(); };
    ws.onerror = () => {}; // onclose follows
  }
  function retry() {
    if (stopped) return;
    setTimeout(connect, backoff);
    backoff = Math.min(MAX_BACKOFF, backoff * 2);
  }

  connect();
  pullMemory();

  return {
    /** Queues a conversation for upload (latest copy wins). */
    pushSession(s) {
      if (!s?.id || !s.messages?.length || s.kind === 'intro') return;
      sessionQueue.set(s.id, { ...s, device: cfg.name });
      schedulePush(3000);
    },
    /** The newest conversation the hub has (from any device), or null. */
    async latestSession() {
      try { return (await api('GET', '/v1/sessions/latest'))?.session ?? null; } catch { return null; }
    },
    /** Tells the hub this device heard the wake word; the hub picks one device to answer (wake_granted) and quiets the rest. */
    wake(score = 1) {
      if (ws?.readyState === 1) { ws.send(JSON.stringify({ type: 'wake', score })); return true; }
      return false; // offline: the caller just answers locally
    },
    /** Sends this desktop's reply to the hub, so the phone and web client see the conversation live. */
    turn(user, reply) { if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'turn', user: String(user).slice(0, 4000), reply: String(reply).slice(0, 8000) })); },
    status: () => ({ url: cfg.url, name: cfg.name, online, pending: dirty || sessionQueue.size > 0 }),
    async stop() { stopped = true; unhook(); clearTimeout(pushTimer); try { ws?.close(); } catch {} if (dirty) await pushMemory(); await flushSessions(); },
  };
}
