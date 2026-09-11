/* A scalar path tracer, from src/os_trace.c.

   WHY THIS IS NOT js/light/integrator.js
     That integrator carries all 95 bins down one geometric path, which is valid
     because every SCENE material is non-dispersive. The invariant still holds.
     What broke is upstream of it: the LENS is dispersive, so ray GENERATION
     became wavelength dependent, and two rays leaving the rear element from the
     same sensor point at 450 nm and 650 nm go to different places in the world.
     Depositing 95 bins down one of them would average the scene over
     wavelengths that never travelled there -- which is precisely how you erase
     the chromatic aberration the lens exists to produce.

     So this one carries a single wavelength and returns a single number. It is
     otherwise the same estimator: next-event estimation plus BSDF sampling,
     combined with the power-2 MIS heuristic, Russian roulette from depth 3.

   THE DOME IS A STRATEGY, NOT A TERM
     The environment has no geometry, so it can never be hit and cannot live in
     the light array. It is one more entry in the strategy count: ONE strategy
     is drawn uniformly out of nstrat, and the sky is the last of them. Choosing
     among the lamps AND the sky with a single draw -- rather than always
     sampling the sky in addition -- is what keeps the estimator unbiased when
     both are present. */

import { PI, TWO_PI } from "../light/core.js?v=f56d3836";
import * as v from "../light/vec3.js?v=f56d3836";
import * as S from "../light/spectrum.js?v=f56d3836";
import * as B from "../light/bsdf.js?v=f56d3836";
import * as L from "../light/light.js?v=f56d3836";
import * as R from "../light/rng.js?v=f56d3836";
import { intersect, occluded } from "../light/scene.js?v=f56d3836";
import { offsetOrigin, makeHit } from "../light/geom.js?v=f56d3836";
import { envRadiance } from "./scenedesc.js?v=f56d3836";

/* Power-2 MIS heuristic. Squaring sharpens the crossover between the two
   strategies, which is what suppresses the fireflies a balance heuristic leaves
   behind on small bright sources. */
function mis2(a, b) {
  const a2 = a * a, b2 = b * b;
  const s = a2 + b2;
  return s > 0 ? a2 / s : 0;
}

/* Cosine-weighted hemisphere about +z, with its solid-angle pdf.

   The right sampler for a UNIFORM dome specifically: the estimator's cos/pdf
   collapses to exactly pi, so a sky costs one shadow ray and contributes no
   cosine noise of its own. Sampling the dome uniformly instead would put most
   of the samples near the horizon, where the cosine throws them away. */
function cosineHemisphere(u1, u2, out) {
  const r = Math.sqrt(u1), phi = TWO_PI * u2;
  const z2 = 1 - u1;
  out.x = r * Math.cos(phi);
  out.y = r * Math.sin(phi);
  out.z = Math.sqrt(z2 > 0 ? z2 : 0);
  return out.z / PI;                         /* the pdf */
}

/* Scratch, module-level so the render loop allocates nothing per ray. A trace
   is never re-entered, so sharing these is safe. */
const fScratch = S.zero();
const hit = makeHit();
const lsample = L.makeSample();
const wlScratch = { x: 0, y: 0, z: 0 };

/* A BSDF's value at one wavelength. The vendored evaluator works in whole
   spectra, so this reads the single bin back out -- the scene is
   non-dispersive, so the direction it sampled is right for every wavelength and
   only the value differs. */
function bsdfEval1(b, wo, wi, lambdaNm) {
  B.evalBsdf(b, wo, wi, fScratch);
  return S.at(fScratch, lambdaNm);
}

/* Estimate radiance arriving along `ray` at one wavelength, in
   W/(m^2 sr nm). */
export function radiance(sc, env, ray, lambdaNm, rng, maxDepth) {
  let out = 0;
  let beta = 1;                    /* path throughput, dimensionless */
  let prevWasDelta = true;         /* the camera ray: nothing to MIS against */
  let prevPdf = 0;
  /* The pdf next-event-toward-the-sky WOULD have had for the direction that got
     us here. Kept so an escaping ray can be weighted against the other strategy
     that could have found the sky. */
  let prevEnvPdf = 0;

  /* A dome at zero radiance is no dome. Dropping it from the strategy count
     here, rather than sampling it and adding zero, keeps the lamps-only
     estimator exactly what it was before the sky existed.

     Asked ONCE, with the camera ray's direction, and then held for the whole
     path -- which is sound only because the dome is uniform, so the answer does
     not depend on the direction it was asked about. envRadiance takes a
     direction anyway, as the seam a gradient sky would arrive at; if one ever
     does, this line has to become a per-vertex test or the strategy count will
     be wrong for every bounce after the first. */
  const haveEnv = env && env.on && envRadiance(env, ray.d, lambdaNm) > 0;
  const nstrat = sc.lights.length + (haveEnv ? 1 : 0);

  const r = { o: ray.o, d: ray.d, tmin: 0, tmax: Infinity };

  for (let depth = 0; depth < maxDepth; depth++) {
    if (!intersect(sc, r, hit)) {
      /* Escaped, so the sky is what is out there -- and it is the ONLY thing an
         escaping ray can see, which is what makes the dome cost nothing to look
         up.

         EXCEPT ON THE CAMERA RAY, which sees black. The dome lights the scene
         and is not photographed: a standard renderer's invisible environment,
         and here it earns its place by making the two lighting modes
         comparable. They exist to be set against each other, and while the sky
         was directly visible, switching between them changed the LIGHTING and
         the BACKDROP at once -- a flat grey field under the dome against black
         under the lamp. Two differences is one too many for an A-against-B, and
         the grey also drove the exposure, so the same number was wrong in one
         mode and right in the other.

         Only the directly visible term goes. Next-event estimation toward the
         dome is untouched, and so is every escaping ray at depth 1 or deeper,
         which is where indirect sky light comes from -- so the subjects are lit
         exactly as brightly as before. The estimator is unchanged; what changed
         is the definition of the picture. */
      if (haveEnv && depth > 0) {
        const w = prevWasDelta ? 1 : mis2(prevPdf, prevEnvPdf / nstrat);
        out += beta * envRadiance(env, r.d, lambdaNm) * w;
      }
      break;
    }

    const mat = sc.mats[hit.matId];
    if (!mat) break;

    /* ---- emission ----
       Taken only on a BSDF-sampled (or camera) ray. NEE already accounted for
       the light's contribution at the previous vertex, so adding it again here
       unweighted is the classic double count. */
    if (mat.emissive && hit.lightId >= 0) {
      const Le = S.at(mat.le, lambdaNm);
      if (prevWasDelta) {
        out += beta * Le;
      } else {
        /* Weight it against the probability NEE would have chosen this same
           point, so the two strategies sum to exactly one. hit.ng, NOT a
           ray-facing normal: pdfW returns 0 when the emitter is seen from
           behind, and handing it a flipped normal would claim a density for a
           connection NEE refuses to make. */
        const pdfL = L.pdfW(sc.lights[hit.lightId], r.o, hit.p, hit.ng) / nstrat;
        out += beta * Le * mis2(prevPdf, pdfL);
      }
    }

    /* Shading uses the geometric normal flipped to face the incoming ray.
       hit.ng is never flipped by the intersector -- that is its contract -- so
       the flip happens here, locally, and is not stored. */
    const ns = hit.backface ? v.neg(hit.ng) : hit.ng;
    const wo = v.neg(r.d);

    const onb = v.basis(ns);
    const woL = v.basisToLocal(onb, wo);

    /* ---- next event estimation ---- */
    if (nstrat > 0 && !B.isDelta(mat.bsdf)) {
      let li = Math.floor(R.f(rng) * nstrat);
      if (li >= nstrat) li = nstrat - 1;

      if (li >= sc.lights.length) {
        /* ---- the sky ---- */
        const pdfE = cosineHemisphere(R.f(rng), R.f(rng), wlScratch);
        const wiL = v.v3(wlScratch.x, wlScratch.y, wlScratch.z);
        const wi = v.basisToWorld(onb, wiL);
        /* Infinity because the dome is infinitely far: anything at all in the
           way occludes it, and there is no far end to stop short of. */
        if (pdfE > 0 && !occluded(sc, hit.p, hit.ng, wi, Infinity)) {
          const f = bsdfEval1(mat.bsdf, woL, wiL, lambdaNm);
          const le = envRadiance(env, wi, lambdaNm);
          let contrib = beta * f * wiL.z * (le / pdfE) * nstrat;
          const pdfB = B.pdfBsdf(mat.bsdf, woL, wiL);
          contrib *= mis2(pdfE / nstrat, pdfB);
          out += contrib;
        }
      } else {
        /* ---- a placed lamp ---- */
        const lt = sc.lights[li];
        if (L.sample(lt, hit.p, R.f(rng), R.f(rng), lsample)) {
          const cosAtP = v.dot(ns, lsample.wi);
          if (cosAtP > 0 && !occluded(sc, hit.p, hit.ng, lsample.wi, lsample.dist)) {
            const wiL = v.basisToLocal(onb, lsample.wi);
            const f = bsdfEval1(mat.bsdf, woL, wiL, lambdaNm);
            /* li_over_pdf is always this light's sHat scaled by one number, so
               reading it at a wavelength is that number times one bin -- the
               spectrum never has to be built. */
            const liOverPdf = lsample.liOverPdfScalar * S.at(lt.sHat, lambdaNm);
            /* One strategy was chosen out of nstrat uniformly, so the estimate
               is scaled back up by that count. */
            let contrib = beta * f * cosAtP * liOverPdf * nstrat;

            /* pdfW == 0 marks a DELTA light, which no BSDF sample can ever hit
               -- so there is nothing to weight against and NEE takes the whole
               contribution. */
            if (lsample.pdfW > 0) {
              const pdfB = B.pdfBsdf(mat.bsdf, woL, wiL);
              contrib *= mis2(lsample.pdfW / nstrat, pdfB);
            }
            out += contrib;
          }
        }
      }
    }

    /* ---- continue along a BSDF-sampled direction ---- */
    const smp = B.sampleBsdf(mat.bsdf, woL, R.f(rng), R.f(rng), fScratch);
    if (!smp || !(smp.pdf > 0)) break;

    const f = S.at(fScratch, lambdaNm);
    const cosI = Math.abs(smp.wi.z);
    beta *= (f * cosI) / smp.pdf;
    if (!(beta > 0)) break;

    prevWasDelta = B.isDelta(mat.bsdf);
    prevPdf = smp.pdf;
    /* The same direction, priced by the SKY's sampler -- what NEE toward the
       dome would have called this. A delta BSDF has no such price and
       prevWasDelta suppresses its use. */
    prevEnvPdf = cosI / PI;

    const wi = v.basisToWorld(onb, smp.wi);
    r.o = offsetOrigin(hit.p, hit.ng, wi);
    r.d = wi;
    r.tmin = 0;
    r.tmax = Infinity;

    /* Russian roulette from depth 3, on the scalar throughput. Starting earlier
       saves little and adds variance to the bounces that carry most of the
       image. */
    if (depth >= 3) {
      const q = beta < 0.95 ? beta : 0.95;
      if (R.f(rng) > q) break;
      beta /= q;
    }
  }
  return out;
}
