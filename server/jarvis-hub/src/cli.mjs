#!/usr/bin/env node
// Manage device tokens.  npm run device -- add <name> [kind] | list | remove <name>
// kind: desktop, phone, pendant, web (just a label; what a device can do is said when it connects).
import path from 'node:path';
try { process.loadEnvFile(process.env.HUB_ENV_FILE || path.join(import.meta.dirname, '..', '.env')); } catch {}
const db = await import('./db.mjs');

const [cmd, name, kind] = process.argv.slice(2);
try {
  if (cmd === 'add' && name) {
    const token = await db.addDevice(name, kind ?? 'device');
    await db.flush();
    console.log(`Device "${name}" added. Its token (shown once, keep it secret):\n\n  ${token}\n`);
    console.log('Desktop: put it in ~/.gg/sidekick/hub.json as {"url":"https://your-hub","token":"..."}');
    console.log('Phone/web: open the hub URL and paste it when asked.');
  } else if (cmd === 'list') {
    const list = db.listDevices();
    if (!list.length) console.log('No devices.');
    for (const d of list) console.log(`${d.name.padEnd(20)} ${d.kind.padEnd(10)} added ${new Date(d.createdAt).toLocaleString()}  last seen ${d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : 'never'}`);
  } else if (cmd === 'remove' && name) {
    const n = await db.removeDevice(name);
    await db.flush();
    console.log(n ? `Removed "${name}". Its token no longer works (restart the hub to drop live connections).` : `No device called "${name}".`);
  } else {
    console.log('Usage:\n  npm run device -- add <name> [desktop|phone|pendant|web]\n  npm run device -- list\n  npm run device -- remove <name>');
    process.exitCode = cmd ? 1 : 0;
  }
} catch (e) {
  console.error(String(e?.message ?? e));
  process.exitCode = 1;
}
