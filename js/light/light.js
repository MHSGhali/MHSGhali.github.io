/* Emitters, from src/light.c.

   FLUX/SHAPE FACTORISATION (the central anti-foot-gun):
     Every light stores its total RADIANT flux `phiE` in watts, separately from a
     normalised spectral shape `sHat` whose band integral is exactly 1. Spectral
     radiant intensity is therefore always phiE * sHat(lambda) * dOmega, and
     there is no other way to spell it.

     A light specified in lumens is converted to watts by units.wattsFromLumens
     BEFORE it reaches a constructor, so lumens are never stored and this file
     stays free of photometric constants entirely.

     finalize() re-derives the emitted flux from the light's geometry and throws
     if it disagrees with phiE. That catches the classic normalisation bugs
     (I0 = phi/4pi used for a spot, a two-sided area light emitting double) at
     scene-build time rather than as a plausible-looking wrong number. The C
     does this with an assert compiled out under NDEBUG; here it always runs,
     because a scene is built from visitor input rather than from a file an
     author checked.

   THE SCALAR FACTORISATION THIS PORT RELIES ON:
     In every branch of sample(), `li_over_pdf` is `sHat` scaled by a single
     number. So the sample carries that number as `liOverPdfScalar` and the
     caller decides whether it needs the spectrum at all. Direct lighting does
     not -- it accumulates one scalar per light and combines spectra once, at
     the end -- which is what keeps the 95-bin loop out of the hot path. */

import { PI, TWO_PI, INV_4PI } from "./core.js?v=408e651f";
import * as v from "./vec3.js?v=408e651f";
import * as S from "./spectrum.js?v=408e651f";

export const POINT = "point";             /* isotropic delta source */
export const DIRECTIONAL = "directional"; /* delta direction, infinitely far */
export const SPOT = "spot";               /* delta position, cone + smoothstep */
export const SPHERE = "sphere";           /* uniform-radiance sphere */
export const DISK = "disk";               /* one-sided Lambertian disk */
export const RECT = "rect";               /* one-sided Lambertian parallelogram */

function base(kind, spd) {
  return {
    kind, sHat: spd, phiE: 0, ePerp: 0,
    p: v.v3(0, 0, 0), n: v.v3(0, 0, 1), ex: v.v3(0, 0, 0), ey: v.v3(0, 0, 0),
    radius: 0, cosTotal: -1, cosFalloff: -1, omegaEff: 0,
    area: 0, radiance: 0, index: -1,
  };
}

export function point(p, phiEW, spd) {
  const l = base(POINT, spd);
  l.p = p; l.phiE = phiEW;
  return l;
}
export function directional(dir, ePerp, spd) {
  const l = base(DIRECTIONAL, spd);
  l.n = v.normalize(dir); /* direction of propagation */
  l.ePerp = ePerp;
  return l;
}
export function spot(p, dir, coneTotalRad, coneFalloffRad, phiEW, spd) {
  const l = base(SPOT, spd);
  l.p = p; l.n = v.normalize(dir); l.phiE = phiEW;
  l.cosTotal = Math.cos(coneTotalRad);
  l.cosFalloff = Math.cos(Math.min(coneFalloffRad, coneTotalRad));
  return l;
}
export function sphere(c, radius, phiEW, spd) {
  const l = base(SPHERE, spd);
  l.p = c; l.radius = radius; l.phiE = phiEW;
  return l;
}
export function disk(c, n, radius, phiEW, spd) {
  const l = base(DISK, spd);
  l.p = c; l.n = v.normalize(n); l.radius = radius; l.phiE = phiEW;
  return l;
}
export function rect(c, ex, ey, phiEW, spd) {
  const l = base(RECT, spd);
  l.p = c; l.ex = ex; l.ey = ey; l.phiE = phiEW;
  l.n = v.normalize(v.cross(ex, ey));
  return l;
}

/* 1 inside the inner cone, smoothstep to 0 at the outer cone. */
function spotFalloff(l, cosTheta) {
  if (cosTheta <= l.cosTotal) return 0;
  if (cosTheta >= l.cosFalloff) return 1;
  const t = (cosTheta - l.cosTotal) / (l.cosFalloff - l.cosTotal);
  return t * t * (3 - 2 * t);
}

/* Integral of the spot falloff over the sphere:
     omegaEff = 2 pi * integral_{cosTotal}^{1} f(mu) dmu
   Exactly 2 pi (1 - cosTotal) for a hard-edged cone; the smoothstep region is
   integrated numerically. */
function spotOmegaEff(l) {
  if (l.cosFalloff <= l.cosTotal) return TWO_PI * (1 - l.cosTotal);
  const hard = TWO_PI * (1 - l.cosFalloff);
  const N = 4096;
  const a = l.cosTotal, b = l.cosFalloff;
  let sum = 0;
  for (let i = 0; i < N; i++) sum += spotFalloff(l, a + (b - a) * ((i + 0.5) / N));
  return hard + (TWO_PI * sum * (b - a)) / N;
}

/* Total radiant flux implied by the light's geometry and radiance. Used by
   finalize's self-check and by the tests. */
export function emittedFlux(l) {
  switch (l.kind) {
    case POINT:       return l.phiE * INV_4PI * 4 * PI;                 /* I * 4pi */
    case SPOT:        return (l.omegaEff > 0 ? l.phiE / l.omegaEff : 0) * l.omegaEff;
    case DIRECTIONAL: return 0; /* infinite extent: flux is not defined */
    case SPHERE: case DISK: case RECT:
      /* A Lambertian emitter of uniform radiance L over area A radiates
         L * A * pi into the hemisphere above each surface element. */
      return l.radiance * l.area * PI;
  }
  return 0;
}

/* Normalise sHat, derive area/radiance/omegaEff, and check the flux implied by
   the geometry equals phiE. Call once per light after construction. */
export function finalize(l, index) {
  l.index = index;
  l.sHat = S.normalizeTo(S.copy(l.sHat), 1.0);

  switch (l.kind) {
    case SPOT:
      l.omegaEff = spotOmegaEff(l);
      break;
    case SPHERE:
      l.area = 4 * PI * l.radius * l.radius;
      /* phi = L * A * pi  =>  L = phi / (4 pi^2 R^2) */
      l.radiance = l.area > 0 ? l.phiE / (l.area * PI) : 0;
      break;
    case DISK:
      l.area = PI * l.radius * l.radius;
      l.radiance = l.area > 0 ? l.phiE / (l.area * PI) : 0;
      break;
    case RECT:
      l.area = 4 * v.len(v.cross(l.ex, l.ey));
      l.radiance = l.area > 0 ? l.phiE / (l.area * PI) : 0;
      break;
  }

  if (l.kind !== DIRECTIONAL) {
    const got = emittedFlux(l);
    if (Math.abs(got - l.phiE) > 1e-9 * Math.max(1, Math.abs(l.phiE))) {
      throw new Error(
        `light flux normalisation is inconsistent with its geometry: ` +
        `${l.kind} declares ${l.phiE} W but its geometry radiates ${got} W`
      );
    }
  }
  const bandIntegral = S.integrate(l.sHat);
  if (Math.abs(bandIntegral - 1) > 1e-5) {
    throw new Error(`spectral shape is not normalised: band integral ${bandIntegral}`);
  }
  return l;
}

/* Radiant intensity in direction `w` (unit, pointing away from the light).
   Defined for the delta kinds; area lights return their on-axis equivalent. */
export function intensity(l, w) {
  switch (l.kind) {
    case POINT: return l.phiE * INV_4PI;
    case SPOT:  return l.omegaEff > 0 ? (l.phiE / l.omegaEff) * spotFalloff(l, v.dot(w, l.n)) : 0;
    case DIRECTIONAL: return 0;
    case SPHERE: return l.radiance * PI * l.radius * l.radius;
    case DISK: case RECT: return l.radiance * l.area * Math.max(0, v.dot(w, l.n));
  }
  return 0;
}

/* Solid-angle pdf of having sampled the point `y` (normal `ny`) on this light
   from `ref`. Needed for the MIS weight applied to emission found by BSDF
   sampling. Returns 0 for delta lights, which BSDF sampling can never hit. */
export function pdfW(l, ref, y, ny) {
  switch (l.kind) {
    case POINT: case SPOT: case DIRECTIONAL:
      return 0; /* delta: unreachable by sampling */
    case SPHERE: case DISK: case RECT: {
      const d = v.sub(y, ref);
      const d2 = v.len2(d);
      if (d2 <= 0 || l.area <= 0) return 0;
      const wi = v.scale(d, 1 / Math.sqrt(d2));
      const cosY = v.dot(ny, v.neg(wi));
      if (cosY <= 0) return 0;
      return v.pdfAreaToSolidAngle(1 / l.area, d2, cosY);
    }
  }
  return 0;
}

/* Emitted spectral radiance leaving this light in direction `w` (unit, away
   from the surface with normal `ny`). Zero behind a one-sided emitter. */
export function radiance(l, ny, w, out = S.zero()) {
  switch (l.kind) {
    case SPHERE: case DISK: case RECT:
      if (v.dot(ny, w) <= 0) { out.fill(0); return out; } /* one-sided */
      return S.scale(l.sHat, l.radiance, out);
    default:
      out.fill(0); /* delta lights have no radiance */
      return out;
  }
}

/* Sample the light as seen from `p`. Returns false if the sample cannot
   contribute (back face, degenerate geometry, outside a spot cone).

   Fills `s` with:
     wi                unit, from the shading point toward the light
     dist              to the sampled point; Infinity for directional
     liOverPdfScalar   the scalar such that li_over_pdf == sHat * this
     pdfW              solid-angle pdf; EXACTLY 0 => delta light
     lightIndex

   `pdfW === 0` marks a delta light. Encoding it that way rather than as a
   boolean means a caller who forgets to check divides by zero (loud) instead of
   computing a silently wrong MIS weight (quiet).

   `liOverPdfScalar` is defined so a sample's contribution to irradiance is
   EXACTLY liOverPdfScalar * sHat * cos(theta at the receiver). For area lights
   it is L/pdf_w; for delta lights I/r^2. One convention for both means the
   estimator has a single code path. */
export function sample(l, p, u1, u2, s) {
  s.lightIndex = l.index;

  switch (l.kind) {
    case POINT: {
      const d = v.sub(l.p, p);
      const d2 = v.len2(d);
      if (d2 <= 0) return false;
      const dist = Math.sqrt(d2);
      s.wi = v.scale(d, 1 / dist);
      s.dist = dist;
      s.pdfW = 0;
      s.liOverPdfScalar = (l.phiE * INV_4PI) / d2;
      return true;
    }
    case SPOT: {
      const d = v.sub(l.p, p);
      const d2 = v.len2(d);
      if (d2 <= 0) return false;
      const dist = Math.sqrt(d2);
      s.wi = v.scale(d, 1 / dist);
      /* Direction from the light toward the receiver is -wi. */
      const f = spotFalloff(l, v.dot(v.neg(s.wi), l.n));
      if (f <= 0) return false;
      s.dist = dist;
      s.pdfW = 0;
      const i0 = l.omegaEff > 0 ? l.phiE / l.omegaEff : 0;
      s.liOverPdfScalar = (i0 * f) / d2;
      return true;
    }
    case DIRECTIONAL: {
      s.wi = v.neg(l.n); /* toward the source */
      s.dist = Infinity;
      s.pdfW = 0;
      s.liOverPdfScalar = l.ePerp;
      return true;
    }
    case SPHERE: {
      /* Uniform area sampling over the whole sphere. Points on the far side
         come out back-facing and are rejected; that halves the sample
         efficiency but keeps the estimator unbiased and the code honest. Cone
         sampling is a variance optimisation for later. */
      const dir = v.sampleSphereUniform(u1, u2);
      const y = v.add(l.p, v.scale(dir, l.radius));
      const dv = v.sub(y, p);
      const d2 = v.len2(dv);
      if (d2 <= 0) return false;
      const dist = Math.sqrt(d2);
      s.wi = v.scale(dv, 1 / dist);
      const cosY = v.dot(dir, v.neg(s.wi));
      if (cosY <= 0) return false; /* back face */
      s.pdfW = v.pdfAreaToSolidAngle(1 / l.area, d2, cosY);
      if (s.pdfW <= 0) return false;
      s.dist = dist;
      s.liOverPdfScalar = l.radiance / s.pdfW;
      return true;
    }
    case DISK: {
      const dd = v.sampleDiskConcentric(u1, u2);
      const b = v.basis(l.n);
      const y = v.add(l.p, v.add(v.scale(b.t, dd.x * l.radius), v.scale(b.b, dd.y * l.radius)));
      const dv = v.sub(y, p);
      const d2 = v.len2(dv);
      if (d2 <= 0) return false;
      const dist = Math.sqrt(d2);
      s.wi = v.scale(dv, 1 / dist);
      const cosY = v.dot(l.n, v.neg(s.wi));
      if (cosY <= 0) return false; /* one-sided */
      s.pdfW = v.pdfAreaToSolidAngle(1 / l.area, d2, cosY);
      if (s.pdfW <= 0) return false;
      s.dist = dist;
      s.liOverPdfScalar = l.radiance / s.pdfW;
      return true;
    }
    case RECT: {
      const a = 2 * u1 - 1, b = 2 * u2 - 1;
      const y = v.add(l.p, v.add(v.scale(l.ex, a), v.scale(l.ey, b)));
      const dv = v.sub(y, p);
      const d2 = v.len2(dv);
      if (d2 <= 0) return false;
      const dist = Math.sqrt(d2);
      s.wi = v.scale(dv, 1 / dist);
      const cosY = v.dot(l.n, v.neg(s.wi));
      if (cosY <= 0) return false; /* one-sided */
      s.pdfW = v.pdfAreaToSolidAngle(1 / l.area, d2, cosY);
      if (s.pdfW <= 0) return false;
      s.dist = dist;
      s.liOverPdfScalar = l.radiance / s.pdfW;
      return true;
    }
  }
  return false;
}

export const makeSample = () => ({
  wi: null, dist: 0, liOverPdfScalar: 0, pdfW: 0, lightIndex: -1,
});
