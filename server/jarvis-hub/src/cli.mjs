#!/usr/bin/env node
// Manage device tokens. Run from /opt/jarvis/server/jarvis-hub as the service user:
//   sudo -u jarvis node src/cli.mjs add <name> [desktop|phone|pendant|browser]
//   sudo -u jarvis node src/cli.mjs list | remove <name> | check <token> | doctor [token] | repair
// It reads HUB_DATA_DIR from the hub's .env, so it always works on the same files as the running hub.
// Running it as root is safe too: files it writes are handed back to the data folder's owner.
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
try { process.loadEnvFile(process.env.HUB_ENV_FILE || path.join(import.meta.dirname, '..', '.env')); } catch {}
const db = await import('./db.mjs');

const [cmd, a1, a2] = process.argv.slice(2);
const PORT = Number(process.env.PORT || 8787);
const say = (s = '') => console.log(s);

async function health() {
  try { return await (await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(3000) })).json(); } catch { return null; }
}
async function tryToken(token) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/v1/me`, { headers: { authorization: `Bearer ${db.cleanToken(token)}` }, signal: AbortSignal.timeout(3000) });
    return r.status;
  } catch { return null; }
}
const sh = (bin, args) => { try { return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };

async function doctor(token) {
  let bad = 0;
  const ok = (t) => say(`  ok    ${t}`), warn = (t) => { bad++; say(`  FIX   ${t}`); };
  say(`Data folder: ${db.DATA}`);
  let dirSt;
  try { dirSt = statSync(db.DATA); ok(`exists, owner uid ${dirSt.uid}, mode ${(dirSt.mode & 0o777).toString(8)}`); }
  catch { warn('missing (it is created on first write)'); }
  if (dirSt) {
    for (const n of readdirSync(db.DATA)) {
      const st = statSync(path.join(db.DATA, n));
      if (st.uid !== dirSt.uid) warn(`${n} is owned by uid ${st.uid}, the hub runs as uid ${dirSt.uid}:  sudo chown -R jarvis:jarvis ${db.DATA}`);
    }
    const corrupt = readdirSync(db.DATA).filter((n) => n.startsWith('devices.json.corrupt-'));
    if (corrupt.length) warn(`${corrupt.length} devices.json.corrupt-* file(s): run  sudo -u jarvis node src/cli.mjs repair  to bring those devices back`);
  }
  const problem = db.devicesProblem();
  if (problem) warn(`devices.json: ${problem}`); else ok(`devices.json: ${db.listDevices().length} device(s): ${db.listDevices().map((d) => d.name).join(', ') || '(none)'}`);

  const h = await health();
  if (!h) warn(`nothing answers on 127.0.0.1:${PORT}:  sudo systemctl status jarvis-hub`);
  else {
    ok(`hub answers on :${PORT} (version ${h.version}, brain ${h.brain ? 'on' : 'off'})`);
    if (typeof h.devices === 'number' && !problem && h.devices !== db.listDevices().length) warn(`the hub sees ${h.devices} device(s) but the file has ${db.listDevices().length}: it uses a different data folder or file owner. Restart: sudo systemctl restart jarvis-hub`);
    if (h.devicesProblem) warn("the hub can't read devices.json (see: journalctl -u jarvis-hub -n 30)");
  }
  const listen = sh('ss', ['-ltnpH', `sport = :${PORT}`]);
  if (listen) {
    const pid = /pid=(\d+)/.exec(listen)?.[1];
    const svc = sh('systemctl', ['show', '-p', 'MainPID', '--value', 'jarvis-hub']);
    if (pid && svc && pid !== svc && svc !== '0') warn(`port ${PORT} belongs to pid ${pid}, not the jarvis-hub service (pid ${svc}): a hub started by hand is answering. Stop it:  sudo kill ${pid}`);
    else if (pid) ok(`port ${PORT} is the jarvis-hub service (pid ${pid})`);
  }
  if (token) {
    const dev = db.deviceForToken(token);
    if (dev) ok(`token belongs to "${dev.name}" in devices.json`); else warn('token is not in devices.json (typo, revoked, or added to another data folder)');
    const st = await tryToken(token);
    if (st === 200) ok('hub accepts the token (GET /v1/me → 200)'); else warn(`hub answers ${st ?? 'nothing'} for the token`);
  }
  say(bad ? `\n${bad} thing(s) to fix.` : '\nAll good.');
  process.exitCode = bad ? 1 : 0;
}

try {
  if (cmd === 'add' && a1) {
    const token = await db.addDevice(a1, a2 ?? 'device');
    await db.flush();
    say(`Device "${a1}" added (data folder ${db.DATA}). Its token, shown once — keep it secret:\n\n  ${token}\n`);
    const st = await tryToken(token);
    if (st === 200) say('Checked: the running hub accepts it.');
    else if (st) say(`Warning: the running hub answered ${st} for it. Run:  sudo -u jarvis node src/cli.mjs doctor ${token}`);
    say('\nDesktop: ~/.gg/sidekick/hub.json  {"url":"https://your-hub","token":"…"}   Phone/browser: open the hub and paste it.');
  } else if (cmd === 'list') {
    const list = db.listDevices();
    if (!list.length) say('No devices.');
    for (const d of list) say(`${d.name.padEnd(20)} ${String(d.kind).padEnd(10)} added ${new Date(d.createdAt).toLocaleString()}  last seen ${d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : 'never'}`);
  } else if (cmd === 'remove' && a1) {
    const n = await db.removeDevice(a1);
    await db.flush();
    say(n ? `Removed "${a1}". Its token stopped working.` : `No device called "${a1}".`);
  } else if (cmd === 'check' && a1) {
    const dev = db.deviceForToken(a1);
    say(dev ? `Token belongs to "${dev.name}".` : 'Token not found in devices.json.');
    const st = await tryToken(a1);
    say(`Running hub: ${st === 200 ? 'accepts it (200)' : st ? `rejects it (${st})` : 'not reachable'}`);
    process.exitCode = dev && st === 200 ? 0 : 1;
  } else if (cmd === 'doctor') {
    await doctor(a1);
  } else if (cmd === 'repair') {
    const r = await db.repairDevices();
    await db.flush();
    say(`devices.json rebuilt from ${r.sources.join(', ') || 'nothing'}: ${r.devices.join(', ') || '(no devices)'}`);
    say('Old copies moved to backup/. Tokens of the devices listed work again.');
  } else {
    say('Usage (run as the service user, from /opt/jarvis/server/jarvis-hub):');
    say('  sudo -u jarvis node src/cli.mjs add <name> [desktop|phone|pendant|browser]');
    say('  sudo -u jarvis node src/cli.mjs list');
    say('  sudo -u jarvis node src/cli.mjs remove <name>');
    say('  sudo -u jarvis node src/cli.mjs check <token>');
    say('  sudo -u jarvis node src/cli.mjs doctor [token]   find why tokens are rejected');
    say('  sudo -u jarvis node src/cli.mjs repair           rebuild devices.json from its backups');
    process.exitCode = cmd ? 1 : 0;
  }
} catch (e) {
  console.error(String(e?.message ?? e));
  process.exitCode = 1;
}
