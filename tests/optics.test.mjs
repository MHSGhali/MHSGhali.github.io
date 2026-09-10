/* Ported from the C engine's tests/ -- test_glass.c, test_lens.c,
   test_camera.c, test_spectral.c, test_trace.c, test_env.c and
   test_render_focus.c -- keeping the original assertions where they survive
   the port, as tests/linkage.test.mjs does.

   The ones that carry real weight are the ones where a wrong answer still
   produces a completely convincing picture: a lens of the wrong focal length,
   an iris that changes the exposure, a pupil bound that eats the corners.

   Run: node --test tests/optics.test.mjs */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as G from "../js/optics/glass.js";
import * as P from "../js/optics/prescription.js";
import * as L from "../js/optics/lens.js";
import * as PU from "../js/optics/pupil.js";
import * as SP from "../js/optics/spectral.js";
import * as CAM from "../js/optics/camera.js";
import * as SD from "../js/optics/scenedesc.js";
import * as S3 from "../js/optics/scene3d.js";
import * as T from "../js/optics/trace.js";
import * as FILM from "../js/optics/film.js";
import * as ST from "../js/optics/settings.js";
import * as optics from "../js/optics/knowledge.js";
import { setup, renderRows, derivedOf, } from "../js/optics/render.js";

import * as S from "../js/light/spectrum.js";
import * as C from "../js/light/color.js";
import * as U from "../js/light/units.js";
import * as v from "../js/light/vec3.js";
import * as R from "../js/light/rng.js";

/* Relative comparison, falling back to absolute near zero -- the C's
   CHECK_NEAR. */
function near(got, want, tol, msg) {
  const d = Math.abs(got - want);
  const r = Math.abs(want) > 1e-12 ? d / Math.abs(want) : d;
  assert.ok(r <= tol, `${msg}: got ${got}, want ${want} (rel err ${r} > tol ${tol})`);
}

/* ------------------------------------------------------------------ glass */

test("every catalogue glass reproduces its own published n_d and V_d", () => {
  /* The data checks itself. A mistyped digit in B_2 or C_3 shifts the index in
     the fourth decimal place -- invisible by eye, and it changes the colour
     correction of any lens built on it. */
  assert.equal(G.selfCheck(), null);
});

test("air is exactly 1.0 at every wavelength, with no sqrt rounding", () => {
  /* The lens tracer compares indices to decide whether a surface refracts at
     all, so this has to be exact rather than close. */
  for (const lam of [360, 486.1327, 550, 587.5618, 656.2725, 830]) {
    assert.equal(G.n(G.AIR, lam), 1);
  }
  assert.equal(G.abbe(G.AIR), 0, "air has no dispersion to divide by");
});

test("a constant glass has zero dispersion by construction", () => {
  const c = G.constant(1.7);
  for (const lam of [400, 550, 700]) assert.equal(G.n(c, lam), 1.7);
  assert.equal(G.dispersion(c), 0);
});

test("a model glass hits its (n_d, V_d) pair exactly", () => {
  /* Guessing "nearest catalogue entry" gets n_d right and V_d wrong, which is
     backwards: V_d is what decides colour correction. */
  for (const [nd, vd] of [[1.5168, 64.17], [1.62004, 36.37], [1.72, 50.0], [1.45, 70.0]]) {
    const g = G.model(nd, vd);
    near(G.n(g, G.LINE_D), nd, 1e-9, `model n_d for (${nd}, ${vd})`);
    near(G.abbe(g), vd, 1e-9, `model V_d for (${nd}, ${vd})`);
  }
});

test("an impossible glass is refused rather than silently substituted", () => {
  assert.throws(() => G.model(0.5, 60), /nd > 1/);
  assert.throws(() => G.model(1.5, -3), /vd > 0/);
});

/* ------------------------------------------------------- paraxial analysis */

test("every shipped design comes out at the focal length it claims", () => {
  /* THE transcription gate. A prescription whose paraxial focal length does not
     match its design value has a typo in it, and the resulting lens renders a
     completely convincing image of the wrong field of view. */
  for (const id of P.IDS) {
    const p = P.prescription(id);
    const lens = L.build(id, 0, p.designFno);
    near(lens.eflMm, p.designEflMm, 0.01, `${P.NAMES[id]} paraxial EFL`);
  }
});

test("the ideal lens is exactly 100 mm at every wavelength", () => {
  const lens = L.build(P.THIN, 100, 5);
  for (const lam of [G.LINE_F, G.LINE_D, G.LINE_C, 380, 800]) {
    assert.equal(L.eflAt(lens, lam), 100, `ideal EFL at ${lam} nm`);
  }
});

test("a singlet's chromatic error is close to -1/V_d, and the achromat kills it", () => {
  /* For a THIN singlet the longitudinal chromatic aberration is exactly
     -1/V_d. The shipped one has 4 mm of glass in it, so it lands near rather
     than on -- and the doublet has to be more than an order of magnitude
     better, which is the whole reason both are shipped. */
  const s = L.build(P.SINGLET_100, 100, 10);
  const vd = G.abbe(G.glass("N-BK7"));
  const measured = (L.eflAt(s, G.LINE_F) - L.eflAt(s, G.LINE_C)) / s.eflMm;
  near(measured, -1 / vd, 0.02, "singlet longitudinal chromatic aberration");

  const a = L.build(P.ACHROMAT_100, 100, 5);
  const achro = (L.eflAt(a, G.LINE_F) - L.eflAt(a, G.LINE_C)) / a.eflMm;
  assert.ok(Math.abs(achro) < Math.abs(measured) / 10,
    `the achromat should correct by more than 10x: singlet ${measured}, doublet ${achro}`);
});

test("scaling a design moves every length and leaves the f-number alone", () => {
  /* Scaling the radii but forgetting the thicknesses produces a lens that is
     neither the original design nor any other real design, and which still
     renders a perfectly plausible image. */
  const a = P.prescription(P.ACHROMAT_100);
  const b = P.scale(P.prescription(P.ACHROMAT_100), 2.5);
  assert.equal(b.designFno, a.designFno, "the f-number is not a length");
  near(b.designEflMm, a.designEflMm * 2.5, 1e-12, "design EFL");
  for (let i = 0; i < a.surf.length; i++) {
    near(b.surf[i].radiusMm, a.surf[i].radiusMm * 2.5, 1e-12, `surface ${i} radius`);
    near(b.surf[i].thicknessMm, a.surf[i].thicknessMm * 2.5, 1e-12, `surface ${i} thickness`);
    near(b.surf[i].semiApMm, a.surf[i].semiApMm * 2.5, 1e-12, `surface ${i} semi-aperture`);
  }
});

test("asking for a focal length gives that focal length, not the design's nominal one", () => {
  /* The design values come from thin-lens equations and a real doublet comes
     out ~0.4 % shorter, so scaling by the nominal value would hand back an
     84.7 mm lens when 85 was asked for -- small, permanent, invisible. */
  for (const mm of [24, 50, 85, 200, 400]) {
    const lens = L.build(P.ACHROMAT_100, mm, 5);
    near(lens.eflMm, mm, 1e-9, `built ${mm} mm lens`);
  }
});

/* ------------------------------------------------------------- the pupils */

test("focusing at infinity puts the film exactly at the back focal distance", () => {
  /* The two paths -- the conjugate equation and the definition of BFD -- have
     to agree at the limit. */
  for (const id of P.IDS) {
    const lens = L.build(id, 100, 5);
    L.focus(lens, Infinity);
    assert.equal(lens.filmZMm, lens.bfdMm, `${P.NAMES[id]} at infinity`);
  }
});

test("the f-number comes from the entrance pupil, not from f/(2N) directly", () => {
  /* Only stops this design can reach: its front element is 20 mm across at
     f = 100 mm, so f/5 is wide open and anything faster is the clamp's
     business, tested below. */
  const lens = L.build(P.ACHROMAT_100, 100, 5);
  for (const fno of [5.6, 8, 11, 16, 22]) {
    L.setFnumber(lens, fno);
    near(2 * lens.epSemiApMm, lens.eflMm / fno, 1e-9,
      `entrance pupil diameter at f/${fno}`);
  }
});

test("a clamped aperture reports the f-number it actually passes", () => {
  /* Storing the requested value would make the lens report f/1.4 while passing
     f/5 worth of light, and every exposure computed from it would be wrong by
     that ratio with nothing to show for it. */
  const lens = L.build(P.ACHROMAT_100, 100, 5);
  L.setFnumber(lens, 1.0);                    /* far wider than the glass allows */
  assert.ok(lens.fNumber > 1.0, "an unreachable aperture must be reported as clamped");
  near(2 * lens.epSemiApMm, lens.eflMm / lens.fNumber, 1e-9,
    "the reported f-number matches the pupil that exists");
  assert.ok(lens.stopSemiApMm <= lens.surf[lens.stopIndex].semiApMm + 1e-12,
    "the iris cannot open wider than the hole it sits in");
});

test("the coc is zero at the focused distance and grows either side", () => {
  const lens = L.build(P.ACHROMAT_100, 100, 5);
  L.focus(lens, 2.0);
  near(L.cocMm(lens, 2.0), 0, 1e-9, "blur at the plane of focus");
  assert.ok(L.cocMm(lens, 1.5) > 0 && L.cocMm(lens, 3.0) > 0);
  assert.ok(L.cocMm(lens, 1.0) > L.cocMm(lens, 1.5), "blur grows toward the lens");
  assert.ok(L.cocMm(lens, 6.0) > L.cocMm(lens, 3.0), "and away from it");
});

test("the depth-of-field solve brackets the focus and agrees with the coc it came from", () => {
  /* Solved by bisection from the real lens rather than from the textbook
     hyperfocal formula, so it has to be self-consistent with cocMm. */
  const lens = L.build(P.ACHROMAT_100, 100, 5);
  L.focus(lens, 2.0);
  const limit = 0.030;
  const d = L.dof(lens, limit);
  assert.ok(d.near < 2.0 && d.far > 2.0, "the slab must contain the focus");
  near(L.cocMm(lens, d.near), limit, 1e-4, "blur at the near limit");
  near(L.cocMm(lens, d.far), limit, 1e-4, "blur at the far limit");
});

test("stopping down widens the sharp slab", () => {
  const lens = L.build(P.ACHROMAT_100, 100, 5);
  let prev = 0;
  for (const fno of [2.8, 5.6, 11, 22]) {
    L.setFnumber(lens, fno);
    L.focus(lens, 2.0);
    const d = L.dof(lens, 0.030);
    const span = d.far - d.near;
    assert.ok(span > prev, `f/${fno} should be deeper than the stop before it`);
    prev = span;
  }
});

test("past the hyperfocal distance the far limit is infinity", () => {
  const lens = L.build(P.ACHROMAT_100, 100, 5);
  L.setFnumber(lens, 8);
  const h = L.hyperfocalM(lens, 0.030);
  assert.ok(Number.isFinite(h) && h > 0);

  L.focus(lens, h * 1.02);
  assert.equal(L.dof(lens, 0.030).far, Infinity, "just past hyperfocal reaches infinity");
  L.focus(lens, h * 0.9);
  assert.ok(Number.isFinite(L.dof(lens, 0.030).far), "just inside it does not");
});

/* ---------------------------------------------------------------- the iris */

test("the iris holds its AREA constant across every blade count and curvature", () => {
  /* The f-number is a statement about how much light gets through, so the iris
     AREA is what must equal pi a^2. Without this, switching from a circular
     iris to seven blades would darken the image by 13 % -- an exposure change
     with no cause, produced by a control that is supposed to affect only the
     SHAPE of the blur.

     And the obvious shortcut, blending rho linearly between the polygon value
     and the circle value, is exact at c = 0 and c = 1 and worst in between --
     precisely where nobody thinks to check. Hence the curvatures in the middle
     of this list. */
  const a = 10;
  const wantArea = Math.PI * a * a;
  for (const blades of [3, 4, 5, 6, 7, 9, 11, 14]) {
    for (const curve of [0, 0.25, 0.5, 0.75, 1]) {
      const rho = L.irisCircumradius(a, blades, curve);
      /* Numeric area of the blended blade boundary, in polar form. */
      const N = 200000;
      let area = 0;
      const m = Math.PI / blades;
      for (let k = 0; k < N; k++) {
        const phi = (2 * Math.PI * (k + 0.5)) / N;
        let p = phi % (2 * m);
        p -= m;
        const straight = (rho * Math.cos(m)) / Math.cos(p);
        const r = straight + curve * (rho - straight);
        area += 0.5 * r * r * ((2 * Math.PI) / N);
      }
      near(area, wantArea, 1e-4, `iris area at ${blades} blades, curvature ${curve}`);
    }
  }
});

test("blades under three are a perfect circle, and the iris contains what it should", () => {
  const lens = L.build(P.ACHROMAT_100, 100, 5);
  lens.blades = 0;
  const a = lens.stopSemiApMm;
  assert.ok(L.apertureContains(lens, a * 0.99, 0));
  assert.ok(!L.apertureContains(lens, a * 1.01, 0));

  /* A hexagonal iris reaches further at a corner than at an edge midpoint, and
     both have to stay inside the circumradius. */
  lens.blades = 6;
  lens.bladeCurvature = 0;
  lens.bladeRotRad = 0;
  const rho = L.irisCircumradius(a, 6, 0);
  assert.ok(L.apertureContains(lens, rho * 0.99, 0), "reaches the corner");
  assert.ok(!L.apertureContains(lens, rho * 1.01, 0), "and no further");
  const edge = rho * Math.cos(Math.PI / 6);
  const mid = Math.PI / 6;
  assert.ok(!L.apertureContains(lens, edge * 1.02 * Math.cos(mid), edge * 1.02 * Math.sin(mid)),
    "an edge midpoint is closer in than a corner");
});

/* ------------------------------------------------------- sequential tracing */

test("Snell round-trips through a flat interface", () => {
  const d = v.normalize(v.v3(0.3, 0.1, 1));
  const n = v.v3(0, 0, -1);
  const into = L.refract(d, n, 1 / 1.5);
  assert.ok(into);
  const back = L.refract(into, n, 1.5 / 1);
  assert.ok(back);
  for (const k of ["x", "y", "z"]) near(back[k], d[k], 1e-12, `Snell round trip ${k}`);
});

test("total internal reflection kills the ray rather than reflecting it", () => {
  /* That light does not reach the film along the intended path, and the
     reflected branch is a flare pass's business, not the primary trace's. */
  const grazing = v.normalize(v.v3(1, 0, 0.05));
  assert.equal(L.refract(grazing, v.v3(0, 0, -1), 1.5 / 1.0), null);
});

test("a plano surface is a plane and a curved one picks the right cap", () => {
  /* Taking -b - sqrt(disc) unconditionally picks the far side of the sphere for
     a negative radius: the lens still traces, it just uses the wrong cap. */
  const down = { o: v.v3(0, 0, -10), d: v.v3(0, 0, 1) };
  near(L.surfaceHit(0, 5, down).t, 15, 1e-12, "plano hit");

  for (const R of [50, -50]) {
    const h = L.surfaceHit(R, 0, down);
    assert.ok(h, `radius ${R} must be hit`);
    /* The vertex is at z = 0 for an on-axis ray whatever the sign of R. */
    near(down.o.z + h.t, 0, 1e-9, `radius ${R} on-axis vertex`);
  }
});

test("the real focus converges to the paraxial one as the pupil closes", () => {
  /* That it does NOT converge at larger fractions is spherical aberration,
     measured rather than invented. */
  const lens = L.build(P.SINGLET_100, 100, 4);
  L.focus(lens, Infinity);
  const tiny = L.realFocusZ(lens, G.LINE_D, Infinity, 0.02);
  near(tiny, lens.bfdMm, 1e-3, "a paraxial ray must land at the paraxial focus");

  const marginal = L.realFocusZ(lens, G.LINE_D, Infinity, 1.0);
  assert.ok(Math.abs(marginal - lens.bfdMm) > Math.abs(tiny - lens.bfdMm) * 10,
    "a marginal ray on an uncorrected singlet must miss it by much more");
});

test("the ideal lens survives a real trace, in both directions", () => {
  /* It regressed once: its two surfaces sat at the same z, so a sequential
     reverse trace reached the plano first, having already flown through where
     the sphere was, and then missed the sphere entirely. Every camera ray came
     back vignetted and the ideal lens rendered pure black. */
  const lens = L.build(P.THIN, 100, 5);
  L.focus(lens, 2);
  const filmZ = L.filmZ(lens);
  let through = 0;
  for (let i = 0; i < 40; i++) {
    const h = (i / 40) * lens.epSemiApMm * 0.9;
    const film = v.v3(0, 0, filmZ);
    const rear = v.v3(h, 0, L.vertexZ(lens, lens.surf.length - 1));
    const r = { o: film, d: v.normalize(v.sub(rear, film)) };
    if (L.traceReverse(lens, G.LINE_D, r, null)) through++;
  }
  assert.ok(through > 20, `the ideal lens must pass reverse rays, passed ${through}/40`);
});

test("transmittance is below one, and more glass of the same kind loses more", () => {
  /* The f-stop / T-stop gap, and it is real: an uncoated lens does not transmit
     what its geometry promises. */
  const singlet = L.build(P.SINGLET_100, 100, 10);      /* two N-BK7 interfaces  */
  const achromat = L.build(P.ACHROMAT_100, 100, 5);     /* three, N-BK7 then F2  */
  for (const lens of [singlet, achromat]) {
    const t = L.transmittance(lens, G.LINE_D);
    assert.ok(t > 0 && t < 1, "uncoated glass reflects some light at every interface");
  }
  assert.ok(L.transmittance(achromat, G.LINE_D) < L.transmittance(singlet, G.LINE_D),
    "three interfaces of ordinary glass lose more than two");

  /* Interface COUNT is not the whole story, and asserting it would be wrong:
     Fresnel loss goes with the size of the index step. The ideal lens has only
     two interfaces but they are air-to-n=2, so it loses far more than either
     real design does. */
  const ideal = L.build(P.THIN, 100, 5);
  assert.ok(L.transmittance(ideal, G.LINE_D) < L.transmittance(achromat, G.LINE_D),
    "a bigger index step loses more, however few interfaces there are");
});

test("the spot on axis at the focused distance is small, and grows off axis", () => {
  const lens = L.build(P.ACHROMAT_100, 100, 5);
  L.focus(lens, 2.0);
  const onAxis = L.spotMm(lens, 2.0, 0, 9);
  /* Not zero: a doublet at f/5 has residual spherical aberration, and that it
     is measured rather than assumed away is the point of tracing real glass.
     What must hold is that focus dominates -- the focused spot is an order of
     magnitude tighter than a defocused one. */
  const defocused = L.spotMm(lens, 3.0, 0, 9);
  assert.ok(onAxis * 5 < defocused,
    `focus must dominate: at focus ${onAxis}, one metre out ${defocused}`);
  const offAxis = L.spotMm(lens, 2.0, 0.28, 9);
  assert.ok(offAxis > onAxis,
    "an uncorrected doublet has coma and astigmatism off axis");
});

/* ------------------------------------------------------------- the pupil cache */

test("the cached pupil bound CONTAINS every ray that really gets through", () => {
  /* A loose bound costs only speed. A tight bound silently deletes light from
     the frame's corners -- and the result looks exactly like tasteful
     vignetting, which is why nobody would ever find it by looking.

     Probed at the d line, so the check at 400 and 700 nm is the one that
     matters: it says the padding really does absorb the band. */
  const lens = L.build(P.ACHROMAT_100, 100, 4);
  L.focus(lens, 2.0);
  const diag = 0.5 * Math.sqrt(36 * 36 + 24 * 24);
  const cache = PU.build(lens, diag);
  const rearSemi = lens.surf[lens.surf.length - 1].semiApMm;
  const box = new Float64Array(4);

  let outside = 0, through = 0;
  for (const lam of [400, 550, 700]) {
    for (let z = 0; z < cache.nzones; z++) {
      const fr = (diag * z) / (cache.nzones - 1);
      const film = v.v3(fr, 0, L.filmZ(lens));
      PU.bounds(cache, fr, box);
      for (let iy = 0; iy < 24; iy++) {
        for (let ix = 0; ix < 24; ix++) {
          const rx = -rearSemi + 2 * rearSemi * ((ix + 0.5) / 24);
          const ry = -rearSemi + 2 * rearSemi * ((iy + 0.5) / 24);
          if (rx * rx + ry * ry > rearSemi * rearSemi) continue;
          const r = { o: film, d: v.normalize(v.sub(v.v3(rx, ry, cache.rearZMm), film)) };
          if (!L.traceReverse(lens, lam, r, null)) continue;
          through++;
          if (rx < box[0] || rx > box[1] || ry < box[2] || ry > box[3]) outside++;
        }
      }
    }
  }
  assert.ok(through > 1000, "the probe must actually find rays");
  assert.equal(outside, 0, `${outside} of ${through} transmitted rays fell outside the cached box`);
});

test("the zone lookup takes a union, never an interpolation", () => {
  /* Interpolation can produce a box narrower than either neighbour where the
     pupil is changing shape quickly, which breaks the superset invariant
     exactly where it matters most. A union cannot. */
  const lens = L.build(P.ACHROMAT_100, 100, 4);
  const diag = 21.63;
  const cache = PU.build(lens, diag);
  const box = new Float64Array(4);
  for (let z = 0; z < cache.nzones - 1; z++) {
    const fr = (diag * (z + 0.5)) / (cache.nzones - 1);
    PU.bounds(cache, fr, box);
    for (const zi of [z, z + 1]) {
      const o = zi * 4;
      if (cache.zone[o + 1] - cache.zone[o] <= 0) continue;   /* degenerate */
      assert.ok(box[0] <= cache.zone[o] + 1e-12 && box[1] >= cache.zone[o + 1] - 1e-12,
        `zone ${zi} x-bound must be contained`);
      assert.ok(box[2] <= cache.zone[o + 2] + 1e-12 && box[3] >= cache.zone[o + 3] - 1e-12,
        `zone ${zi} y-bound must be contained`);
    }
  }
});

/* -------------------------------------------------------- hero wavelengths */

test("every drawn wavelength is a bin centre with a positive probability", () => {
  /* Depositing then needs no redistribution between neighbours, and reading a
     spectrum back at that wavelength is exact to the last bit. */
  for (let i = 0; i < 500; i++) {
    const w = SP.lambdaPick(i, SP.pixelHash(i % 17, (i * 3) % 11));
    assert.ok(w.bin >= 0 && w.bin < S.NBINS);
    assert.equal(w.lambdaNm, S.binLambda(w.bin));
    assert.equal(S.binIndex(w.lambdaNm), w.bin, "a bin centre must round-trip");
    assert.ok(w.invPdf > 0);
  }
});

test("the golden-ratio sequence walks the visible band without state", () => {
  /* Independent uniform draws leave gaps and clumps for any one pixel, which
     reads as colour noise. And it must be stateless, so a pass can be split
     across chunks without changing the result.

     "The whole band" is the wrong claim now that the draw is importance
     sampled: the bins the CIE observer cannot see are deliberately never drawn,
     because a sample spent there could only add noise to an estimate of zero.
     What must be covered is every bin that can actually reach the film. */
  const xb = C.cmfXbar(), yb = C.cmfYbar(), zb = C.cmfZbar();

  /* "Covered" has to mean the bins that carry the picture, not every bin with a
     non-zero response: the deep violet and far red are sampled in PROPORTION to
     what they contribute, which is a hundredth of the peak, so they turn up
     once in a few thousand draws and that is the sampler working. The bins
     holding 99 % of the response between them are the ones a short render must
     not miss. */
  const weights = [];
  let total = 0;
  for (let i = 0; i < S.NBINS; i++) {
    const w = xb[i] + yb[i] + zb[i];
    weights.push([i, w]);
    total += w;
  }
  weights.sort((a, b) => b[1] - a[1]);
  const core = [];
  let acc = 0;
  for (const [i, w] of weights) {
    if (acc / total >= 0.99) break;
    core.push(i);
    acc += w;
  }

  const hash = SP.pixelHash(5, 9);
  const seen = new Set();
  for (let i = 0; i < S.NBINS * 8; i++) seen.add(SP.lambdaPick(i, hash).bin);
  for (const bin of core) {
    assert.ok(seen.has(bin),
      `bin ${bin} (${S.binLambda(bin)} nm) carries part of the visible 99% but was never drawn`);
  }
  assert.ok(core.length > 50, `the core should be most of the band, was ${core.length} bins`);
  /* Stateless: the same index gives the same answer whenever it is asked. */
  assert.equal(SP.lambdaPick(37, hash).bin, SP.lambdaPick(37, hash).bin);
});

test("importance sampling the wavelength leaves the estimator unbiased", () => {
  /* The whole point of invPdf. Drawing proportional to the observer's response
     and dividing by that same probability must reproduce a flat spectrum's XYZ
     exactly -- otherwise the picture's colour would depend on the sampler,
     which is the one thing a sampler is not allowed to do. */
  const xb = C.cmfXbar(), yb = C.cmfYbar(), zb = C.cmfZbar();
  const step = S.SPECTRAL_STEP_NM;

  /* The truth: XYZ of a flat unit spectrum, integrated directly. */
  const flat = S.constant(1);
  const want = {
    x: S.integrateWeighted(flat, xb),
    y: S.integrateWeighted(flat, yb),
    z: S.integrateWeighted(flat, zb),
  };

  const hash = SP.pixelHash(7, 3);
  const N = 200000;
  let gx = 0, gy = 0, gz = 0;
  for (let i = 0; i < N; i++) {
    const w = SP.lambdaPick(i, hash);
    gx += w.invPdf * xb[w.bin] * step;
    gy += w.invPdf * yb[w.bin] * step;
    gz += w.invPdf * zb[w.bin] * step;
  }
  near(gx / N, want.x, 2e-3, "X of a flat spectrum");
  near(gy / N, want.y, 2e-3, "Y of a flat spectrum");
  near(gz / N, want.z, 2e-3, "Z of a flat spectrum");
});

test("no ray is spent on a wavelength the film cannot see", () => {
  /* A bin with zero observer response contributes exactly zero to X, Y and Z,
     so tracing one through the glass and out into the scene is work that can
     only ever produce noise. */
  const xb = C.cmfXbar(), yb = C.cmfYbar(), zb = C.cmfZbar();
  const hash = SP.pixelHash(2, 11);
  for (let i = 0; i < 20000; i++) {
    const w = SP.lambdaPick(i, hash);
    assert.ok(xb[w.bin] + yb[w.bin] + zb[w.bin] > 0,
      `drew ${w.lambdaNm} nm, which the observer cannot see`);
    assert.ok(Number.isFinite(w.invPdf) && w.invPdf > 0, "and its weight must be usable");
  }
});

test("neighbouring pixels do not walk the spectrum in lockstep", () => {
  const a = SP.pixelHash(10, 10), b = SP.pixelHash(11, 10), c = SP.pixelHash(10, 11);
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.notEqual(b, c);
});

/* --------------------------------------------------------------- the camera */

test("the two y flips cancel and the x flip survives", () => {
  /* Applying one and not the other gives a vertically mirrored render that
     looks entirely plausible until something in the scene is not symmetric. So:
     a subject up and to the right must land up and to the right. */
  const cam = CAM.build(P.THIN, 100, 5, 36, 240, 160);
  const centre = CAM.project(cam, v.v3(0, 0, -3));
  near(centre.x, 120, 1e-9, "an axial point lands at the centre column");
  near(centre.y, 80, 1e-9, "and the centre row");

  const upRight = CAM.project(cam, v.v3(0.2, 0.15, -3));
  assert.ok(upRight.x > 120, "world +x must land right of centre");
  assert.ok(upRight.y < 80, "world +y must land ABOVE centre, i.e. at a lower row");

  const downLeft = CAM.project(cam, v.v3(-0.2, -0.15, -3));
  near(downLeft.x, 240 - upRight.x, 1e-9, "and the mapping is symmetric");
  near(downLeft.y, 160 - upRight.y, 1e-9, "in both axes");
});

test("a point at or behind the front vertex has no pixel", () => {
  const cam = CAM.build(P.THIN, 100, 5, 36, 64, 43);
  assert.equal(CAM.project(cam, v.v3(0, 0, 0)), null);
  assert.equal(CAM.project(cam, v.v3(0, 0, 1)), null);
});

test("a camera sample carries a forward ray and a positive weight", () => {
  const cam = CAM.build(P.ACHROMAT_100, 100, 5, 36, 64, 43);
  L.focus(cam.lens, 2);
  CAM.refresh(cam);
  const rng = R.seed(1n, 2n);
  const s = CAM.makeSample();
  let through = 0;
  for (let i = 0; i < 2000; i++) {
    if (!CAM.sample(cam, i % 64, (i * 7) % 43, i, rng, s)) continue;
    through++;
    assert.ok(s.weight > 0, "a transmitted sample must carry positive weight");
    assert.ok(s.d.z < 0, "and travel away from the camera, down -z");
    near(v.len(s.d), 1, 1e-9, "with a unit direction");
  }
  assert.ok(through > 100, `too few samples got through: ${through}`);
});

test("vignetting is reported, not renormalised away", () => {
  /* Retrying until a ray gets through would make the corners exactly as bright
     as the centre, which looks entirely plausible and is the opposite of what a
     real lens does. So a corner pixel must lose MORE samples than the centre. */
  const cam = CAM.build(P.ACHROMAT_100, 100, 2.8, 36, 64, 43);
  L.focus(cam.lens, 2);
  CAM.refresh(cam);
  const rng = R.seed(3n, 4n);
  const s = CAM.makeSample();
  /* The MEAN WEIGHT over every sample, with a vignetted one contributing zero
     -- which is exactly what the film accumulates. Not the hit rate: the pupil
     bound is fitted per zone, so the fraction of box samples that get through
     is roughly flat across the frame even as the light falls away. Measuring
     the rate would have reported no vignetting at all. */
  const meanWeight = (x, y) => {
    let w = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) if (CAM.sample(cam, x, y, i, rng, s)) w += s.weight;
    return w / N;
  };
  const centre = meanWeight(32, 21);
  const edge = meanWeight(2, 21);
  const corner = meanWeight(1, 1);
  assert.ok(centre > 0, "the centre must pass light");
  assert.ok(edge < centre, `the edge must be down on the centre: ${edge} vs ${centre}`);
  assert.ok(corner < edge, `and the corner further still: ${corner} vs ${edge}`);
});

/* ---------------------------------------------------------------- the scene */

test("a lamp's authored lumens survive into the built scene as watts", () => {
  const d = SD.preset(SD.RAIL);
  const { scene } = SD.build(d);
  assert.equal(scene.lights.length, 1);
  const lamp = scene.lights[0];
  const spd = S.blackbody(5500);
  near(lamp.phiE, U.wattsFromLumens(20800, spd), 1e-9, "lumens became watts once");
  near(U.photometric(S.scale(lamp.sHat, lamp.phiE)), 20800, 1e-6,
    "and converting back gives the number on the lamp");
});

test("the key light is an area source facing down", () => {
  const { scene } = SD.build(SD.preset(SD.RAIL));
  const lamp = scene.lights[0];
  near(lamp.n.y, -1, 1e-12, "an overhead panel points at the floor");
  near(lamp.area, 1.0, 1e-12, "a 1 x 1 m panel has 1 m^2 of area");
});

test("AMBIENT turns the lamps off entirely rather than dimming them", () => {
  /* A choice, not a blend: a scene half-lit by each is a third thing that
     answers neither. */
  const d = SD.preset(SD.RAIL);
  d.lightMode = SD.AMBIENT;
  const b = SD.build(d);
  assert.equal(b.scene.lights.length, 0, "no lamp is emitted at all");
  assert.equal(b.scene.prims.length, d.objects.length, "and no emissive face either");
  assert.ok(b.env.on);

  const lamps = SD.build(SD.preset(SD.RAIL));
  assert.equal(lamps.scene.lights.length, 1);
  assert.equal(lamps.env.on, false, "and the dome is off when the lamps are on");
});

test("the dome is authored in lux and stored as radiance", () => {
  /* A uniform dome of radiance L puts exactly pi*L on a surface facing it, so
     the radiance is E/pi -- and the division happens in one place. */
  const d = SD.preset(SD.RAIL);
  d.lightMode = SD.AMBIENT;
  d.ambientLux = 2000;
  const { env } = SD.build(d);
  /* Integrate the stored radiance back to an illuminance and compare. */
  const ePerp = U.photometric(env.le) * Math.PI;
  near(ePerp, 2000, 1e-6, "lux in, lux back out");
});

test("an object's colour keeps its luminance through the spectral uplift", () => {
  /* Smits' basis reproduces a colour approximately, and the approximation is
     worst in the saturated corners. The quantity this simulator reports is
     photometric, so of the two errors it is luminance that must not drift. */
  const white = S.daylight(6504);
  const yWhite = C.spectrumToXyz(white).y;
  for (const rgb of [[0.75, 0.75, 0.78], [0.55, 0.20, 0.18], [0.5, 0.5, 0.5], [0.2, 0.6, 0.3]]) {
    const s = SD.spectrumFromRgbReflectance(rgb);
    const got = C.spectrumToXyz(S.mul(s, white)).y / yWhite;
    const want = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    near(got, want, 1e-6, `luminance of ${JSON.stringify(rgb)}`);
    for (let i = 0; i < S.NBINS; i++) {
      assert.ok(s[i] >= 0 && s[i] <= 0.99, "no bin may reflect more than it receives");
    }
  }
});

test("the clamps refuse every value that would throw inside a light build", () => {
  /* A zero-area light divides by zero; a colour temperature below about 1200 K
     underflows every visible bin so the shape cannot be normalised. Both throw
     inside a worker build, nowhere near the control that was moved. */
  const d = SD.preset(SD.RAIL);
  d.lights[0].sizeU = 0;
  d.lights[0].sizeV = -5;
  d.lights[0].cctK = 1;
  d.lights[0].fluxLm = 1e12;
  d.objects[0].radius = 0;
  assert.doesNotThrow(() => SD.build(d));
});

/* ---------------------------------------------------------------- transport */

test("an escaping ray sees the dome, and nothing else", () => {
  const d = SD.preset(SD.RAIL);
  d.lightMode = SD.AMBIENT;
  const b = SD.build(d);
  const rng = R.seed(1n, 1n);
  const up = { o: v.v3(0, 0, 0), d: v.v3(0, 1, 0) };
  near(T.radiance(b.scene, b.env, up, 550, rng, 5), SD.envRadiance(b.env, null, 550), 1e-12,
    "straight to the sky, unweighted");

  const lamps = SD.build(SD.preset(SD.RAIL));
  assert.equal(T.radiance(lamps.scene, lamps.env, up, 550, rng, 5), 0,
    "with no dome and no backdrop there is nothing out there");
});

test("a sphere under a uniform dome comes back at its own reflectance", () => {
  /* A convex object in empty space sees the whole hemisphere at every point, so
     its radiance is exactly rho * L_sky. That is a closed form the estimator
     has to reproduce, and it exercises NEE, the dome strategy and MIS at once. */
  const d = {
    objects: [{ kind: "sphere", centre: v.v3(0, 0, -2), radius: 0.4, rgb: [0.5, 0.5, 0.5], name: "S" }],
    lights: [], camEye: v.v3(0, 0, 0), camTarget: v.v3(0, 0, -1),
    lightMode: SD.AMBIENT, ambientLux: 2000, ambientCctK: 6500,
  };
  const b = SD.build(d);
  const rho = SD.spectrumFromRgbReflectance([0.5, 0.5, 0.5]);
  const lam = 550;
  const want = S.at(rho, lam) * SD.envRadiance(b.env, null, lam);

  const rng = R.seed(11n, 3n);
  let sum = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) {
    sum += T.radiance(b.scene, b.env, { o: v.v3(0, 0, 0), d: v.v3(0, 0, -1) }, lam, rng, 4);
  }
  near(sum / N, want, 0.02, "a lit convex Lambertian must return rho * L");
});

test("the film's XYZ accumulation equals accumulating the spectrum", () => {
  /* This is the one liberty taken with the C's data structures, so it is pinned
     rather than argued: X, Y and Z are linear functionals of the spectrum, so
     depositing cmf[bin]*step per sample is the same as building the mean
     spectrum and projecting it afterwards. */
  const f = FILM.create(1, 1);
  const acc = S.accZero();
  const rng = R.seed(5n, 6n);
  const n = 400;
  for (let i = 0; i < n; i++) {
    const bin = Math.floor(R.f(rng) * S.NBINS);
    const val = R.f(rng) * 4;
    FILM.add(f, 0, 0, bin, val);
    acc[bin] += val;
  }
  const meanSpec = new Float64Array(S.NBINS);
  for (let i = 0; i < S.NBINS; i++) meanSpec[i] = acc[i] / n;
  const ref = {
    x: S.integrateWeighted(meanSpec, C.cmfXbar()),
    y: S.integrateWeighted(meanSpec, C.cmfYbar()),
    z: S.integrateWeighted(meanSpec, C.cmfZbar()),
  };
  near(f.xyz[0] / n, ref.x, 1e-12, "X");
  near(f.xyz[1] / n, ref.y, 1e-12, "Y");
  near(f.xyz[2] / n, ref.z, 1e-12, "Z");
});

test("an unsampled pixel is black and opaque, not transparent", () => {
  const f = FILM.create(2, 1);
  FILM.add(f, 0, 0, 40, 1);
  const out = FILM.tonemap(f, 100, new Uint8ClampedArray(8));
  assert.equal(out[7], 255, "alpha must be opaque even where nothing was traced");
  assert.equal(out[4], 0);
  assert.equal(out[5], 0);
  assert.equal(out[6], 0);
});

/* ------------------------------------------------------------------ render */

const baseSettings = () => ({
  design: P.ACHROMAT_100, focalMm: 100, fno: 5, focusM: 2,
  blades: 0, curvature: 0, rotDeg: 0,
  preset: SD.RAIL, lightMode: SD.LAMPS, ambientLux: 2000, ambientCctK: 6500,
  sensorWMm: 36, resW: 48, exposure: 100, cocLimitMm: 0.03, spp: 2, depth: 3,
});

test("a render is identical however the rows are chunked", () => {
  /* THE determinism contract. Seeding per chunk would make every render depend
     on how the scheduler happened to slice it, so a bug would reproduce only
     sometimes and a regression test could not exist at all. */
  const s = baseSettings();
  const st = setup(s);

  const whole = FILM.create(st.width, st.height);
  renderRows(st, whole, s, 0, 0, st.height);

  const chunked = FILM.create(st.width, st.height);
  for (let y = 0; y < st.height; y += 7) {
    renderRows(st, chunked, s, 0, y, Math.min(st.height, y + 7));
  }

  assert.deepEqual(Array.from(chunked.xyz), Array.from(whole.xyz));
  assert.deepEqual(Array.from(chunked.n), Array.from(whole.n));
});

test("every sample is counted, vignetted or not", () => {
  /* Skipping a vignetted sample would renormalise the vignetting away. */
  const s = baseSettings();
  const st = setup(s);
  const f = FILM.create(st.width, st.height);
  renderRows(st, f, s, 0, 0, st.height);
  for (let i = 0; i < f.n.length; i++) {
    assert.equal(f.n[i], s.spp, `pixel ${i} must have counted every sample`);
  }
});

const RAIL_DEPTHS = [1.0, 1.5, 2.0, 3.0, 5.0];
/* The rail's targets sit off axis in proportion to their distance, so they all
   subtend the same angle. */
const RAIL_FRAC = { 1.0: -0.140, 1.5: -0.070, 2.0: 0, 3.0: 0.070, 5.0: 0.140 };

const sharpestAt = (lens, heightOf) => {
  let best = Infinity, bestAt = 0;
  for (const dist of RAIL_DEPTHS) {
    const spot = L.spotMm(lens, dist, heightOf(dist), 11);
    if (spot < best) { best = spot; bestAt = dist; }
  }
  return bestAt;
};

test("focus decides which target is sharp, on the axis", () => {
  /* The whole point of the rail, measured by the real traced spot rather than
     by the paraxial slab. On axis, defocus is the whole story and the focused
     distance must win every time. */
  const lens = L.build(P.ACHROMAT_100, 100, 5);
  for (const at of RAIL_DEPTHS) {
    L.focus(lens, at);
    assert.equal(sharpestAt(lens, () => 0), at,
      `focused at ${at} m, the ${at} m target must be sharpest on axis`);
  }
});

test("off axis, an uncorrected doublet can beat focus -- and does, at 5 m", () => {
  /* This is not a defect being tolerated, it is the thing the panel's SPOT row
     exists to report. Off axis a simple doublet's coma and astigmatism grow
     with field angle, and by 0.7 m off the axis at 5 m they dominate defocus
     entirely: focus the lens at 5 m and the 3 m target -- half the field angle
     away -- resolves better than the one actually in focus.

     The depth-of-field slab says the opposite, and neither is wrong: they are
     answers to different questions. Pinned here so that if the aberration ever
     silently disappears from the trace, a test says so. */
  const lens = L.build(P.ACHROMAT_100, 100, 5);
  const height = (d) => Math.abs(RAIL_FRAC[d]) * d;

  L.focus(lens, 2.0);
  assert.equal(sharpestAt(lens, height), 2.0,
    "near the axis the focused target still wins");

  L.focus(lens, 5.0);
  assert.equal(sharpestAt(lens, height), 3.0,
    "but at the edge of the field, aberration beats focus");
  assert.ok(L.spotMm(lens, 5.0, height(5.0), 11) > L.spotMm(lens, 5.0, 0, 11) * 10,
    "and the cause is the field angle, not the focus");
});

test("stopping down darkens the frame by about the right number of stops", () => {
  /* Exposure comes from the aperture, so halving the pupil area must roughly
     halve the light. Roughly, because vignetting and the real pupil are not a
     textbook f-number -- but two stops must not come out as one or as three. */
  const meanY = (fno) => {
    const s = { ...baseSettings(), fno, lightMode: SD.AMBIENT, resW: 36 };
    const st = setup(s);
    const f = FILM.create(st.width, st.height);
    renderRows(st, f, s, 0, 0, st.height);
    let sum = 0;
    for (let i = 0; i < f.n.length; i++) sum += f.xyz[i * 3 + 1] / f.n[i];
    return sum / f.n.length;
  };
  /* Both reachable: this design is wide open at f/5, so f/4 would clamp and the
     "two stops" would silently be one and a third. */
  const wide = meanY(5.6);
  const stopped = meanY(11);         /* two stops down: expect about 1/4 */
  const ratio = wide / stopped;
  assert.ok(ratio > 2.8 && ratio < 5.6,
    `two stops should be about 4x, got ${ratio.toFixed(2)}x`);
});

test("the blade count changes the blur's shape and not the exposure", () => {
  /* The visible half of the iris-area invariant: a hexagonal iris encloses the
     same area as the circle it replaces, so it must not darken the picture.

     Measured at f/8, where the blade polygon fits comfortably inside the
     barrel. Wide open it does not, and that is a different effect entirely --
     see the test below.

     Enough passes that Monte Carlo noise is well under the effect being denied:
     at one pass the three shapes differ by a couple of percent purely because
     they draw different rays; by 64 spp that is a tenth of a percent, so a 1 %
     tolerance is a real claim rather than a loose one. */
  const meanY = (blades) => {
    const s = { ...baseSettings(), blades, fno: 8, lightMode: SD.AMBIENT, resW: 36, spp: 4 };
    const st = setup(s);
    const f = FILM.create(st.width, st.height);
    for (let pass = 0; pass < 16; pass++) renderRows(st, f, s, pass, 0, st.height);
    let sum = 0;
    for (let i = 0; i < f.n.length; i++) sum += f.xyz[i * 3 + 1] / f.n[i];
    return sum / f.n.length;
  };
  const circle = meanY(0);
  for (const blades of [6, 9]) {
    near(meanY(blades), circle, 0.01, `${blades} blades must not change the exposure`);
  }
});

test("nothing promises a starburst this renderer cannot produce", () => {
  /* A real lens's sunstars are diffraction at the blade edges. This renderer is
     geometric -- it knows where rays land, not how they interfere -- so a blade
     count changes the SHAPE of a defocused highlight and nothing else. The
     prompt said otherwise in three places, which would have had the assistant
     confidently describing an effect that can never appear on screen. */
  const K = readFileSync("js/optics/knowledge.js", "utf8");
  const A = readFileSync("js/optics/assistant.js", "utf8");
  for (const [name, src] of [["knowledge", K], ["assistant", A]]) {
    for (const m of src.matchAll(/^.*\b(starburst|sunstar|spike)\w*\b.*$/gim)) {
      const line = m[0];
      /* Saying it is ABSENT is the point; saying it is present is the bug. */
      assert.match(line, /\bno\b|\bNOT\b|never|cannot|diffraction/i,
        `${name} mentions a starburst without denying it: ${line.trim()}`);
    }
  }
  /* And the limits section has to name it, since a visitor will ask. */
  assert.match(optics.LIMITS_TEXT ?? K, /starburst|sunstar/i,
    "the limits should say plainly that there are no sunstars");
});

test("wide open, the blade corners really are clipped by the barrel", () => {
  /* The one case where a blade count DOES change the exposure, and it is not a
     violation of the area invariant -- it is the invariant meeting a real
     mechanical limit.

     An N-gon of the same area as a circle of radius a has to reach further than
     a at its corners: a hexagon reaches 1.0996a. At f/5 this design is wide
     open, its iris is already 10.0 mm against a 10.04 mm bore, and the hexagon's
     corners land at 11.0 mm -- outside the clear aperture of the elements
     behind the stop, which duly clip them. The picture is a couple of percent
     darker, and it should be: the corners of that iris do not fit down the
     barrel.

     Stop down one third of a stop and the polygon fits, and the difference goes
     away. Pinned so that neither half can be "fixed" into the other. */
  const lens = L.build(P.ACHROMAT_100, 100, 5);
  const bore = lens.surf[lens.stopIndex].semiApMm;
  assert.ok(L.irisCircumradius(lens.stopSemiApMm, 6, 0) > bore,
    "wide open, a hexagonal iris must reach past the bore");

  const stopped = L.build(P.ACHROMAT_100, 100, 5.6);
  assert.ok(L.irisCircumradius(stopped.stopSemiApMm, 6, 0) < stopped.surf[stopped.stopIndex].semiApMm,
    "one third of a stop down, it fits");

  const meanY = (blades, fno) => {
    const s = { ...baseSettings(), blades, fno, lightMode: SD.AMBIENT, resW: 36, spp: 4 };
    const st = setup(s);
    const f = FILM.create(st.width, st.height);
    for (let pass = 0; pass < 16; pass++) renderRows(st, f, s, pass, 0, st.height);
    let sum = 0;
    for (let i = 0; i < f.n.length; i++) sum += f.xyz[i * 3 + 1] / f.n[i];
    return sum / f.n.length;
  };
  const lossWideOpen = 1 - meanY(6, 5) / meanY(0, 5);
  assert.ok(lossWideOpen > 0.01,
    `wide open the clipped corners must cost real light, lost ${(lossWideOpen * 100).toFixed(2)}%`);
});

/* ------------------------------------------------------------- the diagram */

test("the diagram's distances come from the lens, not from a formula of its own", () => {
  /* A diagram that disagrees with the render is worse than no diagram. */
  const lens = L.build(P.ACHROMAT_100, 100, 5);
  L.focus(lens, 2.0);
  const d = SD.preset(SD.RAIL);
  const s = S3.build(d, lens, 36, 24, 0.03);
  const ref = L.dof(lens, 0.03);
  assert.equal(s.nearM, ref.near);
  assert.equal(s.farM, ref.far);
  assert.equal(s.hyperfocalM, L.hyperfocalM(lens, 0.03));
});

test("exactly the targets inside the slab are marked sharp", () => {
  const lens = L.build(P.ACHROMAT_100, 100, 5);
  const d = SD.preset(SD.RAIL);
  for (const [at, want] of [[1.0, ["1M"]], [2.0, ["2M"]], [5.0, ["5M"]]]) {
    L.focus(lens, at);
    const s = S3.build(d, lens, 36, 24, 0.03);
    const marked = s.labels.filter((l) => l.kind === S3.SUBJECT).map((l) => l.text);
    assert.deepEqual(marked, want, `focused at ${at} m`);
  }
});

test("the lamp is drawn as off, and the sky appears, under AMBIENT", () => {
  /* Still drawn: losing it off the screen would make switching modes feel like
     deleting it. */
  const lens = L.build(P.ACHROMAT_100, 100, 5);
  L.focus(lens, 2);
  const lamps = S3.build(SD.preset(SD.RAIL), lens, 36, 24, 0.03);
  assert.ok(lamps.labels.some((l) => l.text === "KEY 20800LM"));
  assert.ok(!lamps.segs.some((g) => g.kind === S3.SKY));

  const d = SD.preset(SD.RAIL);
  d.lightMode = SD.AMBIENT;
  const sky = S3.build(d, lens, 36, 24, 0.03);
  assert.ok(sky.labels.some((l) => l.text === "KEY OFF"));
  assert.ok(sky.labels.some((l) => l.text === "SKY 2000 LX"));
  assert.ok(sky.segs.some((g) => g.kind === S3.SKY));
});

test("the diagram survives having no lens at all", () => {
  const s = S3.build(SD.preset(SD.RAIL), null, 36, 24, 0.03);
  assert.ok(s.segs.length > 0, "the ground and the camera are still drawn");
  assert.ok(!s.segs.some((g) => g.kind === S3.FOCUS), "but nothing that needs a lens");
});

/* ------------------------------------------------------------- the settings */

test("there is one clamp path, and it holds for every field", () => {
  for (const f of ST.FIELDS) {
    if (f.enumOf) {
      const s = ST.defaults();
      ST.set(s, f.id, "definitely-not-a-valid-option");
      assert.ok(f.enumOf().includes(s[f.id]), `${f.id} must stay a legal option`);
      continue;
    }
    const lo = ST.defaults(); ST.set(lo, f.id, f.lo - 1e6);
    const hi = ST.defaults(); ST.set(hi, f.id, f.hi + 1e6);
    assert.ok(lo[f.id] >= f.lo, `${f.id} clamped below its floor`);
    assert.ok(hi[f.id] <= f.hi, `${f.id} clamped above its ceiling`);
    const nan = ST.defaults();
    ST.set(nan, f.id, NaN);
    assert.ok(Number.isFinite(nan[f.id]), `${f.id} must reject NaN`);
  }
});

test("one and two blades are a hole in the range, not a limit", () => {
  /* Enforced in set(), not by an input's step, so a value arriving from a URL
     cannot land in it. */
  for (const from of [0, 3, 9]) {
    for (const ask of [1, 2]) {
      const s = ST.defaults();
      ST.set(s, "blades", from);
      ST.set(s, "blades", ask);
      assert.ok(s.blades === 0 || s.blades >= 3,
        `from ${from}, asking ${ask} gave ${s.blades}`);
    }
  }
});

test("exposure and the sharpness limit never restart a render", () => {
  const a = ST.defaults(), b = ST.defaults();
  ST.set(b, "exposure", 1234);
  ST.set(b, "cocLimitMm", 0.01);
  assert.equal(ST.imageDiffers(a, b), false);
  ST.set(b, "fno", 11);
  assert.equal(ST.imageDiffers(a, b), true);
});

test("every settable field survives a hash round trip", () => {
  const s = ST.defaults();
  ST.set(s, "design", P.SINGLET_100);
  ST.set(s, "focalMm", 55);
  ST.set(s, "fno", 2.8);
  ST.set(s, "focusM", 1.25);
  ST.set(s, "blades", 7);
  ST.set(s, "curvature", 0.4);
  ST.set(s, "lightMode", SD.AMBIENT);

  const back = ST.defaults();
  ST.fromHash(`#${ST.toHash(s)}`, back);
  for (const f of ST.FIELDS) {
    assert.equal(back[f.id], s[f.id], `${f.id} did not survive the round trip`);
  }
});

test("a hand-edited link cannot produce a state the panel could not", () => {
  const s = ST.defaults();
  ST.fromHash("#fno=0.001&blades=2&resW=99999&focusM=-4&design=made-up", s);
  assert.ok(s.fno >= 1 && s.fno <= 45);
  assert.ok(s.blades === 0 || s.blades >= 3);
  assert.ok(s.resW <= 640);
  assert.ok(s.focusM >= 0.15);
  assert.ok(P.IDS.includes(s.design));
});

test("an incoming link is a whole state, not a diff against this one", () => {
  /* fromHash reports whether the hash was UNDERSTOOD. It used to report whether
     it had CHANGED anything, which is not the same: a link back to the shipped
     camera is "#preset=rail", so a visitor who had stopped down to f/16 and
     then pasted a colleague's default link was told nothing had changed, and
     the page kept f/16 while the address bar claimed otherwise. */
  const s = ST.defaults();
  assert.equal(ST.toHash(s), "preset=rail", "the default state shares as a bare preset");
  assert.equal(ST.fromHash("#preset=rail", ST.defaults()), true,
    "a link that names the state it already is was still understood");

  /* And the caller can then apply it wholesale: a field the link omits goes
     back to its default rather than keeping what this session left it at. */
  const incoming = ST.defaults();
  ST.fromHash("#preset=rail", incoming);
  assert.equal(incoming.fno, ST.defaults().fno);

  /* Something it cannot read is still refused. */
  assert.equal(ST.fromHash("#preset=not-a-scene", ST.defaults()), false);
  assert.equal(ST.fromHash("#nonsense=1", ST.defaults()), false);
  assert.equal(ST.fromHash("", ST.defaults()), false);
});

test("a bare preset link loads that preset", () => {
  const s = ST.defaults();
  assert.ok(ST.fromHash("#preset=rail", s));
  assert.equal(s.preset, SD.RAIL);
  const t = ST.defaults();
  assert.equal(ST.fromHash("#preset=not-a-scene", t), false);
  assert.equal(t.preset, SD.RAIL);
});

test("the render height follows the sensor and never degenerates", () => {
  assert.equal(ST.resH(320), 213);
  assert.equal(ST.resH(64), 43);
  assert.ok(ST.resH(1) >= 2, "a degenerate grid would divide by zero downstream");
});

test("the derived readouts are finite and agree with the lens they came from", () => {
  const s = baseSettings();
  const st = setup(s);
  const d = derivedOf(st.cam.lens, st.cam.sensorWMm, st.cam.sensorHMm, s.cocLimitMm);
  near(d.eflMm, st.cam.lens.eflMm, 1e-12, "focal length");
  near(d.fNumber, st.cam.lens.fNumber, 1e-12, "f-number");
  near(d.hfovDeg, CAM.hfovDeg(st.cam), 1e-12, "field of view");
  assert.ok(d.tstop > d.fNumber, "a T-stop is always slower than the f-stop it comes from");
  assert.ok(Number.isFinite(d.nearM) && d.nearM > 0);
  assert.ok(Number.isFinite(d.hyperfocalM));
});
