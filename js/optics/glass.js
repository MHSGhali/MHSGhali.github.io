/* Refractive index as a function of wavelength, from src/os_glass.c and
   os_glass_data.c.

   THE INVARIANT THIS MODULE OWNS
     The refractive index is a function of (glass, wavelength) and of nothing
     else, and every `n` in this port comes from here. There is no default
     index, no "about 1.5", and no per-surface override.

     The failure mode that buys: a hard-coded 1.5 somewhere in the tracer
     deletes chromatic aberration completely while leaving every image perfectly
     plausible. There is no visual tell -- a lens with no dispersion just looks
     like a good lens. Confining n to one function means the only way to lose
     colour is to delete this file.

   DISPERSION LIVES HERE AND ONLY HERE
     js/light/spectrum.js may carry all 95 bins down one path because every
     SCENE material is non-dispersive. This module is the exception that forced
     hero-wavelength sampling (see spectral.js), and it is reached from the
     sequential lens tracer only -- never from a Bsdf. The C enforces that fence
     with a grep gate in its Makefile; here it is a convention, so: if you find
     yourself importing this from trace.js, something has gone wrong.

   THE MODEL
     Three-term Sellmeier, the form every glass catalogue publishes:

         n^2(lambda) - 1 = sum_i  B_i lambda^2 / (lambda^2 - C_i)

     with lambda in MICROMETRES and C_i in um^2. Nanometres are the unit
     everywhere else, so n() takes nanometres and converts internally: that
     division by 1000 happens in exactly one place. A stray factor of 1000
     inside a square root does not produce an obviously broken number, it
     produces a lens that is subtly the wrong shape. */

/* The three Fraunhofer lines that define n_d and the Abbe number. Blue F and
   red C bracket the visible band; yellow d is where "the" index is quoted. */
export const LINE_F = 486.1327;   /* H  F, blue   */
export const LINE_D = 587.5618;   /* He d, yellow */
export const LINE_C = 656.2725;   /* H  C, red    */

/* The catalogue. Every row carries its PUBLISHED n_d and V_d beside its
   coefficients, and selfCheck() recomputes both from the coefficients -- so a
   mistyped digit fails a test rather than quietly changing a lens's colour
   correction. The data checks itself; nobody has to trust the typing.

   Sorted by n_d, crowns (high V_d) first then flints (low V_d), which is the
   order a lens designer thinks in: the achromat pairs a crown with a flint. */
export const CATALOGUE = {
  /* All B zero, so n^2 = 1 exactly at every wavelength -- no rounding, no
     dispersion. Not Edlen's formula for real air, which differs in the fourth
     decimal: a prescription's air gaps are design values measured against
     vacuum-referenced indices, so real air here would shift every lens's focus
     by microns and fail the paraxial self-checks for a reason that looks like a
     coding error. The published fields are 0 to mark "nothing to check". */
  air: { B: [0, 0, 0], C: [0, 0, 0], nd: 0, vd: 0, name: "air" },

  /* ---- crowns ---- */
  "N-BK7":   { B: [1.03961212, 0.231792344, 1.01046945],
               C: [0.00600069867, 0.0200179144, 103.560653],
               nd: 1.51680, vd: 64.17, name: "N-BK7" },
  "N-SK16":  { B: [1.34317774, 0.241144399, 0.994317969],
               C: [0.00704687339, 0.0229005, 92.7508526],
               nd: 1.62041, vd: 60.32, name: "N-SK16" },
  "N-LAK9":  { B: [1.462312, 0.344399589, 1.15508372],
               C: [0.00724270156, 0.0243353131, 85.4686868],
               nd: 1.69100, vd: 54.71, name: "N-LAK9" },
  "N-BAF10": { B: [1.5851495, 0.143559385, 1.08521269],
               C: [0.00926681282, 0.0424489805, 105.613573],
               nd: 1.67003, vd: 47.11, name: "N-BAF10" },
  "N-LAF2":  { B: [1.80984227, 0.15729555, 1.0930037],
               C: [0.0101711622, 0.0442431765, 100.687748],
               nd: 1.74397, vd: 44.85, name: "N-LAF2" },

  /* ---- flints ---- */
  F2:        { B: [1.34533359, 0.209073176, 0.937357162],
               C: [0.00997743871, 0.0470450767, 111.886764],
               nd: 1.62004, vd: 36.37, name: "F2" },
  SF2:       { B: [1.40301821, 0.231767504, 0.939056586],
               C: [0.0105795466, 0.0493226978, 112.405955],
               nd: 1.64769, vd: 33.85, name: "SF2" },
  "N-SF5":   { B: [1.52481889, 0.187085527, 1.42729015],
               C: [0.011254756, 0.0588995392, 129.141675],
               nd: 1.67271, vd: 32.25, name: "N-SF5" },
  SF11:      { B: [1.73759695, 0.313747346, 1.89878101],
               C: [0.013188707, 0.0623068142, 155.23629],
               nd: 1.78472, vd: 25.68, name: "SF11" },
};

export const AIR = CATALOGUE.air;

export const glass = (name) => CATALOGUE[name] || AIR;

/* ---- evaluation ---- */

/* Refractive index at `lambdaNm`. */
export function n(g, lambdaNm) {
  /* Nanometres in, micrometres for the maths. THE one place this conversion
     happens; C_i are published in um^2. */
  const l = lambdaNm * 1e-3;
  const l2 = l * l;

  let n2m1 = 0;
  for (let i = 0; i < 3; i++) {
    const d = l2 - g.C[i];
    /* A resonance sits exactly at C_i, where the term blows up. No visible
       wavelength lands on a real glass's resonance (they are in the UV and the
       far IR), so this guard is for a corrupt table, not for physics -- and
       skipping the term is quieter than an Infinity propagating into every
       ray. */
    if (Math.abs(d) < 1e-12) continue;
    n2m1 += (g.B[i] * l2) / d;
  }

  /* Air has all B zero, so n2m1 is exactly 0 and this returns exactly 1.0 --
     no sqrt rounding. The lens tracer compares indices to decide whether a
     surface refracts at all, so that exactness is asserted by the tests. */
  const n2 = 1 + n2m1;
  return n2 > 0 ? Math.sqrt(n2) : 1;
}

/* Mean dispersion n_F - n_C. */
export const dispersion = (g) => n(g, LINE_F) - n(g, LINE_C);

/* Abbe number V_d = (n_d - 1) / (n_F - n_C), computed from the coefficients
   rather than read from the published field, so it can be compared against it.
   Returns 0 for air, which has no dispersion to divide by -- rather than
   Infinity, which would keep it printable and keep a caller that sums Abbe
   numbers from producing a NaN. */
export function abbe(g) {
  const dn = dispersion(g);
  if (Math.abs(dn) < 1e-15) return 0;
  return (n(g, LINE_D) - 1) / dn;
}

/* A dispersionless glass of index `nConst`, exactly, at every wavelength.

   Not physical -- no real material has zero dispersion -- and that is the
   point: it is how the IDEAL thin lens is expressed, so there is an optic that
   contributes no COLOUR of its own. It still refracts, so the surface it is
   used on still has whatever shape aberration that surface has; only the
   wavelength dependence is gone.

   The trick is that a Sellmeier term with C = 0 reduces to a constant:
   lambda^2/(lambda^2 - 0) is 1 for every lambda, so B_1 = n^2 - 1 gives
   n^2(lambda) = n^2 identically, with no special case in the evaluator. */
export function constant(nConst) {
  return {
    B: [nConst * nConst - 1, 0, 0], C: [0, 0, 0],
    nd: 0, vd: 0, name: "ideal",
  };
}

/* ---- model glasses ------------------------------------------------------

   Published lens prescriptions almost never name their glasses -- they print
   two numbers per element, n_d and V_d, and leave the catalogue match to the
   reader. Guessing "nearest catalogue entry" gets n_d right and V_d wrong,
   which is precisely backwards: V_d is what decides the lens's colour
   correction, and colour correction is what this page exists to show.

   Two-term Sellmeier with the resonances pinned, so only B1 and B2 are free:

     n^2(l) - 1 = B1 l^2/(l^2 - C1) + B2 l^2/(l^2 - C2),   C1 = 0.01, C2 = 100

   one resonance below the visible band and one above it, which is the physical
   shape of a real glass. Constraint (a), n(l_d) = nd, is LINEAR in (B1, B2), so
   B2 is eliminated:

     B2 = (nd^2 - 1 - B1 g1(l_d)) / g2(l_d)

   Constraint (b), n(l_F) - n(l_C) = (nd - 1)/vd, is not linear, but with B2
   eliminated it is a smooth scalar function of B1 alone -- so a secant
   iteration closes it in a handful of steps with no derivative to get wrong. */

const MODEL_C1 = 0.01;    /* um^2, a UV resonance below the visible band */
const MODEL_C2 = 100.0;   /* um^2, an IR resonance above it              */

function gterm(lambdaNm, C) {
  const l2 = (lambdaNm * 1e-3) * (lambdaNm * 1e-3);
  return l2 / (l2 - C);
}

/* Residual of constraint (b) for a trial B1, with B2 pinned by constraint (a).
   Mutates `g` in place, as the C does, so the loop allocates nothing. */
function modelResidual(B1, nd, targetDn, g) {
  const B2 = ((nd * nd - 1) - B1 * gterm(LINE_D, MODEL_C1)) / gterm(LINE_D, MODEL_C2);
  g.B[0] = B1; g.B[1] = B2; g.B[2] = 0;
  g.C[0] = MODEL_C1; g.C[1] = MODEL_C2; g.C[2] = 0;
  return dispersion(g) - targetDn;
}

/* Synthesise a glass reproducing (nd, vd) EXACTLY.

   Throws if the solve did not converge, which happens for physically
   impossible (nd, vd) pairs. Refusing is the point: an unconverged glass has a
   plausible index and a wrong dispersion, and downstream it looks like a lens
   design error rather than a data error. Here is the only place the
   distinction is still clear. */
export function model(nd, vd) {
  if (!(nd > 1) || !(vd > 0)) throw new Error(`model glass needs nd > 1 and vd > 0, got ${nd}, ${vd}`);

  const g = { B: [0, 0, 0], C: [0, 0, 0], nd: 0, vd: 0, name: "model" };
  const targetDn = (nd - 1) / vd;

  /* Secant needs two seeds. B1 near n^2-1 puts almost all the index on the UV
     term, which is where a real crown sits; the second is deliberately far
     away so the first step is informative. */
  let x0 = nd * nd - 1;
  let x1 = x0 * 0.5;
  let f0 = modelResidual(x0, nd, targetDn, g);
  let f1 = modelResidual(x1, nd, targetDn, g);

  for (let it = 0; it < 100; it++) {
    const denom = f1 - f0;
    if (Math.abs(denom) < 1e-18) break;   /* flat: no secant step exists */
    const x2 = x1 - (f1 * (x1 - x0)) / denom;
    const f2 = modelResidual(x2, nd, targetDn, g);
    x0 = x1; f0 = f1;
    x1 = x2; f1 = f2;
    if (Math.abs(f2) < 1e-15) break;
  }

  /* Verify rather than trust the loop. */
  modelResidual(x1, nd, targetDn, g);
  if (!(Math.abs(n(g, LINE_D) - nd) < 1e-9)) {
    throw new Error(`model glass did not converge on n_d: wanted ${nd}, got ${n(g, LINE_D)}`);
  }
  if (!(Math.abs(dispersion(g) - targetDn) < 1e-12)) {
    throw new Error(`model glass did not converge on V_d: wanted ${vd}, got ${abbe(g)}`);
  }
  return g;
}

/* ---- data integrity ---- */

/* Assert that every catalogue entry's coefficients reproduce its own published
   n_d and V_d. Returns null when clean, or the first failure as a string. */
export function selfCheck() {
  for (const g of Object.values(CATALOGUE)) {
    if (g.nd <= 0) continue;   /* air */
    const nd = n(g, LINE_D);
    const vd = abbe(g);
    /* Catalogues print n_d to five decimals, so 1e-4 is about one unit in the
       last published place -- tight enough to catch a mistyped digit, loose
       enough not to fire on the rounding in the published value. */
    if (Math.abs(nd - g.nd) > 1e-4) {
      return `${g.name}: n_d computed ${nd.toFixed(6)}, published ${g.nd.toFixed(5)}`;
    }
    /* V_d is a ratio of small differences, so it amplifies coefficient error;
       0.05 is roughly one unit in its last published place. */
    if (Math.abs(vd - g.vd) > 0.05) {
      return `${g.name}: V_d computed ${vd.toFixed(3)}, published ${g.vd.toFixed(2)}`;
    }
  }
  return null;
}

/* Resolve a prescription's glass reference to an actual glass. Three forms,
   because prescriptions come from three places: named catalogue entries,
   transcribed (n_d, V_d) pairs, and the ideal lens's dispersionless medium. */
export function resolve(ref) {
  if (!ref || ref.kind === "air") return AIR;
  switch (ref.kind) {
    case "catalogue": return glass(ref.name);
    case "model":     return model(ref.nd, ref.vd);
    case "constant":  return constant(ref.n);
  }
  throw new Error(`unknown glass reference kind: ${ref.kind}`);
}
