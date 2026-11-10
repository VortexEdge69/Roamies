// Jarvis Hub storage: plain JSON files under HUB_DATA_DIR (default ./data). One user, a handful of devices,
// so files beat a database: easy to back up (copy the folder), easy to read. Writes are atomic and serialised.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chownSync, copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';
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
// The hub runs as the `jarvis` user. If a command (the device CLI) runs as root, files it writes would become
// root-owned and unreadable to the service, so root hands every file it writes back to the data folder's owner.
function ownerFix(p) {
  if (process.getuid?.() !== 0) return;
  try { const st = statSync(DATA); if (st.uid !== 0) chownSync(p, st.uid, st.gid); } catch {}
}
export function writeJson(file, data, { backup = false } = {}) {
  const run = async () => {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    ownerFix(path.dirname(file));
    const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
    const fh = await fs.open(tmp, 'w', 0o600);
    try { await fh.writeFile(JSON.stringify(data, null, 2)); await fh.sync(); } finally { await fh.close(); }
    ownerFix(tmp);
    if (backup && existsSync(file)) { await fs.copyFile(file, `${file}.bak`).catch(() => {}); ownerFix(`${file}.bak`); }
    await fs.rename(tmp, file);
  };
  const next = (chains.get(file) ?? Promise.resolve()).then(run, run);
  chains.set(file, next.catch(() => {}));
  return next;
}
export const flush = () => Promise.all([...chains.values()]);

/**
 * Reads JSON. A missing file → `fallback`. Unparseable → a copy is kept as <file>.corrupt-<time> (the file itself
 * stays where it is) and `fallback` is returned. Any other error (permission denied, I/O) is thrown: a file we
 * can't read is not a corrupt file, and must never be moved away or replaced with an empty one.
 */
export function readJson(file, fallback = null) {
  let text;
  try { text = readFileSync(file, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return fallback;
    if (e.code === 'EACCES' || e.code === 'EPERM') {
      throw Object.assign(new Error(`${file} is not readable by this user (uid ${process.getuid?.()}): fix with  chown -R jarvis:jarvis ${path.dirname(file)}`), { code: e.code });
    }
    throw e;
  }
  try { return JSON.parse(text); }
  catch {
    const aside = `${file}.corrupt-${Date.now()}`;
    try { copyFileSync(file, aside); ownerFix(aside); } catch {}
    console.error(`[db] ${path.basename(file)} isn't valid JSON; a copy is kept as ${path.basename(aside)}`);
    return fallback;
  }
}

// ---------- devices (bearer tokens, stored hashed) ----------
// devices.json is written only by the device CLI; the hub only reads it (re-reading when it changes, so new devices
// work without a restart). "Last seen" times go in devices-seen.json, written only by the hub, so the two never
// overwrite each other's changes.

const hash = (t) => createHash('sha256').update(String(t)).digest('hex');
const SEEN = path.join(DATA, 'devices-seen.json');
let devices = null, devicesMtime = -1, devicesError = null;
function loadDevices() {
  let m = 0;
  try { m = statSync(F.devices).mtimeMs; } catch {}
  if (devices && m === devicesMtime) return devices;
  try {
    const d = readJson(F.devices, null);
    if (d === null && m) throw new Error(`${F.devices} isn't valid JSON`);
    devices = d && Array.isArray(d.devices) ? d : { version: 1, devices: [] };
    devicesError = null;
  } catch (e) {
    // Keep the last list that worked rather than locking every device out.
    if (devicesError !== e.message) console.error(`[db] devices: ${e.message}${devices ? ' (still using the last good list)' : ''}`);
    devicesError = e.message;
    devices ??= { version: 1, devices: [] };
  }
  devicesMtime = m;
  return devices;
}
export const devicesProblem = () => (loadDevices(), devicesError);

/** Normalises a pasted token: trims spaces, quotes and a leading "Bearer ". */
export const cleanToken = (t) => String(t ?? '').trim().replace(/^["']|["']$/g, '').trim().replace(/^Bearer\s+/i, '').replace(/^["']|["']$/g, '').trim();

/** The device list from disk, for changing it. Refuses (rather than starting an empty list) if the file is broken. */
function devicesForEdit() {
  const BAD = {};
  const d = readJson(F.devices, existsSync(F.devices) ? BAD : { version: 1, devices: [] });
  if (d === BAD || !Array.isArray(d?.devices)) throw new Error(`${F.devices} can't be read as a device list; run:  node src/cli.mjs repair`);
  return structuredClone(d);
}

export async function addDevice(name, kind = 'device') {
  const n = String(name).trim().slice(0, 40);
  if (!/^[\w .-]{1,40}$/.test(n)) throw new Error('device name: letters, numbers, spaces, . _ - only');
  const d = devicesForEdit();
  if (d.devices.some((x) => x.name.toLowerCase() === n.toLowerCase())) throw new Error(`a device called "${n}" already exists (remove it first)`);
  const token = `jh_${randomBytes(24).toString('base64url')}`;
  d.devices.push({ name: n, kind: String(kind).slice(0, 20), tokenHash: hash(token), createdAt: Date.now() });
  await writeJson(F.devices, d, { backup: true });
  devices = null; // re-read on next use
  return token;
}

export function listDevices() {
  const seen = (() => { try { return readJson(SEEN, {}) ?? {}; } catch { return {}; } })();
  return loadDevices().devices.map(({ tokenHash, ...rest }) => ({ ...rest, lastSeenAt: seen[rest.name] ?? rest.lastSeenAt ?? null }));
}

export async function removeDevice(name) {
  const d = devicesForEdit();
  const before = d.devices.length;
  d.devices = d.devices.filter((x) => x.name.toLowerCase() !== String(name).toLowerCase());
  if (d.devices.length !== before) { await writeJson(F.devices, d, { backup: true }); devices = null; }
  return before - d.devices.length;
}

/** The device a token belongs to, or null. Constant-time compare on the hashes. */
export function deviceForToken(token) {
  const t = cleanToken(token);
  if (!t.startsWith('jh_') || t.length > 200) return null;
  const h = Buffer.from(hash(t), 'hex');
  for (const dev of loadDevices().devices) {
    const other = Buffer.from(String(dev.tokenHash ?? ''), 'hex');
    if (other.length === h.length && timingSafeEqual(other, h)) return dev;
  }
  return null;
}

const seenNow = {};
let seenTimer = null;
export function markSeen(dev) {
  seenNow[dev.name] = Date.now();
  if (seenTimer) return;
  seenTimer = setTimeout(() => {
    seenTimer = null;
    let all = {};
    try { all = readJson(SEEN, {}) ?? {}; } catch {}
    writeJson(SEEN, { ...all, ...seenNow }).catch(() => {});
  }, 5000);
}

/**
 * Rebuilds devices.json from it and every backup that still parses (.bak, .corrupt-*), keeping each device's
 * newest entry, and moves the backups into backup/. Brings back tokens lost to the old "unreadable means corrupt"
 * bug. Returns { devices, sources }.
 */
export async function repairDevices() {
  const dir = path.dirname(F.devices), base = path.basename(F.devices);
  const names = (await fs.readdir(dir)).filter((n) => n === base || n.startsWith(`${base}.`)).filter((n) => !n.endsWith('.tmp'));
  const byName = new Map(), sources = [];
  for (const n of names) {
    let d = null;
    try { d = JSON.parse(readFileSync(path.join(dir, n), 'utf8')); } catch { continue; }
    if (!Array.isArray(d?.devices)) continue;
    sources.push(n);
    for (const dev of d.devices) {
      if (!dev?.name || !/^[0-9a-f]{64}$/.test(dev.tokenHash ?? '')) continue;
      const key = dev.name.toLowerCase(), have = byName.get(key);
      if (!have || (dev.createdAt ?? 0) > (have.createdAt ?? 0)) byName.set(key, { name: dev.name, kind: dev.kind ?? 'device', tokenHash: dev.tokenHash, createdAt: dev.createdAt ?? Date.now() });
    }
  }
  if (!sources.length) throw new Error('no readable device list or backup found; nothing changed (add devices again with: node src/cli.mjs add <name>)');
  const out = { version: 1, devices: [...byName.values()].sort((a, b) => a.createdAt - b.createdAt) };
  await writeJson(F.devices, out, { backup: true });
  const bk = path.join(dir, 'backup');
  await fs.mkdir(bk, { recursive: true, mode: 0o700 }); ownerFix(bk);
  for (const n of names) if (n !== base) await fs.rename(path.join(dir, n), path.join(bk, n)).catch(() => {});
  devices = null;
  return { devices: out.devices.map((d) => d.name), sources };
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
    let s = null;
    try { s = readJson(path.join(F.sessions, n)); } catch (e) { console.error(`[db] ${e.message}`); }
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

// ---------- notes (what you're working on, in your words) ----------
// Free-form notes about your projects: written from the Brain view, or by Jarvis when you ask it to note something.

const NOTES = path.join(DATA, 'notes.json');
const NOTE_CAP = 500;
export const listNotes = () => { const n = readJson(NOTES, { version: 1, notes: [] }); return Array.isArray(n?.notes) ? n.notes : []; };

export async function saveNote({ id, title, text, tags }) {
  const notes = listNotes();
  const clean = {
    title: String(title ?? '').trim().slice(0, 120),
    text: String(text ?? '').trim().slice(0, 8000),
    tags: (Array.isArray(tags) ? tags : String(tags ?? '').split(',')).map((t) => String(t).trim().toLowerCase().replace(/[^a-z0-9 _-]/g, '')).filter(Boolean).slice(0, 8),
  };
  if (!clean.title && !clean.text) throw Object.assign(new Error('a note needs a title or text'), { code: 400 });
  if (!clean.title) clean.title = clean.text.split('\n')[0].slice(0, 80);
  const now = Date.now();
  let note = id ? notes.find((n) => n.id === id) : null;
  if (id && !note) throw Object.assign(new Error('no such note'), { code: 404 });
  if (note) Object.assign(note, clean, { updatedAt: now });
  else { note = { id: newId('n'), ...clean, createdAt: now, updatedAt: now }; notes.push(note); }
  notes.sort((a, b) => b.updatedAt - a.updatedAt);
  await writeJson(NOTES, { version: 1, notes: notes.slice(0, NOTE_CAP) });
  return note;
}

export async function deleteNote(id) {
  const notes = listNotes(), i = notes.findIndex((n) => n.id === id);
  if (i < 0) return false;
  notes.splice(i, 1);
  await writeJson(NOTES, { version: 1, notes });
  return true;
}

// ---------- the brain view: everything Jarvis knows about your work, readable ----------

const SUMMARY_HEAD = '[Summary of the earlier conversation';
function textOf(m) {
  const t = typeof m?.content === 'string' ? m.content : (m?.content ?? []).filter((p) => p?.type === 'text').map((p) => p.text).join(' ');
  return t.replace(/<live>[\s\S]*?<\/live>/g, '').replace(/^\[[^\]]{4,40}\]\s*/, '').replace(/\[(remind|upset|happy|concerned|hype|think|wave)\]/gi, '').replace(/\s+/g, ' ').trim();
}

/** A readable digest of one desktop conversation: what it was about, its summary, and how it ended. */
function digest(s) {
  const msgs = (s.messages ?? []).filter((m) => m.role === 'user' || m.role === 'assistant');
  const summaryMsg = msgs.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(SUMMARY_HEAD));
  const turns = msgs.filter((m) => m !== summaryMsg).map((m) => ({ role: m.role, text: textOf(m) })).filter((t) => t.text && !t.text.startsWith('(System'));
  const firstAsk = turns.find((t) => t.role === 'user')?.text ?? '';
  return {
    id: s.id,
    device: s.device ?? null,
    lastActiveAt: s.lastActiveAt ?? s.receivedAt ?? 0,
    title: firstAsk.slice(0, 90) || 'Conversation',
    summary: summaryMsg ? summaryMsg.content.replace(/^\[[^\]]*\]\s*/, '').slice(0, 1200) : '',
    recent: turns.slice(-6).map((t) => ({ role: t.role, text: t.text.slice(0, 400) })),
    turns: turns.length,
  };
}

export async function brainView() {
  const mem = getMemory();
  const weekAgo = Date.now() - 7 * 864e5;
  const sessions = [];
  for (const meta of (await listSessions()).slice(0, 15)) {
    let s = null;
    try { s = getSession(meta.id); } catch {}
    if (s) sessions.push(digest(s));
  }
  return {
    notes: listNotes(),
    commitments: mem.commitments.filter((c) => c.status === 'open' || (c.doneAt ?? 0) > weekAgo).sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || (a.due ?? Infinity) - (b.due ?? Infinity)),
    facts: mem.facts.slice().sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt)),
    work: sessions,
    chats: getHubChat().turns.slice(-20).reverse(),
  };
}
