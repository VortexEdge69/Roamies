// Jarvis web/phone client. Install it on Android from Chrome's menu (Add to Home screen).
// Talks to the hub over one WebSocket: chats, hears other devices' turns, speaks "say" lines and reminders,
// and joins wake-word arbitration so only one device answers "Jarvis".
import { createSphere } from './sphere.js';
import { createBrainView } from './brainview.js';

const $ = (id) => document.getElementById(id);
const store = {
  get: (k, d = null) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};
// The Android app opens this page as  /#native=1&device=…&token=…  (the fragment never reaches the server).
const NATIVE = window.JarvisNative ?? null;
{
  const h = new URLSearchParams(location.hash.slice(1));
  const t = h.get('token');
  if (t && /^jh_[A-Za-z0-9_-]{20,100}$/.test(t)) { try { localStorage.setItem('token', t); } catch {} }
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}
const prefs = { voice: store.get('voice', '1') === '1', desk: store.get('desk') === '1', wake: store.get('wake') === '1' };
let token = store.get('token');
let ws = null, backoff = 1000, reqId = 0, stopRetry = false;
const sphere = createSphere($('sphere'));

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

// ---------- setup ----------
function showSetup(err = '') {
  $('setup').classList.remove('hidden'); $('app').classList.add('hidden');
  $('setupErr').textContent = err;
}
$('save').onclick = async () => {
  const t = $('token').value.trim();
  if (!t.startsWith('jh_')) return showSetup('That doesn\'t look like a device token (they start with jh_).');
  const r = await fetch('v1/me', { headers: { 'x-jarvis-token': t } }).catch(() => null);
  if (!r?.ok) return showSetup(r?.status === 401 ? 'The hub didn\'t accept that token.' : 'Couldn\'t reach the hub.');
  token = t; store.set('token', t); stopRetry = false; start();
};
$('logout').onclick = () => { store.set('token', null); if (NATIVE) NATIVE.unpair(); else location.reload(); };

// ---------- feed ----------
function add(kind, text, from) {
  const el = document.createElement('div');
  el.className = `msg ${kind}`;
  if (from) { const f = document.createElement('span'); f.className = 'from'; f.textContent = from; el.append(f); }
  el.append(document.createTextNode(text));
  $('feed').append(el);
  $('feed').scrollTop = $('feed').scrollHeight;
  while ($('feed').children.length > 60) $('feed').firstChild.remove();
}
const caption = (t) => { $('caption').textContent = t; };

// ---------- speaking ----------
function speak(text) {
  if (!prefs.voice || !('speechSynthesis' in window) || !text) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replace(/[*_#`>]/g, ''));
  const v = speechSynthesis.getVoices().find((x) => /en-GB/i.test(x.lang) && /male|daniel|george|arthur/i.test(x.name)) ?? speechSynthesis.getVoices().find((x) => /en-GB/i.test(x.lang));
  if (v) u.voice = v;
  u.rate = 1.02;
  u.onstart = () => sphere.setMode('talk');
  u.onend = u.onerror = () => { sphere.setMode('idle'); resumeWake(); };
  pauseWake();
  speechSynthesis.speak(u);
}

// ---------- connection ----------
const setStatus = (on, text) => { $('dot').classList.toggle('on', on); $('statusText').textContent = text; };
function connect() {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/v1/live`;
  ws = new WebSocket(url, ['jarvis.v1', `bearer.${token}`]);
  ws.onopen = () => {
    backoff = 1000;
    ws.send(JSON.stringify({ type: 'hello', kind: /Android|iPhone/i.test(navigator.userAgent) ? 'phone' : 'web', canSpeak: true }));
    loadMemory();
  };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'welcome') setStatus(true, m.brain ? 'Online' : 'Online · brain needs an API key');
    else if (m.type === 'presence') setStatus(true, `Online · ${m.devices.map((d) => d.name).join(', ')}`);
    else if (m.type === 'reply') { sphere.setMode('idle'); caption(''); add('', m.text, 'Jarvis'); speak(m.text); }
    else if (m.type === 'error') { sphere.setMode('idle'); caption(''); add('note', m.error); }
    else if (m.type === 'turn') { add('note', `${m.from}: ${m.user}`); add('', m.reply, `Jarvis · ${m.from}`); }
    else if (m.type === 'say') { add('', m.text, m.from ? `Jarvis · from ${m.from}` : 'Jarvis'); if (!NATIVE?.isListening()) speak(m.text); } // the app's background service speaks these itself
    else if (m.type === 'reminder') { add('note', m.text); loadMemory(); }
    else if (m.type === 'memory' || m.type === 'notes' || m.type === 'session') loadMemory();
    else if (m.type === 'wake_granted' || m.type === 'wake_yield') onWakeResult(m);
  };
  let opened = false;
  ws.addEventListener('open', () => { opened = true; });
  ws.onclose = () => {
    setStatus(false, 'Offline, retrying…');
    // Never got in: find out why straight away instead of retrying blindly.
    if (!opened || backoff > 8000) {
      fetch('v1/me', { headers: { 'x-jarvis-token': token } }).then((r) => {
        if (r.status === 401) { stopRetry = true; store.set('token', null); showSetup('The hub rejected this token (revoked, or added to another hub). Paste a new one.'); }
        else if (r.ok && !opened) setStatus(false, 'Token OK, but the live link is blocked: the proxy must pass WebSocket upgrades for /v1/live.');
      }).catch(() => setStatus(false, 'Can\'t reach the hub, retrying…'));
    }
    if (!stopRetry) { setTimeout(connect, backoff); backoff = Math.min(30000, backoff * 2); }
  };
}

function ask(text, { voice = false } = {}) {
  text = text.trim();
  if (!text) return;
  add('me', text);
  if (!ws || ws.readyState !== 1) return add('note', 'Not connected yet.');
  if (prefs.desk) { ws.send(JSON.stringify({ type: 'prompt', text })); add('note', 'Sent to your desktop.'); return; }
  sphere.setMode('think'); caption('Thinking…');
  ws.send(JSON.stringify({ type: 'chat', id: ++reqId, text, voice: voice || prefs.voice }));
}
$('bar').onsubmit = (e) => { e.preventDefault(); ask($('text').value); $('text').value = ''; };

// ---------- brain: notes and work, and the globe's memory nodes ----------
const api = (path, opts = {}) => fetch(path, { ...opts, headers: { 'x-jarvis-token': token, ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers ?? {}) } })
  .catch(() => new Response(null, { status: 0 }));
const brain = createBrainView({ api, onData: (d) => sphere.setMemory(d) });
const loadMemory = () => brain.load();
$('brainBtn').onclick = () => brain.open();

// ---------- hold-to-talk (recorded, transcribed on the hub) ----------
let rec = null, chunks = [], stream = null, meter = null;
async function startRec() {
  if (rec) return;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch { return add('note', 'Microphone permission is needed for voice.'); }
  pauseWake();
  NATIVE?.pauseMic();
  const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
  rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = sendRec;
  rec.start();
  $('mic').classList.add('live'); sphere.setMode('listen'); caption('Listening…');
  // Feed the mic level to the globe.
  const ac = new AudioContext(), src = ac.createMediaStreamSource(stream), an = ac.createAnalyser();
  an.fftSize = 512; src.connect(an);
  const buf = new Uint8Array(an.fftSize);
  meter = setInterval(() => { an.getByteTimeDomainData(buf); let s = 0; for (const v of buf) s += ((v - 128) / 128) ** 2; sphere.setLevel(Math.min(1, Math.sqrt(s / buf.length) * 4)); }, 50);
  rec._ac = ac;
}
function stopRec() {
  if (!rec) return;
  clearInterval(meter); rec._ac?.close();
  rec.stop(); stream.getTracks().forEach((t) => t.stop());
  NATIVE?.resumeMic();
  $('mic').classList.remove('live');
}
async function sendRec() {
  const blob = new Blob(chunks, { type: rec.mimeType.split(';')[0] || 'audio/webm' });
  rec = null;
  if (blob.size < 2000) { sphere.setMode('idle'); caption(''); resumeWake(); return; }
  sphere.setMode('think'); caption('Transcribing…');
  const r = await fetch('v1/transcribe', { method: 'POST', headers: { 'x-jarvis-token': token, 'content-type': blob.type }, body: blob }).catch(() => null);
  const out = r?.ok ? await r.json() : null;
  if (!out) { sphere.setMode('idle'); caption(''); add('note', 'Transcription failed. Is STT_API_KEY set on the hub?'); resumeWake(); return; }
  if (!out.text) { sphere.setMode('idle'); caption('Didn\'t catch that.'); resumeWake(); return; }
  ask(out.text, { voice: true });
}
const mic = $('mic');
mic.addEventListener('pointerdown', (e) => { e.preventDefault(); mic.setPointerCapture(e.pointerId); startRec(); });
mic.addEventListener('pointerup', stopRec);
mic.addEventListener('pointercancel', stopRec);

// ---------- "Hey Jarvis" (browser speech recognition, while the page is open) ----------
// Chrome on Android and desktop support this. It listens continuously for the word "Jarvis"; whatever follows it
// in the same breath is the request. The hub arbitrates, so a desktop that also heard it doesn't answer twice.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null, wakeWanted = false, wakePaused = false, pendingWake = null;
function startWake() {
  if (!SR) { add('note', 'This browser has no speech recognition; use hold-to-talk.'); setWakePref(false); return; }
  wakeWanted = true;
  if (recog || wakePaused) return;
  recog = new SR();
  recog.continuous = true; recog.interimResults = false; recog.lang = store.get('lang', 'en-IN');
  recog.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (!e.results[i].isFinal) continue;
      const said = e.results[i][0].transcript.trim(), conf = e.results[i][0].confidence || 0.7;
      const m = /\bjarvis\b[\s,.!?]*(.*)$/i.exec(said);
      if (!m) continue;
      const request = m[1].trim();
      pendingWake = { request, timer: setTimeout(() => onWakeResult({ type: 'wake_granted', by: 'me' }), 700) };
      ws?.readyState === 1 && ws.send(JSON.stringify({ type: 'wake', score: conf }));
      sphere.setMode('listen');
    }
  };
  recog.onend = () => { recog = null; if (wakeWanted && !wakePaused) setTimeout(startWake, 300); };
  recog.onerror = (e) => { if (e.error === 'not-allowed') { setWakePref(false); add('note', 'Microphone permission is needed for "Hey Jarvis".'); } };
  try { recog.start(); } catch {}
}
function onWakeResult(m) {
  if (!pendingWake) return;
  const p = pendingWake; pendingWake = null; clearTimeout(p.timer);
  if (m.type === 'wake_yield' && m.by !== 'me') { sphere.setMode('idle'); caption(`${m.by} is answering`); setTimeout(() => caption(''), 2000); return; }
  if (p.request) ask(p.request, { voice: true });
  else { caption('Yes, sir?'); speak('Yes, sir?'); setTimeout(startRec, 900); setTimeout(stopRec, 7000); }
}
function stopWake() { wakeWanted = false; try { recog?.stop(); } catch {} recog = null; }
function pauseWake() { wakePaused = true; try { recog?.stop(); } catch {} }
function resumeWake() { wakePaused = false; if (wakeWanted) startWake(); }

// ---------- toggles ----------
function chip(id, key, on, after) {
  const b = $(id);
  const set = (v) => { prefs[key] = v; b.setAttribute('aria-pressed', String(v)); store.set(key, v ? '1' : '0'); after?.(v); };
  b.onclick = () => set(!prefs[key]);
  set(on);
  return set;
}
const initialWake = prefs.wake;
chip('voiceBtn', 'voice', prefs.voice, (v) => { if (!v) speechSynthesis?.cancel(); });
chip('deskBtn', 'desk', prefs.desk);
let setWakePref;
if (NATIVE) {
  // In the Android app, "Always listening" runs in the background with the screen off (a notification shows it).
  const b = $('wakeBtn');
  b.textContent = 'Always listening';
  b.title = 'Listen for "Jarvis" in the background, even with the screen off';
  const sync = () => { const on = NATIVE.isListening(); b.setAttribute('aria-pressed', String(on)); b.textContent = on ? `Always listening · ${NATIVE.status()}` : 'Always listening'; };
  b.onclick = () => { NATIVE.isListening() ? NATIVE.stopListening() : NATIVE.startListening(); setTimeout(sync, 800); };
  setInterval(sync, 2000); sync();
  setWakePref = () => {};
} else {
  setWakePref = chip('wakeBtn', 'wake', false, (v) => (v ? startWake() : stopWake()));
}

// ---------- go ----------
function start() {
  $('setup').classList.add('hidden'); $('app').classList.remove('hidden');
  connect();
  if (initialWake && !NATIVE) setWakePref(true); // browsers need a tap first; if refused, the chip turns itself off
}
if (token) start(); else showSetup();
