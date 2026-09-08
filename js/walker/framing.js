/* Camera framing for the walker background.

   Kept apart from the renderer, and free of three.js, for one reason: the
   question "is the creature actually on screen?" has a numeric answer, and a
   module that imports nothing can be asked it directly in a test rather than
   squinted at in a browser at one window size.

   An analytic answer -- back off far enough for the creature's half-height to
   fit the vertical field -- is wrong, and wrong in a way that only shows up on
   some screens. The camera looks DOWN at the creature and the crankshaft has
   depth, so what the frustum has to hold is not the creature's height but the
   projection of a tilted box, which is taller. Instead this projects the box's
   eight corners and backs off until they land inside the frame. The box is
   convex, so the extent of its projected corners IS the extent of its
   projection: eight points settle it exactly. */

/* The corners of the box one leg sweeps over a revolution, extended along the
   crankshaft. Callers pass the leg's swept extent so this stays honest if the
   linkage changes. */
export function sweptBox(legExtent, legCount, spacing) {
  const halfZ = ((legCount - 1) / 2) * spacing;
  const corners = [];
  for (const x of [legExtent.x0, legExtent.x1])
    for (const y of [legExtent.y0, legExtent.y1])
      for (const z of [-halfZ, halfZ]) corners.push({ x, y, z });
  return {
    corners,
    cx: (legExtent.x0 + legExtent.x1) / 2,
    cy: (legExtent.y0 + legExtent.y1) / 2,
    halfW: (legExtent.x1 - legExtent.x0) / 2 + halfZ * 0.34,
  };
}

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => ({
  x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x,
});
const norm = (a) => {
  const l = Math.hypot(a.x, a.y, a.z) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};

/* Normalised device extents of `corners` as seen by a camera at `eye` aimed at
   `at`. Anything at or behind the eye plane is skipped rather than projected
   through infinity. */
export function project(corners, eye, at, fovDeg, aspect) {
  const tanHalf = Math.tan((fovDeg * Math.PI) / 360);
  const f = norm(sub(at, eye));
  const r = norm(cross(f, { x: 0, y: 1, z: 0 }));
  const u = cross(r, f);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of corners) {
    const d = sub(p, eye);
    const zv = dot(d, f);
    if (zv <= 1e-3) continue;
    const nx = dot(d, r) / zv / (tanHalf * aspect);
    const ny = dot(d, u) / zv / tanHalf;
    if (nx < x0) x0 = nx;
    if (nx > x1) x1 = nx;
    if (ny < y0) y0 = ny;
    if (ny > y1) y1 = ny;
  }
  return { x0, x1, y0, y1 };
}

/* Where to put the camera so the creature is wholly visible and sits in the
   right-hand part of the frame. `bodyX` slides the whole answer along with the
   walking creature; everything else depends only on the aspect, so a caller
   can compute this once per resize.

   `fill` is how much of the frame the creature should occupy, and `bias` how
   far right of centre to push it, as a share of the visible half-width. Both
   are capped by the same projection test, so neither can push it off screen. */
/* Rotate a point about the box centre, yaw first then pitch about the yawed
   right axis -- the same order the renderer turns the camera rig in. */
function spinAbout(p, box, yaw, pitch) {
  let x = p.x - box.cx, y = p.y - box.cy, z = p.z;
  const cy1 = Math.cos(yaw), sy = Math.sin(yaw);
  let nx = x * cy1 + z * sy;
  let nz = -x * sy + z * cy1;
  x = nx; z = nz;
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  /* about the yawed right axis, which after the yaw above is world +x */
  const ny = y * cp - z * sp;
  nz = y * sp + z * cp;
  return { x: x + box.cx, y: ny + box.cy, z: nz };
}

export function fitCamera(box, aspect, opts = {}) {
  const fovDeg = opts.fovDeg ?? 34;
  const fill = opts.fill ?? 0.86;      /* leave a margin all round */
  /* Horizontal and vertical are not the same question. Fitting the whole swept
     box in BOTH leaves the creature small enough that six legs superimpose into
     a knot. Vertically it must stay inside the frame -- crop the feet and it
     stops reading as something that walks. Horizontally the extremes are the
     ends of the crankshaft, a straight bar whose ends carry no information, so
     letting those run past the edge buys the scale back for free.
     fillX above 1 therefore means "allowed to overflow"; fillY never should. */
  const fillX = opts.fillX ?? fill;
  const fillY = opts.fillY ?? fill;
  const bias = opts.bias ?? 0.46;
  const yaw = opts.yaw ?? 0.36;        /* camera x offset as a share of distance */
  const rise = opts.rise ?? 105;       /* how far above the creature's centre  */
  const tanHalf = Math.tan((fovDeg * Math.PI) / 360);

  /* Turning the view changes what the frustum has to hold: seen down the
     crankshaft, six legs that were stacked behind one another become a row
     nearly three times as wide. Fitting the corners as the visitor has
     actually turned them is what keeps the creature framed at every angle
     instead of only at the one it was designed at. */
  const corners = (opts.yaw || opts.pitch)
    ? box.corners.map((c) => spinAbout(c, box, opts.yaw || 0, opts.pitch || 0))
    : box.corners;

  let dist = (box.halfW * 1.4) / (tanHalf * Math.max(aspect, 0.2));
  let shift = 0, ndc = null;

  for (let iter = 0; iter < 60; iter++) {
    const halfViewW = dist * tanHalf * aspect;
    /* The guard keeps the shift from pushing the box off the far edge. It has
       to allow the same horizontal overflow fillX does, or a frame deliberately
       cropped sideways would collapse the bias to zero and re-centre the
       creature -- straight under the headline it is supposed to sit beside. */
    shift = Math.max(0, Math.min(halfViewW * fillX - box.halfW * 1.08, halfViewW * bias));
    const aim = box.cx - shift;
    const eye = { x: aim + dist * yaw, y: box.cy + rise, z: dist };
    const at = { x: aim, y: box.cy - 6, z: 0 };
    ndc = project(corners, eye, at, fovDeg, aspect);
    const over = Math.max(
      Math.max(-ndc.x0, ndc.x1) / fillX,
      Math.max(-ndc.y0, ndc.y1) / fillY,
    );
    /* Converge from BOTH sides. Only ever backing away leaves the creature
       tiny at the angles where it is narrower than the estimate assumed --
       turned end-on to the crankshaft it filled barely a quarter of the frame.
       The projection scales as roughly 1/distance, so `over` is very nearly
       the correction factor and this settles in two or three passes. */
    if (Math.abs(over - 1) < 0.01) return { dist, shift, eye, at, ndc, fovDeg };
    dist *= Math.max(0.6, Math.min(over, 1.5));
  }
  return { dist, shift, ndc, fovDeg,
           eye: { x: box.cx - shift + dist * yaw, y: box.cy + rise, z: dist },
           at: { x: box.cx - shift, y: box.cy - 6, z: 0 } };
}
