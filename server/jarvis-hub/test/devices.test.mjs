// Device tokens on disk: a file the hub can't read, or a broken one, must never lock devices out or be replaced
// with an empty list. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-devices-test-'));
process.env.HUB_DATA_DIR = TMP;
process.on('exit', () => { try { fs.chmodSync(path.join(TMP, 'devices.json'), 0o600); } catch {} fs.rmSync(TMP, { recursive: true, force: true }); });
const db = await import('../src/db.mjs');
const F = path.join(TMP, 'devices.json');
const quiet = console.error; console.error = () => {};

const t1 = await db.addDevice('phone', 'phone');
const t2 = await db.addDevice('laptop', 'desktop');
assert.equal(db.deviceForToken(t1)?.name, 'phone');
assert.equal(db.deviceForToken(`  "Bearer ${t2}" `)?.name, 'laptop', 'pasted tokens are cleaned up');
assert.equal(db.deviceForToken('jh_wrong'), null);
await assert.rejects(db.addDevice('phone'), /already exists/);
await assert.rejects(db.addDevice('bad/name'), /letters/);

// A broken file: the last good list keeps working, the file is left alone (a copy is kept), edits are refused.
const good = fs.readFileSync(F, 'utf8');
fs.writeFileSync(F, '{"devices": ['); fs.utimesSync(F, new Date(), new Date(Date.now() + 5000));
assert.equal(db.deviceForToken(t1)?.name, 'phone', 'still works with a broken file');
assert.ok(db.devicesProblem(), 'the problem is reported');
assert.equal(fs.readFileSync(F, 'utf8'), '{"devices": [', 'the broken file is not moved or replaced');
await assert.rejects(db.addDevice('tablet'), /repair/, 'adding refuses rather than starting an empty list');

// The old bug: valid lists moved aside as devices.json.corrupt-*. repair brings every device back.
fs.writeFileSync(path.join(TMP, 'devices.json.corrupt-1700000000000'), good);
const r = await db.repairDevices();
await db.flush();
assert.deepEqual(r.devices.sort(), ['laptop', 'phone']);
assert.equal(db.deviceForToken(t2)?.name, 'laptop');
assert.ok(fs.existsSync(path.join(TMP, 'backup', 'devices.json.corrupt-1700000000000')), 'old copies moved to backup/');
assert.equal(db.devicesProblem(), null);

// Unreadable (permission denied) is not "corrupt": nothing is renamed, the last good list keeps working.
if (process.getuid?.() !== 0) {
  fs.chmodSync(F, 0o000); fs.utimesSync(F, new Date(), new Date(Date.now() + 10000));
  assert.equal(db.deviceForToken(t1)?.name, 'phone', 'still works when the file is unreadable');
  assert.match(db.devicesProblem(), /not readable/);
  assert.ok(fs.existsSync(F), 'the unreadable file is not moved away');
  assert.equal(fs.readdirSync(TMP).filter((n) => n.includes('corrupt')).length, 0);
  fs.chmodSync(F, 0o600);
}

// last-seen goes to its own file; devices.json is only written by the CLI paths
db.markSeen({ name: 'phone' });
console.error = quiet;
console.log('devices: ok');
process.exit(0);
