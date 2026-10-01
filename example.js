/* InsertPress Planner — built-in example part.
 * A 60 × 45 × 12 mm block on a 15 mm grid with a mix of holes, so the
 * detector has real cases to sort out:
 *   five M3 blind holes, an M2.5, an M5, a through hole (all usable),
 *   a 4 mm hole that is too shallow for an M3 (flagged),
 *   a 10 mm pocket (ignored: too big), and a hole from the bottom (ignored: blocked).
 */
(function (root) {
  'use strict';
  const IP = (root.IP = root.IP || {});

  function exampleBlock() {
    const S = 15, NX = 4, NY = 3, T = 12, N = 32;
    const top = (d, depth) => ({ d, depth, from: 'top' });
    // rows listed back (high Y) to front
    const layout = [
      [top(4, 7), top(4, 7), top(4, 7), top(4, 7)],
      [{ d: 4, from: 'through' }, top(10, 4), null, top(6.4, 11)],
      [top(4, 7), { d: 4, depth: 6, from: 'bottom' }, top(3.6, 5.5), top(4, 4)],
    ];
    const tris = [];
    const tri = (a, b, c) => tris.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    const W = S * NX, D = S * NY, h = S / 2;

    for (let row = 0; row < NY; row++) {
      for (let col = 0; col < NX; col++) {
        const spec = layout[row][col];
        const cx = col * S + h, cy = D - (row * S + h);
        const ang = (k) => Math.PI / 4 + (k * 2 * Math.PI) / N;
        const sq = (k) => {
          const a = ang(k), r = h / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)));
          return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
        };
        const ci = (k, r) => [cx + r * Math.cos(ang(k)), cy + r * Math.sin(ang(k))];
        const r = spec ? spec.d / 2 : 0;
        const openTop = spec && spec.from !== 'bottom';
        const openBot = spec && spec.from !== 'top';

        for (let k = 0; k < N; k++) {
          const b0 = sq(k), b1 = sq(k + 1);
          // top face (normal up)
          if (openTop) {
            const c0 = ci(k, r), c1 = ci(k + 1, r);
            tri([b0[0], b0[1], T], [b1[0], b1[1], T], [c1[0], c1[1], T]);
            tri([b0[0], b0[1], T], [c1[0], c1[1], T], [c0[0], c0[1], T]);
          } else {
            tri([cx, cy, T], [b0[0], b0[1], T], [b1[0], b1[1], T]);
          }
          // bottom face (normal down)
          if (openBot) {
            const c0 = ci(k, r), c1 = ci(k + 1, r);
            tri([b0[0], b0[1], 0], [c1[0], c1[1], 0], [b1[0], b1[1], 0]);
            tri([b0[0], b0[1], 0], [c0[0], c0[1], 0], [c1[0], c1[1], 0]);
          } else {
            tri([cx, cy, 0], [b1[0], b1[1], 0], [b0[0], b0[1], 0]);
          }
          if (!spec) continue;
          // bore wall (normal toward the axis)
          const z0 = spec.from === 'top' ? T - spec.depth : 0;
          const z1 = spec.from === 'bottom' ? spec.depth : T;
          const c0 = ci(k, r), c1 = ci(k + 1, r);
          tri([c0[0], c0[1], z0], [c1[0], c1[1], z1], [c1[0], c1[1], z0]);
          tri([c0[0], c0[1], z0], [c0[0], c0[1], z1], [c1[0], c1[1], z1]);
          if (spec.from === 'top') tri([cx, cy, z0], [c0[0], c0[1], z0], [c1[0], c1[1], z0]);      // floor, up
          if (spec.from === 'bottom') tri([cx, cy, z1], [c1[0], c1[1], z1], [c0[0], c0[1], z1]);   // ceiling, down
        }
      }
    }
    // outer walls (normals outward)
    const quad = (a, b, c, d) => { tri(a, b, c); tri(a, c, d); };
    quad([0, 0, 0], [W, 0, 0], [W, 0, T], [0, 0, T]);
    quad([W, 0, 0], [W, D, 0], [W, D, T], [W, 0, T]);
    quad([W, D, 0], [0, D, 0], [0, D, T], [W, D, T]);
    quad([0, D, 0], [0, 0, 0], [0, 0, T], [0, D, T]);
    return new Float32Array(tris);
  }

  IP.exampleBlock = exampleBlock;
})(typeof window !== 'undefined' ? window : globalThis);
