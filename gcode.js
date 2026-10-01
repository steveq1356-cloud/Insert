/* InsertPress Planner — G-code for GRBL 1.1.
 *
 * Coordinate convention (set up once per session on the machine):
 *   X0 Y0  = inside corner of the fence (part is pushed into it)
 *   Z0     = tip touching the bed with the spring float relaxed (paper test)
 * So a tip Z of "H" means the tip is level with a surface H mm above the bed.
 */
(function (root) {
  'use strict';
  const IP = (root.IP = root.IP || {});

  // Typical tapered brass inserts (CNC Kitchen-style sizes). Edit to match yours.
  const INSERTS = {
    m2:   { name: 'M2',       L: 3.0, hole: 3.2 },
    m25:  { name: 'M2.5',     L: 4.0, hole: 3.6 },
    m3:   { name: 'M3',       L: 5.7, hole: 4.0 },
    m3s:  { name: 'M3 short', L: 3.0, hole: 4.0 },
    m4:   { name: 'M4',       L: 8.1, hole: 5.6 },
    m5:   { name: 'M5',       L: 9.5, hole: 6.4 },
  };

  const DEFAULT_SETTINGS = {
    mode: 'xy',            // 'xy' moves X/Y; 'manual' pauses so you position the part
    loadMode: 'each',      // 'each' pause per hole; 'start' load every insert first
    overloadStop: true,    // press with G38.3 so the move halts if the float sensor trips
    defaultInsert: 'm3',
    sink: 0.1,             // mm below the surface to finish the insert
    approachGap: 1.0,      // mm above the insert top before slowing to press feed
    pressFeed: 60,         // mm/min
    dwell: 2.0,            // s, hold at depth
    retractSlow: 2.0,      // mm, slow lift distance off the insert
    retractFeed: 120,      // mm/min
    clearance: 5.0,        // mm above (part top + longest insert) for travel
    minClear: 0,           // mm, never travel lower than this
    bedX: 200, bedY: 200,  // usable travel from the fence corner
    park: true, parkX: 0, parkY: 0,
    rapidXY: 1500, rapidZ: 400, // mm/min, only used for the time estimate
    dMin: 2.5, dMax: 7.0,  // hole-detection diameter range
  };

  function guessInsert(dia, fallback) {
    if (!dia) return fallback;
    let best = null, bd = Infinity;
    for (const [k, v] of Object.entries(INSERTS)) {
      const d = Math.abs(v.hole - dia);
      if (d < bd - 1e-9) { bd = d; best = k; }
    }
    if (best && INSERTS[fallback] && INSERTS[fallback].hole === INSERTS[best].hole) return fallback;
    return bd <= 0.6 ? best : fallback;
  }

  function fmt(v) {
    let t = (Math.round(v * 1000) / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    return t === '-0' ? '0' : t;
  }

  /** Per-hole sanity checks. holes are in press order. */
  function check(holes, s) {
    const out = [];
    holes.forEach((h, i) => {
      const n = i + 1;
      const ins = INSERTS[h.insert] || INSERTS[s.defaultInsert];
      if (h.blind && h.depth != null && h.depth < ins.L + 0.3) {
        out.push({ level: 'warn', hole: n, text: `Hole ${n} is ${fmt(h.depth)} mm deep but the ${ins.name} insert is ${fmt(ins.L)} mm long. It will bottom out.` });
      }
      if (h.dia && Math.abs(h.dia - ins.hole) > 0.4) {
        out.push({ level: 'warn', hole: n, text: `Hole ${n} measures ${fmt(h.dia)} mm; ${ins.name} inserts usually want about ${fmt(ins.hole)} mm.` });
      }
      if (s.mode === 'xy' && (h.x < 0 || h.y < 0 || h.x > s.bedX || h.y > s.bedY)) {
        out.push({ level: 'error', hole: n, text: `Hole ${n} (X${fmt(h.x)} Y${fmt(h.y)}) is outside the ${s.bedX} × ${s.bedY} mm travel.` });
      }
      const sink = h.sink != null ? h.sink : s.sink;
      if (h.H - sink < 0) {
        out.push({ level: 'error', hole: n, text: `Hole ${n} would drive the tip below the bed.` });
      }
      for (let j = 0; j < i; j++) {
        if (Math.hypot(holes[j].x - h.x, holes[j].y - h.y) < 1) {
          out.push({ level: 'warn', hole: n, text: `Holes ${j + 1} and ${n} are less than 1 mm apart. Is one a duplicate?` });
        }
      }
    });
    return out;
  }

  /**
   * job = { name, size:{x,y,z}, holes:[{x,y,H,insert,sink?,dia?,depth?,blind?}], settings }
   * holes must already be in press order.
   */
  function generate(job) {
    const s = Object.assign({}, DEFAULT_SETTINGS, job.settings || {});
    const holes = job.holes || [];
    const issues = check(holes, s);
    if (!holes.length) return { text: '', issues, seconds: 0, clearZ: 0 };

    const ins = (h) => INSERTS[h.insert] || INSERTS[s.defaultInsert];
    const maxL = Math.max(...holes.map((h) => ins(h).L));
    const clearZ = Math.max(s.minClear, job.size.z + maxL + s.clearance);
    const xy = s.mode === 'xy';
    const out = [];
    const push = (l) => out.push(l);

    let secs = 0, px = xy && s.park ? s.parkX : 0, py = xy && s.park ? s.parkY : 0, pz = clearZ;
    const travel = (x, y) => { secs += (Math.hypot(x - px, y - py) / s.rapidXY) * 60; px = x; py = y; };
    const zmove = (z, feed) => { secs += (Math.abs(z - pz) / (feed || s.rapidZ)) * 60; pz = z; };

    push(`; InsertPress Planner job: ${job.name || 'untitled'}`);
    push(`; Part ${fmt(job.size.x)} x ${fmt(job.size.y)} x ${fmt(job.size.z)} mm, ${holes.length} insert${holes.length === 1 ? '' : 's'}`);
    push(`; Mode: ${xy ? 'X/Y motion' : 'Z only, part positioned by hand'}`);
    push('; Origin: X0 Y0 = fence corner, Z0 = bed surface (touch-off)');
    push(`; Clear height Z${fmt(clearZ)}, press F${fmt(s.pressFeed)}, dwell ${fmt(s.dwell)} s`);
    push('G21 G90 G94 G17');
    push('G54');
    push(`G0 Z${fmt(clearZ)}`);
    push('(MSG,Iron hot? Cycle Start to begin)');
    push('M0');
    if (s.loadMode === 'start') {
      push(`(MSG,Place all ${holes.length} inserts then Cycle Start)`);
      push('M0');
    }

    holes.forEach((h, i) => {
      const n = i + 1;
      const k = ins(h);
      const sink = h.sink != null ? h.sink : s.sink;
      const zAbove = h.H + k.L + s.approachGap;
      const zFinal = h.H - sink;
      const zLift = Math.min(zFinal + s.retractSlow, clearZ);
      push('');
      push(`; Hole ${n}/${holes.length}  X${fmt(h.x)} Y${fmt(h.y)}  surface Z${fmt(h.H)}  ${k.name} L${fmt(k.L)}`);
      if (xy) {
        push(`G0 X${fmt(h.x)} Y${fmt(h.y)}`);
        travel(h.x, h.y);
        if (s.loadMode === 'each') { push(`(MSG,Hole ${n}: place ${k.name} insert)`); push('M0'); }
      } else {
        const what = s.loadMode === 'each' ? `place ${k.name}, ` : '';
        push(`(MSG,Hole ${n}: ${what}align X${fmt(h.x)} Y${fmt(h.y)})`);
        push('M0');
      }
      if (zAbove < clearZ) { push(`G0 Z${fmt(zAbove)}`); zmove(zAbove); }
      push(s.overloadStop
        ? `G38.3 Z${fmt(zFinal)} F${fmt(s.pressFeed)} ; press, halts if float trips`
        : `G1 Z${fmt(zFinal)} F${fmt(s.pressFeed)} ; press`);
      zmove(zFinal, s.pressFeed);
      push(`G4 P${fmt(s.dwell)}`);
      secs += s.dwell;
      push(`G1 Z${fmt(zLift)} F${fmt(s.retractFeed)}`);
      zmove(zLift, s.retractFeed);
      push(`G0 Z${fmt(clearZ)}`);
      zmove(clearZ);
    });

    push('');
    push('; Done');
    push(`G0 Z${fmt(clearZ)}`);
    if (xy && s.park) { push(`G0 X${fmt(s.parkX)} Y${fmt(s.parkY)}`); travel(s.parkX, s.parkY); }
    push('M2');

    return { text: out.join('\n') + '\n', issues, seconds: secs, clearZ };
  }

  /** Nearest-neighbour tour from (sx, sy), then 2-opt cleanup. Returns a new array. */
  function optimizeOrder(points, sx, sy) {
    const left = points.slice();
    const tour = [];
    let cx = sx, cy = sy;
    while (left.length) {
      let bi = 0, bd = Infinity;
      left.forEach((p, i) => { const d = Math.hypot(p.x - cx, p.y - cy); if (d < bd) { bd = d; bi = i; } });
      const p = left.splice(bi, 1)[0];
      tour.push(p); cx = p.x; cy = p.y;
    }
    const start = { x: sx, y: sy };
    const D = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    let improved = true, guard = 0;
    while (improved && guard++ < 50) {
      improved = false;
      for (let i = 0; i < tour.length - 1; i++) {
        const a = i === 0 ? start : tour[i - 1], b = tour[i];
        for (let j = i + 1; j < tour.length; j++) {
          const c = tour[j], d = tour[j + 1];
          const before = D(a, b) + (d ? D(c, d) : 0);
          const after = D(a, c) + (d ? D(b, d) : 0);
          if (after < before - 1e-9) {
            const seg = tour.slice(i, j + 1).reverse();
            tour.splice(i, seg.length, ...seg);
            improved = true;
            break;
          }
        }
        if (improved) break;
      }
    }
    return tour;
  }

  IP.INSERTS = INSERTS;
  IP.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
  IP.gcode = { generate, check, guessInsert, optimizeOrder, fmt };
})(typeof window !== 'undefined' ? window : globalThis);
