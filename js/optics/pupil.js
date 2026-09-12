/* Where on the rear element a sensor point can usefully aim. From
   src/os_pupil.c.

   THE INVARIANT THIS MODULE OWNS
     The cached bound always CONTAINS the true exit pupil for every sensor point
     in its zone. A loose bound costs only speed. A tight bound silently deletes
     light from the frame's corners -- and the result looks exactly like
     tasteful vignetting, which is why nobody would ever find it by looking.

   WHY IT EXISTS
     The naive approach samples the whole rear element uniformly. On axis that
     is fine; toward the corners most of the element is not reachable through
     the rest of the glass, and upwards of 90 % of rays are traced only to be
     thrown away at some interior surface.

     The lens is rotationally symmetric, so the reachable region depends only on
     the sensor point's RADIUS, and its azimuth just rotates the answer. Hence a
     table over radial zones, each holding an axis-aligned box, built once and
     rotated at sample time.

   SAMPLING STAYS UNBIASED
     Points are drawn uniformly inside the box and weighted by its area, so the
     estimator is unbiased for ANY box that contains the true pupil. Rays that
     fall inside the box but miss the real pupil are traced and rejected, which
     costs time and no accuracy. That asymmetry is why the build pads. */

import * as L from "./lens.js?v=58764426";
import { LINE_D } from "./glass.js?v=58764426";
import * as v from "../light/vec3.js?v=58764426";

/* Probes per axis per zone, and how far the found box is inflated, in grid
   cells. The C's values, kept.

   This is about 74 000 reverse lens traces and it reruns on every change to
   aperture, focus or focal length -- the three controls a visitor drags -- so
   it was the one budget worth measuring before trusting. It comes to ~14 ms,
   which is comfortably inside a debounce, and a coarser 16x24 grid saved 7 ms
   while making the mean box 15 % LOOSER, which is paid back many times over in
   rejected rays across a quarter of a million camera samples. So the cheaper
   grid is not actually cheaper.

   If this ever does need loosening, loosening is the safe direction: the
   padding is measured in CELLS, so a coarser grid pads more and stays a
   SUPERSET. Tightening it would delete light from the corners. */
export const GRID = 48;
export const ZONES = 32;
const PAD_CELLS = 2.0;

/* Build the table for this lens as currently scaled, stopped and focused. It
   belongs outside any render loop -- once per control change, in the worker. */
export function build(lens, filmRadiusMm, nzones = ZONES, grid = GRID) {
  if (nzones < 2) nzones = 2;
  const ns = lens.surf.length;
  const cache = {
    zone: new Float64Array(nzones * 4),      /* x0, x1, y0, y1 per zone */
    nzones,
    filmRadiusMm,
    rearZMm: L.vertexZ(lens, ns - 1),
  };

  const filmZ = L.filmZ(lens);
  const rearSemi = lens.surf[ns - 1].semiApMm;

  for (let z = 0; z < nzones; z++) {
    /* One representative sensor point per zone, on the +x axis. Rotational
       symmetry means every other azimuth is this answer, rotated. */
    const fr = (filmRadiusMm * z) / (nzones - 1);
    const film = v.v3(fr, 0, filmZ);

    let loX = Infinity, hiX = -Infinity, loY = Infinity, hiY = -Infinity;
    let any = false;

    for (let iy = 0; iy < grid; iy++) {
      const ry = -rearSemi + 2 * rearSemi * ((iy + 0.5) / grid);
      for (let ix = 0; ix < grid; ix++) {
        const rx = -rearSemi + 2 * rearSemi * ((ix + 0.5) / grid);
        if (rx * rx + ry * ry > rearSemi * rearSemi) continue;

        const target = v.v3(rx, ry, cache.rearZMm);
        const r = { o: film, d: v.normalize(v.sub(target, film)) };
        /* Probed at the d line. The pupil moves by microns across the band,
           which the padding below absorbs; the superset property is asserted at
           400, 550 and 700 nm in the tests. */
        if (!L.traceReverse(lens, LINE_D, r, null)) continue;

        any = true;
        if (rx < loX) loX = rx;
        if (rx > hiX) hiX = rx;
        if (ry < loY) loY = ry;
        if (ry > hiY) hiY = ry;
      }
    }

    const o = z * 4;
    if (!any) {
      /* Nothing got through from this sensor radius -- it is outside the image
         circle. An empty box would be a zero-area sample, so the zone is marked
         degenerate and sample() reports zero area, which is the truthful
         answer: no light reaches there. */
      cache.zone[o] = 0; cache.zone[o + 1] = 0;
      cache.zone[o + 2] = 0; cache.zone[o + 3] = 0;
      continue;
    }

    /* THE padding. The grid finds the pupil only to within one cell, so an
       unpadded box is systematically too small -- and a too-small box darkens
       the frame edges in a way indistinguishable from real vignetting. Two
       cells is cheap insurance; the cost is a few percent more rejected
       rays. */
    const cell = (2 * rearSemi) / grid;
    const pad = PAD_CELLS * cell;
    cache.zone[o] = loX - pad; cache.zone[o + 1] = hiX + pad;
    cache.zone[o + 2] = loY - pad; cache.zone[o + 3] = hiY + pad;
  }
  return cache;
}

/* The bound for a sensor point at radius `rMm`, unrotated, written into `out`
   as [x0, x1, y0, y1] so the sampler allocates nothing per ray. */
export function bounds(c, rMm, out) {
  if (c.nzones <= 0) { out[0] = out[1] = out[2] = out[3] = 0; return out; }
  let t = c.filmRadiusMm > 0 ? rMm / c.filmRadiusMm : 0;
  if (t < 0) t = 0;
  if (t > 1) t = 1;

  /* Take the UNION of the two bracketing zones rather than interpolating
     between them. Interpolation can produce a box narrower than either
     neighbour where the pupil is changing shape quickly, which breaks the
     superset invariant exactly where it matters most. A union cannot. */
  const f = t * (c.nzones - 1);
  let i = Math.floor(f);
  if (i >= c.nzones - 1) i = c.nzones - 2;
  const a = i * 4, b = (i + 1) * 4;
  const zo = c.zone;

  out[0] = Math.min(zo[a], zo[b]);
  out[1] = Math.max(zo[a + 1], zo[b + 1]);
  out[2] = Math.min(zo[a + 2], zo[b + 2]);
  out[3] = Math.max(zo[a + 3], zo[b + 3]);
  return out;
}

const boundScratch = new Float64Array(4);

/* Sample a point on the rear plane for a sensor point at (fx, fy) mm, and
   report the area sampled over so the caller can weight by it. Writes
   [rx, ry, area] into `out`; returns false only when the zone is degenerate. */
export function sample(c, fxMm, fyMm, u1, u2, out) {
  if (c.nzones <= 0) return false;

  const r = Math.sqrt(fxMm * fxMm + fyMm * fyMm);
  const b = bounds(c, r, boundScratch);

  const w = b[1] - b[0], h = b[3] - b[2];
  if (!(w > 0) || !(h > 0)) { out[2] = 0; return false; }

  const px = b[0] + w * u1;
  const py = b[2] + h * u2;

  /* The box was found for a sensor point on the +x axis. Rotate it to this
     point's actual azimuth -- that is the whole payoff of the lens being
     rotationally symmetric. */
  if (r > 1e-12) {
    const ca = fxMm / r, sa = fyMm / r;
    out[0] = px * ca - py * sa;
    out[1] = px * sa + py * ca;
  } else {
    out[0] = px;
    out[1] = py;
  }
  out[2] = w * h;
  return true;
}
