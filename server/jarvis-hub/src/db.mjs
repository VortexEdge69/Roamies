// Jarvis Hub storage: plain JSON files under HUB_DATA_DIR (default ./data). One user, a handful of devices,
// so files beat a database: easy to back up (copy the folder), easy to read. Writes are atomic and serialised.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { cleanDoc, emptyDoc, mergeMemory } from '../../../showcase/tauri/sidecar/syncmerge.mjs';

export const DATA = path.resolve(process.env.HUB_DATA_DIR || path.join(import.meta.dirname, '..', 'data'));
const F = {
  memory: path.join(DATA, 'memory.json'),
  devices: path.join(DATA, 'devices.json'),
  hubChat: path.join(DATA, 'hub-chat.json'),
  sessions: path.join(DATA, 'sessions'),
};
const SESSION_ID = /^[A-Za-z0-9_-]{6,64}$/;
const KEEP_SESSIONS = 200;

const chains = new Map();
export function writeJson(file, data) {
  const run = async () => {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
    const fh = await fs.open(tmp, 'w', 0o600);
    try { await fh.writeFile(JSON.stringify(data, null, 2)); await fh.sync(); } finally { await fh.close(); }
    await fs.rename(tmp, file);
  };
  const next = (chains.get(file) ?? Promise.resolve()).then(run, run);
  chains.set(file, next.catch(() => {}));
  return next;
}
export const flush = () => Promise.all([...chains.values()]);

export function readJson(file, fallback = null) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return fallback;
    const aside = `${file}.corrupt-${Date.now()}`;
    fs.rename(file, aside).catch(() => {});
    console.error(`[db] ${path.basename(file)} was unreadable; kept it as ${path.basename(aside)}`);
    return fallback;
  }
}

// ---------- devices (bearer tokens, stored hashed) ----------

const hash = (t) => createHash('sha256').update(String(t)).digest('hex');
// Re-read when the file changes, so `npm run device add` works without restarting the hub.
let devices = null, devicesMtime = 0;
const loadDevices = () => {
  let m = 0; try { m = statSync(F.devices).mtimeMs; } catch {}
  if (!devices || m !== devicesMtime) { devices = readJson(F.devices, { version: 1, devices: [] }); devicesMtime = m; }
  return devices;
};

export function addDevice(name, kind = 'device') {
  const n = String(name).trim().slice(0, 40);
  if (!n) throw new Error('device name required');
  const d = loadDevices();
  if (d.devices.some((x) => x.name.toLowerCase() === n.toLowerCase())) throw new Error(`a device called "${n}" already exists`);
  const token = `jh_${randomBytes(24).toString('base64url')}`;
  d.devices.push({ name: n, kind: String(kind).slice(0, 20), tokenHash: hash(token), createdAt: Date.now(), lastSeenAt: null });
  return writeJson(F.devices, d).then(() => token);
}

export function listDevices() {
  return loadDevices().devices.map(({ tokenHash, ...rest }) => rest);
}

export async function removeDevice(name) {
  const d = loadDevices(), before = d.devices.length;
  d.devices = d.devices.filter((x) => x.name.toLowerCase() !== String(name).toLowerCase());
  if (d.devices.length !== before) await writeJson(F.devices, d);
  return before - d.devices.length;
}

/** The device a token belongs to, or null. Constant-time compare on the hashes. */
export function deviceForToken(token) {
  if (typeof token !== 'string' || !token.startsWith('jh_') || token.length > 200) return null;
  const h = Buffer.from(hash(token), 'hex');
  for (const dev of loadDevices().devices) {
    const other = Buffer.from(dev.tokenHash, 'hex');
    if (other.length === h.length && timingSafeEqual(other, h)) return dev;
  }
  return null;
}

let seenTimer = null;
export function markSeen(dev) {
  dev.lastSeenAt = Date.now();
  clearTimeout(seenTimer);
  seenTimer = setTimeout(() => writeJson(F.devices, loadDevices()).catch(() => {}), 5000);
}

// ---------- memory ----------

let memory = null;
let rev = 0;
export const getMemory = () => (memory ??= cleanDoc(readJson(F.memory, emptyDoc())));
export const memoryRev = () => rev;

/** Merges a device's doc in. Returns { doc, changed }. */
export async function mergeIn(doc) {
  const { doc: merged, changed } = mergeMemory(getMemory(), doc);
  if (changed) { memory = merged; rev++; await writeJson(F.memory, memory); }
  return { doc: getMemory(), changed };
}

/** Applies a change made on the hub itself (the hub's own brain). `fn` edits the doc in place. */
export async function editMemory(fn) {
  const m = getMemory();
  const out = fn(m);
  rev++;
  await writeJson(F.memory, m);
  return out;
}

export const newId = (prefix) => `${prefix}${randomBytes(4).toString('hex')}`;

// ---------- sessions (desktop conversations, uploaded for backup and carrying on elsewhere) ----------

export async function putSession(id, s) {
  if (!SESSION_ID.test(id)) throw Object.assign(new Error('bad session id'), { code: 400 });
  if (!s || !Array.isArray(s.messages)) throw Object.assign(new Error('bad session'), { code: 400 });
  const clean = { ...s, id, receivedAt: Date.now() };
  await writeJson(path.join(F.sessions, `${id}.json`), clean);
  pruneSessions().catch(() => {});
  return clean;
}

export function getSession(id) {
  if (!SESSION_ID.test(id)) return null;
  return readJson(path.join(F.sessions, `${id}.json`));
}

export async function listSessions() {
  let names = [];
  try { names = (await fs.readdir(F.sessions)).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const n of names) {
    const s = readJson(path.join(F.sessions, n));
    if (s) out.push({ id: s.id, device: s.device ?? null, startedAt: s.startedAt ?? null, lastActiveAt: s.lastActiveAt ?? s.receivedAt ?? 0, messages: s.messages?.length ?? 0 });
  }
  return out.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

export async function latestSession() {
  const [top] = await listSessions();
  return top ? getSession(top.id) : null;
}

async function pruneSessions() {
  const all = await listSessions();
  for (const s of all.slice(KEEP_SESSIONS)) await fs.unlink(path.join(F.sessions, `${s.id}.json`)).catch(() => {});
}

// ---------- the hub brain's own short conversation (phone, web and pendant chats) ----------

const HUB_TURNS = 40;
export const getHubChat = () => readJson(F.hubChat, { version: 1, turns: [] });
export async function addHubTurn(turn) {
  const c = getHubChat();
  c.turns.push({ at: Date.now(), ...turn });
  if (c.turns.length > HUB_TURNS) c.turns.splice(0, c.turns.length - HUB_TURNS);
  await writeJson(F.hubChat, c);
}
export const clearHubChat = () => writeJson(F.hubChat, { version: 1, turns: [] });

export const dataExists = () => existsSync(DATA);
