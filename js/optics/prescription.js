/* Lens designs as inert data, from src/os_prescription_data.c.

   THE INVARIANT THIS MODULE OWNS
     A prescription is data and nothing else. It has no f-number, no focus
     distance and no chosen focal length -- those belong to a lens, which is a
     *mounted, stopped, focused instance* of a prescription. Nothing downstream
     of lens.js ever reads a prescription directly.

     And: scaling a prescription by k multiplies EVERY length by k -- radii,
     thicknesses and semi-apertures alike -- leaving every angle in the system,
     and therefore the f-number and the aberration character, exactly unchanged.
     The failure mode that buys is a focal-length control that scales the radii
     but forgets the thicknesses, producing a lens that is neither the original
     design nor any other real design, and which still renders a perfectly
     plausible image.

   SIGN CONVENTION, STATED ONCE AND NOWHERE ELSE
     Light travels in +z. Surfaces are listed front (object side) first, rear
     (sensor side) last. z = 0 is the front vertex at construction time.

         radiusMm > 0   centre of curvature lies at GREATER z than the vertex
         radiusMm < 0   centre of curvature lies at SMALLER z
         radiusMm = 0   plano

     `glass` names the medium the ray enters AFTER crossing this surface, so
     the last surface is essentially always air. `thicknessMm` is the axial gap
     from this surface's vertex to the next one's.

     Get the radius sign backwards and the lens focuses backwards -- and still
     renders an image, just an inverted, wrong one. That is why the convention
     is written here and why lens.build() checks the paraxial focal length
     against the design value before it will hand back a lens. */

import * as G from "./glass.js?v=8425d6a8";

export const MAX_SURF = 24;

export const THIN = "thin";
export const SINGLET_100 = "singlet";
export const ACHROMAT_100 = "achromat";
export const IDS = [THIN, SINGLET_100, ACHROMAT_100];
export const NAMES = { [THIN]: "IDEAL", [SINGLET_100]: "SINGLET", [ACHROMAT_100]: "ACHROMAT" };

/* Glass-reference constructors. Three forms, because prescriptions come from
   three places -- see glass.resolve(). */
const cat = (name) => ({ kind: "catalogue", name });
const air = () => ({ kind: "catalogue", name: "air" });
const konst = (n) => ({ kind: "constant", n });

/* ---- the derived test articles ------------------------------------------

   Both 100 mm designs are built from the thin-lens design equations at fetch
   time, so their radii carry full double precision rather than the four or
   five digits a hand-derivation would print. That matters more than it looks:
   the flint's rear radius comes out as the reciprocal of a DIFFERENCE of two
   similar numbers (1/R2 and phi2/(n2-1) are both about 0.021 and differ in the
   third significant figure), so rounding the inputs to five places moves R3 by
   several millimetres out of eight hundred.

   They are the test articles: the singlet's chromatic error must come out at
   -1/V_d and the doublet's must be two orders of magnitude smaller. That pair
   of results proves the glass table, the paraxial trace and the achromat
   derivation are all simultaneously right, and it is the reason a 100 mm
   doublet nobody would photograph with is the first lens in the file. */

/* SINGLET: equiconvex, so with R2 = -R1 the thin-lens maker's equation

       phi = (n - 1)(1/R1 - 1/R2) = (n - 1)(2/R1)

   gives R1 = 2(n_d - 1)f. For N-BK7 at f = 100 that is 103.36 mm. */
function buildSinglet() {
  const bk7 = G.glass("N-BK7");
  const f = 100.0;
  const R = 2 * (G.n(bk7, G.LINE_D) - 1) * f;

  return {
    name: "singlet100",
    source: "derived: equiconvex N-BK7, thin-lens f = 100 mm at the d line",
    stopIndex: 0,                    /* the front surface is its own stop */
    designEflMm: f,
    designFno: 10.0,                 /* semi-aperture 5 mm at f = 100 mm  */
    imageCircleMm: 20.0,
    surf: [
      { radiusMm: +R, thicknessMm: 4.0, semiApMm: 10.0, glass: cat("N-BK7"), isStop: true },
      { radiusMm: -R, thicknessMm: 0.0, semiApMm: 10.0, glass: air(), isStop: false },
    ],
  };
}

/* ACHROMAT: the Fraunhofer condition. Two thin elements in contact correct
   colour when their powers are split by their Abbe numbers,

       phi1 =  phi V1/(V1 - V2)        phi2 = -phi V2/(V1 - V2)

   because then phi1/V1 + phi2/V2 = 0, which is exactly the statement that the
   F and C focal lengths coincide. The crown is made equiconvex (a free choice
   -- the condition fixes the powers, not the shapes) and the flint's front
   radius is then forced to match the crown's rear so the two can be cemented:

       R1 = 2(n1 - 1)/phi1,   R2 = -R1,   1/R3 = 1/R2 - phi2/(n2 - 1) */
function buildAchromat() {
  const crown = G.glass("N-BK7");
  const flint = G.glass("F2");

  const f = 100.0;
  const phi = 1 / f;

  const v1 = G.abbe(crown), v2 = G.abbe(flint);
  const n1 = G.n(crown, G.LINE_D), n2 = G.n(flint, G.LINE_D);

  const phi1 = (phi * v1) / (v1 - v2);
  const phi2 = (-phi * v2) / (v1 - v2);

  const R1 = (2 * (n1 - 1)) / phi1;          /* crown, equiconvex  */
  const R2 = -R1;                            /* cemented interface */
  const R3 = 1 / (1 / R2 - phi2 / (n2 - 1));

  return {
    name: "achromat100",
    source: "derived: Fraunhofer N-BK7 + F2 cemented doublet, f = 100 mm",
    stopIndex: 0,
    designEflMm: f,
    designFno: 5.0,                  /* semi-aperture 10 mm at f = 100 */
    imageCircleMm: 20.0,
    surf: [
      { radiusMm: R1, thicknessMm: 4.0, semiApMm: 10.0, glass: cat("N-BK7"), isStop: true },
      { radiusMm: R2, thicknessMm: 2.5, semiApMm: 10.0, glass: cat("F2"), isStop: false },
      { radiusMm: R3, thicknessMm: 0.0, semiApMm: 10.0, glass: air(), isStop: false },
    ],
  };
}

/* An ideal thin lens, expressed with a dispersionless medium of index n.

   It exists so there is an optic whose FIRST-ORDER behaviour is exact and whose
   dispersion is zero, to test the exposure and depth-of-field arithmetic
   against: on a real prescription the paraxial numbers and the traced ones
   differ, and a test would have to be loosened until it could no longer see a
   genuine error.

   "Ideal" is therefore a claim about the paraxial trace and the colour, NOT
   about the real one. A single spherical surface is not aplanatic: this lens
   has more spherical aberration than the achromat does -- 0.048 mm against
   0.032 mm on axis at f/5 -- because the doublet's second element is bending
   the marginal rays back and this has nothing to do that with. It is exactly
   100 mm at every wavelength and its blue and red foci coincide, which is all
   it was ever for.

   TWO surfaces, not one. A single surface whose following medium is air has
   n = n' on both sides and therefore no power at all -- the C's first version
   did exactly that and produced a lens of infinite focal length, which
   lens.build() caught. So: a curved entry surface into a dispersionless medium
   of index n, followed by a plano exit back into air. The curved surface has
   power (n - 1)/R, so R = (n - 1)f gives exactly 1/f; the plano surface has
   zero power and only returns the ray to air.

   THE ONE DEVIATION FROM THE C, AND WHY
     The C gives the two surfaces ZERO separation, on the argument that nothing
     then accumulates between them. That is true of the POWER, and it is false
     of the geometry: the R = 100 sphere's cap bulges 13.4 mm past its own
     vertex at the 50 mm clear semi-aperture, so a plano at z = 0 sits INSIDE
     the sphere it is supposed to follow. A sequential tracer visits surfaces in
     prescription order, not in hit order, so a ray reverse-traced from the film
     reaches the plano at z = 0 first, having already flown through where the
     sphere was, and then misses the sphere entirely on the way out. Every
     camera ray is reported vignetted and the ideal lens renders pure black.

     It never showed up in the C because nothing there renders through this
     design -- it exists for the paraxial and exposure tests, which use only the
     y-nu trace, and the C's default lens is the achromat. Here IDEAL is one of
     three designs a visitor can pick, so it has to survive a real trace.

     The separation costs nothing that matters. A plano surface contributes zero
     power at ANY thickness, so the combined power stays phi1 + 0 - phi1*0*t/n =
     phi1: the focal length is still exactly 100.000000000 mm, at every
     wavelength, which is the whole point of this design. Only the back focal
     distance moves (100 -> 90), and that is a position, not a property. */
function buildThin() {
  const f = 100.0;
  const n = 2.0;

  return {
    name: "thin",
    source: "ideal: dispersionless, exactly f = 100 mm",
    stopIndex: 0,
    designEflMm: f,
    designFno: 1.0,
    imageCircleMm: 43.3,             /* covers full frame */
    surf: [
      /* 20 mm clears the 13.4 mm sag at the full semi-aperture with room to
         spare. See the note above; it does not move the focal length. */
      { radiusMm: (n - 1) * f, thicknessMm: 20.0, semiApMm: 50.0, glass: konst(n), isStop: true },
      { radiusMm: 0.0, thicknessMm: 0.0, semiApMm: 50.0, glass: air(), isStop: false },
    ],
  };
}

/* Fetch a prescription BY VALUE, recomputed per call -- so there is no lazily
   initialised module-level object to be scribbled on by a caller that scales
   it. A prescription is fetched once per lens build, never in a render loop. */
export function prescription(id) {
  switch (id) {
    case THIN:         return buildThin();
    case SINGLET_100:  return buildSinglet();
    case ACHROMAT_100: return buildAchromat();
  }
  throw new Error(`unknown lens design: ${id}`);
}

export const prescriptionName = (id) => NAMES[id] || "?";

/* Scale every length by k. Every length, or it is not a real design. The
   f-number is preserved automatically: the focal length and the entrance pupil
   scale together, and every angle in the system is untouched. Mutates in
   place, on the caller's own copy. */
export function scale(p, k) {
  for (const s of p.surf) {
    s.radiusMm *= k;      /* 0 stays 0: a plano stays plano */
    s.thicknessMm *= k;
    s.semiApMm *= k;
  }
  p.designEflMm *= k;
  p.imageCircleMm *= k;
  /* designFno is deliberately NOT scaled. That is the whole point. */
  return p;
}
