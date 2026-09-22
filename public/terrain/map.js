/**
 * A small slippy map, no library: image tiles in layers, a canvas for
 * drawn overlays, and an SVG on top for the route. Drag to pan, wheel or
 * pinch to zoom, +/− buttons. Fractional zoom: tiles come from the nearest
 * whole level and are scaled.
 *
 * Coordinates: "world" is Web Mercator in 0..1 on both axes.
 */

import { mx, my, unmx, unmy } from './dem.js';

const TILE = 256;

export class SlippyMap {
  /**
   * el: container. layers: [{ id, url(z, x, y) -> string|null, minZ, maxZ, opacity, visible }]
   */
  constructor(el, { center = { lat: 63, lon: 12 }, zoom = 11, minZoom = 9, maxZoom = 16.5, layers = [] } = {}) {
    this.el = el;
    this.minZoom = minZoom;
    this.maxZoom = maxZoom;
    this.cx = mx(center.lon);
    this.cy = my(center.lat);
    this.zoom = zoom;
    this.layers = layers.map((l) => ({ opacity: 1, visible: true, minZ: 9, maxZ: 16, ...l, imgs: new Map() }));
    this.handlers = { click: new Set(), move: new Set(), hover: new Set() };

    el.classList.add('slippy');
    this.tileRoot = document.createElement('div');
    this.tileRoot.className = 'slippy-tiles';
    el.appendChild(this.tileRoot);
    for (const l of this.layers) {
      l.div = document.createElement('div');
      l.div.className = 'slippy-layer';
      l.div.dataset.layer = l.id;
      this.tileRoot.appendChild(l.div);
    }
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'slippy-canvas';
    el.appendChild(this.canvas);
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'slippy-svg');
    el.appendChild(this.svg);

    this.canvasPainters = [];
    this.svgPainters = [];
    this.bindInput();
    new ResizeObserver(() => this.render()).observe(el);
    this.render();
  }

  on(ev, fn) { this.handlers[ev].add(fn); return () => this.handlers[ev].delete(fn); }
  emit(ev, arg) { for (const fn of this.handlers[ev]) fn(arg); }

  get W() { return this.el.clientWidth; }
  get H() { return this.el.clientHeight; }
  get scale() { return TILE * 2 ** this.zoom; }

  /** lat/lon -> screen pixels */
  project(lat, lon) {
    return [(mx(lon) - this.cx) * this.scale + this.W / 2, (my(lat) - this.cy) * this.scale + this.H / 2];
  }
  unproject(x, y) {
    return { lat: unmy(this.cy + (y - this.H / 2) / this.scale), lon: unmx(this.cx + (x - this.W / 2) / this.scale) };
  }
  bounds() {
    const nw = this.unproject(0, 0), se = this.unproject(this.W, this.H);
    return { north: nw.lat, west: nw.lon, south: se.lat, east: se.lon };
  }
  center() { return { lat: unmy(this.cy), lon: unmx(this.cx) }; }

  setView(center, zoom = this.zoom) {
    this.cx = mx(center.lon);
    this.cy = my(center.lat);
    this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, zoom));
    this.render();
  }
  /** Frame a set of points with some padding. */
  fit(points, pad = 48, maxZoom = 15) {
    if (!points.length) return;
    const xs = points.map((p) => mx(p.lon)), ys = points.map((p) => my(p.lat));
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const zx = Math.log2((this.W - 2 * pad) / (Math.max(maxX - minX, 1e-7) * TILE));
    const zy = Math.log2((this.H - 2 * pad) / (Math.max(maxY - minY, 1e-7) * TILE));
    this.cx = (minX + maxX) / 2;
    this.cy = (minY + maxY) / 2;
    this.zoom = Math.max(this.minZoom, Math.min(maxZoom, Math.min(zx, zy)));
    this.render();
  }
  zoomAt(factorLog2, sx = this.W / 2, sy = this.H / 2) {
    const before = this.unproject(sx, sy);
    this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom + factorLog2));
    // keep the point under the cursor still
    this.cx = mx(before.lon) - (sx - this.W / 2) / this.scale;
    this.cy = my(before.lat) - (sy - this.H / 2) / this.scale;
    this.render();
  }

  setLayer(id, patch) {
    const l = this.layers.find((x) => x.id === id);
    if (!l) return;
    Object.assign(l, patch);
    if (patch.url) { l.div.textContent = ''; l.imgs.clear(); }
    this.render();
  }

  /** Painters draw on the canvas / SVG after every render. */
  addCanvasPainter(fn) { this.canvasPainters.push(fn); this.render(); }
  addSvgPainter(fn) { this.svgPainters.push(fn); this.render(); }

  requestRender() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = null; this.render(); });
  }

  render() {
    const W = this.W, H = this.H;
    if (!W || !H) return;
    for (const l of this.layers) this.renderLayer(l);

    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(W * dpr) || this.canvas.height !== Math.round(H * dpr)) {
      this.canvas.width = Math.round(W * dpr);
      this.canvas.height = Math.round(H * dpr);
    }
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    for (const p of this.canvasPainters) p(ctx, this);

    this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    this.svg.setAttribute('width', W);
    this.svg.setAttribute('height', H);
    this.svg.innerHTML = this.svgPainters.map((p) => p(this)).join('');
    this.emit('move', this);
  }

  /** Which whole-level tiles cover the view. */
  visibleTiles(minZ = 0, maxZ = 20) {
    const z = Math.max(minZ, Math.min(maxZ, Math.round(this.zoom)));
    const n = 2 ** z;
    const s = this.scale / (TILE * n); // screen px per tile px
    const x0 = Math.floor((this.cx - this.W / 2 / this.scale) * n), x1 = Math.floor((this.cx + this.W / 2 / this.scale) * n);
    const y0 = Math.floor((this.cy - this.H / 2 / this.scale) * n), y1 = Math.floor((this.cy + this.H / 2 / this.scale) * n);
    const out = [];
    for (let x = Math.max(0, x0); x <= Math.min(n - 1, x1); x++) {
      for (let y = Math.max(0, y0); y <= Math.min(n - 1, y1); y++) {
        out.push({ z, x, y, sx: (x / n - this.cx) * this.scale + this.W / 2, sy: (y / n - this.cy) * this.scale + this.H / 2, size: TILE * s });
      }
    }
    return out;
  }

  renderLayer(l) {
    l.div.style.opacity = l.opacity;
    l.div.hidden = !l.visible;
    if (!l.visible || this.zoom < l.minZ - 0.5) {
      l.div.hidden = true;
      return;
    }
    const want = new Set();
    for (const t of this.visibleTiles(l.minZ, l.maxZ)) {
      const url = l.url(t.z, t.x, t.y);
      if (!url) continue;
      want.add(url);
      let img = l.imgs.get(url);
      if (!img) {
        img = new Image();
        img.decoding = 'async';
        img.alt = '';
        img.draggable = false;
        img.onerror = () => { img.style.visibility = 'hidden'; img.dataset.failed = '1'; };
        img.onload = () => { img.dataset.loaded = '1'; };
        img.src = url;
        l.imgs.set(url, img);
        l.div.appendChild(img);
      }
      img.style.transform = `translate(${t.sx.toFixed(1)}px, ${t.sy.toFixed(1)}px)`;
      img.style.width = img.style.height = `${(t.size + 0.5).toFixed(1)}px`;
    }
    for (const [url, img] of l.imgs) {
      if (!want.has(url)) { img.remove(); l.imgs.delete(url); }
    }
  }

  /* -------------------------- input -------------------------- */

  bindInput() {
    const el = this.el;
    const pts = new Map();
    let drag = null, pinch = null, downAt = null;

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      if (e.target.closest?.('[data-grab]')) return; // route handles manage themselves
      el.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      downAt = { x: e.clientX, y: e.clientY, t: Date.now(), moved: false };
      if (pts.size === 1) drag = { x: e.clientX, y: e.clientY, cx: this.cx, cy: this.cy };
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        const r = el.getBoundingClientRect();
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), zoom: this.zoom, mid: [(a[0] + b[0]) / 2 - r.left, (a[1] + b[1]) / 2 - r.top] };
        drag = null;
      }
    });
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      if (!pts.has(e.pointerId)) {
        this.emit('hover', { ...this.unproject(e.clientX - r.left, e.clientY - r.top), x: e.clientX - r.left, y: e.clientY - r.top });
        return;
      }
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) downAt.moved = true;
      if (pinch && pts.size === 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        const target = pinch.zoom + Math.log2(d / pinch.d);
        this.zoomAt(target - this.zoom, pinch.mid[0], pinch.mid[1]);
      } else if (drag) {
        this.cx = drag.cx - (e.clientX - drag.x) / this.scale;
        this.cy = drag.cy - (e.clientY - drag.y) / this.scale;
        this.requestRender();
      }
    });
    const end = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (pts.size === 0) {
        if (downAt && !downAt.moved && Date.now() - downAt.t < 600 && e.type === 'pointerup') {
          const r = el.getBoundingClientRect();
          const x = e.clientX - r.left, y = e.clientY - r.top;
          this.emit('click', { ...this.unproject(x, y), x, y });
        }
        drag = null;
        downAt = null;
      } else if (pts.size === 1) {
        const [p] = [...pts.values()];
        drag = { x: p[0], y: p[1], cx: this.cx, cy: this.cy };
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const step = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      this.zoomAt(-step / 400, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
  }
}
