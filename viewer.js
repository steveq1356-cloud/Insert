/* InsertPress Planner — 3D view (Three.js r128, Z up like the machine). */
(function (root) {
  'use strict';
  const IP = (root.IP = root.IP || {});

  const COLORS = {
    bed: 0x34434a, grid: 0x46565d, grid10: 0x55666e, fence: 0x8f9a9e,
    part: 0xc9ced0, edges: 0x5d676c,
    candidate: 0xf3f1ea, selected: 0xc99a3b, active: 0xffd27a, path: 0xe0602f,
  };

  class Viewer {
    constructor(el, handlers) {
      this.el = el;
      this.h = handlers || {};
      this.bed = { x: 200, y: 200 };
      this.markerMeshes = [];

      const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }));
      r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      el.appendChild(r.domElement);

      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(35, 1, 0.5, 5000);
      this.camera.up.set(0, 0, 1);
      this.camera.position.set(-120, -160, 160);
      this.controls = new THREE.OrbitControls(this.camera, r.domElement);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.12;
      this.controls.screenSpacePanning = true;

      this.scene.add(new THREE.HemisphereLight(0xf2f4f5, 0x3a4348, 0.85));
      const sun = new THREE.DirectionalLight(0xffffff, 0.75);
      sun.position.set(-0.6, -1, 1.6);
      this.scene.add(sun);

      this.bedGroup = new THREE.Group();
      this.partGroup = new THREE.Group();
      this.markerGroup = new THREE.Group();
      this.pathGroup = new THREE.Group();
      this.scene.add(this.bedGroup, this.partGroup, this.markerGroup, this.pathGroup);
      this.setBed(200, 200);

      this.raycaster = new THREE.Raycaster();
      this.mouse = new THREE.Vector2();
      this._down = null;
      const c = r.domElement;
      c.addEventListener('pointerdown', (e) => { this._down = { x: e.clientX, y: e.clientY }; });
      c.addEventListener('pointerup', (e) => {
        if (!this._down) return;
        const moved = Math.hypot(e.clientX - this._down.x, e.clientY - this._down.y);
        this._down = null;
        if (moved < 5 && e.button === 0) this._pick(e);
      });
      c.addEventListener('pointermove', (e) => this._hover(e));

      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(el);
      this.resize();
      const loop = () => { this.controls.update(); this.renderer.render(this.scene, this.camera); requestAnimationFrame(loop); };
      loop();
    }

    resize() {
      const w = this.el.clientWidth || 1, h = this.el.clientHeight || 1;
      this.renderer.setSize(w, h, false);
      this.renderer.domElement.style.width = w + 'px';
      this.renderer.domElement.style.height = h + 'px';
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }

    _clear(g) {
      while (g.children.length) {
        const o = g.children.pop();
        o.traverse((n) => {
          if (n.geometry) n.geometry.dispose();
          if (n.material) { if (n.material.map) n.material.map.dispose(); n.material.dispose(); }
        });
      }
    }

    setBed(x, y) {
      this.bed = { x, y };
      this._clear(this.bedGroup);
      const plate = new THREE.Mesh(
        new THREE.PlaneGeometry(x, y),
        new THREE.MeshStandardMaterial({ color: COLORS.bed, roughness: 0.9, metalness: 0.1 }));
      plate.position.set(x / 2, y / 2, -0.05);
      this.bedGroup.add(plate);
      const minor = [], major = [];
      for (let i = 0; i <= x; i += 10) (i % 50 ? minor : major).push(i, 0, 0, i, y, 0);
      for (let j = 0; j <= y; j += 10) (j % 50 ? minor : major).push(0, j, 0, x, j, 0);
      const lines = (arr, color) => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
        return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color }));
      };
      this.bedGroup.add(lines(minor, COLORS.grid), lines(major, COLORS.grid10));
      // L-shaped fence in the origin corner
      const mat = new THREE.MeshStandardMaterial({ color: COLORS.fence, roughness: 0.5, metalness: 0.6 });
      const fx = new THREE.Mesh(new THREE.BoxGeometry(Math.min(x, 80) + 4, 4, 8), mat);
      fx.position.set((Math.min(x, 80) + 4) / 2 - 4, -2, 4);
      const fy = new THREE.Mesh(new THREE.BoxGeometry(4, Math.min(y, 80), 8), mat);
      fy.position.set(-2, Math.min(y, 80) / 2, 4);
      this.bedGroup.add(fx, fy);
    }

    setPart(positions, size) {
      this._clear(this.partGroup);
      this.size = size;
      if (!positions) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      g.computeVertexNormals();
      g.computeBoundingSphere();
      this.partMesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
        color: COLORS.part, roughness: 0.72, metalness: 0.05,
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      }));
      this.partGroup.add(this.partMesh);
      if (positions.length / 9 < 400000) {
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(g, 35),
          new THREE.LineBasicMaterial({ color: COLORS.edges, transparent: true, opacity: 0.55 }));
        this.partGroup.add(edges);
      }
      this.frame('iso');
    }

    /** holes: [{id, x, y, H, dia, n (press number or null), active}] */
    setHoles(holes) {
      this._clear(this.markerGroup);
      this.markerMeshes = [];
      const diag = this.size ? Math.hypot(this.size.x, this.size.y) : 60;
      const tag = Math.max(3.2, Math.min(9, diag * 0.045));
      for (const h of holes) {
        const r = (h.dia || 4) / 2;
        const color = h.active ? COLORS.active : h.n ? COLORS.selected : COLORS.candidate;
        const ring = new THREE.Mesh(new THREE.RingGeometry(r + 0.25, r + (h.n ? 1.3 : 0.8), 40),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: h.n ? 1 : 0.75, side: THREE.DoubleSide, depthTest: false }));
        ring.position.set(h.x, h.y, h.H + 0.03);
        ring.renderOrder = 2;
        this.markerGroup.add(ring);
        const hit = new THREE.Mesh(new THREE.CircleGeometry(r + 1.6, 24),
          new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }));
        hit.position.copy(ring.position);
        hit.userData.id = h.id;
        this.markerGroup.add(hit);
        this.markerMeshes.push(hit);
        if (h.n) {
          const s = this._label(String(h.n), h.active);
          s.position.set(h.x, h.y, h.H + tag * 0.9);
          s.scale.set(tag * (String(h.n).length > 1 ? 1.35 : 1), tag, 1);
          s.renderOrder = 3;
          this.markerGroup.add(s);
        }
      }
    }

    _label(text, active) {
      const c = document.createElement('canvas');
      const w = text.length > 1 ? 172 : 128;
      c.width = w; c.height = 128;
      const x = c.getContext('2d');
      x.fillStyle = active ? '#ffd27a' : '#c99a3b';
      const rr = 22;
      x.beginPath();
      x.moveTo(rr, 6); x.lineTo(w - rr, 6); x.quadraticCurveTo(w - 6, 6, w - 6, rr);
      x.lineTo(w - 6, 122 - rr); x.quadraticCurveTo(w - 6, 122, w - rr, 122);
      x.lineTo(rr, 122); x.quadraticCurveTo(6, 122, 6, 122 - rr);
      x.lineTo(6, rr); x.quadraticCurveTo(6, 6, rr, 6);
      x.fill();
      x.fillStyle = '#2a2418';
      x.font = '600 76px Archivo, "Helvetica Neue", Arial, sans-serif';
      x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText(text, w / 2, 68);
      const tex = new THREE.CanvasTexture(c);
      tex.anisotropy = 4;
      return new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
    }

    /** pts: [[x,y,z], ...] in travel order */
    setPath(pts) {
      this._clear(this.pathGroup);
      if (!pts || pts.length < 2) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts.flat(), 3));
      const line = new THREE.Line(g, new THREE.LineDashedMaterial({ color: COLORS.path, dashSize: 2.2, gapSize: 1.4 }));
      line.computeLineDistances();
      this.pathGroup.add(line);
    }

    setPathVisible(v) { this.pathGroup.visible = v; }

    frame(kind) {
      const s = this.size || { x: this.bed.x, y: this.bed.y, z: 10 };
      const c = new THREE.Vector3(s.x / 2, s.y / 2, s.z / 2);
      const d = Math.max(s.x, s.y, s.z, 30) * 2.4;
      if (kind === 'top') this.camera.position.set(c.x, c.y - d * 0.001, c.z + d * 1.1);
      else if (kind === 'front') this.camera.position.set(c.x, c.y - d * 1.2, c.z + d * 0.25);
      else this.camera.position.set(c.x - d * 0.7, c.y - d * 0.95, c.z + d * 0.85);
      this.controls.target.copy(c);
      this.controls.update();
    }

    _ray(e) {
      const rect = this.renderer.domElement.getBoundingClientRect();
      this.mouse.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      this.raycaster.setFromCamera(this.mouse, this.camera);
    }

    _pick(e) {
      this._ray(e);
      const m = this.raycaster.intersectObjects(this.markerMeshes, false)[0];
      if (m) return this.h.onPick && this.h.onPick({ type: 'hole', id: m.object.userData.id });
      if (!this.partMesh) return;
      const p = this.raycaster.intersectObject(this.partMesh, false)[0];
      if (p && this.h.onPick) this.h.onPick({ type: 'surface', point: p.point, normalZ: p.face ? p.face.normal.z : 0 });
    }

    _hover(e) {
      if (e.buttons) return;
      this._ray(e);
      const m = this.raycaster.intersectObjects(this.markerMeshes, false)[0];
      const id = m ? m.object.userData.id : null;
      this.renderer.domElement.style.cursor = id != null ? 'pointer' : this.h.addMode && this.h.addMode() ? 'crosshair' : '';
      if (id !== this._hoverId) { this._hoverId = id; if (this.h.onHover) this.h.onHover(id); }
    }
  }

  IP.Viewer = Viewer;
})(typeof window !== 'undefined' ? window : globalThis);
