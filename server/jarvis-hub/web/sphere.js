// The JARVIS globe for the web/phone client, in the style of Roamies' desktop JARVIS: a sphere of LED points
// rippled by the voice. Around it, the "brain": every saved fact and commitment is a node on an outer shell,
// wired to the globe, so you can see what Jarvis remembers. Facts glow cyan, open commitments amber, overdue red.
export function createSphere(canvas) {
  const ctx = canvas.getContext('2d');
  const TAU = Math.PI * 2;
  const golden = (n) => Array.from({ length: n }, (_, i) => {
    const y = 1 - (2 * (i + 0.5)) / n, r = Math.sqrt(1 - y * y), a = i * 2.39996;
    return [Math.cos(a) * r, y, Math.sin(a) * r];
  });
  const DOTS = golden(700);
  let nodes = [];          // { p:[x,y,z], kind, label, born }
  let mode = 'idle';       // idle | listen | think | talk
  let level = 0, target = 0, spin = 0, last = performance.now(), hover = null, pulse = 0;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2), r = canvas.getBoundingClientRect();
    canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  new ResizeObserver(resize).observe(canvas);
  resize();

  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  function setMemory(doc) {
    const items = [
      ...(doc?.facts ?? []).map((f) => ({ id: f.id, kind: 'fact', label: f.text })),
      ...(doc?.commitments ?? []).filter((c) => c.status === 'open').map((c) => ({ id: c.id, kind: c.due && c.due < Date.now() ? 'overdue' : 'task', label: c.text })),
    ];
    const pts = golden(Math.max(items.length, 1));
    const old = new Map(nodes.map((n) => [n.id, n]));
    nodes = items.map((it, i) => ({ ...it, p: pts[i], born: old.get(it.id)?.born ?? performance.now() }));
    pulse = 1;
  }

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    const t = now / 1000;
    if (mode === 'talk') target = 0.45 + 0.35 * Math.abs(Math.sin(t * 11.3)) * Math.abs(Math.sin(t * 2.9 + 1));
    else if (mode === 'listen') target = Math.max(target * 0.9, 0.3);
    else if (mode === 'think') target = 0.25;
    else target = 0.12 + 0.05 * Math.sin(t * 1.4);
    level += (target - level) * Math.min(1, dt * 10);
    pulse = Math.max(0, pulse - dt * 0.8);
    spin += (reduce ? 0.05 : mode === 'think' ? 1.4 : 0.28) * dt;

    const w = canvas.clientWidth, h = canvas.clientHeight;
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.26;
    ctx.clearRect(0, 0, w, h);
    const accent = css('--accent') || '#6ff3ff', warm = css('--warm') || '#ffc35c', hot = css('--hot') || '#ff5c6c';
    const yaw = spin, pitch = -0.38, cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const proj = (x, y, z, r) => {
      const x1 = x * cyw - z * syw, z1 = x * syw + z * cyw;
      const y1 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
      return [cx + x1 * r, cy + y1 * r, z2];
    };

    // glow behind the globe
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.9);
    g.addColorStop(0, hexA(accent, 0.18 + level * 0.25)); g.addColorStop(1, hexA(accent, 0));
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);

    // the globe
    const wavy = mode === 'talk' || mode === 'listen' ? level : 0.12;
    for (const p of DOTS) {
      const band = Math.sin(p[1] * 7 - t * (mode === 'talk' ? 9 : 3)) * 0.5 + Math.sin(Math.atan2(p[2], p[0]) * 5 + t * 4) * 0.5;
      const r = R * (1 + wavy * 0.16 * band + pulse * 0.04);
      const [x, y, z] = proj(p[0], p[1], p[2], r);
      const depth = (z + 1) / 2;
      ctx.fillStyle = hexA(accent, 0.12 + depth * 0.75 * (0.55 + level * 0.6));
      const s = 0.8 + depth * 1.6;
      ctx.fillRect(x - s / 2, y - s / 2, s, s);
    }
    // the lit heart
    const heart = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.45);
    heart.addColorStop(0, hexA(accent, 0.55 + level * 0.4)); heart.addColorStop(1, hexA(accent, 0));
    ctx.fillStyle = heart; ctx.beginPath(); ctx.arc(cx, cy, R * 0.45, 0, TAU); ctx.fill();

    // the brain: memory nodes on an outer shell, wired in
    hover = null;
    const shell = R * 1.55;
    const placed = nodes.map((n) => {
      const age = Math.min(1, (now - n.born) / 900);
      const wob = 1 + 0.02 * Math.sin(t * 1.3 + n.p[0] * 9);
      const [x, y, z] = proj(n.p[0], n.p[1], n.p[2], shell * wob * (0.6 + 0.4 * age));
      const [ax, ay] = proj(n.p[0], n.p[1], n.p[2], R * 1.02);
      return { n, x, y, z, ax, ay, age };
    }).sort((a, b) => a.z - b.z);
    for (const q of placed) {
      const col = q.n.kind === 'fact' ? accent : q.n.kind === 'overdue' ? hot : warm;
      const depth = (q.z + 1) / 2;
      ctx.strokeStyle = hexA(col, (0.06 + depth * 0.22) * q.age);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(q.ax, q.ay); ctx.lineTo(q.x, q.y); ctx.stroke();
      const s = (2 + depth * 3) * (q.n.kind === 'fact' ? 1 : 1.25);
      ctx.fillStyle = hexA(col, (0.3 + depth * 0.7) * q.age);
      ctx.beginPath(); ctx.arc(q.x, q.y, s, 0, TAU); ctx.fill();
      if (pointer && Math.hypot(pointer.x - q.x, pointer.y - q.y) < 14 && depth > 0.35) hover = q;
    }
    if (hover) {
      const text = hover.n.label.length > 60 ? hover.n.label.slice(0, 57) + '…' : hover.n.label;
      ctx.font = '13px ui-sans-serif, system-ui, sans-serif';
      const tw = ctx.measureText(text).width, bx = Math.min(Math.max(8, hover.x - tw / 2 - 8), w - tw - 24), by = hover.y - 34;
      ctx.fillStyle = css('--panel') || 'rgba(8,16,22,.9)'; ctx.fillRect(bx, by, tw + 16, 24);
      ctx.fillStyle = css('--text') || '#dff'; ctx.fillText(text, bx + 8, by + 16);
    }
    requestAnimationFrame(frame);
  }

  let pointer = null;
  canvas.addEventListener('pointermove', (e) => { const r = canvas.getBoundingClientRect(); pointer = { x: e.clientX - r.left, y: e.clientY - r.top }; });
  canvas.addEventListener('pointerleave', () => { pointer = null; });
  canvas.addEventListener('pointerdown', (e) => { const r = canvas.getBoundingClientRect(); pointer = { x: e.clientX - r.left, y: e.clientY - r.top }; });

  function hexA(c, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(c);
    if (!m) return c;
    const n = parseInt(m[1], 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
  }

  requestAnimationFrame(frame);
  return {
    setMode(m) { mode = m; },
    setLevel(v) { target = Math.max(target, v); },
    setMemory,
  };
}
