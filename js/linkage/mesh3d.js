/* Turning flat outlines into printable solids. A port of the C tool's
   src/mesh3d.c.

   Everything the STL export writes is a PRISM: a closed 2D region -- one outer
   boundary and any number of holes -- swept to a thickness. A link plate, a
   rail, a washer, a pin and a baseplate differ only in the outline they are
   swept from, so there is one pipeline here and no special cases downstream.

   The output is a triangle soup, because that is what STL is. It is a soup
   with a rule, though: every solid this builds must be CLOSED (every edge
   shared by exactly two triangles wound oppositely). An unclosed mesh is not a
   solid, and a slicer will either refuse it or quietly print something else --
   so isClosed() is checked before anything is written.

   The one liberty taken with the original: the C threads explicit capacity
   through every builder, because it is writing into caller-owned buffers.
   Arrays grow here, so the _capacity functions have no reason to exist and
   the builders simply return what they built. Nothing about the geometry
   changes.

   Units are millimetres throughout, matching 1 world unit = 1 mm. */

/* Points closer together than this are the same point. Outlines are in
   millimetres and the finest feature drawn is a fifth of a millimetre, so this
   is far below anything real and far above double-precision noise. */
const WELD = 1e-9;

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const scale = (a, s) => ({ x: a.x * s, y: a.y * s });
const cross = (a, b) => a.x * b.y - a.y * b.x;
const dot = (a, b) => a.x * b.x + a.y * b.y;
const len = (a) => Math.hypot(a.x, a.y);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export const createMesh = () => ({ verts: [] });

export function addTri(m, a, b, c) {
  m.verts.push(a, b, c);
}

export const triCount = (m) => m.verts.length / 3;

/* Positive means counter-clockwise. */
export function signedArea(p) {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    a += p[j].x * p[i].y - p[i].x * p[j].y;
  }
  return a * 0.5;
}

/* ---- ear clipping ------------------------------------------------------ */

const samePoint = (a, b) =>
  Math.abs(a.x - b.x) < WELD && Math.abs(a.y - b.y) < WELD;

/* Strictly inside; a point sitting exactly on an edge does not block an ear.
   That matters because bridging a hole leaves two vertices lying ON the
   bridge, and treating those as blockers would stall the clip. Works whichever
   way round a, b, c happen to run. */
function strictlyInside(a, b, c, q) {
  const d1 = cross(sub(b, a), sub(q, a));
  const d2 = cross(sub(c, b), sub(q, b));
  const d3 = cross(sub(a, c), sub(q, c));
  return (d1 > WELD && d2 > WELD && d3 > WELD) ||
         (d1 < -WELD && d2 < -WELD && d3 < -WELD);
}

/* Do the two segments cross properly -- not merely touch at a shared
   endpoint, and not merely graze? */
function segmentsCross(a, b, c, d) {
  const d1 = cross(sub(b, a), sub(c, a));
  const d2 = cross(sub(b, a), sub(d, a));
  const d3 = cross(sub(d, c), sub(a, c));
  const d4 = cross(sub(d, c), sub(b, c));
  return ((d1 > WELD && d2 < -WELD) || (d1 < -WELD && d2 > WELD)) &&
         ((d3 > WELD && d4 < -WELD) || (d3 < -WELD && d4 > WELD));
}

/* Does q lie strictly between a and b on the segment joining them? */
function pointOnSegment(a, b, q) {
  const ab = sub(b, a);
  const l = len(ab);
  if (l < WELD) return false;
  if (Math.abs(cross(ab, sub(q, a))) / l > 1e-7) return false;
  const t = dot(sub(q, a), ab) / (l * l);
  return t > 1e-9 && t < 1 - 1e-9;
}

/* Clips a simple counter-clockwise polygon (possibly carrying bridge seams)
   into triangles. False if it gets stuck, which means the outline was not
   simple to begin with. */
function earClip(v, out, z, up) {
  const n = v.length;
  if (n < 3) return false;

  const prev = new Int32Array(n), next = new Int32Array(n);
  const gone = new Uint8Array(n);
  for (let i = 0; i < n; i++) { prev[i] = (i + n - 1) % n; next[i] = (i + 1) % n; }

  let remaining = n, cur = 0, ok = true;
  /* Every clip removes one vertex, and finding the next ear can cost a full
     sweep of what is left, so a quadratic allowance is the honest bound; the
     slack on top absorbs the sweeps that find nothing. This turns "no ear
     anywhere" into a clean failure rather than a hang. */
  let budget = 4 * n * n + 64 * n;

  while (remaining > 3) {
    if (budget-- <= 0) { ok = false; break; }
    const i = cur, ip = prev[cur], inx = next[cur];
    const a = v[ip], b = v[i], c = v[inx];
    const turn = cross(sub(b, a), sub(c, b));

    /* A vertex exactly on the line between its neighbours is neither convex
       nor reflex, so it is never an ear -- and a polygon can end up as nothing
       but such vertices. Clipping it as a zero-area ear costs a sliver a
       slicer ignores, and keeps the vertex so the cap still matches the wall
       built from the same loop. A vertex that doubles BACK along the line is a
       different thing -- the turn at the end of a bridging seam -- so require
       the neighbours to lie on opposite sides before treating it this way. */
    const flat = Math.abs(turn) <= WELD && dot(sub(a, b), sub(c, b)) < 0;
    let ear = flat || turn > WELD;

    if (ear && !flat) {
      for (let k = next[inx]; k !== ip; k = next[k]) {
        const q = v[k];
        if (samePoint(q, a) || samePoint(q, b) || samePoint(q, c)) continue;
        if (strictlyInside(a, b, c, q)) { ear = false; break; }
      }
    }
    if (ear && !flat) {
      /* Asking only about vertices is not enough once bridging seams are in
         play. A seam is a zero-width channel, so a pair of its edges can run
         clean across a candidate ear with every endpoint ON the triangle's
         boundary -- inside nothing, caught by nothing, blocking everything.
         So ask about the edges themselves. */
      for (let k = inx; ;) {
        const k2 = next[k];
        if (segmentsCross(a, c, v[k], v[k2])) { ear = false; break; }
        const mid = scale(add(v[k], v[k2]), 0.5);
        if (strictlyInside(a, b, c, mid)) { ear = false; break; }
        k = k2;
        if (k === ip) break;
      }
    }

    if (ear) {
      const A = { x: a.x, y: a.y, z }, B = { x: b.x, y: b.y, z }, C = { x: c.x, y: c.y, z };
      if (up) addTri(out, A, B, C); else addTri(out, C, B, A);
      next[ip] = inx;
      prev[inx] = ip;
      gone[i] = 1;
      remaining--;
      cur = ip;
    } else {
      cur = inx;
    }
  }

  if (ok) {
    let i = cur;
    while (gone[i]) i = (i + 1) % n;
    const a = v[prev[i]], b = v[i], c = v[next[i]];
    const A = { x: a.x, y: a.y, z }, B = { x: b.x, y: b.y, z }, C = { x: c.x, y: c.y, z };
    if (up) addTri(out, A, B, C); else addTri(out, C, B, A);
  }
  return ok;
}

/* ---- hole bridging -----------------------------------------------------

   Ear clipping only understands ONE loop, so each hole is cut into the outer
   boundary along a seam: a pair of coincident edges out to the hole and back.
   The seam has zero width, so the solid is unchanged, and what is left is a
   single simple polygon.

   The seam runs from the hole to a vertex of the ORIGINAL outer boundary --
   never to a point on another hole's seam or on another hole. That restriction
   is the whole trick. Landing one seam on another leaves two zero-width
   channels sharing a point, which is a polygon that still passes an
   edge-crossing test but no longer has an ear anywhere -- so the clip stalls
   on geometry that looks perfectly fine. Rows of anchors at the same height,
   which is how baseplates usually come out, hit that case routinely. */

/* Does a..b cut across this loop? Ends that touch the loop at `m` are the
   seam's own attachment and do not count. */
function seamHitsLoop(a, b, loop, m) {
  for (let i = 0; i < loop.length; i++) {
    const j = (i + 1) % loop.length;
    if (samePoint(loop[i], m) || samePoint(loop[j], m)) continue;
    if (segmentsCross(a, b, loop[i], loop[j])) return true;
    if (!samePoint(loop[i], a) && !samePoint(loop[i], b) &&
        pointOnSegment(a, b, loop[i])) return true;
  }
  return false;
}

function seamIsClear(poly, m, v, hole, holesPending) {
  const cand = poly[v];
  if (samePoint(m, cand)) return false;
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    if (i !== v && j !== v && segmentsCross(m, cand, poly[i], poly[j])) return false;
    if (i === v || samePoint(poly[i], m) || samePoint(poly[i], cand)) continue;
    if (pointOnSegment(m, cand, poly[i])) return false;
  }
  /* This hole is not spliced in yet, so check it separately: a seam that cut
     back across its own hole would join the wrong sides of it. */
  if (seamHitsLoop(m, cand, hole, m)) return false;
  /* And so are the holes still queued behind it. A seam laid across empty
     material today is a seam laid across a HOLE once that hole arrives, and by
     then it is part of the boundary and cannot be moved. Two anchors a few
     millimetres apart on the same edge land exactly on that. */
  for (const later of holesPending) {
    if (later.length < 3) continue;
    if (seamHitsLoop(m, cand, later, m)) return false;
  }
  return true;
}

/* Forces a copy of `src` to the winding `ccw` asks for. */
function wound(src, ccw) {
  return signedArea(src) > 0 === ccw ? src.slice() : src.slice().reverse();
}

/* Merges the outer loop and every hole into one simple polygon, or null. */
function bridgeHoles(region) {
  let poly = wound(region.outer, true);
  /* outerEdge[i] marks the edge from poly[i] to poly[i+1] as part of the
     ORIGINAL boundary, i.e. somewhere a seam may still land. */
  let outerEdge = poly.map(() => true);

  /* Rightmost hole first, so the seams fan out in a consistent order. */
  const rightmost = (h) => h.reduce((mx, p) => Math.max(mx, p.x), -Infinity);
  const order = region.holes
    .map((h, i) => i)
    .sort((a, b) => rightmost(region.holes[b]) - rightmost(region.holes[a]));

  for (let hi = 0; hi < order.length; hi++) {
    const hole = region.holes[order[hi]];
    if (hole.length < 3) continue;
    /* A hole runs the opposite way round to the boundary, so that walking in
       through the seam and out again keeps the merged loop simple. */
    const hw = wound(hole, false);
    const pending = order.slice(hi + 1).map((k) => region.holes[k]);

    /* Try every point of the hole against every vertex still on the original
       boundary, and take the shortest seam that is genuinely clear. Leaving
       from the hole's rightmost vertex alone is the textbook choice, but it
       has no answer at all when the only clear seam leaves from elsewhere. */
    let bestV = -1, bestS = -1, bestLen = 0;
    for (let e = 0; e < poly.length; e++) {
      if (!outerEdge[e]) continue;          /* still starts an original edge */
      for (let s = 0; s < hw.length; s++) {
        const l = dist(hw[s], poly[e]);
        if (bestV >= 0 && l >= bestLen) continue;
        if (!seamIsClear(poly, hw[s], e, hw, pending)) continue;
        bestV = e; bestS = s; bestLen = l;
      }
    }
    if (bestV < 0) return null;

    const p = bestV;
    const outPoly = [], outEdge = [];
    for (let k = 0; k <= p; k++) { outPoly.push(poly[k]); outEdge.push(outerEdge[k]); }
    outEdge[p] = false;                     /* poly[p] now leads into the hole */
    for (let k = 0; k < hw.length; k++) {
      outPoly.push(hw[(bestS + k) % hw.length]);
      outEdge.push(false);
    }
    outPoly.push(hw[bestS]); outEdge.push(false);   /* close the hole */
    /* Back out along the seam. This copy of poly[p] carries on round the
       original boundary, but it is no longer landable: a second seam arriving
       at the same vertex would make two zero-width channels meet at a point,
       which is the same earless polygon as landing on a seam. */
    outPoly.push(poly[p]); outEdge.push(false);
    for (let k = p + 1; k < poly.length; k++) { outPoly.push(poly[k]); outEdge.push(outerEdge[k]); }

    poly = outPoly;
    outerEdge = outEdge;
  }
  return poly;
}

/* Triangulates the flat region on its own, appending triangles at height `z`
   wound counter-clockwise when `up`. */
export function triangulate(m, region, z, up) {
  if (!region || region.outer.length < 3) return false;
  const poly = bridgeHoles(region);
  if (!poly) return false;
  return earClip(poly, m, z, up);
}

/* ---- extrusion --------------------------------------------------------- */

/* One loop's worth of wall. The loop must already be wound the way the region
   wants it -- anticlockwise outside, clockwise for a hole -- and that alone
   decides which way the wall faces: a hole is just a boundary walked the other
   way round, so the same two triangles serve both. Flipping the pattern as
   well would turn the bore inside out. */
function wallFromLoop(m, p, z0, z1) {
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    const a0 = { x: a.x, y: a.y, z: z0 }, a1 = { x: a.x, y: a.y, z: z1 };
    const b0 = { x: b.x, y: b.y, z: z0 }, b1 = { x: b.x, y: b.y, z: z1 };
    addTri(m, a0, b0, b1);
    addTri(m, a0, b1, a1);
  }
}

/* Sweeps `region` from z0 to z1 and appends the resulting closed solid: a
   floor, a ceiling and a wall around the outer boundary and every hole. */
export function extrude(m, region, z0, z1) {
  if (!region || region.outer.length < 3 || Math.abs(z1 - z0) < WELD) return false;
  if (z1 < z0) { const t = z0; z0 = z1; z1 = t; }

  const before = m.verts.length;
  /* The floor faces down and the ceiling up, so one is wound the other way. */
  if (!triangulate(m, region, z0, false)) { m.verts.length = before; return false; }
  if (!triangulate(m, region, z1, true)) { m.verts.length = before; return false; }

  wallFromLoop(m, wound(region.outer, true), z0, z1);
  for (const hole of region.holes) {
    if (hole.length < 3) continue;
    wallFromLoop(m, wound(hole, false), z0, z1);
  }
  return true;
}

/* ---- closedness -------------------------------------------------------- */

function edgesAllMatched(m, strict) {
  const vn = m.verts.length;
  if (vn < 3) return false;

  /* Weld coincident corners so two triangles meeting along an edge agree
     about which edge it is. */
  const key = (v) => `${Math.round(v.x / WELD)},${Math.round(v.y / WELD)},${Math.round(v.z / WELD)}`;
  const ids = new Map();
  const id = new Int32Array(vn);
  for (let i = 0; i < vn; i++) {
    const k = key(m.verts[i]);
    let g = ids.get(k);
    if (g === undefined) { g = ids.size; ids.set(k, g); }
    id[i] = g;
  }

  const counts = new Map();
  for (let t = 0; t < vn / 3; t++) {
    const v0 = id[t * 3], v1 = id[t * 3 + 1], v2 = id[t * 3 + 2];
    /* A degenerate sliver has no edges to match. */
    if (v0 === v1 || v1 === v2 || v2 === v0) return false;
    for (const [a, b] of [[v0, v1], [v1, v2], [v2, v0]]) {
      const k = `${a}:${b}`;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  for (const [k, forward] of counts) {
    const [a, b] = k.split(":");
    const back = counts.get(`${b}:${a}`) || 0;
    if (forward !== back) return false;
    if (strict && forward !== 1) return false;
  }
  return true;
}

/* ONE closed surface: every directed edge matched by exactly one running the
   other way. This is the printability check. */
export const isClosed = (m) => edgesAllMatched(m, true);

/* Closed, allowing SEVERAL surfaces: for an assembly, where separate solids
   touch face to face. Coincident faces make an edge appear four times rather
   than two, which is not a hole and must not be read as one. */
export const shellsAreClosed = (m) => edgesAllMatched(m, false);

/* ---- binary STL -------------------------------------------------------- */

/* `name` goes in the 80-byte header, for anyone who opens it in a text
   editor. Returns the bytes. */
export function writeStl(m, name) {
  const tris = triCount(m);
  const buf = new ArrayBuffer(84 + tris * 50);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const header = `${name} -- Linkage Design`.slice(0, 79);
  for (let i = 0; i < header.length; i++) bytes[i] = header.charCodeAt(i) & 0x7f;
  view.setUint32(80, tris, true);

  let o = 84;
  for (let t = 0; t < tris; t++) {
    const a = m.verts[t * 3], b = m.verts[t * 3 + 1], c = m.verts[t * 3 + 2];
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
    const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz);
    if (nl > 0) { nx /= nl; ny /= nl; nz /= nl; }
    view.setFloat32(o, nx, true); view.setFloat32(o + 4, ny, true); view.setFloat32(o + 8, nz, true);
    o += 12;
    for (const p of [a, b, c]) {
      view.setFloat32(o, p.x, true);
      view.setFloat32(o + 4, p.y, true);
      view.setFloat32(o + 8, p.z, true);
      o += 12;
    }
    view.setUint16(o, 0, true);
    o += 2;
  }
  return bytes;
}

/* ---- outline builders -------------------------------------------------- */

export function circle(centre, radius, segments) {
  const n = Math.max(8, segments | 0);
  if (!(radius > WELD)) return [];
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    out.push({ x: centre.x + radius * Math.cos(a), y: centre.y + radius * Math.sin(a) });
  }
  return out;
}

/* A capsule: the points within `radius` of the segment a..b. Also the shape of
   a two-pin link and of a slot a pin runs in. */
export function stadium(a, b, radius, capSegments) {
  const seg = Math.max(3, capSegments | 0);
  if (!(radius > WELD)) return [];
  const d = sub(b, a);
  const l = len(d);
  if (l < WELD) return circle(a, radius, seg * 2 + 2);
  const theta = Math.atan2(d.y, d.x);
  const out = [];
  /* Round the far end, then the near one; sweeping anticlockwise from the
     right-hand side of the axis keeps the whole loop anticlockwise. */
  for (let i = 0; i <= seg; i++) {
    const t = theta - Math.PI / 2 + (Math.PI * i) / seg;
    out.push({ x: b.x + radius * Math.cos(t), y: b.y + radius * Math.sin(t) });
  }
  for (let i = 0; i <= seg; i++) {
    const t = theta + Math.PI / 2 + (Math.PI * i) / seg;
    out.push({ x: a.x + radius * Math.cos(t), y: a.y + radius * Math.sin(t) });
  }
  return out;
}

/* Andrew's monotone chain, anticlockwise. Collinear points are dropped, so a
   bar's three pins give a hull of two and coincident pins a hull of one. */
function convexHull(pts) {
  if (pts.length < 1) return [];
  if (pts.length === 1) return [pts[0]];
  const s = pts.slice().sort((a, b) => (a.x - b.x) || (a.y - b.y));
  const hull = [];
  for (let i = 0; i < s.length; i++) {
    while (hull.length >= 2 &&
           cross(sub(hull[hull.length - 1], hull[hull.length - 2]),
                 sub(s[i], hull[hull.length - 2])) <= WELD) hull.pop();
    hull.push(s[i]);
  }
  const floorK = hull.length + 1;
  for (let i = s.length - 2; i >= 0; i--) {
    while (hull.length >= floorK &&
           cross(sub(hull[hull.length - 1], hull[hull.length - 2]),
                 sub(s[i], hull[hull.length - 2])) <= WELD) hull.pop();
    hull.push(s[i]);
  }
  let h = hull.length > 1 ? hull.length - 1 : hull.length;  /* closing point repeats */
  if (h >= 2 && samePoint(hull[0], hull[1])) h = 1;
  return hull.slice(0, h);
}

/* The convex hull of `pts` grown outwards by `radius`, with an arc at every
   corner -- the outline of a link plate with a round boss at each pin. Copes
   with one point (a disc) and with collinear points (a capsule). */
export function hullOffset(pts, radius, cornerSegments) {
  if (!pts || pts.length < 1 || !(radius > WELD)) return [];
  const seg = Math.max(2, cornerSegments | 0);
  const hull = convexHull(pts);
  if (hull.length === 1) return circle(hull[0], radius, seg * 4);
  if (hull.length === 2) return stadium(hull[0], hull[1], radius, seg * 2);

  const out = [];
  /* Push each edge out along its outward normal and join consecutive offsets
     with an arc: the boss at every pin, with flats between. */
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const d = sub(b, a);
    const l = len(d);
    if (l < WELD) continue;
    const nrm = { x: d.y / l, y: -d.x / l };   /* outward, anticlockwise hull */
    out.push(add(a, scale(nrm, radius)));
    out.push(add(b, scale(nrm, radius)));

    const e = sub(hull[(i + 2) % hull.length], b);
    const el = len(e);
    if (el < WELD) continue;
    const nrm2 = { x: e.y / el, y: -e.x / el };
    const a0 = Math.atan2(nrm.y, nrm.x), a1 = Math.atan2(nrm2.y, nrm2.x);
    let sweep = a1 - a0;
    while (sweep <= 0) sweep += 2 * Math.PI;
    while (sweep > 2 * Math.PI) sweep -= 2 * Math.PI;
    for (let k = 1; k < seg; k++) {
      const t = a0 + (sweep * k) / seg;
      out.push({ x: b.x + radius * Math.cos(t), y: b.y + radius * Math.sin(t) });
    }
  }
  return out;
}
