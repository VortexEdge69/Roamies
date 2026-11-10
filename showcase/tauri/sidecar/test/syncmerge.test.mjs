// Jarvis Hub sync: merging memory between devices, and the store's sync hooks. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeMemory, fingerprint, TOMBSTONE_TTL } from '../syncmerge.mjs';

const now = 1_800_000_000_000;
const c = (id, text, t, extra = {}) => ({ id, text, createdAt: t, updatedAt: t, status: 'open', ...extra });

// union by id
{
  const a = { version: 1, commitments: [c('c1', 'gym', now - 10)], facts: [], deleted: {} };
  const b = { version: 1, commitments: [c('c2', 'call mom', now - 5)], facts: [], deleted: {} };
  const { doc, changed } = mergeMemory(a, b, now);
  assert.deepEqual(doc.commitments.map((x) => x.id), ['c1', 'c2']);
  assert.equal(changed, true);
}
// newer edit wins
{
  const a = { commitments: [c('c1', 'gym', now - 100)] };
  const b = { commitments: [c('c1', 'gym', now - 100, { status: 'done', doneAt: now - 1, updatedAt: now - 1 })] };
  assert.equal(mergeMemory(a, b, now).doc.commitments[0].status, 'done');
  assert.equal(mergeMemory(b, a, now).doc.commitments[0].status, 'done', 'order does not matter');
  assert.equal(mergeMemory(b, a, now).changed, false, 'nothing new for the side that already had it');
}
// tombstones delete, and stop a stale copy coming back
{
  const a = { commitments: [], facts: [], deleted: { f1: now - 10 } };
  const b = { facts: [{ id: 'f1', text: 'likes tea', createdAt: now - 50 }] };
  assert.equal(mergeMemory(a, b, now).doc.facts.length, 0);
  // but an edit made after the delete brings it back
  const b2 = { facts: [{ id: 'f1', text: 'likes tea', createdAt: now - 50, updatedAt: now - 1 }] };
  assert.equal(mergeMemory(a, b2, now).doc.facts.length, 1);
}
// old tombstones expire
{
  const { doc } = mergeMemory({ deleted: { x: now - TOMBSTONE_TTL - 1, y: now - 5 } }, {}, now);
  assert.deepEqual(Object.keys(doc.deleted), ['y']);
}
// the same fact learned on two devices collapses to one
{
  const a = { facts: [{ id: 'fa', text: 'Lives in Vijayawada.', createdAt: now - 20 }] };
  const b = { facts: [{ id: 'fb', text: 'lives in vijayawada', createdAt: now - 10 }] };
  const { doc } = mergeMemory(a, b, now);
  assert.equal(doc.facts.length, 1);
  assert.equal(doc.facts[0].id, 'fb');
  assert.ok(doc.deleted.fa, 'the duplicate is tombstoned so it stays gone everywhere');
}
// junk is ignored
{
  const { doc } = mergeMemory({ commitments: [null, { id: 5 }, { id: 'ok', text: 't', createdAt: 1 }] }, { facts: 'nope', deleted: { a: 'x' } }, now);
  assert.equal(doc.commitments.length, 1);
  assert.equal(doc.facts.length, 0);
  assert.deepEqual(doc.deleted, {});
}
// fingerprint ignores order
assert.equal(fingerprint({ facts: [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }] }), fingerprint({ facts: [{ id: 'b', text: 'y' }, { id: 'a', text: 'x' }] }));

// store: local changes fire the hook and record tombstones; remote merges don't fire it
{
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-sync-test-'));
  process.env.ROAMIES_DATA_DIR = TMP;
  process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
  const S = await import('../store.mjs');
  let fired = 0;
  S.onMemorySaved(() => fired++);
  const f = await S.addFact('Plays cricket on Sundays');
  assert.equal(fired, 1);
  assert.ok(f.updatedAt, 'facts carry updatedAt');
  await S.forgetFact(f.id);
  assert.ok(S.memorySnapshot().deleted[f.id], 'forgetting leaves a tombstone');
  const before = fired;
  const changed = await S.applyRemoteMemory({ facts: [{ id: 'fz', text: 'Has a VPS', createdAt: Date.now() }] });
  assert.equal(changed, true);
  assert.equal(fired, before, 'remote merges do not echo back');
  assert.ok(S.listFacts().some((x) => x.id === 'fz'));
  assert.equal(await S.applyRemoteMemory({ facts: [{ id: 'fz', text: 'Has a VPS', createdAt: 1 }] }), false, 'an older copy changes nothing');
  await S.flushWrites();
}

console.log('syncmerge: ok');
