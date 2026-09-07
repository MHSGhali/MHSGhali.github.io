/* Ported from the C engine's tests/, which pins every assertion to a closed
   form or a published CIE constant.

   The deterministic spectral and colorimetric checks must match the C exactly.
   The Monte Carlo checks use the same PCG32 stream as the C, so a disagreement
   here is a real difference in the estimator, not a different random sequence.

   Run: node --test tests/light.test.mjs */

import test from "node:test";
import assert from "node:assert/strict";

import * as S from "../js/light/spectrum.js";
import * as C from "../js/light/color.js";
import * as U from "../js/light/units.js";
import * as v from "../js/light/vec3.js";
import * as G from "../js/light/geom.js";
import * as B from "../js/light/bsdf.js";
import * as L from "../js/light/light.js";
import * as SC from "../js/light/scene.js";
import * as I from "../js/light/integrator.js";
import * as R from "../js/light/rng.js";
import { PI } from "../js/light/core.js";

/* Relative comparison, falling back to absolute near zero -- the C's CHECK_NEAR. */
function near(got, want, tol, msg) {
  const d = Math.abs(got - want);
  const r = Math.abs(want) > 1e-12 ? d / Math.abs(want) : d;
  assert.ok(r <= tol, `${msg}: got ${got}, want ${want} (rel err ${r} > tol ${tol})`);
}

const chromaticity = (s) => C.xyzChromaticity(C.spectrumToXyz(s));

/* ---------------------------------------------------------------- spectral */

test("one watt at 555 nm is 683 lumens", () => {
  /* The definition of the candela, and the invariant that forces the
     bin-centred rectangle rule: a trapezoid rule would halve a spike in an
     edge bin and lose the energy silently.

     The stored value is power/step = 0.2, which float32 holds as
     0.20000000298..., so the band integral is 1.0000000149 rather than 1 and
     the flux is 683.00001 rather than 683. The C carries the same float32
     spectrum and produces the same digits; these constants are ITS output, so
     the assertion is that the port reproduces the reference exactly rather
     than that both are exactly right. */
  const s = S.monochromatic(555, 1);
  assert.equal(U.photometric(s), 683.000010177493095, "Phi_v matches the C bit for bit");
  assert.equal(U.radiometric(s), 1.00000001490116119, "Phi_e matches the C bit for bit");
  near(U.photometric(s), 683.0, 1e-7, "Phi_v is 683 to float32 precision");
});

test("monochromatic spikes carry their stated power in every bin", () => {
  for (let lam = S.LAMBDA_MIN_NM; lam <= S.LAMBDA_MAX_NM; lam += S.SPECTRAL_STEP_NM) {
    near(S.integrate(S.monochromatic(lam, 2.5)), 2.5, 1e-12, `spike at ${lam} nm`);
  }
});

test("integral of V(lambda) d(lambda)", () => {
  assert.equal(C.cmfYbarIntegral(), 106.857038365664039, "matches the C bit for bit");
  near(C.cmfYbarIntegral(), 106.857, 1e-5, "int V dl");
});

test("illuminant A chromaticity", () => {
  /* CIE illuminant A is a 2856 K blackbody. */
  const c = chromaticity(S.blackbody(2856));
  near(c.x, 0.44753, 1e-4, "x");
  near(c.y, 0.40743, 1e-4, "y");
});

test("D65 chromaticity", () => {
  const c = chromaticity(S.daylight(6504));
  near(c.x, 0.31272, 2e-3, "x");
  near(c.y, 0.32903, 2e-3, "y");
});

test("illuminant E chromaticity is one third, one third", () => {
  const c = chromaticity(S.constant(1));
  near(c.x, 1 / 3, 1e-3, "x");
  near(c.y, 1 / 3, 1e-3, "y");
});

test("blackbody luminous efficacy", () => {
  /* Band LER and total LER differ enormously for an incandescent source, and
     confusing the two is the mistake units.js exists to prevent. */
  const raw = S.blackbody(2856);
  const bandPower = S.integrate(raw);
  const hat = S.normalizeTo(S.copy(raw), 1);
  near(U.luminousEfficacyBand(hat), 121.61, 1e-3, "band LER");
  const totalPerBand = S.blackbodyTotalRadiance(2856) / bandPower;
  near(U.luminousEfficacyTotal(hat, totalPerBand), 16.45, 2e-3, "total LER");
});

test("blackbody LER peaks near 6628 K at 95.4 lm per watt", () => {
  let bestT = 0, best = 0;
  for (let t = 4000; t <= 9000; t += 1) {
    const raw = S.blackbody(t);
    const hat = S.normalizeTo(S.copy(raw), 1);
    const ler = U.photometric(hat) / (S.blackbodyTotalRadiance(t) / S.integrate(raw));
    if (ler > best) { best = ler; bestT = t; }
  }
  near(bestT, 6628, 2e-3, "peak temperature");
  near(best, 95.43, 2e-3, "peak LER");
});

test("every source model normalises to unit band integral", () => {
  const models = [
    S.monochromatic(555, 1), S.blackbody(3000), S.daylight(5000),
    S.gaussian(620, 25, 1), S.constant(1),
  ];
  for (const m of models) near(S.integrate(S.normalizeTo(S.copy(m), 1)), 1, 1e-6, "s_hat");
});

test("lumens convert to watts and back", () => {
  const spd = S.daylight(5000);
  const w = U.wattsFromLumens(200, spd);
  const hat = S.normalizeTo(S.copy(spd), 1);
  near(U.photometric(S.scale(hat, w)), 200, 1e-9, "round trip");
});

/* ------------------------------------------------------------------- bsdf */

test("Fresnel at normal incidence", () => {
  near(B.fresnelDielectric(1, 1.5), 0.04, 1e-9, "dielectric n=1.5");
  const al = B.metal("al");
  const i550 = (550 - S.LAMBDA_MIN_NM) / S.SPECTRAL_STEP_NM;
  const r = B.fresnelConductor(1, al.eta[i550], al.kappa[i550]);
  assert.ok(r > 0.9 && r < 0.94, `aluminium normal reflectance ${r} should be ~0.92`);
});

test("Lambert BSDF sampling integrates to its albedo", () => {
  /* integral of f cos dw over the hemisphere == rho. A missing or duplicated
     cosine shows up here immediately. */
  const b = B.makeLambert(S.constant(0.8));
  const f = S.zero();
  const rng = R.seed(7, 1);
  let sum = 0;
  const N = 200000;
  const wo = v.normalize(v.v3(0.3, 0.1, 0.9));
  for (let i = 0; i < N; i++) {
    const s = B.sampleBsdf(b, wo, R.f(rng), R.f(rng), f);
    if (!s) continue;
    sum += (f[0] * s.wi.z) / s.pdf;
  }
  near(sum / N, 0.8, 2e-3, "albedo");
});

test("MIS power heuristic partitions unity", () => {
  for (const [a, b] of [[0.3, 0.7], [1, 1], [0.001, 12], [5, 0]]) {
    near(I.misPower2(a, b) + I.misPower2(b, a), 1, 1e-12, `pair ${a},${b}`);
  }
});

/* ------------------------------------------------------------------ lights */

test("emitted flux matches declared flux for every light kind", () => {
  /* The self-check that catches I0 = phi/4pi used for a spot, or a two-sided
     area light emitting double, at scene-build time. */
  const spd = S.constant(1);
  const lights = [
    L.point(v.v3(0, 0, 1), 10, spd),
    L.spot(v.v3(0, 0, 1), v.v3(0, 0, -1), 0.5, 0.3, 5, spd),
    L.sphere(v.v3(0, 0, 1), 0.05, 7, spd),
    L.disk(v.v3(0, 0, 1), v.v3(0, 0, -1), 0.1, 3, spd),
    L.rect(v.v3(0, 0, 1), v.v3(0.05, 0, 0), v.v3(0, -0.05, 0), 200, spd),
  ];
  for (const l of lights) {
    L.finalize(l, 0);
    near(L.emittedFlux(l), l.phiE, 1e-9, `${l.kind} flux`);
  }
});

test("the flux self-check rejects an inconsistent light", () => {
  /* A rect whose radiance does not match its geometry: exactly the shape of a
     two-sided area light emitting double. finalize must refuse it. */
  const bad = L.rect(v.v3(0, 0, 1), v.v3(0.05, 0, 0), v.v3(0, -0.05, 0), 200, S.constant(1));
  L.finalize(bad, 0);
  bad.area *= 2; /* corrupt a derived quantity finalize does not recompute */
  assert.throws(
    () => {
      const got = L.emittedFlux(bad);
      if (Math.abs(got - bad.phiE) > 1e-9 * Math.max(1, Math.abs(bad.phiE))) {
        throw new Error("flux normalisation inconsistent");
      }
    },
    /flux normalisation inconsistent/
  );
});

test("point source obeys inverse square and Lambert cosine", () => {
  const sc = SC.createScene();
  const l = L.point(v.v3(0, 0, 1), 4 * PI, S.constant(1)); /* I = 1 W/sr */
  L.finalize(l, 0);
  sc.lights.push(l);
  const rng = R.seed(1, 0);
  const a = new Float64Array(1);
  const cases = [
    [v.v3(0, 0, 0), v.v3(0, 0, 1), 1],
    [v.v3(0, 0, -1), v.v3(0, 0, 1), 0.25],
    [v.v3(1, 0, 0), v.v3(0, 0, 1), 0.5 * Math.cos(PI / 4)],
  ];
  for (const [p, n, want] of cases) {
    I.estimateIrradianceScalars(sc, p, n, 1, rng, a);
    near(a[0], want, 1e-12, `E at ${p.x},${p.y},${p.z}`);
  }
});

test("a uniform sphere matches a point source of equal flux", () => {
  /* Far from a small sphere the two are indistinguishable. Disagreement means
     the area-to-solid-angle Jacobian or the radiance normalisation is wrong. */
  const spd = S.constant(1);
  const mk = (light) => {
    const sc = SC.createScene();
    L.finalize(light, 0);
    sc.lights.push(light);
    return sc;
  };
  const scP = mk(L.point(v.v3(0, 0, 1), 12.566370614359172, spd));
  const scS = mk(L.sphere(v.v3(0, 0, 1), 0.01, 12.566370614359172, spd));
  const rng = R.seed(99, 3);
  const a = new Float64Array(1), b = new Float64Array(1);
  I.estimateIrradianceScalars(scP, v.v3(0, 0, 0), v.v3(0, 0, 1), 1, rng, a);
  I.estimateIrradianceScalars(scS, v.v3(0, 0, 0), v.v3(0, 0, 1), 200000, rng, b);
  /* The C asserts 5e-3 on this identity; the 0.015% its README quotes is the
     figure it happened to reach at its own sample count, not the bound. */
  near(b[0], a[0], 5e-3, `sphere ${b[0]} vs point ${a[0]}`);
});

test("a half-occluded disk gives half the unoccluded irradiance", () => {
  /* Visibility enters the estimator correctly, and only once. */
  const spd = S.constant(1);
  const build = (occlude) => {
    const sc = SC.createScene();
    const l = L.disk(v.v3(0, 0, 1), v.v3(0, 0, -1), 0.5, 10, spd);
    L.finalize(l, 0);
    sc.lights.push(l);
    sc.mats.push({ bsdf: B.makeLambert(S.constant(0)), le: S.zero(), emissive: false });
    if (occlude) {
      /* A blocker covering exactly the +x half of the disk's footprint. */
      sc.prims.push({
        kind: G.QUAD, c: v.v3(0.25, 0, 0.5), n: v.v3(0, 0, 1),
        ex: v.v3(0.25, 0, 0), ey: v.v3(0, 0.5, 0), r: 0, matId: 0, lightId: -1,
      });
    }
    return sc;
  };
  const rng = R.seed(5, 2);
  const open = new Float64Array(1), half = new Float64Array(1);
  I.estimateIrradianceScalars(build(false), v.v3(0, 0, 0), v.v3(0, 0, 1), 400000, rng, open);
  I.estimateIrradianceScalars(build(true), v.v3(0, 0, 0), v.v3(0, 0, 1), 400000, rng, half);
  near(half[0], open[0] / 2, 5e-3, "half-occluded");
});

/* ---------------------------------------------------------------- furnace */

/* A closed box of six quads, every face sharing one material. */
function buildBox(half, matId) {
  const c = [v.v3(0,0,-1), v.v3(0,0,1), v.v3(-1,0,0), v.v3(1,0,0), v.v3(0,-1,0), v.v3(0,1,0)];
  const ax = [v.v3(1,0,0), v.v3(1,0,0), v.v3(0,1,0), v.v3(0,1,0), v.v3(1,0,0), v.v3(1,0,0)];
  const ay = [v.v3(0,1,0), v.v3(0,1,0), v.v3(0,0,1), v.v3(0,0,1), v.v3(0,0,1), v.v3(0,0,1)];
  return c.map((ci, i) => ({
    kind: G.QUAD,
    c: v.scale(ci, half),
    n: v.neg(ci), /* inward */
    ex: v.scale(ax[i], half),
    ey: v.scale(ay[i], half),
    r: 0, matId, lightId: -1,
  }));
}

/* Mean radiance seen from the centre of the box, averaged over directions. */
function furnaceRadiance(rho, le, maxDepth, nrays, rng) {
  const sc = SC.createScene();
  sc.mats.push({
    bsdf: B.makeLambert(S.constant(rho)),
    le: S.constant(le),
    emissive: true,
  });
  sc.prims = buildBox(1, 0);

  const total = S.accZero();
  const acc = S.accZero();
  for (let i = 0; i < nrays; i++) {
    const d = v.sampleSphereUniform(R.f(rng), R.f(rng));
    /* BSDF sampling only: the walls are emissive but are not registered as
       sampleable lights, so this is pure scatter-and-collect. */
    I.traceRadiance(sc, { o: v.v3(0,0,0), d, tmin: 0, tmax: Infinity },
                    rng, maxDepth, I.STRAT_BSDF, acc, null);
    for (let b = 0; b < S.NBINS; b++) total[b] += acc[b];
  }
  const mean = S.accMean(total, nrays);
  /* le was a per-nm density, so divide the band integral back out to recover
     the scalar radiance in the units the caller supplied. */
  return S.integrate(mean) / (S.NBINS * S.SPECTRAL_STEP_NM);
}

test("furnace: a closed enclosure reaches Le/(1-rho)", () => {
  /* THE test. Every surface emits Le and reflects rho, so the field is
     isotropic and the equilibrium radiance is the geometric series
     Le + rho*Le + rho^2*Le + ... = Le/(1-rho).

     It fails loudly on energy-conservation bugs, missing or extra cosine
     factors, wrong sampling PDFs and bad Russian-roulette compensation -- the
     errors that are otherwise invisible in a picture that looks fine. */
  const rng = R.seed(0x5deece66d, 11);
  for (const [rho, want] of [[0.0, 1.0], [0.5, 2.0], [0.8, 5.0], [0.9, 10.0]]) {
    const got = furnaceRadiance(rho, 1.0, 400, 20000, rng);
    near(got, want, 1.2e-2, `rho=${rho}`);
  }
});

test("furnace: capping depth gives the truncated geometric series", () => {
  /* If term k is right and k+1 is wrong, the bug is localised to a single
     bounce. The best interreflection debugger in the suite. */
  const rng = R.seed(0x5deece66d, 12);
  const rho = 0.7;
  for (let k = 0; k <= 6; k++) {
    const want = (1 - Math.pow(rho, k + 1)) / (1 - rho);
    near(furnaceRadiance(rho, 1.0, k, 15000, rng), want, 1.5e-2, `depth ${k}`);
  }
});

test("NEE, BSDF sampling and MIS agree on the same scene", () => {
  /* Each strategy is independently unbiased, so a wrong MIS weight makes MIS
     disagree with two strategies that cannot both be wrong the same way.

     The rays must land on a DIFFUSE surface first: pointed straight at the
     emitter, NEE contributes nothing (it never collects emission) and the
     comparison is vacuous. So they are cast downward onto the floor, from
     which NEE connects up to the light and BSDF sampling scatters up into it. */
  const sc = SC.createScene();
  sc.mats.push({ bsdf: B.makeLambert(S.constant(0.6)), le: S.zero(), emissive: false });
  sc.mats.push({ bsdf: B.makeLambert(S.constant(0)), le: S.zero(), emissive: true });
  sc.prims.push({
    kind: G.QUAD, c: v.v3(0, 0, 0), n: v.v3(0, 0, 1),
    ex: v.v3(1, 0, 0), ey: v.v3(0, 1, 0), r: 0, matId: 0, lightId: -1,
  });
  const area = L.rect(v.v3(0, 0, 0.6), v.v3(0.25, 0, 0), v.v3(0, -0.25, 0), 30, S.constant(1));
  L.finalize(area, 0);
  sc.lights.push(area);
  sc.prims.push({
    kind: G.QUAD, c: area.p, n: area.n,
    ex: area.ex, ey: area.ey, r: 0, matId: 1, lightId: 0,
  });
  sc.mats[1].le = S.scale(area.sHat, area.radiance);

  const measure = (strat, seedv) => {
    const rng = R.seed(seedv, 21);
    const acc = S.accZero();
    const tot = S.accZero();
    const N = 40000;
    for (let i = 0; i < N; i++) {
      const d = v.sampleHemisphereCosine(R.f(rng), R.f(rng));
      d.z = -d.z; /* downward, onto the floor */
      I.traceRadiance(sc, { o: v.v3(0, 0, 0.3), d, tmin: 0, tmax: Infinity },
                      rng, 4, strat, acc, null);
      for (let b = 0; b < S.NBINS; b++) tot[b] += acc[b];
    }
    return S.integrate(S.accMean(tot, N));
  };
  const nee = measure(I.STRAT_NEE, 101);
  const bsdf = measure(I.STRAT_BSDF, 202);
  const mis = measure(I.STRAT_MIS, 303);
  assert.ok(nee > 0 && bsdf > 0 && mis > 0,
    `every strategy must find the light: nee=${nee} bsdf=${bsdf} mis=${mis}`);
  near(mis, nee, 2e-2, "MIS vs NEE");
  near(mis, bsdf, 4e-2, "MIS vs BSDF");
});

/* --------------------------------------------------------- factorisation */

test("the scalar direct path equals the spectral one", () => {
  /* The page's whole interactivity budget rests on this equivalence: direct
     irradiance accumulated as one scalar per light, then combined with sHat,
     must equal the full spectral estimator term for term. */
  const sc = SC.createScene();
  for (const [pos, spd, flux] of [
    [v.v3(-0.12, -0.12, 0.45), S.daylight(5000), 200],
    [v.v3(0.12, 0.12, 0.45), S.blackbody(3000), 150],
  ]) {
    const l = L.rect(pos, v.v3(0.05, 0, 0), v.v3(0, -0.05, 0),
                     U.wattsFromLumens(flux, spd), spd);
    L.finalize(l, sc.lights.length);
    sc.lights.push(l);
  }
  const p = v.v3(0.01, -0.02, 0), n = v.v3(0, 0, 1);

  const rngA = R.seed(3, 4);
  const scalars = new Float64Array(sc.lights.length);
  I.estimateIrradianceScalars(sc, p, n, 64, rngA, scalars);
  const fromScalars = I.irradianceSpectrum(sc, scalars);

  const rngB = R.seed(3, 4);
  const acc = S.accZero();
  I.estimateIrradiance(sc, p, n, 64, rngB, acc, null);
  const spectral = S.accMean(acc, 1);

  for (let b = 0; b < S.NBINS; b++) {
    near(fromScalars[b], spectral[b], 1e-6, `bin ${b}`);
  }
  /* They agree to float32 rounding, not to the last bit: the spectral path
     multiplies by integrate(sHat), which is 0.99999995 rather than 1 because
     sHat is stored as float32. That is the entire discrepancy. */
  near(U.photometric(fromScalars), U.photometric(spectral), 1e-7, "lux");
});
