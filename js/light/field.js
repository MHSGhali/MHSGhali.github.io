/* Per-surface illuminance fields.

   Each receiving primitive is tessellated once; the field is solved at every
   VERTEX and carried as a colour attribute, rather than painted into a UV
   texture. That choice matters for spheres: three.js's spherical UV unwrap
   would have to be inverted to find the world point behind each texel, and
   getting it subtly wrong is invisible until the shadow lands in the wrong
   place. A vertex already knows where it is.

   WHAT IS STORED, AND WHY
     direct[vertex][light]  the mean of liOverPdfScalar * cos * V
     indRad[vertex][light]  band integral of that light's indirect radiance
     indLum[vertex][light]  the ybar-weighted integral of the same

   Direct light is one scalar per light because a light sample's li_over_pdf is
   always the light's sHat scaled by a number (see light.js), so the spectrum
   factors out of the loop entirely.

   Indirect light cannot use that: it has been multiplied by spectral albedo on
   the way round, so it is no longer a multiple of any sHat. But the two numbers
   the page displays -- W/m^2 and lux -- are both LINEAR functionals of the
   spectrum, so accumulating those two integrals directly is exact, and costs
   two doubles per light per vertex instead of the 95 a spectrum would need.

   The pay-off: switching lux <-> W/m^2, or isolating one lamp's contribution,
   is a dot product over stored numbers. Neither re-solves anything. */

import { PI } from "./core.js?v=008be1e5";
import * as v from "./vec3.js?v=008be1e5";
import * as S from "./spectrum.js?v=008be1e5";
import * as U from "./units.js?v=008be1e5";
import * as I from "./integrator.js?v=008be1e5";
import * as R from "./rng.js?v=008be1e5";
import { offsetOrigin } from "./geom.js?v=008be1e5";
import { cmfYbar } from "./color.js?v=008be1e5";
import { KM_LM_PER_W } from "./core.js?v=008be1e5";

/* Same seed constant the C's grid uses, and the same rule: seeded from the
   POINT index, never a worker or tile id, so the result does not depend on how
   the work was scheduled. */
const SEED = 0x2545f4914f6cdd1dn;

export const QUALITY = {
  /* gridMax caps the measurement grid, which otherwise dominates: a 64x64 grid
     is 4096 points against a few hundred per drawn surface, so leaving it at
     full resolution makes the draft pass as slow as the fine one. */
  draft: { quadSeg: 20, diskSeg: 16, sphereSeg: [20, 14], direct: 12, gridMax: 24 },
  fine:  { quadSeg: 44, diskSeg: 36, sphereSeg: [44, 28], direct: 64, gridMax: 64 },
};

/* ---- tessellation: positions and normals in WORLD space ----------------

   Double precision, not float32, even though these arrays end up in a GPU
   buffer that is float32 either way. The solver traces a shadow ray from every
   vertex, and offsetOrigin lifts that ray off the surface by only 1e-9 of the
   point magnitude -- comfortably above double rounding, but BELOW the ~4e-9
   that float32 moves a vertex on a 0.06 m sphere. A vertex that rounds to just
   inside its own sphere self-occludes, so over half of a lit hemisphere's
   vertices came back shadowed and the part was covered in dark streaks. The
   renderer narrows these to float32 on the way to WebGL; the solve must not. */

function tessQuad(prim, seg) {
  const nv = (seg + 1) * (seg + 1);
  const pos = new Float64Array(nv * 3);
  const nor = new Float64Array(nv * 3);
  const idx = new Uint32Array(seg * seg * 6);
  let k = 0;
  for (let j = 0; j <= seg; j++) {
    for (let i = 0; i <= seg; i++, k++) {
      const a = (i / seg) * 2 - 1, b = (j / seg) * 2 - 1;
      const p = v.add(prim.c, v.add(v.scale(prim.ex, a), v.scale(prim.ey, b)));
      pos[k * 3] = p.x; pos[k * 3 + 1] = p.y; pos[k * 3 + 2] = p.z;
      nor[k * 3] = prim.n.x; nor[k * 3 + 1] = prim.n.y; nor[k * 3 + 2] = prim.n.z;
    }
  }
  /* Wind the triangles to agree with the primitive's own normal. cross(ex,ey)
     is not always +n -- the enclosure's ceiling has ex,ey in the same handedness
     as its floor but faces the other way -- and a face wound against its normal
     is culled from the side you are meant to see it from, so you end up looking
     at the unlit outside of a room instead of into it.

     The unflipped winding below, (a,c,b), faces MINUS cross(ex,ey): a and c
     differ in v, a and b in u, so (c-a) x (b-a) = ey x ex. Hence the flip is
     needed when cross(ex,ey) already points along n. */
  const flip = v.dot(v.cross(prim.ex, prim.ey), prim.n) > 0;
  let t = 0;
  for (let j = 0; j < seg; j++) {
    for (let i = 0; i < seg; i++) {
      const a = j * (seg + 1) + i, b = a + 1, c = a + seg + 1, d = c + 1;
      if (flip) {
        idx[t++] = a; idx[t++] = b; idx[t++] = c;
        idx[t++] = b; idx[t++] = d; idx[t++] = c;
      } else {
        idx[t++] = a; idx[t++] = c; idx[t++] = b;
        idx[t++] = b; idx[t++] = c; idx[t++] = d;
      }
    }
  }
  return { pos, nor, idx };
}

function tessDisk(prim, seg) {
  const rings = Math.max(4, Math.round(seg / 2));
  const nv = 1 + rings * seg;
  const pos = new Float64Array(nv * 3);
  const nor = new Float64Array(nv * 3);
  const idx = new Uint32Array(seg * 3 + (rings - 1) * seg * 6);
  const b = v.basis(prim.n);
  const put = (k, p) => {
    pos[k * 3] = p.x; pos[k * 3 + 1] = p.y; pos[k * 3 + 2] = p.z;
    nor[k * 3] = prim.n.x; nor[k * 3 + 1] = prim.n.y; nor[k * 3 + 2] = prim.n.z;
  };
  put(0, prim.c);
  let k = 1;
  for (let r = 1; r <= rings; r++) {
    const rad = (r / rings) * prim.r;
    for (let s = 0; s < seg; s++, k++) {
      const a = (s / seg) * 2 * PI;
      put(k, v.add(prim.c, v.add(v.scale(b.t, rad * Math.cos(a)), v.scale(b.b, rad * Math.sin(a)))));
    }
  }
  let t = 0;
  for (let s = 0; s < seg; s++) {
    idx[t++] = 0; idx[t++] = 1 + s; idx[t++] = 1 + ((s + 1) % seg);
  }
  for (let r = 1; r < rings; r++) {
    const a0 = 1 + (r - 1) * seg, b0 = 1 + r * seg;
    for (let s = 0; s < seg; s++) {
      const s1 = (s + 1) % seg;
      idx[t++] = a0 + s; idx[t++] = b0 + s; idx[t++] = a0 + s1;
      idx[t++] = a0 + s1; idx[t++] = b0 + s; idx[t++] = b0 + s1;
    }
  }
  return { pos, nor, idx };
}

function tessSphere(prim, segU, segV) {
  const nv = (segU + 1) * (segV + 1);
  const pos = new Float64Array(nv * 3);
  const nor = new Float64Array(nv * 3);
  const idx = new Uint32Array(segU * segV * 6);
  let k = 0;
  for (let j = 0; j <= segV; j++) {
    const theta = (j / segV) * PI;
    const st = Math.sin(theta), ct = Math.cos(theta);
    for (let i = 0; i <= segU; i++, k++) {
      const phi = (i / segU) * 2 * PI;
      const d = v.v3(st * Math.cos(phi), st * Math.sin(phi), ct);
      const p = v.add(prim.c, v.scale(d, prim.r));
      pos[k * 3] = p.x; pos[k * 3 + 1] = p.y; pos[k * 3 + 2] = p.z;
      nor[k * 3] = d.x; nor[k * 3 + 1] = d.y; nor[k * 3 + 2] = d.z;
    }
  }
  let t = 0;
  for (let j = 0; j < segV; j++) {
    for (let i = 0; i < segU; i++) {
      const a = j * (segU + 1) + i, b = a + 1, c = a + segU + 1, d = c + 1;
      idx[t++] = a; idx[t++] = c; idx[t++] = b;
      idx[t++] = b; idx[t++] = c; idx[t++] = d;
    }
  }
  return { pos, nor, idx };
}

/* A plane is unbounded; give it a finite patch around the scene so it can carry
   a field at all. */
function tessPlane(prim, seg, extent) {
  const b = v.basis(prim.n);
  return tessQuad(
    { c: prim.c, n: prim.n, ex: v.scale(b.t, extent), ey: v.scale(b.b, extent) },
    seg
  );
}

/* The measurement grid, sampled exactly where the C's grid_row samples it:
   at CELL CENTRES, p = o + u*(i+0.5)/nu + v*(j+0.5)/nv.

   Not at cell corners. A corner grid puts vertices on the boundary of the
   measured area, which in an enclosed scene lands them inside the walls, fully
   occluded and reading zero -- and one zero drives U0 and Ud to zero however
   well lit the rest of the plane is. Sampling centres also makes these numbers
   directly comparable with the CLI's. */
export function tessGrid(g, cap = Infinity) {
  const nu = Math.max(1, Math.min(g.nu | 0, cap)), nv = Math.max(1, Math.min(g.nv | 0, cap));
  const n = v.normalize(v.cross(g.u, g.v));
  const pos = new Float64Array(nu * nv * 3);
  const nor = new Float64Array(nu * nv * 3);
  let k = 0;
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++, k++) {
      const p = v.add(g.o, v.add(v.scale(g.u, (i + 0.5) / nu), v.scale(g.v, (j + 0.5) / nv)));
      pos[k * 3] = p.x; pos[k * 3 + 1] = p.y; pos[k * 3 + 2] = p.z;
      nor[k * 3] = n.x; nor[k * 3 + 1] = n.y; nor[k * 3 + 2] = n.z;
    }
  }
  /* Never drawn, so it needs no triangles. */
  return { pos, nor, idx: new Uint32Array(0) };
}

export function tessellate(prim, q, extent = 1) {
  switch (prim.kind) {
    case "quad": return tessQuad(prim, q.quadSeg);
    case "disk": return tessDisk(prim, q.diskSeg);
    case "sphere": return tessSphere(prim, q.sphereSeg[0], q.sphereSeg[1]);
    case "plane": return tessPlane(prim, q.quadSeg, extent);
  }
  return tessQuad(prim, q.quadSeg);
}

/* ---- solving ----------------------------------------------------------- */

/* Per-light constants, so a stored scalar becomes a displayed number by one
   multiply. Computed once per solve, not per vertex. */
export function lightWeights(scene) {
  const rad = new Float64Array(scene.lights.length);
  const lum = new Float64Array(scene.lights.length);
  scene.lights.forEach((l, i) => {
    rad[i] = U.radiometric(l.sHat);
    lum[i] = U.photometric(l.sHat);
  });
  return { rad, lum };
}

/* Direct illuminance at every vertex of one surface. Fills `direct`, laid out
   vertex-major: direct[vi * nlights + li]. */
export function solveDirect(scene, mesh, direct, nsamples, vertexBase) {
  const nl = scene.lights.length;
  const nv = mesh.pos.length / 3;
  const row = new Float64Array(nl);
  for (let vi = 0; vi < nv; vi++) {
    const p = v.v3(mesh.pos[vi * 3], mesh.pos[vi * 3 + 1], mesh.pos[vi * 3 + 2]);
    const n = v.v3(mesh.nor[vi * 3], mesh.nor[vi * 3 + 1], mesh.nor[vi * 3 + 2]);
    /* Seeded from the vertex's global index, so the field does not change when
       the work is split differently between passes. */
    const rng = R.seed(SEED, BigInt(vertexBase + vi + 1));
    I.estimateIrradianceScalars(scene, p, n, nsamples, rng, row);
    for (let li = 0; li < nl; li++) direct[vi * nl + li] = row[li];
  }
  return direct;
}

/* One progressive pass of indirect light, ADDED to the running sums. `pass` is
   the pass number, so each one draws a fresh stream but stays reproducible.

   Cosine-samples the hemisphere: with pdf = cos/pi the cosine in the
   irradiance integral cancels and the estimator is (pi/N) sum L_i, with
   first-hit emission suppressed because direct light already counted it. */
export function solveIndirectPass(
  scene, mesh, indRad, indLum, samples, maxDepth, pass, vertexBase
) {
  const nl = scene.lights.length;
  const nv = mesh.pos.length / 3;
  /* traceRadiance zeroes its accumulators on entry, as the C does, so each
     sample needs its own temporaries and the running sums are added here. */
  const rowRad = new Float64Array(nl);
  const rowLum = new Float64Array(nl);
  const sumRad = new Float64Array(nl);
  const sumLum = new Float64Array(nl);
  const acc = S.accZero();
  const w = PI / samples;

  for (let vi = 0; vi < nv; vi++) {
    const p = v.v3(mesh.pos[vi * 3], mesh.pos[vi * 3 + 1], mesh.pos[vi * 3 + 2]);
    const n = v.v3(mesh.nor[vi * 3], mesh.nor[vi * 3 + 1], mesh.nor[vi * 3 + 2]);
    const fr = v.basis(n);
    const rng = R.seed(SEED, BigInt((pass + 1) * 1000003 + vertexBase + vi + 1));

    sumRad.fill(0);
    sumLum.fill(0);
    for (let k = 0; k < samples; k++) {
      const wl = v.sampleHemisphereCosine(R.f(rng), R.f(rng));
      if (wl.z <= 0) continue;
      const wi = v.basisToWorld(fr, wl);
      const ray = { o: offsetOrigin(p, n, wi), d: wi, tmin: 0, tmax: Infinity };
      /* skipEmissionBefore = 1: the first hit's emission is direct light, which
         solveDirect already counted, so collecting it here would double it. */
      I.traceRadiance(scene, ray, rng, maxDepth, I.STRAT_MIS, acc, rowRad, 1, rowLum);
      for (let li = 0; li < nl; li++) { sumRad[li] += rowRad[li]; sumLum[li] += rowLum[li]; }
    }
    for (let li = 0; li < nl; li++) {
      indRad[vi * nl + li] += sumRad[li] * w;
      indLum[vi * nl + li] += sumLum[li] * w;
    }
  }
}

/* Collapse the stored per-light rows into one displayed number per vertex.

   This is the whole point of storing attribution rather than a spectrum:
   changing units, or isolating one lamp, is this loop -- not a re-solve. */
export function shade(
  out, direct, indRad, indLum, weights, nl, nverts, photometric, includeIndirect, mask
) {
  const dw = photometric ? weights.lum : weights.rad;
  for (let vi = 0; vi < nverts; vi++) {
    let sum = 0;
    for (let li = 0; li < nl; li++) {
      if (mask && !mask[li]) continue;
      sum += direct[vi * nl + li] * dw[li];
      if (includeIndirect) {
        sum += photometric ? indLum[vi * nl + li] : indRad[vi * nl + li];
      }
    }
    out[vi] = sum;
  }
  return out;
}
