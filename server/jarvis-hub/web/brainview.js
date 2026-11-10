// The Brain view: your work as Jarvis knows it, in words. Notes you (or Jarvis) wrote, what you're working on,
// digests of recent desktop conversations, remembered facts, and recent chats. Searchable; notes are editable.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const when = (ms) => {
  if (!ms) return '';
  const d = new Date(ms), now = Date.now(), diff = now - ms;
  if (diff >= 0 && diff < 60_000) return 'just now';
  if (diff >= 0 && diff < 3600_000) return `${Math.round(diff / 60_000)} min ago`;
  if (diff >= 0 && diff < 86_400_000) return `${Math.round(diff / 3600_000)} h ago`;
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const dueText = (c) => (c.due ? (c.status === 'open' && c.due < Date.now() ? `overdue · ${when(c.due)}` : `due ${new Date(c.due).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`) : 'anytime');

export function createBrainView({ api, onData }) {
  const $ = (id) => document.getElementById(id);
  const root = $('brain'), body = $('brainBody'), search = $('brainSearch');
  let data = null, tab = 'notes', editing = null;

  async function load() {
    const r = await api('v1/brain');
    if (!r.ok) { body.innerHTML = `<div class="empty">Couldn't load (${r.status}).</div>`; return; }
    data = await r.json();
    onData?.(data);
    counts();
    if (!root.classList.contains('hidden')) render();
  }

  function counts() {
    const n = (id, v) => { $(id).textContent = v ? String(v) : ''; };
    n('nNotes', data.notes.length);
    n('nTasks', data.commitments.filter((c) => c.status === 'open').length);
    n('nWork', data.work.length);
    n('nFacts', data.facts.length);
    n('nChats', data.chats.length);
  }

  const matches = (...fields) => { const q = search.value.trim().toLowerCase(); return !q || fields.join(' ').toLowerCase().includes(q); };

  function render() {
    if (!data) { body.innerHTML = '<div class="empty">Loading…</div>'; return; }
    if (editing) return renderEditor();
    let html = '';
    if (tab === 'notes') {
      const list = data.notes.filter((n) => matches(n.title, n.text, n.tags.join(' ')));
      html = list.map((n) => `<article class="card"><h4>${esc(n.title)}</h4>
        <div class="meta"><span>${when(n.updatedAt)}</span>${n.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}</div>
        <p>${esc(n.text)}</p>
        <div class="row"><button data-edit="${n.id}">Edit</button><button data-del="${n.id}">Delete</button></div></article>`).join('')
        || `<div class="empty">${search.value ? 'No matching notes.' : 'No notes yet. Tap “New note”, or tell Jarvis “note this down: …”.'}</div>`;
    } else if (tab === 'tasks') {
      const list = data.commitments.filter((c) => matches(c.text));
      html = list.map((c) => `<article class="card ${c.status !== 'open' ? 'done' : c.due && c.due < Date.now() ? 'overdue' : ''}"><h4>${esc(c.text)}</h4>
        <div class="meta"><span>${c.status === 'open' ? dueText(c) : `${c.status} ${when(c.doneAt)}`}</span><span>${c.kind === 'reminder' ? 'reminder' : 'commitment'}</span></div></article>`).join('')
        || '<div class="empty">Nothing open. Tell Jarvis what you plan to do and it will hold you to it.</div>';
    } else if (tab === 'work') {
      const list = data.work.filter((w) => matches(w.title, w.summary, w.recent.map((t) => t.text).join(' ')));
      html = list.map((w) => `<article class="card"><h4>${esc(w.title)}</h4>
        <div class="meta"><span>${when(w.lastActiveAt)}</span>${w.device ? `<span>on ${esc(w.device)}</span>` : ''}<span>${w.turns} messages</span></div>
        ${w.summary ? `<p>${esc(w.summary)}</p>` : ''}
        ${w.recent.map((t) => `<div class="turn"><b>${t.role === 'user' ? 'You' : 'Jarvis'}</b>${esc(t.text)}</div>`).join('')}</article>`).join('')
        || '<div class="empty">No desktop conversations yet. They appear here once Roamies on your computer is connected to the hub.</div>';
    } else if (tab === 'facts') {
      const list = data.facts.filter((f) => matches(f.text));
      html = list.map((f) => `<article class="card"><h4 style="font-weight:500">${esc(f.text)}</h4><div class="meta"><span>${when(f.updatedAt ?? f.createdAt)}</span></div></article>`).join('')
        || '<div class="empty">Nothing remembered yet.</div>';
    } else if (tab === 'chats') {
      const list = data.chats.filter((c) => matches(c.user, c.reply));
      html = list.map((c) => `<article class="card"><div class="meta"><span>${when(c.at)}</span><span>${esc(c.device ?? '')}</span></div>
        <div class="turn"><b>You</b>${esc(c.user)}</div><div class="turn"><b>Jarvis</b>${esc(c.reply)}</div></article>`).join('')
        || '<div class="empty">No chats yet.</div>';
    }
    body.innerHTML = html;
  }

  function renderEditor() {
    const n = editing.id ? data.notes.find((x) => x.id === editing.id) ?? {} : {};
    body.innerHTML = `<div class="editor">
      <input id="noteTitle" type="text" placeholder="Title (e.g. Kreedo streaming server)" value="${esc(n.title ?? '')}" aria-label="Title">
      <input id="noteTags" type="text" placeholder="Projects, comma-separated (e.g. kreedo, vecrahost)" value="${esc((n.tags ?? []).join(', '))}" aria-label="Tags">
      <textarea id="noteText" placeholder="What you're working on, decisions, details to keep…" aria-label="Note">${esc(n.text ?? '')}</textarea>
      <div class="row" style="display:flex;gap:8px;margin-top:10px"><button id="noteSave" class="primary">Save</button><button id="noteCancel">Cancel</button></div>
      <p id="noteErr" style="color:var(--hot)"></p></div>`;
    $('noteText').focus();
    $('noteCancel').onclick = () => { editing = null; render(); };
    $('noteSave').onclick = async () => {
      const payload = { title: $('noteTitle').value, text: $('noteText').value, tags: $('noteTags').value };
      const r = await api(editing.id ? `v1/notes/${editing.id}` : 'v1/notes', { method: editing.id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
      if (!r.ok) { $('noteErr').textContent = (await r.json().catch(() => ({}))).error ?? `Save failed (${r.status})`; return; }
      editing = null; tab = 'notes'; selectTab(); await load(); render();
    };
  }

  function selectTab() { for (const b of root.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab)); }

  root.querySelector('.tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    tab = b.dataset.tab; editing = null; selectTab(); render();
  });
  body.addEventListener('click', async (e) => {
    const ed = e.target.closest('[data-edit]'), del = e.target.closest('[data-del]');
    if (ed) { editing = { id: ed.dataset.edit }; render(); }
    if (del && confirm('Delete this note?')) { await api(`v1/notes/${del.dataset.del}`, { method: 'DELETE' }); await load(); render(); }
  });
  search.addEventListener('input', () => { if (!editing) render(); });
  $('newNote').onclick = () => { editing = { id: null }; render(); };
  $('closeBrain').onclick = () => root.classList.add('hidden');

  return {
    load,
    open() { root.classList.remove('hidden'); render(); load(); },
  };
}
