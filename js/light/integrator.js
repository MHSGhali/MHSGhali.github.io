/* The transport estimators, from src/integrator.c. */

import { PI } from "./core.js?v=265455f0";
import * as v from "./vec3.js?v=265455f0";
import * as S from "./spectrum.js?v=265455f0";
import * as L from "./light.js?v=265455f0";
import * as B from "./bsdf.js?v=265455f0";
import { intersect, occluded } from "./scene.js?v=265455f0";
import { cmfYbar } from "./color.js?v=265455f0";
import { KM_LM_PER_W } from "./core.js?v=265455f0";
import { offsetOrigin, makeHit } from "./geom.js?v=265455f0";
import * as R from "./rng.js?v=265455f0";

/* Which sampling strategies the path tracer uses to find emitted light.

   NEE and BSDF are each independently unbiased, so rendering the same scene
   three ways and requiring agreement is what catches MIS bookkeeping errors: a
   wrong weight makes MIS disagree with two strategies that cannot both be wrong
   in the same direction. MIS should also show the lowest variance. */
export const STRAT_BSDF = 1;
export const STRAT_NEE = 2;
export const STRAT_MIS = 3;

/* Power heuristic (beta = 2). Exposed so the tests can assert its partition of
   unity: misPower2(a,b) + misPower2(b,a) === 1. */
export function misPower2(pa, pb) {
  const a = pa * pa, b = pb * pb, d = a + b;
  return d > 0 ? a / d : 0;
}

const isDeltaLight = (l) =>
  l.kind === L.POINT || l.kind === L.SPOT || l.kind === L.DIRECTIONAL;

/* ------------------------------------------------------------------------
   Direct irradiance.

     E = integral over the hemisphere of L_i(p,w) cos(theta) dw

   estimated by next-event estimation against every light:

     E ~= sum over lights of (1/N) sum over samples of
              li_over_pdf * cos(theta_p) * V(p,y)

   Loops over ALL lights rather than selecting one stochastically: with a
   handful of lights that is lower variance, and it keeps the light-selection
   probability out of the estimator entirely.

   Delta lights are sampled exactly once -- their sample is deterministic, so
   averaging N copies would only waste work.

   `outScalars` receives one number per light: the mean of
   liOverPdfScalar * cos * V. Because every light's li_over_pdf is its sHat
   scaled by that number, and sHat integrates to 1, this array IS the C's
   `a_row` contribution matrix, and the spectrum is recovered exactly by
   irradianceSpectrum() below. Keeping the 95-bin array out of this loop is
   what makes the direct solve fast enough to run on every edit.
   ------------------------------------------------------------------------ */
export function estimateIrradianceScalars(sc, p, n, nsamples, rng, outScalars) {
  const s = L.makeSample();
  for (let li = 0; li < sc.lights.length; li++) {
    const l = sc.lights[li];
    const delta = isDeltaLight(l);
    const ns = delta ? 1 : nsamples;

    let sum = 0;
    for (let k = 0; k < ns; k++) {
      const u1 = delta ? 0 : R.f(rng);
      const u2 = delta ? 0 : R.f(rng);
      if (!L.sample(l, p, u1, u2, s)) continue;

      const cosP = v.dot(n, s.wi);
      if (cosP <= 0) continue; /* below the horizon */
      if (occluded(sc, p, n, s.wi, s.dist)) continue;

      sum += s.liOverPdfScalar * cosP;
    }
    outScalars[li] = sum / ns;
  }
  return outScalars;
}

/* Recover the spectral irradiance from a row of per-light scalars. */
export function irradianceSpectrum(sc, scalars, out = S.zero()) {
  out.fill(0);
  for (let li = 0; li < sc.lights.length; li++) {
    if (scalars[li] !== 0) S.addScaledInplace(out, sc.lights[li].sHat, scalars[li]);
  }
  return out;
}

/* The faithful spectral form, kept so the port can be checked against the C
   term by term. The field solver uses the scalar form above. */
export function estimateIrradiance(sc, p, n, nsamples, rng, outAcc, aRow) {
  outAcc.fill(0);
  const scalars = new Float64Array(sc.lights.length);
  estimateIrradianceScalars(sc, p, n, nsamples, rng, scalars);
  for (let li = 0; li < sc.lights.length; li++) {
    S.accAddScaled(outAcc, sc.lights[li].sHat, scalars[li]);
    if (aRow) aRow[li] = scalars[li] * S.integrate(sc.lights[li].sHat);
  }
  return outAcc;
}

/* ---- path tracing ---- */

const matOf = (sc, matId) => (matId >= 0 && matId < sc.mats.length ? sc.mats[matId] : null);

/* Deposit a contribution into the radiance accumulator and, if requested, into
   the emitting source's own column.

   `aRowLum` gets the same contribution measured photometrically. Both are
   linear functionals of the spectrum, so attributing them at the deposit -- the
   moment the emitting source is known -- is exact for both unit systems. The
   alternative, splitting a vertex's luminous total between sources afterwards
   in proportion to their radiometric share, is only exact when every source has
   the same spectrum. */
function deposit(out, aRow, aRowLum, beta, value, w, lightId, scratch) {
  const c = S.mul(beta, value, scratch);
  S.accAddScaled(out, c, w);
  if (lightId >= 0) {
    if (aRow) aRow[lightId] += S.integrate(c) * w;
    if (aRowLum) aRowLum[lightId] += KM_LM_PER_W * S.integrateWeighted(c, cmfYbar()) * w;
  }
}

/* Estimate spectral radiance arriving along `ray`, in W/(m^2 sr nm).

   `skipEmissionBefore`: emitted radiance is ignored at path vertices shallower
   than this. Used by the probe estimator, where direct light is already counted
   by explicit light sampling, so collecting emission at the first hit as well
   would double count it. */
export function traceRadiance(
  sc, ray, rng, maxDepth, strat, outAcc, aRow, skipEmissionBefore = 0, aRowLum = null
) {
  outAcc.fill(0);
  if (aRow) aRow.fill(0);
  if (aRowLum) aRowLum.fill(0);

  const beta = S.constant(1); /* path throughput, dimensionless */
  const f = S.zero();
  const le = S.zero();
  const cScratch = S.zero();
  const depositScratch = S.zero();
  const hit = makeHit();
  const r = { o: ray.o, d: ray.d, tmin: ray.tmin, tmax: ray.tmax };
  const s = L.makeSample();

  let prevDelta = true; /* camera vertex: emission counts */
  let pdfBsdfPrev = 0;
  const useNee = (strat & STRAT_NEE) !== 0;
  const useBsdf = (strat & STRAT_BSDF) !== 0;

  for (let depth = 0; ; depth++) {
    if (!intersect(sc, r, hit)) break;
    const m = matOf(sc, hit.matId);
    if (!m) break;

    /* Orient the shading frame against the incoming ray so both sides of a
       surface shade correctly. ng itself is never mutated. */
    const ns = hit.backface ? v.neg(hit.ng) : hit.ng;

    /* ---- emitted radiance found by scattering ---- */
    if (m.emissive && useBsdf && depth >= skipEmissionBefore) {
      let w = 1;
      if (!prevDelta && hit.lightId >= 0 && useNee) {
        /* hit.ng, NOT ns. pdfW returns 0 when the emitter is seen from behind;
           handing it the ray-facing normal makes that cosine positive on a
           backface hit, so BSDF sampling would claim a density for a connection
           NEE refuses to make, and the MIS weights would stop summing to one. */
        const pl = L.pdfW(sc.lights[hit.lightId], r.o, hit.p, hit.ng);
        w = misPower2(pdfBsdfPrev, pl);
      }
      /* Also hit.ng. `ns` has already been flipped to face the incoming ray, so
         dot(ns, -r.d) is >= 0 for every hit and this gate could never fire --
         emitters found by scattering would be effectively two-sided while
         light.radiance and light.pdfW treat them as one-sided, so NEE and BSDF
         sampling would disagree about the back of every area light. */
      if (v.dot(hit.ng, v.neg(r.d)) <= 0) le.fill(0);
      else S.copy(m.le, le);
      deposit(outAcc, aRow, aRowLum, beta, le, w, hit.lightId, depositScratch);
    }

    if (depth >= maxDepth) break;

    const fr = v.basis(ns);
    const wo = v.basisToLocal(fr, v.neg(r.d));
    if (wo.z <= 0) break;

    /* ---- next-event estimation ---- */
    if (useNee && !B.isDelta(m.bsdf)) {
      for (let li = 0; li < sc.lights.length; li++) {
        const l = sc.lights[li];
        if (!L.sample(l, hit.p, R.f(rng), R.f(rng), s)) continue;
        const wi = v.basisToLocal(fr, s.wi);
        if (wi.z <= 0) continue;
        if (occluded(sc, hit.p, ns, s.wi, s.dist)) continue;

        B.evalBsdf(m.bsdf, wo, wi, f);
        if (S.isBlack(f)) continue;

        let w = 1;
        if (s.pdfW > 0 && useBsdf) {
          /* Not a delta light, and BSDF sampling could also have found it:
             combine. Delta lights keep w = 1 because BSDF sampling can never
             hit them, so there is no double count. */
          w = misPower2(s.pdfW, B.pdfBsdf(m.bsdf, wo, wi));
        }
        /* c = f * li_over_pdf, and li_over_pdf is sHat scaled by the sample's
           scalar -- the same factorisation the direct estimator exploits. */
        S.mul(f, l.sHat, cScratch);
        S.scale(cScratch, s.liOverPdfScalar, cScratch);
        deposit(outAcc, aRow, aRowLum, beta, cScratch, w * wi.z, l.index, depositScratch);
      }
    }

    /* ---- continue the path ---- */
    const smp = B.sampleBsdf(m.bsdf, wo, R.f(rng), R.f(rng), f);
    if (!smp || smp.pdf <= 0) break;

    S.scale(f, smp.wi.z / smp.pdf, cScratch);
    S.mulInplace(beta, cScratch);
    prevDelta = B.isDelta(m.bsdf);
    pdfBsdfPrev = prevDelta ? 0 : smp.pdf;

    const wiW = v.basisToWorld(fr, smp.wi);
    r.o = offsetOrigin(hit.p, ns, wiW);
    r.d = wiW;
    r.tmin = 0;
    r.tmax = Infinity;

    /* ---- Russian roulette ----
       The survival probability is a SCALAR function of the throughput. A
       per-bin decision would decorrelate the wavelengths and destroy the
       meaning of the spectral throughput. Applied after both deposits. */
    if (depth >= 3) {
      const q = Math.min(0.95, S.max(beta));
      if (q <= 1e-6 || R.f(rng) >= q) break;
      S.scale(beta, 1 / q, beta);
    }
  }
  return outAcc;
}

/* Full spectral irradiance INCLUDING interreflection -- the quantity the
   analytic cos(theta)/r^2 model cannot produce.

     E = E_direct + E_indirect

   E_direct comes from explicit light sampling with visibility, so it accounts
   for shadowing. E_indirect cosine-samples the hemisphere and traces: with
   pdf = cos/pi the cosine cancels and the estimator is (pi/N) sum L_i, with
   first-hit emission suppressed so the two halves do not overlap. */
export function estimateIrradianceFull(
  sc, p, n, directSamples, indirectSamples, maxDepth, rng, outAcc, aRow
) {
  estimateIrradiance(sc, p, n, directSamples, rng, outAcc, aRow);
  if (indirectSamples <= 0 || maxDepth <= 0) return outAcc;

  const fr = v.basis(n);
  const ind = S.accZero();
  const row = aRow ? new Float64Array(sc.lights.length) : null;
  const L2 = S.accZero();

  for (let k = 0; k < indirectSamples; k++) {
    const wl = v.sampleHemisphereCosine(R.f(rng), R.f(rng));
    if (wl.z <= 0) continue;
    const wi = v.basisToWorld(fr, wl);
    const ray = { o: offsetOrigin(p, n, wi), d: wi, tmin: 0, tmax: Infinity };

    /* skipEmissionBefore = 1: the first hit's emission is direct light, already
       counted above. Everything deeper is genuine indirect. */
    traceRadiance(sc, ray, rng, maxDepth, STRAT_MIS, L2, row, 1);
    for (let b = 0; b < S.NBINS; b++) ind[b] += L2[b];
    if (aRow && row) {
      for (let i = 0; i < sc.lights.length; i++) aRow[i] += (row[i] * PI) / indirectSamples;
    }
  }

  const w = PI / indirectSamples;
  for (let b = 0; b < S.NBINS; b++) outAcc[b] += ind[b] * w;
  return outAcc;
}
