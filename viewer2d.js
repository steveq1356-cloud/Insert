/* InsertPress Planner — 2D top view.
 * Used when Three.js can't load (offline, blocked CDN). Same interface as IP.Viewer.
 */
(function (root) {
  'use strict';
  const IP = (root.IP = root.IP || {});

  class Viewer2D {
    constructor(el, handlers) {
      this.el = el;
      this.h = handlers || {};
      this.bed = { x: 200, y: 200 };
      this.holes = [];
      this.path = null;
      this.pathVisible = true;
      this.view = { k: 2, ox: 60, oy: 400 };
      const c = (this.canvas = document.createElement('canvas'));
      c.style.display = 'block';
      c.style.touchAction = 'none';
      el.appendChild(c);
      this.ctx = c.getContext('2d');

      let drag = null;
      c.addEventListener('pointerdown', (e) => {
        drag = { x: e.clientX, y: e.clientY, ox: this.view.ox, oy: this.view.oy, moved: 0 };
        c.setPointerCapture(e.pointerId);
      });
      c.addEventListener('pointermove', (e) => {
        if (drag) {
          drag.moved = Math.max(drag.moved, Math.hypot(e.clientX - drag.x, e.clientY - drag.y));
          if (drag.moved > 4) {
            this.view.ox = drag.ox + (e.clientX - drag.x);
            this.view.oy = drag.oy + (e.clientY - drag.y);
            this.draw();
          }
          return;
        }
        this._hover(e);
      });
      c.addEventListener('pointerup', (e) => {
        if (drag && drag.moved <= 4) this._pick(e);
        drag = null;
      });
      c.addEventListener('pointerleave', () => { if (this._hoverId != null) { this._hoverId = null; this.h.onHover && this.h.onHover(null); } });
      c.addEventListener('wheel', (e) => {
        e.preventDefault();
        const r = c.getBoundingClientRect();
        const mx = e.clientX - r.left, my = e.clientY - r.top;
        const f = Math.exp(-e.deltaY * 0.0015);
        const k = Math.min(60, Math.max(0.3, this.view.k * f));
        const real = k / this.view.k;
        this.view.ox = mx - (mx - this.view.ox) * real;
        this.view.oy = my - (my - this.view.oy) * real;
        this.view.k = k;
        this.draw();
      }, { passive: false });

      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(el);
      this.resize();
    }

    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.w = this.el.clientWidth || 1;
      this.hgt = this.el.clientHeight || 1;
      this.canvas.width = this.w * dpr;
      this.canvas.height = this.hgt * dpr;
      this.canvas.style.width = this.w + 'px';
      this.canvas.style.height = this.hgt + 'px';
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.frame();
    }

    setBed(x, y) { this.bed = { x, y }; this.draw(); }

    setPart(positions, size) {
      this.size = size;
      this.up = [];
      this.tris = positions;
      if (positions) {
        const P = positions, n = P.length / 9;
        for (let t = 0; t < n; t++) {
          const b = t * 9;
          const ux = P[b + 3] - P[b], uy = P[b + 4] - P[b + 1], uz = P[b + 5] - P[b + 2];
          const vx = P[b + 6] - P[b], vy = P[b + 7] - P[b + 1], vz = P[b + 8] - P[b + 2];
          const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
          const l = Math.hypot(nx, ny, nz);
          if (!l || nz / l < 0.3) continue;
          this.up.push({ b, z: (P[b + 2] + P[b + 5] + P[b + 8]) / 3, nz: nz / l });
        }
        this.up.sort((a, b) => a.z - b.z);
      }
      this.frame();
    }

    setHoles(holes) { this.holes = holes; this.draw(); }
    setPath(pts) { this.path = pts; this.draw(); }
    setPathVisible(v) { this.pathVisible = v; this.draw(); }

    frame() {
      const s = this.size || { x: this.bed.x, y: this.bed.y };
      // fit the part plus a little of the fence, leaving room for the toolbars
      const x0 = -10, y0 = -10, x1 = Math.max(s.x, 20) + 6, y1 = Math.max(s.y, 20) + 6;
      const padX = 60, padTop = 70, padBot = 50;
      const k = Math.min((this.w - padX * 2) / (x1 - x0), (this.hgt - padTop - padBot) / (y1 - y0));
      this.view.k = Math.max(0.3, k);
      this.view.ox = (this.w - (x1 - x0) * this.view.k) / 2 - x0 * this.view.k;
      this.view.oy = padTop + ((this.hgt - padTop - padBot) + (y1 - y0) * this.view.k) / 2 + y0 * this.view.k;
      this._framed = this.w > 1;
      this.draw();
    }

    sx(x) { return this.view.ox + x * this.view.k; }
    sy(y) { return this.view.oy - y * this.view.k; }
    wx(px) { return (px - this.view.ox) / this.view.k; }
    wy(py) { return (this.view.oy - py) / this.view.k; }

    draw() {
      const c = this.ctx;
      if (!c) return;
      c.clearRect(0, 0, this.w, this.hgt);
      const k = this.view.k;
      // bed
      c.fillStyle = 'rgba(255,255,255,0.03)';
      c.fillRect(this.sx(0), this.sy(this.bed.y), this.bed.x * k, this.bed.y * k);
      const step = k > 4 ? 5 : 10;
      c.lineWidth = 1;
      for (let i = 0; i <= this.bed.x; i += step) {
        c.strokeStyle = i % 50 === 0 ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.05)';
        c.beginPath(); c.moveTo(Math.round(this.sx(i)) + 0.5, this.sy(0)); c.lineTo(Math.round(this.sx(i)) + 0.5, this.sy(this.bed.y)); c.stroke();
      }
      for (let j = 0; j <= this.bed.y; j += step) {
        c.strokeStyle = j % 50 === 0 ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.05)';
        c.beginPath(); c.moveTo(this.sx(0), Math.round(this.sy(j)) + 0.5); c.lineTo(this.sx(this.bed.x), Math.round(this.sy(j)) + 0.5); c.stroke();
      }
      // fence
      c.fillStyle = '#7d888d';
      const fw = Math.max(5, Math.min(12, 3 * k));
      const fl = Math.min(80, Math.max(this.size ? Math.max(this.size.x, this.size.y) : 80, 20) + 12);
      c.fillRect(this.sx(0) - fw, this.sy(fl), fw, fl * k + fw);
      c.fillRect(this.sx(0) - fw, this.sy(0), fl * k + fw, fw);

      // part, painted low to high; runs of equal shade share one path so no seams show
      if (this.tris && this.up.length) {
        const P = this.tris, zt = Math.max(this.size.z, 0.001);
        let cur = null;
        const flush = () => { if (cur) { c.fillStyle = cur; c.fill(); c.strokeStyle = cur; c.lineWidth = 0.6; c.stroke(); } };
        for (const t of this.up) {
          const b = t.b;
          const v = 150 + Math.round(70 * (t.z / zt)) - Math.round((1 - t.nz) * 50);
          const col = `rgb(${v},${v + 4},${v + 6})`;
          if (col !== cur) { flush(); cur = col; c.beginPath(); }
          c.moveTo(this.sx(P[b]), this.sy(P[b + 1]));
          c.lineTo(this.sx(P[b + 3]), this.sy(P[b + 4]));
          c.lineTo(this.sx(P[b + 6]), this.sy(P[b + 7]));
          c.closePath();
        }
        flush();
      }

      // path
      if (this.path && this.pathVisible && this.path.length > 1) {
        c.save();
        c.strokeStyle = '#e8743f'; c.lineWidth = 1.6; c.setLineDash([6, 4]);
        c.beginPath();
        let last = null;
        for (const p of this.path) {
          if (last && last[0] === p[0] && last[1] === p[1]) continue;
          if (!last) c.moveTo(this.sx(p[0]), this.sy(p[1])); else c.lineTo(this.sx(p[0]), this.sy(p[1]));
          last = p;
        }
        c.stroke();
        c.restore();
      }

      // holes
      for (const h of this.holes) {
        const r = Math.max(4, ((h.dia || 4) / 2) * k);
        const x = this.sx(h.x), y = this.sy(h.y);
        c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2);
        if (h.n) {
          c.fillStyle = h.active ? 'rgba(255,210,122,.35)' : 'rgba(201,154,59,.28)'; c.fill();
          c.lineWidth = 2.5; c.strokeStyle = h.active ? '#ffd27a' : '#c99a3b'; c.stroke();
        } else {
          c.fillStyle = h.active ? 'rgba(201,154,59,.25)' : 'rgba(31,40,45,.18)'; c.fill();
          c.lineWidth = 3.5; c.strokeStyle = 'rgba(255,255,255,.85)'; c.stroke();
          c.lineWidth = 1.6; c.strokeStyle = h.active ? '#8a6420' : '#1f282d'; c.setLineDash([4, 3]); c.stroke(); c.setLineDash([]);
        }
        if (h.n) {
          const label = String(h.n);
          c.font = '600 12px Archivo, "Helvetica Neue", Arial, sans-serif';
          const tw = Math.max(20, c.measureText(label).width + 10);
          const tx = x + r * 0.7, ty = y - r * 0.7 - 18;
          c.fillStyle = h.active ? '#ffd27a' : '#c99a3b';
          roundRect(c, tx, ty, tw, 18, 4); c.fill();
          c.fillStyle = '#2a2418'; c.textAlign = 'center'; c.textBaseline = 'middle';
          c.fillText(label, tx + tw / 2, ty + 9.5);
        }
      }
    }

    _local(e) {
      const r = this.canvas.getBoundingClientRect();
      return { px: e.clientX - r.left, py: e.clientY - r.top };
    }

    _holeAt(px, py) {
      let best = null, bd = Infinity;
      for (const h of this.holes) {
        const d = Math.hypot(this.sx(h.x) - px, this.sy(h.y) - py);
        const r = Math.max(8, ((h.dia || 4) / 2) * this.view.k + 4);
        if (d < r && d < bd) { bd = d; best = h; }
      }
      return best;
    }

    _pick(e) {
      const { px, py } = this._local(e);
      const h = this._holeAt(px, py);
      if (h) return this.h.onPick && this.h.onPick({ type: 'hole', id: h.id });
      if (!this.tris) return;
      const x = this.wx(px), y = this.wy(py), P = this.tris;
      let hit = null;
      for (let i = this.up.length - 1; i >= 0; i--) {
        const t = this.up[i], b = t.b;
        const x0 = P[b], y0 = P[b + 1], x1 = P[b + 3], y1 = P[b + 4], x2 = P[b + 6], y2 = P[b + 7];
        const d = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
        if (!d) continue;
        const l0 = ((y1 - y2) * (x - x2) + (x2 - x1) * (y - y2)) / d;
        const l1 = ((y2 - y0) * (x - x2) + (x0 - x2) * (y - y2)) / d;
        const l2 = 1 - l0 - l1;
        if (l0 < 0 || l1 < 0 || l2 < 0) continue;
        const z = l0 * P[b + 2] + l1 * P[b + 5] + l2 * P[b + 8];
        if (!hit || z > hit.z) hit = { z, nz: t.nz };
      }
      if (hit && this.h.onPick) this.h.onPick({ type: 'surface', point: { x, y, z: hit.z }, normalZ: hit.nz });
    }

    _hover(e) {
      const { px, py } = this._local(e);
      const h = this._holeAt(px, py);
      const id = h ? h.id : null;
      this.canvas.style.cursor = id != null ? 'pointer' : this.h.addMode && this.h.addMode() ? 'crosshair' : 'grab';
      if (this.h.onHover) this.h.onHover(id, e.clientX, e.clientY);
      this._hoverId = id;
    }
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r); c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r);
    c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y);
    c.closePath();
  }

  IP.Viewer2D = Viewer2D;
})(typeof window !== 'undefined' ? window : globalThis);
