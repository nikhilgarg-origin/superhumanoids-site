// Scroll-scrubbed render sequences + telemetry readout.
(() => {
  const root = document.documentElement;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const mobile = matchMedia('(max-width: 720px)').matches;
  const variant = mobile ? 'm' : 'd';
  const step = mobile ? 2 : 1;          // phones get every other frame
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const smooth = t => t * t * (3 - 2 * t);
  // design variants for review: ?v=1 perception (default) · 2 cinematic · 3 kinetic type · 4 x-ray · 5 blueprint
  const V = clamp(+new URLSearchParams(location.search).get('v') || 1, 1, 5);
  root.dataset.v = V;
  const LOOK = {
    1: { edges: 'solid', joint: 'ring', labels: true },
    2: { off: true },
    3: { joint: 'dot' },
    4: { edges: 'solid', joint: 'ring', labels: true, line: 'rgba(160,190,255,.7)' },
    5: { edges: 'dashed', joint: 'cross', arcs: true, labels: true, line: 'rgba(143,176,255,.55)' },
  }[V];

  // ---------- frame sequences ----------
  // Frames arrive as compressed blobs (a few MB per sequence). Only a small window around the
  // frame on screen is decoded, off the main thread via createImageBitmap, so scrubbing never
  // waits on a decode and decoded memory stays bounded (~13 frames per active sequence).
  const WINDOW = mobile ? 5 : 6;
  const canBitmap = 'createImageBitmap' in window;
  // ImageBitmap.close() releases memory synchronously and is not cheap, so retired frames are
  // closed a couple at a time when the main thread is idle, never inside a scroll frame
  const retired = [];
  const idle = window.requestIdleCallback || (f => setTimeout(() => f({ timeRemaining: () => 8 }), 120));
  let sweeping = false;
  function retire(bmp) {
    retired.push(bmp);
    if (sweeping) return; sweeping = true;
    const sweep = dl => {
      while (retired.length && dl.timeRemaining() > 4) for (let n = 0; n < 2 && retired.length; n++) retired.shift().close?.();
      if (retired.length) idle(sweep, { timeout: 2000 }); else sweeping = false;
    };
    idle(sweep, { timeout: 2000 });
  }
  const seqs = {};
  function sequence(name, total) {
    if (seqs[name]) return seqs[name];
    const idx = [];
    for (let i = 0; i < total; i += step) idx.push(i);
    const s = { name, idx, blobs: new Array(idx.length), bmps: new Map(), pending: new Set(),
                loaded: new Uint8Array(idx.length), started: false, onload: [], center: 0, active: false, width: 0 };
    s.src = i => `assets/frames/${name}/${variant}/${String(idx[i]).padStart(4, '0')}.webp`;
    s.load = () => {
      if (s.started) return; s.started = true;
      // first, last, then coarse-to-fine so scrubbing works before everything arrives
      const order = [0, idx.length - 1];
      for (let stride = 16; stride >= 1; stride >>= 1)
        for (let i = 0; i < idx.length; i += stride) if (!order.includes(i)) order.push(i);
      let inflight = 0, k = 0;
      const pump = () => {
        while (inflight < 6 && k < order.length) {
          const i = order[k++]; inflight++;
          fetch(s.src(i)).then(r => r.ok ? r.blob() : Promise.reject(r.status)).then(b => {
            s.blobs[i] = b; s.loaded[i] = 1;
            if (Math.abs(i - s.center) <= WINDOW || i === 0) s.decode(i);
          }).catch(() => {}).finally(() => { inflight--; pump(); });
        }
      };
      pump();
    };
    s.decode = i => {
      if (s.bmps.has(i) || s.pending.has(i) || !s.blobs[i]) return;
      s.pending.add(i);
      const opts = s.width ? { resizeWidth: s.width, resizeQuality: 'medium' } : undefined;
      const job = canBitmap ? createImageBitmap(s.blobs[i], opts)
        : new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = URL.createObjectURL(s.blobs[i]); });
      job.then(bmp => {
        s.pending.delete(i);
        if (!s.active && i !== 0 && Math.abs(i - s.center) > WINDOW) { retire(bmp); return; }
        s.bmps.set(i, bmp); s.onload.forEach(f => f(i));
      }).catch(() => s.pending.delete(i));
    };
    // keep the window around `center` decoded, release everything else
    s.focus = center => {
      s.center = center;
      for (const [i, bmp] of s.bmps) if (Math.abs(i - center) > WINDOW * 2) { retire(bmp); s.bmps.delete(i); }
      for (let d = 0; d <= WINDOW; d++) { s.decode(center + d); s.decode(center - d); }
    };
    s.release = () => { for (const [i, bmp] of s.bmps) if (i !== s.center) { retire(bmp); s.bmps.delete(i); } };
    s.nearest = i => {
      for (let d = 0; d < idx.length; d++) {
        if (s.bmps.has(i - d)) return s.bmps.get(i - d);
        if (s.bmps.has(i + d)) return s.bmps.get(i + d);
      }
      return null;
    };
    return (seqs[name] = s);
  }

  // canvas sizes come from a ResizeObserver, so the render loop never reads layout
  const sizes = new WeakMap();
  const ro = new ResizeObserver(entries => { for (const e of entries) sizes.set(e.target, e.contentRect); dirty = true; });
  function fitCanvas(c, scale = 1) {
    if (!sizes.has(c)) { ro.observe(c); sizes.set(c, c.getBoundingClientRect()); }
    // never allocate more canvas than the frames can fill (1920 px desktop, 720 px phone)
    const box = sizes.get(c), cap = mobile ? 720 * 1.6 : 1920;
    const dpr = Math.min(devicePixelRatio || 1, 2, cap / Math.max(1, box.width)) * scale;
    const w = Math.round(box.width * dpr), h = Math.round(box.height * dpr);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; c._last = null; }
  }
  const XRAY = 'grayscale(1) brightness(.62) contrast(2.3) sepia(1) hue-rotate(185deg) saturate(2.4)';
  const ctxFilter = 'filter' in CanvasRenderingContext2D.prototype;
  if (ctxFilter) root.classList.add('ctx-filter');
  function draw(c, img) {
    if (!img || c._last === img) return;
    const ctx = c.getContext('2d');
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    const cw = c.width, ch = c.height, r = Math.max(cw / iw, ch / ih);
    const w = iw * r, h = ih * r;
    ctx.drawImage(img, (cw - w) / 2, (ch - h) / 2, w, h);
    c._last = img;
  }

  // ---------- perception overlay ----------
  // Joint pivots projected through the same cameras that rendered the frames (pipeline/render.py
  // --project), so the rings sit on the actual joints. Drawn on a light 2D canvas above the render.
  const FRAME_ASPECT = mobile ? 720 / 1280 : 16 / 9;
  const RIG = {
    humanoid: { edges: [[3, 0], [0, 1], [1, 2], [0, 4], [3, 4], [4, 5], [4, 6], [5, 7]], labels: [0, 1, 2] },
    quadruped: { edges: [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [0, 4], [2, 6], [4, 6]], labels: [1, 7] },
    arm: { edges: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6]], labels: [1, 3, 6] },
  };
  const deg = r => `${r >= 0 ? '' : '−'}${Math.round(Math.abs(r) * 57.2958)}°`;
  function overlay(canvas, name) {
    const o = { canvas, name, data: null, frame: -1, alpha: 0, born: 0, drawn: '' };
    fetch(`assets/frames/${name}/joints-${variant}.json`).then(r => r.json()).then(d => { o.data = d; dirty = true; }).catch(() => {});
    o.draw = (frame, alpha, now) => {
      if (!o.data) return;
      const box = sizes.get(canvas) || canvas.getBoundingClientRect();
      if (!sizes.has(canvas)) { ro.observe(canvas); sizes.set(canvas, box); }
      const dpr = Math.min(devicePixelRatio || 1, 2), W = box.width, H = box.height;
      if (canvas.width !== Math.round(W * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); o.drawn = ''; }
      // lock-on: rings settle from wide to tight, joint by joint, the first time the overlay shows
      if (alpha > 0.01 && !o.born) o.born = now;
      const t = reduced ? 1 : (now - o.born) / 700;
      const st = canvas.parentElement;
      const key = frame + '|' + alpha.toFixed(2) + '|' + (t < 1.6 ? t.toFixed(2) : 'done') + '|' + W + (V === 4 ? '|' + st._lx + ',' + st._ly : '');
      if (key === o.drawn) return;
      o.drawn = key;
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      if (alpha <= 0.01 || LOOK.off) return;
      let w, h, x0, y0;
      if (W / H > FRAME_ASPECT) { w = W; h = W / FRAME_ASPECT; x0 = 0; y0 = (H - h) / 2; }
      else { h = H; w = H * FRAME_ASPECT; x0 = (W - w) / 2; y0 = 0; }
      const pts = o.data.frames[Math.min(frame, o.data.frames.length - 1)].map(([x, y, q]) => [x0 + x * w, y0 + y * h, q]);
      o.last = pts;
      const rig = RIG[name];
      // phones stack the copy under the robot: keep the overlay out of the text block
      ctx.save();
      if (V === 4) { if (st._lx === undefined) { ctx.restore(); return; } ctx.beginPath(); ctx.arc(st._lx, st._ly, fx.R, 0, Math.PI * 2); ctx.clip(); }
      const limit = mobile ? H * 0.58 : Infinity, vis = p => p[1] < limit - 12;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 1;
      if (LOOK.edges) {
        ctx.strokeStyle = LOOK.line || 'rgba(236,235,231,.38)';
        ctx.setLineDash(LOOK.edges === 'dashed' ? [4, 4] : []);
        ctx.beginPath();
        for (const [a, b] of rig.edges) if (vis(pts[a]) && vis(pts[b])) { ctx.moveTo(pts[a][0], pts[a][1]); ctx.lineTo(pts[b][0], pts[b][1]); }
        ctx.stroke(); ctx.setLineDash([]);
      }
      pts.forEach(([x, y, q], k) => {
        if (!vis(pts[k])) return;
        const lt = clamp(t - k * 0.07), e = 1 - Math.pow(1 - lt, 3);
        ctx.globalAlpha = alpha * e;
        if (LOOK.joint === 'dot') {
          ctx.fillStyle = 'rgba(236,235,231,.9)'; ctx.beginPath(); ctx.arc(x, y, 2.5 + 4 * (1 - e), 0, Math.PI * 2); ctx.fill();
          return;
        }
        if (LOOK.joint === 'cross') {
          const r = 9 + 10 * (1 - e);
          ctx.strokeStyle = 'rgba(190,210,255,.9)'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(x - r, y); ctx.lineTo(x - 3, y); ctx.moveTo(x + 3, y); ctx.lineTo(x + r, y);
          ctx.moveTo(x, y - r); ctx.lineTo(x, y - 3); ctx.moveTo(x, y + 3); ctx.lineTo(x, y + r); ctx.stroke();
          if (LOOK.arcs) {   // the joint's current angle, swept from zero
            ctx.strokeStyle = 'rgba(84,121,234,.95)'; ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.arc(x, y, 14, -Math.PI / 2, -Math.PI / 2 + clamp(q, -Math.PI * 2, Math.PI * 2), q < 0); ctx.stroke();
          }
          return;
        }
        ctx.strokeStyle = 'rgba(236,235,231,.92)'; ctx.lineWidth = 1.25;
        ctx.beginPath(); ctx.arc(x, y, 6 + 10 * (1 - e), 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = '#5479ea';
        ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fill();
      });
      ctx.font = '500 11px "Geist Mono", ui-monospace, monospace';
      ctx.textBaseline = 'middle';
      // labels sit outboard of the body: left of centre goes left, right goes right
      const cx = pts.reduce((m, p) => m + p[0], 0) / pts.length;
      for (const k of LOOK.labels ? rig.labels : []) {
        const [x, y, q] = pts[k], lt = clamp(t - 0.5 - k * 0.05);
        if (lt <= 0 || !vis(pts[k])) continue;
        ctx.globalAlpha = alpha * lt;
        const side = x < cx ? -1 : 1, label = V === 5 ? `${o.data.labels[k]}  θ ${deg(q)}` : `${o.data.labels[k]}  ${deg(q)}`;
        const tw = ctx.measureText(label).width + 14;
        const ex = x + side * 34, ey = y - 10;
        ctx.strokeStyle = 'rgba(236,235,231,.55)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x + side * 7, y - 2); ctx.lineTo(ex, ey); ctx.stroke();
        const bx = clamp(side < 0 ? ex - tw : ex, 6, W - tw - 6);
        ctx.fillStyle = 'rgba(29,30,31,.82)';
        ctx.beginPath(); ctx.roundRect(bx, ey - 10, tw, 20, 4); ctx.fill();
        ctx.fillStyle = '#ecebe7'; ctx.fillText(label, bx + 7, ey + 0.5);
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    };
    return o;
  }

  // ---------- sections ----------
  const hero = document.querySelector('.hero');
  const bodies = document.querySelector('.bodies');
  const heroCanvas = hero.querySelector('.seq');
  const [bodyA, bodyB] = bodies.querySelectorAll('.seq');
  const heroOv = overlay(hero.querySelector('.overlay'), 'humanoid');
  const bodiesOvCanvas = bodies.querySelector('.overlay');
  const quadOv = overlay(bodiesOvCanvas, 'quadruped'), armOv = overlay(bodiesOvCanvas, 'arm');
  let readyAt = 0;

  // ---------- variant staging ----------
  const heroStage = hero.querySelector('.stage'), bodiesStage = bodies.querySelector('.stage');
  const add = (parent, cls, tag = 'div', before = null) => { const el = document.createElement(tag); el.className = cls; el.setAttribute('aria-hidden', 'true'); parent.insertBefore(el, before); return el; };
  const fx = {};
  if (V === 2) {        // cinematic: letterbox opens with the scroll, the camera pushes in, cuts dip to black
    fx.bars = [heroStage, bodiesStage].map(st => [add(st, 'bar top'), add(st, 'bar bottom')]);
    fx.dip = add(bodiesStage, 'dip', 'div', bodiesStage.querySelector('.scrim'));
  }
  if (V === 3) fx.word = add(bodiesStage, 'bigword', 'div', bodiesStage.querySelector('.overlay'));
  if (V === 4) {        // x-ray lens: an inverted copy of the frame plus the skeleton, inside a circle
    // the lens is its own small canvas: only the pixels inside the circle are ever filtered
    for (const st of [heroStage, bodiesStage]) st._lens = add(st, 'lens', 'canvas', st.querySelector('.overlay'));
    fx.pointer = 0;
    // write the lens straight onto its three layers (not via an inherited CSS variable, which
    // would restyle every child of the stage on each move), and only when it actually moves
    const R = mobile ? 100 : 150;
    fx.moveLens = (st, x, y) => {
      if (st._lx !== undefined && Math.abs(st._lx - x) < 0.5 && Math.abs(st._ly - y) < 0.5) return;
      st._lx = x; st._ly = y;
      st._lens.style.transform = `translate(${(x - R).toFixed(1)}px, ${(y - R).toFixed(1)}px)`;
      st._lensDirty = true; dirty = true;
    };
    fx.R = R;
    // copy the circle of the frame under the lens into the lens canvas, filtered
    fx.paintLens = (st, img) => {
      if (!img || st._lx === undefined || (!st._lensDirty && st._lensImg === img)) return;
      st._lensDirty = false; st._lensImg = img;
      const c = st._lens, dpr = Math.min(devicePixelRatio || 1, 2), size = 2 * R;
      if (c.width !== size * dpr) { c.width = c.height = size * dpr; }
      const box = sizes.get(st.querySelector('.seq')); if (!box) return;
      const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
      const r = Math.max(box.width / iw, box.height / ih), ox = (box.width - iw * r) / 2, oy = (box.height - ih * r) / 2;
      const ctx = c.getContext('2d');
      if (ctxFilter) ctx.filter = XRAY;
      ctx.drawImage(img, (st._lx - R - ox) / r, (st._ly - R - oy) / r, size / r, size / r, 0, 0, c.width, c.height);
    };
    for (const st of [heroStage, bodiesStage]) st.addEventListener('pointermove', e => {
      if (e.pointerType !== 'mouse') return;
      fx.pointer = performance.now(); fx.moveLens(st, e.clientX, e.clientY);
    }, { passive: true });
  }
  const heroCopy = hero.querySelector('.hero-copy');
  const heroTitle = hero.querySelector('.hero-title');
  const cue = hero.querySelector('.scroll-cue');
  const humanoid = sequence('humanoid', +hero.dataset.frames);
  const quadruped = sequence('quadruped', +bodies.dataset.frames);
  const arm = sequence('arm', +bodies.dataset.frames);
  const bodyItems = [...bodies.querySelectorAll('.body-list li')];
  const rail = bodies.querySelector('.body-rail i');
  const nav = document.querySelector('.nav');

  humanoid.onload.push(i => { if (i === 0) { requestAnimationFrame(() => root.classList.add('ready')); quadruped.load(); arm.load(); } dirty = true; });
  quadruped.onload.push(() => (dirty = true));
  arm.onload.push(() => (dirty = true));
  humanoid.load();
  // reveal the page even if frames are slow to arrive
  setTimeout(() => root.classList.add('ready'), 1800);

  // telemetry: joint angles exported from the same MuJoCo motion that drove the render
  const tele = { data: null, cells: [...hero.querySelectorAll('[data-j]')], clock: hero.querySelector('[data-clock]') };
  fetch('assets/frames/humanoid/telemetry.json').then(r => r.json()).then(d => { tele.data = d; dirty = true; }).catch(() => {});

  const progress = el => {
    const r = el.getBoundingClientRect();
    return clamp(-r.top / (r.height - innerHeight));
  };

  // Scroll progress per stage, from GSAP ScrollTrigger. Without GSAP, read the rects directly.
  const st = { hero: 0, bodies: 0 };
  const pins = [];
  const hasGsap = !!(window.gsap && window.ScrollTrigger);
  if (hasGsap) {
    gsap.registerPlugin(ScrollTrigger);
    for (const [key, el] of [['hero', hero], ['bodies', bodies]]) {
      gsap.to(st, {
        [key]: 1, ease: 'none', onUpdate: () => (dirty = true),
        // Lenis already smooths the scroll; a second catch-up here only adds latency
        scrollTrigger: { trigger: el, start: 'top top', end: 'bottom bottom', scrub: true },
      });
      pins.push(ScrollTrigger.create({ trigger: el, start: 'top top', end: 'bottom bottom', onToggle: () => (dirty = true) }));
    }
  }

  // decode windows exist only for stages near the viewport
  let heroLive = true, bodiesLive = false;
  const liveIO = new IntersectionObserver(es => es.forEach(e => {
    const on = e.isIntersecting;
    if (e.target === hero) { heroLive = on; humanoid.active = on; if (!on) humanoid.release(); }
    else { bodiesLive = on; quadruped.active = arm.active = on; if (!on) { quadruped.release(); arm.release(); } }
    dirty = true;
  }), { rootMargin: '50% 0px' });
  liveIO.observe(hero); liveIO.observe(bodies);

  // reading pace: the problem statement brightens word by word as it passes through the viewport
  const big = document.querySelector('.problem .big');
  const words = [];
  if (big && hasGsap && !reduced) {
    big.setAttribute('aria-label', big.textContent);
    big.innerHTML = big.textContent.trim().split(/\s+/).map(t => `<span class="w" aria-hidden="true">${t}</span>`).join(' ');
    words.push(...big.querySelectorAll('.w'));
    let lit = -1;
    const paint = p => {
      const n = Math.round(p * words.length);
      if (n === lit) return;
      words.forEach((el, k) => { el.style.opacity = k < n ? 1 : 0.22; });
      lit = n;
    };
    paint(0);
    ScrollTrigger.create({ trigger: big, start: 'top 80%', end: 'bottom 45%', onUpdate: self => paint(self.progress) });
  }

  // roadmap: the line draws with the scroll and each milestone lights as the line reaches it
  const timeline = document.querySelector('.timeline');
  if (timeline && hasGsap) {
    const track = timeline.querySelector('.track'), stops = [...timeline.querySelectorAll('li:not(.track)')];
    const vertical = () => matchMedia('(max-width: 900px)').matches;
    const set = p => {
      track.style.transform = vertical() ? `scaleY(${p})` : `scaleX(${p})`;
      stops.forEach((li, k) => li.classList.toggle('is-reached', p >= k / stops.length + 0.02 || (k === 0 && p > 0.01)));
    };
    set(reduced ? 1 : 0);
    if (!reduced) ScrollTrigger.create({ trigger: timeline, start: 'top 75%', end: 'bottom 55%', onUpdate: self => set(self.progress) });
  }

  // nav: a hairline slides under the section you are in
  const navLinks = [...document.querySelectorAll('.nav nav a')], navMark = document.querySelector('.nav-mark');
  if (hasGsap && navMark) {
    const mark = a => {
      navLinks.forEach(l => l === a ? l.setAttribute('aria-current', 'true') : l.removeAttribute('aria-current'));
      if (!a) { navMark.style.opacity = 0; return; }
      navMark.style.opacity = 1;
      navMark.style.transform = `translateX(${a.offsetLeft}px) scaleX(${a.offsetWidth})`;
    };
    navLinks.forEach(a => {
      const sec = document.querySelector(a.getAttribute('href'));
      if (sec) ScrollTrigger.create({ trigger: sec, start: 'top 50%', end: 'bottom 50%', onToggle: self => self.isActive ? mark(a) : (a.hasAttribute('aria-current') && mark(null)) });
    });
  }

  // review switcher, only on URLs that carry ?v=
  if (new URLSearchParams(location.search).has('v')) {
    const names = ['Perception', 'Cinematic', 'Kinetic type', 'X-ray', 'Blueprint'];
    const bar = document.createElement('nav'); bar.className = 'variants'; bar.setAttribute('aria-label', 'Design variants');
    bar.innerHTML = names.map((n, i) => `<a href="?v=${i + 1}"${i + 1 === V ? ' aria-current="true"' : ''}>${i + 1}<span>${n}</span></a>`).join('');
    document.body.append(bar);
  }

  let dirty = true, lastFrame = -1, bodyOn = 0;
  function render() {
    if (!hasGsap) { st.hero = progress(hero); st.bodies = progress(bodies); }
    // hero
    const ph = st.hero;
    const fh = Math.round(ph * (humanoid.idx.length - 1));
    fitCanvas(heroCanvas);
    humanoid.width = Math.min(heroCanvas.width, 1920);
    if (heroLive) humanoid.focus(fh);
    draw(heroCanvas, humanoid.nearest(fh));
    if (V === 4) fx.paintLens(heroStage, humanoid.nearest(fh));
    if (V === 2) {
      const open = reduced ? 1 : smooth(clamp(ph / 0.16));
      fx.bars[0].forEach(b => (b.style.transform = `scaleY(${1 - open})`));
      heroCanvas.style.transform = `scale(${1.0 + 0.07 * ph})`;
    }
    if (V === 3) heroTitle.style.fontWeight = Math.round(300 + 400 * smooth(clamp(ph / 0.42)));
    const fade = smooth(clamp((ph - 0.42) / 0.3));
    heroCopy.style.opacity = 1 - fade;
    heroCopy.style.transform = `translateY(${-fade * 40}px)`;
    heroCopy.style.visibility = fade >= 1 ? 'hidden' : '';
    cue.style.opacity = 1 - clamp(ph * 8);
    cue.style.animationPlayState = ph > 0.13 ? 'paused' : 'running';
    if (tele.data && fh !== lastFrame) {
      const src = humanoid.idx[fh];
      tele.cells.forEach(dd => { const v = tele.data.joints[dd.dataset.j]?.[src]; if (v != null) dd.textContent = (v >= 0 ? '+' : '−') + String(Math.round(Math.abs(v) * 57.2958)).padStart(2, '0') + '°'; });
      tele.clock.textContent = `t ${(src / tele.data.fps).toFixed(2)} s`;
      lastFrame = fh;
    }

    // bodies: first half quadruped, second half arm, crossfade in the middle
    const pb = st.bodies;
    const a = clamp(pb / 0.5), b = clamp((pb - 0.5) / 0.5);
    fitCanvas(bodyA); fitCanvas(bodyB);
    quadruped.width = arm.width = Math.min(bodyA.width, 1920);
    const fa = Math.round(a * (quadruped.idx.length - 1)), fb = Math.round(b * (arm.idx.length - 1));
    if (bodiesLive) { quadruped.focus(fa); if (pb > 0.3) arm.focus(fb); }
    if (pb < 0.53) draw(bodyA, quadruped.nearest(fa));
    if (pb > 0.47) draw(bodyB, arm.nearest(fb));
    if (V === 4) fx.paintLens(bodiesStage, pb < 0.5 ? quadruped.nearest(fa) : arm.nearest(fb));
    if (V === 2) {
      const open = reduced ? 1 : smooth(clamp(pb / 0.06));
      fx.bars[1].forEach(b => (b.style.transform = `scaleY(${1 - open})`));
      const local = pb < 0.5 ? pb / 0.5 : (pb - 0.5) / 0.5;
      bodyA.style.transform = bodyB.style.transform = `scale(${1.0 + 0.06 * local})`;
    }
    if (V === 3) {
      const name = pb < 0.5 ? 'Quadruped' : 'Arm';
      if (fx.word.textContent !== name) fx.word.textContent = name;
      const local = pb < 0.5 ? pb / 0.5 : (pb - 0.5) / 0.5;
      fx.word.style.transform = `translateX(${(4 - 8 * local).toFixed(2)}vw)`;
    }
    // tight crossfade bridged by a brief blur, so the two scenes never sit in a double exposure
    const x = clamp((pb - 0.47) / 0.06), haze = Math.sin(Math.PI * x);
    bodyB.style.opacity = smooth(x);
    const blur = reduced || haze < 0.01 || V === 2 ? '' : `blur(${(haze * 10).toFixed(1)}px)`;
    if (V === 2) { fx.dip.style.opacity = haze; bodyB.style.opacity = x < 0.5 ? 0 : 1; }
    if (bodyA.style.filter !== blur) bodyA.style.filter = bodyB.style.filter = blur;
    const on = pb < 0.5 ? 0 : 1;
    if (on !== bodyOn) { bodyItems[bodyOn].classList.remove('is-on'); bodyItems[on].classList.add('is-on'); bodyOn = on; }
    rail.style.transform = `scaleX(${pb})`;

    // perception overlays: hero locks on after the intro and clears as the stage ends
    const now = performance.now();
    if (!readyAt && root.classList.contains('ready')) readyAt = now;
    // rings lock on as the boot scan line clears the head (~1.5 s after the lights start)
    const heroA = readyAt && (reduced || now - readyAt > 1500) ? 1 - smooth(clamp((ph - 0.9) / 0.1)) : 0;
    if (heroLive) heroOv.draw(fh, heroA, now);
    if (bodiesLive) {
      const ov = pb < 0.5 ? quadOv : armOv, other = ov === quadOv ? armOv : quadOv;
      other.drawn = '';
      ov.draw(pb < 0.5 ? fa : fb, 1 - haze, now);
    }
    if (V === 4 && now - fx.pointer > 2500) {    // no mouse: the lens rides the wrist / knee / flange
      const follow = (st, ov, k) => { const p = ov.last && ov.last[k]; if (p) fx.moveLens(st, p[0], p[1]); };
      follow(heroStage, heroOv, 1); follow(bodiesStage, pb < 0.5 ? quadOv : armOv, pb < 0.5 ? 1 : 5);
    }
    const settling = o => o.born && now - o.born < 1600;
    if ((readyAt && !heroOv.born && heroLive) || settling(heroOv) || settling(quadOv) || settling(armOv)) dirty = true;

    // nav sits on the render while a stage is pinned, gets a backing over regular content
    const pinned = hasGsap ? pins.some(p => p.isActive)
      : [hero, bodies].some(s => { const r = s.getBoundingClientRect(); return r.top <= 0 && r.bottom >= innerHeight; });
    nav.classList.toggle('solid', !pinned && scrollY > 8);
  }

  // ---------- live simulation, loaded on request ----------
  const live = document.querySelector('[data-sim]');
  live.querySelector('[data-sim-start]').addEventListener('click', async ev => {
    const btn = ev.currentTarget, note = live.querySelector('[data-sim-note]');
    btn.disabled = true; btn.textContent = 'Loading physics…';
    try {
      const { startSim } = await import('./sim.js');
      await startSim(live, { onProgress: p => { btn.textContent = `Loading physics… ${Math.round(p * 100)}%`; } });
      live.classList.add('is-live');
      live.querySelector('.live-ui').hidden = false;
    } catch (err) {
      console.error(err);
      btn.disabled = false; btn.textContent = 'Try again';
      note.textContent = 'The simulation could not start in this browser. Try a recent desktop browser; the renders above show the same robots.';
    }
  });

  function loop() {
    if (dirty) { dirty = false; render(); }
    requestAnimationFrame(loop);
  }
  addEventListener('scroll', () => (dirty = true), { passive: true });
  addEventListener('resize', () => (dirty = true));

  if (!reduced && window.Lenis) {
    const lenis = new Lenis({ lerp: 0.09, smoothWheel: true, anchors: true });
    lenis.on('scroll', () => (dirty = true));
    window.__lenis = lenis;
    if (hasGsap) {
      // one clock for both: Lenis advances on GSAP's ticker and ScrollTrigger reads every Lenis frame
      lenis.on('scroll', ScrollTrigger.update);
      gsap.ticker.add(t => lenis.raf(t * 1000));
      gsap.ticker.lagSmoothing(0);
    } else {
      const raf = t => { lenis.raf(t); requestAnimationFrame(raf); };
      requestAnimationFrame(raf);
    }
  }
  loop();
})();
