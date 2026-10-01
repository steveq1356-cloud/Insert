/* InsertPress Planner — STL loading and part placement.
 * Produces a flat Float32Array of triangle vertices [x,y,z, x,y,z, x,y,z, ...]
 * in millimetres, oriented and shifted so the part sits in the fence corner:
 * min X = 0, min Y = 0, min Z = 0 (bed surface).
 */
(function (root) {
  'use strict';
  const IP = (root.IP = root.IP || {});

  function parseSTL(buffer) {
    const dv = new DataView(buffer);
    // Binary STL: 80-byte header, uint32 count, 50 bytes per triangle.
    // Check the size first, because many binary files start with "solid" too.
    if (buffer.byteLength >= 84) {
      const n = dv.getUint32(80, true);
      if (84 + n * 50 === buffer.byteLength) return parseBinary(dv, n);
    }
    const head = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 1024)));
    if (/^\s*solid/i.test(head)) {
      const out = parseAscii(new TextDecoder().decode(new Uint8Array(buffer)));
      if (out.length) return out;
    }
    if (buffer.byteLength >= 84) {
      const n = dv.getUint32(80, true);
      if (n > 0 && 84 + n * 50 <= buffer.byteLength) return parseBinary(dv, n);
    }
    throw new Error('This file is not a readable STL. Export it from your CAD program as STL (binary or ASCII).');
  }

  function parseBinary(dv, n) {
    const pos = new Float32Array(n * 9);
    let o = 84;
    for (let i = 0; i < n; i++) {
      o += 12; // skip stored normal; we recompute from winding
      for (let j = 0; j < 9; j++) {
        pos[i * 9 + j] = dv.getFloat32(o, true);
        o += 4;
      }
      o += 2;
    }
    return pos;
  }

  function parseAscii(text) {
    const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
    const out = [];
    let m;
    while ((m = re.exec(text))) out.push(+m[1], +m[2], +m[3]);
    out.length -= out.length % 9;
    return new Float32Array(out);
  }

  /** Rotate by quarter turns (about X, then Y, then Z), scale, then drop into the fence corner. */
  function preparePart(raw, opts) {
    const rot = (opts && opts.rot) || { x: 0, y: 0, z: 0 };
    const scale = (opts && opts.scale) || 1;
    const pos = new Float32Array(raw.length);
    const turns = [((rot.x % 4) + 4) % 4, ((rot.y % 4) + 4) % 4, ((rot.z % 4) + 4) % 4];
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < raw.length; i += 3) {
      let x = raw[i] * scale, y = raw[i + 1] * scale, z = raw[i + 2] * scale, t;
      for (let k = 0; k < turns[0]; k++) { t = y; y = -z; z = t; }   // +90° about X
      for (let k = 0; k < turns[1]; k++) { t = x; x = z; z = -t; }   // +90° about Y
      for (let k = 0; k < turns[2]; k++) { t = x; x = -y; y = t; }   // +90° about Z
      pos[i] = x; pos[i + 1] = y; pos[i + 2] = z;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    for (let i = 0; i < pos.length; i += 3) {
      pos[i] -= minX; pos[i + 1] -= minY; pos[i + 2] -= minZ;
    }
    return {
      positions: pos,
      triCount: pos.length / 9,
      size: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ },
    };
  }

  /** Write a binary STL (used by the example generator script). */
  function toBinarySTL(pos) {
    const n = pos.length / 9;
    const buf = new ArrayBuffer(84 + n * 50);
    const dv = new DataView(buf);
    const label = 'InsertPress Planner example part';
    for (let i = 0; i < label.length; i++) dv.setUint8(i, label.charCodeAt(i));
    dv.setUint32(80, n, true);
    let o = 84;
    for (let t = 0; t < n; t++) {
      const b = t * 9;
      const ux = pos[b + 3] - pos[b], uy = pos[b + 4] - pos[b + 1], uz = pos[b + 5] - pos[b + 2];
      const vx = pos[b + 6] - pos[b], vy = pos[b + 7] - pos[b + 1], vz = pos[b + 8] - pos[b + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      dv.setFloat32(o, nx / l, true); dv.setFloat32(o + 4, ny / l, true); dv.setFloat32(o + 8, nz / l, true);
      o += 12;
      for (let j = 0; j < 9; j++) { dv.setFloat32(o, pos[b + j], true); o += 4; }
      o += 2;
    }
    return buf;
  }

  IP.stl = { parseSTL, preparePart, toBinarySTL };
})(typeof window !== 'undefined' ? window : globalThis);
