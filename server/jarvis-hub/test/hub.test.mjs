// End-to-end: starts a hub on a free port with a throwaway data folder, and drives it like two devices would.
// Run: npm test   (no API keys needed; the brain answers with its "no key" line)
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

const ROOT = path.join(import.meta.dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-hub-test-'));
const PORT = 18000 + Math.floor(Math.random() * 2000);
const env = { ...process.env, HUB_DATA_DIR: TMP, PORT: String(PORT), HUB_ENV_FILE: path.join(TMP, 'none.env'), ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', GROQ_API_KEY: '', STT_API_KEY: '' };
const token = (name, kind) => /(jh_[A-Za-z0-9_-]+)/.exec(execFileSync('node', ['src/cli.mjs', 'add', name, kind], { cwd: ROOT, env }).toString())[1];
const desk = token('desktop', 'desktop'), phone = token('phone', 'phone');

const hub = spawn('node', ['src/hub.mjs'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'inherit'] });
process.on('exit', () => { hub.kill(); fs.rmSync(TMP, { recursive: true, force: true }); });
await new Promise((r) => hub.stdout.on('data', (d) => String(d).includes('Jarvis Hub') && r()));

const base = `http://127.0.0.1:${PORT}`;
const api = (method, p, tok, body) => fetch(base + p, { method, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
const open = (tok) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/v1/live`, ['jarvis.v1', `bearer.${tok}`]);
  const inbox = [];
  ws.on('message', (d) => inbox.push(JSON.parse(String(d))));
  ws.on('open', () => resolve({ ws, inbox, next: (type, ms = 2000) => waitFor(inbox, type, ms) }));
  ws.on('error', reject);
});
async function waitFor(inbox, type, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const i = inbox.findIndex((m) => m.type === type);
    if (i >= 0) return inbox.splice(i, 1)[0];
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no ${type} within ${ms}ms`);
}

// health and auth
assert.equal((await (await fetch(base + '/health')).json()).ok, true);
assert.equal((await api('GET', '/v1/memory')).status, 401, 'no token');
assert.equal((await api('GET', '/v1/memory', 'jh_wrong')).status, 401, 'bad token');
assert.equal((await api('GET', '/v1/me', desk)).status, 200);
await assert.rejects(open('jh_nope'), 'socket refuses a bad token');

// the web client is served
assert.match(await (await fetch(base + '/')).text(), /<title>/);

// live link: the desktop says hello and hears when the phone changes memory
const d = await open(desk), ph = await open(phone);
d.ws.send(JSON.stringify({ type: 'hello', kind: 'desktop', canSpeak: true, canRun: true }));
ph.ws.send(JSON.stringify({ type: 'hello', kind: 'phone', canSpeak: true }));
await d.next('welcome');
await ph.next('presence');
const now = Date.now();
const merged = await (await api('POST', '/v1/memory/merge', phone, { commitments: [{ id: 'c1', text: 'submit EC1051 assignment', createdAt: now, updatedAt: now, status: 'open' }] })).json();
assert.equal(merged.changed, true);
assert.equal((await d.next('memory')).from, 'phone', 'desktop told about the change');
// the desktop merges its own and gets the union back
const back = await (await api('POST', '/v1/memory/merge', desk, { facts: [{ id: 'f1', text: 'Name is Rahul', createdAt: now }] })).json();
assert.deepEqual([back.doc.commitments.length, back.doc.facts.length], [1, 1]);
// pushing the same again changes nothing
assert.equal((await (await api('POST', '/v1/memory/merge', desk, back.doc)).json()).changed, false);

// sessions: uploaded by the desktop, newest comes back
const s1 = { id: '20261110-190000-abc123', startedAt: now, lastActiveAt: now, messages: [{ role: 'user', content: 'hi' }] };
assert.equal((await api('PUT', `/v1/sessions/${s1.id}`, desk, s1)).status, 200);
assert.equal((await (await api('GET', '/v1/sessions/latest', phone)).json()).session.id, s1.id);
assert.equal((await api('PUT', '/v1/sessions/..%2F..%2Fetc', desk, s1)).status, 400, 'path tricks refused');

// say: the phone makes the desktop speak
assert.equal((await api('POST', '/v1/say', phone, { text: 'Hello from the phone', target: 'desktop' })).status, 200);
assert.equal((await d.next('say')).text, 'Hello from the phone');

// prompt: the phone hands a request to the desktop
ph.ws.send(JSON.stringify({ type: 'prompt', text: 'open Spotify' }));
const pr = await d.next('prompt');
assert.deepEqual([pr.text, pr.from], ['open Spotify', 'phone']);

// wake arbitration: both hear "Jarvis", the louder one answers, the other yields
d.ws.send(JSON.stringify({ type: 'wake', score: 0.6 }));
ph.ws.send(JSON.stringify({ type: 'wake', score: 0.9 }));
assert.equal((await ph.next('wake_granted')).by, 'phone');
assert.equal((await d.next('wake_yield')).by, 'phone');

// chat without a key: a polite explanation, not a crash
const c = await (await api('POST', '/v1/chat', phone, { text: 'hello' })).json();
assert.match(c.reply, /API key/);

// devices list hides token hashes
const devs = await (await api('GET', '/v1/devices', desk)).json();
assert.equal(JSON.stringify(devs).includes('tokenHash'), false);

d.ws.close(); ph.ws.close();
console.log('hub: ok');
process.exit(0);
