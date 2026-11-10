// Merging the memory document between devices and the Jarvis Hub (server/jarvis-hub).
// Shared by the desktop sidecar and the hub, so both sides merge the same way.
//
// Memory doc: { version: 1, commitments: [...], facts: [...], deleted: { [id]: ms } }
// Every item carries an id; its "stamp" is the newest of updatedAt / doneAt / remindedAt / createdAt.
// Rules: union by id, the newer stamp wins; a tombstone newer than (or as new as) an item removes it;
// facts with the same normalised text collapse into the newest one; tombstones expire after 30 days.

export const TOMBSTONE_TTL = 30 * 864e5;

export const stamp = (x) => Math.max(x?.updatedAt ?? 0, x?.doneAt ?? 0, x?.remindedAt ?? 0, x?.createdAt ?? 0);

const norm = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

export function emptyDoc() {
  return { version: 1, commitments: [], facts: [], deleted: {} };
}

/** Accepts anything shaped like a memory doc (or null) and returns a clean one. */
export function cleanDoc(d) {
  const ok = (x) => x && typeof x === 'object' && typeof x.id === 'string' && x.id.length <= 40 && typeof x.text === 'string';
  const deleted = {};
  if (d?.deleted && typeof d.deleted === 'object') {
    for (const [id, t] of Object.entries(d.deleted)) if (typeof id === 'string' && id.length <= 40 && Number.isFinite(t)) deleted[id] = t;
  }
  return {
    version: 1,
    commitments: Array.isArray(d?.commitments) ? d.commitments.filter(ok) : [],
    facts: Array.isArray(d?.facts) ? d.facts.filter(ok) : [],
    deleted,
  };
}

function mergeList(a, b, deleted) {
  const byId = new Map();
  for (const x of [...a, ...b]) {
    const have = byId.get(x.id);
    if (!have || stamp(x) > stamp(have)) byId.set(x.id, x);
  }
  return [...byId.values()].filter((x) => !(deleted[x.id] >= stamp(x)));
}

/** The canonical order, so the same contents always serialise the same way. */
const byCreated = (p, q) => (p.createdAt ?? 0) - (q.createdAt ?? 0) || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0);

/**
 * Merges two memory docs. Returns { doc, changed }, where `changed` says whether the result differs from `a`
 * (so a side only writes or pushes when something really arrived).
 */
export function mergeMemory(a, b, now = Date.now()) {
  const A = cleanDoc(a), B = cleanDoc(b);
  const deleted = { ...A.deleted };
  for (const [id, t] of Object.entries(B.deleted)) if (!(deleted[id] >= t)) deleted[id] = t;
  for (const [id, t] of Object.entries(deleted)) if (now - t > TOMBSTONE_TTL) delete deleted[id];

  const commitments = mergeList(A.commitments, B.commitments, deleted).sort(byCreated);
  // Two devices can learn the same fact under different ids: keep the newest, tombstone the other.
  const factsAll = mergeList(A.facts, B.facts, deleted);
  const byText = new Map();
  for (const f of factsAll) {
    const k = norm(f.text), have = byText.get(k);
    if (!have) { byText.set(k, f); continue; }
    const [keep, drop] = stamp(f) > stamp(have) || (stamp(f) === stamp(have) && f.id > have.id) ? [f, have] : [have, f];
    byText.set(k, keep);
    deleted[drop.id] = Math.max(deleted[drop.id] ?? 0, stamp(drop));
  }
  const facts = [...byText.values()].sort(byCreated);

  const doc = { version: 1, commitments, facts, deleted };
  return { doc, changed: fingerprint(doc) !== fingerprint(A) };
}

/** A stable fingerprint of a doc's contents (not its formatting). */
export function fingerprint(d) {
  const c = cleanDoc(d);
  const keys = (o) => Object.keys(o).sort().reduce((r, k) => ((r[k] = o[k]), r), {});
  const sorted = (l) => [...l].sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0)).map(keys);
  return JSON.stringify({ c: sorted(c.commitments), f: sorted(c.facts), d: keys(c.deleted) });
}
