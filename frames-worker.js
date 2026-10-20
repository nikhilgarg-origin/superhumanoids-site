// Frame player worker. Owns the scroll-sequence canvases (OffscreenCanvas): fetches the compressed
// frames, decodes a small window around the frame on screen, draws it, and frees what scrolls away.
// The main thread only posts "show frame N", so scrolling never waits on a decode, draw or free.
let WINDOW = 6;
const seqs = new Map();   // name -> { urls, blobs, bmps, pending, center, width, active, started }
const views = new Map();  // id -> { canvas, ctx, name, frame, drawn }

function seq(name) { return seqs.get(name); }

function load(s) {
  if (s.started) return; s.started = true;
  const n = s.urls.length;
  // first, last, then coarse-to-fine so scrubbing works before everything arrives
  const order = [0, n - 1];
  for (let stride = 16; stride >= 1; stride >>= 1)
    for (let i = 0; i < n; i += stride) if (!order.includes(i)) order.push(i);
  let inflight = 0, k = 0;
  const pump = () => {
    while (inflight < 4 && k < order.length) {
      const i = order[k++]; inflight++;
      fetch(s.urls[i]).then(r => r.ok ? r.blob() : Promise.reject(r.status)).then(b => {
        s.blobs[i] = b;
        if (i === 0 || Math.abs(i - s.center) <= WINDOW) decode(s, i);
      }).catch(() => {}).finally(() => { inflight--; pump(); });
    }
  };
  pump();
}

function decode(s, i) {
  if (i < 0 || i >= s.urls.length || s.bmps.has(i) || s.pending.has(i) || !s.blobs[i]) return;
  s.pending.add(i);
  const opts = s.width ? { resizeWidth: s.width, resizeQuality: 'medium' } : undefined;
  createImageBitmap(s.blobs[i], opts).then(bmp => {
    s.pending.delete(i);
    if (i !== 0 && (!s.active || Math.abs(i - s.center) > WINDOW * 2)) { bmp.close(); return; }
    s.bmps.set(i, bmp);
    if (i === 0) postMessage({ type: 'first', name: s.name });
    for (const v of views.values()) if (v.name === s.name) paint(v);
  }).catch(() => s.pending.delete(i));
}

function focus(s, center) {
  s.center = center;
  for (const [i, bmp] of s.bmps) if (i !== 0 && Math.abs(i - center) > WINDOW * 2) { bmp.close(); s.bmps.delete(i); }
  for (let d = 0; d <= WINDOW; d++) { decode(s, center + d); decode(s, center - d); }
}

function nearest(s, i) {
  for (let d = 0; d < s.urls.length; d++) {
    if (s.bmps.has(i - d)) return s.bmps.get(i - d);
    if (s.bmps.has(i + d)) return s.bmps.get(i + d);
  }
  return null;
}

function paint(v) {
  const s = v.name && seq(v.name);
  if (!s || !v.canvas.width) return;
  const img = nearest(s, v.frame);
  if (!img || img === v.drawn) return;
  const cw = v.canvas.width, ch = v.canvas.height, r = Math.max(cw / img.width, ch / img.height);
  const w = img.width * r, h = img.height * r;
  v.ctx.drawImage(img, (cw - w) / 2, (ch - h) / 2, w, h);
  v.drawn = img;
}

self.onmessage = ({ data: m }) => {
  if (m.type === 'config') WINDOW = m.window;
  else if (m.type === 'seq') seqs.set(m.name, { name: m.name, urls: m.urls, blobs: [], bmps: new Map(), pending: new Set(), center: 0, width: 0, active: true, started: false });
  else if (m.type === 'load') load(seq(m.name));
  else if (m.type === 'view') views.set(m.id, { canvas: m.canvas, ctx: m.canvas.getContext('2d', { alpha: false }), name: null, frame: 0, drawn: null });
  else if (m.type === 'size') { const v = views.get(m.id); v.canvas.width = m.w; v.canvas.height = m.h; v.drawn = null; paint(v); }
  else if (m.type === 'show') {
    const v = views.get(m.id), s = seq(m.name);
    v.name = m.name; v.frame = m.frame; s.active = true;
    if (m.width) s.width = m.width;
    focus(s, m.frame); paint(v);
  } else if (m.type === 'sleep') {             // stage scrolled far away: keep only frame 0 decoded
    const s = seq(m.name); s.active = false;
    for (const [i, bmp] of s.bmps) if (i !== 0) { bmp.close(); s.bmps.delete(i); }
  }
};
