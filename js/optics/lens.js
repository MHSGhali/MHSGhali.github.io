/* A mounted lens: scaled, stopped, focused, and traceable. From src/os_lens.c.

   THE INVARIANT THIS MODULE OWNS
     Every ray that reaches the world passed through the clear aperture of every
     surface AND through the iris, exactly once each. Nothing is faked, nothing
     is clipped twice, and the ONLY vignetting in this program is geometric --
     it emerges from those clips and from nowhere else.

     The failure mode that buys is subtle and extremely common: adding a cos^4
     falloff term "because lenses darken at the edges". The cos^4 law is already
     produced by the pupil-sampling Jacobian in camera.js, so an added term
     double-counts it, darkens the corners by roughly a factor of two, and looks
     like a tasteful vignette rather than a bug. If a corner is dark here, it is
     because rays aimed at it hit the edge of a real element.

   COORDINATES
     Lens space is MILLIMETRES, z along the axis, +z from the object toward the
     sensor, origin at the FRONT VERTEX. The scene is metres. Those two units
     meet in exactly one function, camera.sample(). A radius in mm multiplied by
     a scene distance in metres is a 1000x focus error, and a 1000x focus error
     does not look like a crash, it looks slightly soft.

   PARAXIAL ANALYSIS
     The y-nu trace below is the classical first-order method, and it is worth
     having even though a real trace is also implemented, for three reasons: it
     defines the focal length and the pupils (which are first-order properties,
     not measurements); it runs at any wavelength, which is how chromatic
     aberration becomes a NUMBER rather than a coloured fringe you squint at;
     and it is the reference the real trace must converge to as the ray height
     goes to zero, which is the test that says spherical aberration is being
     computed rather than invented.

         per surface:  u' = (n u - y (n' - n)/R) / n'      then  y += u' t
         EFL = -y_first / u'_last      BFD = -y_last / u'_last */

import { PI, TWO_PI, clamp, lerp } from "../light/core.js?v=6aaa6367";
import * as v from "../light/vec3.js?v=6aaa6367";
import { fresnelDielectric } from "../light/bsdf.js?v=6aaa6367";
import * as G from "./glass.js?v=6aaa6367";
import * as P from "./prescription.js?v=6aaa6367";

/* Index of the medium AFTER surface i. */
export function nAfter(L, i, lambdaNm) {
  if (i < 0 || i >= L.surf.length) return 1;
  return G.n(L.glass[i], lambdaNm);
}

/* Index of the medium BEFORE surface i. Object space, ahead of the first
   surface, is air by definition. */
export function nBefore(L, i, lambdaNm) {
  if (i <= 0) return 1;
  return G.n(L.glass[i - 1], lambdaNm);
}

/* Axial z of surface i's vertex, measured from the front vertex. */
export function vertexZ(L, i) {
  let z = 0;
  for (let k = 0; k < i && k < L.surf.length; k++) z += L.surf[k].thicknessMm;
  return z;
}

/* ---- the y-nu trace ----------------------------------------------------

   One paraxial ray, traced surface by surface. `y` is the height at the current
   surface and `u` the slope leaving it. A plano surface (R = 0) has zero power,
   which the guard below expresses directly rather than by dividing by zero and
   hoping the infinity cancels.

   Entering parallel to the axis at height 1 makes the outputs fall out: the ray
   crosses the axis one focal length behind the rear principal plane, so
   EFL = -y_in/u'_out, and it crosses it BFD behind the rear vertex, so
   BFD = -y_out/u'_out. */
function ynuTrace(L, lambdaNm, y0, u0) {
  let y = y0, u = u0;
  const ns = L.surf.length;
  for (let i = 0; i < ns; i++) {
    const n = nBefore(L, i, lambdaNm);
    const np = nAfter(L, i, lambdaNm);
    const R = L.surf[i].radiusMm;

    const power = Math.abs(R) < 1e-12 ? 0 : (np - n) / R;
    u = (n * u - y * power) / np;

    if (i + 1 < ns) y += u * L.surf[i].thicknessMm;
  }
  return { y, u };
}

/* Full y-nu trace at one wavelength. This is where chromatic aberration is
   measured rather than merely seen. */
export function paraxial(L, lambdaNm) {
  const { y, u } = ynuTrace(L, lambdaNm, 1, 0);

  /* u == 0 means the lens has no power -- an afocal stack, or a bug. Report
     infinity rather than dividing by zero, so a caller sees "no focus" instead
     of a NaN that spreads silently through everything downstream. */
  const efl = Math.abs(u) < 1e-15 ? Infinity : -1 / u;
  const bfd = Math.abs(u) < 1e-15 ? Infinity : -y / u;
  /* The rear principal plane is where the extended incoming ray meets the
     extended outgoing one; it sits BFD - EFL from the rear vertex. */
  return { efl, bfd, ppRear: bfd - efl };
}

/* Effective focal length at a wavelength. eflAt(F) - eflAt(C) over eflAt(d) is
   the longitudinal chromatic aberration, and for a thin singlet it equals
   exactly -1/V_d. */
export const eflAt = (L, lambdaNm) => paraxial(L, lambdaNm).efl;

/* ---- the pupils --------------------------------------------------------

   A pupil is the IMAGE of the aperture stop: the entrance pupil is the stop
   seen from in front, through whatever glass precedes it; the exit pupil is the
   stop seen from behind, through whatever follows it. They matter for different
   things -- the entrance pupil defines the f-number, and the exit pupil
   subtends the blur cone at the film and so sets the circle of confusion.

   FINDING THE IMAGE OF A POINT NEEDS TWO RAYS.
     The C's first version traced ONE ray leaving the stop parallel to the axis
     and reported where it crossed. That is not the image of the stop; it is the
     FOCAL POINT of the group, because a ray parallel to the axis is by
     definition the one that defines the focus. It gave a pupil roughly a focal
     length from where the pupil actually is, and therefore a defocus blur off
     by a factor of six -- while still producing a plausible number that scaled
     correctly with aperture.

     The image of a point is where rays LEAVING THAT POINT reconverge. So trace
     two, from the same point at different slopes, and intersect them. */

/* One paraxial ray from (height y0, slope u0) at z0, through surfaces i0..i1 in
   the direction of travel, ending at the plane zEnd. `forward` selects whether
   i runs up (toward the sensor) or down (toward the object); the indices swap
   with the direction. */
function ynuRange(L, lambdaNm, forward, i0, i1, y0, u0, z0, zEnd) {
  let y = y0, u = u0, z = z0;
  const step = forward ? 1 : -1;
  for (let i = i0; forward ? i <= i1 : i >= i1; i += step) {
    const zi = vertexZ(L, i);
    y += u * (zi - z);
    z = zi;
    const n = forward ? nBefore(L, i, lambdaNm) : nAfter(L, i, lambdaNm);
    const np = forward ? nAfter(L, i, lambdaNm) : nBefore(L, i, lambdaNm);
    const R = L.surf[i].radiusMm;
    /* Travelling the other way flips the sign of the curvature. */
    const Reff = forward ? R : -R;
    const power = Math.abs(Reff) < 1e-12 ? 0 : (np - n) / Reff;
    u = (n * u - y * power) / np;
  }
  y += u * (zEnd - z);
  return { y, u };
}

/* Image the stop plane through surfaces i0..i1, reporting the magnification and
   where the image sits relative to zRef. */
function imageStop(L, lambdaNm, forward, i0, i1, zStop, zRef) {
  /* Two rays from the same stop-edge point, at different slopes. */
  const U = 0.02;
  const a = ynuRange(L, lambdaNm, forward, i0, i1, 1, 0, zStop, zRef);
  const b = ynuRange(L, lambdaNm, forward, i0, i1, 1, U, zStop, zRef);

  const du = a.u - b.u;
  if (Math.abs(du) < 1e-15) {
    /* The two rays stayed parallel: the group is afocal for this plane, so the
       image is at infinity. Report the stop unchanged rather than an infinity
       that would propagate into every blur calculation. */
    return { mag: 1, zImg: 0 };
  }
  const t = (b.y - a.y) / du;
  return { zImg: t, mag: a.y + a.u * t };   /* the object height was 1 */
}

function entrancePupil(L, lambdaNm) {
  const s = L.stopIndex;
  const zStop = vertexZ(L, s);

  if (s <= 0) {
    /* Nothing in front of the stop: it IS the entrance pupil. */
    L.epZMm = zStop;
    L.epMag = 1;
    L.epSemiApMm = L.stopSemiApMm;
    return;
  }
  const { mag, zImg } = imageStop(L, lambdaNm, false, s - 1, 0, zStop, 0);
  L.epMag = mag;
  L.epZMm = zImg;                            /* from the front vertex */
  L.epSemiApMm = L.stopSemiApMm * Math.abs(mag);
}

function exitPupil(L, lambdaNm) {
  const s = L.stopIndex;
  const ns = L.surf.length;
  const zStop = vertexZ(L, s);
  const zRear = vertexZ(L, ns - 1);

  if (s >= ns - 1) {
    L.xpMag = 1;
    L.xpSemiApMm = L.stopSemiApMm;
    L.xpZMm = zStop - zRear;
    return;
  }
  const { mag, zImg } = imageStop(L, lambdaNm, true, s + 1, ns - 1, zStop, zRear);
  L.xpMag = mag;
  L.xpZMm = zImg;                            /* from the REAR vertex */
  L.xpSemiApMm = L.stopSemiApMm * Math.abs(mag);
}

/* Diameter of the defocus blur, in mm on the film, for an object at
   `objectDistanceM` with the lens focused where it currently is.

   Computed from the EXIT pupil and the actual film position rather than from
   the textbook thin-lens expression, which silently assumes the two pupils are
   the same size. Returns 0 at the focused distance. */
export function cocMm(L, objectDistanceM) {
  let sPrime;
  if (!Number.isFinite(objectDistanceM)) {
    sPrime = L.eflMm;
  } else {
    const sFromPp = objectDistanceM * 1000 - (L.ffdMm + L.eflMm);
    if (sFromPp <= L.eflMm) return Infinity;
    sPrime = 1 / (1 / L.eflMm - 1 / sFromPp);
  }
  const zImg = L.ppRearMm + sPrime;          /* from the rear vertex */
  const defocus = Math.abs(L.filmZMm - zImg);

  /* Similar triangles from the exit pupil: the cone it subtends has narrowed to
     a point at zImg, so at the film it is this wide. */
  const lever = zImg - L.xpZMm;
  if (!(Math.abs(lever) > 1e-9)) return Infinity;
  return (2 * L.xpSemiApMm * defocus) / Math.abs(lever);
}

/* Set the f-number. The stop radius follows from the ENTRANCE pupil, not from
   f/(2N) directly: the entrance pupil is the paraxial image of the stop formed
   by the elements in FRONT of it, and ignoring that magnification is wrong by
   10-20 % on a real design -- a quarter of a stop of exposure error that no
   image would ever reveal. */
export function setFnumber(L, fno) {
  if (!(fno > 0)) return false;

  /* Wanted entrance-pupil DIAMETER is efl/N, so its radius is efl/(2N). The
     stop that produces it is smaller by the pupil magnification. */
  const wantEpSemi = L.eflMm / (2 * fno);

  /* The magnification does not depend on the stop size, so it can be found once
     with a provisional stop and then inverted. */
  L.stopSemiApMm = wantEpSemi;               /* provisional, to seed the trace */
  entrancePupil(L, G.LINE_D);
  const m = Math.abs(L.epMag) > 1e-12 ? Math.abs(L.epMag) : 1;

  let stop = wantEpSemi / m;

  /* The iris cannot open wider than the mechanical hole it sits in: a 50 mm
     design whose front element is 20 mm across cannot be an f/1.4 lens no
     matter what the caller asks for. Clamping is the right behaviour -- a UI
     dragging the aperture should stop at the limit rather than error -- but the
     clamp MUST be reflected back in fNumber. Storing the requested value
     instead would make the lens report f/1.4 while passing f/5 worth of light,
     and every exposure computed from it would be wrong by that ratio with
     nothing to show for it. */
  const limit = L.surf[L.stopIndex].semiApMm;
  const clamped = stop > limit;
  if (clamped) stop = limit;

  L.stopSemiApMm = stop;
  entrancePupil(L, G.LINE_D);                /* recompute with the final stop */
  exitPupil(L, G.LINE_D);

  L.fNumber = clamped ? L.eflMm / (2 * L.epSemiApMm) : fno;
  return true;
}

/* ---- focus --------------------------------------------------------------

   For an object at distance s the paraxial image distance from the REAR
   principal plane is given by the thick-lens conjugate equation, and the film
   sits that far behind the rear principal plane.

       1/s' = 1/f + 1/s        (s measured positive toward the object)

   At infinity s' = f, and the film lands at BFD behind the rear vertex, which
   is the definition of BFD -- so the two paths agree at the limit, and that
   agreement is asserted in the tests.

   Focusing moves the FILM, not the glass, so the camera's pose stays anchored
   at the front vertex and the world does not walk while racking. */
export function focus(L, distanceM) {
  if (!(distanceM > 0)) return false;

  if (!Number.isFinite(distanceM)) {
    L.filmZMm = L.bfdMm;
    L.focusDistanceM = Infinity;
    return true;
  }

  const sMm = distanceM * 1000;
  /* Object distance is measured from the FRONT principal plane, so subtract the
     front principal plane offset from the front vertex. Working in the
     thick-lens form keeps this correct for a long telephoto, where the
     principal planes sit well outside the glass. */
  const sFromPp = sMm - (L.ffdMm + L.eflMm);
  if (sFromPp <= L.eflMm) return false;      /* inside the front focal point */

  const sPrime = 1 / (1 / L.eflMm - 1 / sFromPp);
  L.filmZMm = L.ppRearMm + sPrime;
  L.focusDistanceM = distanceM;
  return true;
}

/* Transmittance at one wavelength on axis: the product of (1 - R_fresnel) over
   every glass-air interface. This is the f-stop / T-stop gap, and it is real:
   an uncoated double Gauss transmits about 60 %. */
export function transmittance(L, lambdaNm) {
  let t = 1;
  for (let i = 0; i < L.surf.length; i++) {
    const n = nBefore(L, i, lambdaNm);
    const np = nAfter(L, i, lambdaNm);
    if (Math.abs(np - n) < 1e-12) continue;  /* not an optical interface */
    /* At normal incidence, which is what "on axis" means. */
    t *= 1 - fresnelDielectric(1, n / np);
  }
  return t;
}

/* Half the diagonal field angle the design covers, in degrees, given a sensor
   diagonal. Reports coverage. */
export function halfFovDeg(L, sensorDiagonalMm) {
  if (!(L.eflMm > 0)) return 0;
  return (Math.atan2(sensorDiagonalMm * 0.5, L.eflMm) * 180) / PI;
}

/* ---- build --------------------------------------------------------------

   Refuses, with a reason, if the resulting paraxial focal length does not match
   the design value. Transcription error is the most likely defect in any
   prescription table, and a lens whose focal length is 12 % off still renders a
   perfectly convincing image -- of the wrong field of view. Pass eflMm <= 0 to
   keep the design's own focal length. */
export function build(id, eflMm, fno) {
  const p = P.prescription(id);

  const L = {
    name: p.name,
    surf: p.surf.map((s) => ({ ...s })),
    glass: p.surf.map((s) => G.resolve(s.glass)),
    stopIndex: p.stopIndex >= 0 ? p.stopIndex : 0,
    imageCircleMm: p.imageCircleMm,
  };
  const ns = L.surf.length;
  L.totalTrackMm = vertexZ(L, ns - 1);

  /* First-order properties, at the d line, before anything can use them. */
  let px = paraxial(L, G.LINE_D);
  L.eflMm = px.efl; L.bfdMm = px.bfd; L.ppRearMm = px.ppRear;
  if (!Number.isFinite(L.eflMm) || L.eflMm <= 0) {
    throw new Error(`${p.name}: paraxial focal length is not a positive finite number (${L.eflMm})`);
  }

  /* The front focal distance, by the same trace run from the other end. */
  {
    let y = 1, u = 0;
    for (let i = ns - 1; i >= 0; i--) {
      const n = nAfter(L, i, G.LINE_D);
      const np = nBefore(L, i, G.LINE_D);
      const R = L.surf[i].radiusMm;
      if (i + 1 < ns) y += u * L.surf[i].thicknessMm;
      const power = Math.abs(R) < 1e-12 ? 0 : (np - n) / -R;
      u = (n * u - y * power) / np;
    }
    /* NEGATED -- that is what dividing y by u rather than -y by u amounts to --
       because this ray travels in -z.

       The y-nu trace reports the crossing as a DISTANCE along the direction of
       travel; that direction is toward the object, so a crossing 100 mm ahead
       of the front vertex sits at z = -100 in the lens's own coordinates.
       Without the flip a thin lens reports its front focal point 100 mm BEHIND
       its vertex, which puts the front principal plane 200 mm out and makes
       every focus distance wrong -- consistently, and in a way that still
       focuses on something. */
    L.ffdMm = Math.abs(u) < 1e-15 ? -Infinity : y / u;
  }

  /* THE transcription gate. */
  const want = p.designEflMm;
  if (Math.abs(L.eflMm - want) > 0.01 * want) {
    throw new Error(
      `${p.name}: paraxial EFL ${L.eflMm.toFixed(4)} mm but the design says ` +
      `${want.toFixed(4)} mm (${(100 * (L.eflMm - want) / want).toFixed(2)}% off) ` +
      `-- check the table's radii and signs`
    );
  }

  /* Scale to the REQUESTED focal length, using the focal length actually
     measured rather than the design's nominal one.

     Those two differ: the design values come from thin-lens equations, and a
     real doublet with 4 mm and 2.5 mm elements comes out ~0.4 % shorter. If k
     were computed from the nominal value, asking for an 85 mm lens would hand
     back an 84.7 mm one -- small, permanent, and invisible in every image.
     Paraxial focal length is exactly proportional to k, so measuring once and
     dividing is exact and needs no iteration. */
  L.scale = 1;
  if (eflMm > 0) {
    const k = eflMm / L.eflMm;
    for (const s of L.surf) {
      s.radiusMm *= k;
      s.thicknessMm *= k;
      s.semiApMm *= k;
    }
    L.scale = k;
    L.imageCircleMm *= k;
    L.totalTrackMm = vertexZ(L, ns - 1);
    px = paraxial(L, G.LINE_D);
    L.eflMm = px.efl; L.bfdMm = px.bfd; L.ppRearMm = px.ppRear;
    L.ffdMm *= k;
  }

  /* Nine straight blades: the common photographic default. An odd blade count
     gives 2N starburst spikes instead of N, which is why most lenses have an
     odd one. Changing this changes the SHAPE of the blur and the spike count;
     irisCircumradius keeps it from changing the exposure by so much as a
     photon. The page's default is a perfect circle (blades = 0) so the first
     thing a visitor sees is not a nonagon. */
  L.blades = 9;
  L.bladeRotRad = 0;
  L.bladeCurvature = 0;

  if (!setFnumber(L, fno > 0 ? fno : p.designFno)) {
    throw new Error(`${p.name}: f/${fno} is not a usable aperture`);
  }
  focus(L, Infinity);
  return L;
}

/* ---- real sequential ray tracing ----------------------------------------

   Lens-local coordinates, MILLIMETRES, +z toward the sensor, origin at the
   front vertex. A ray is { o, d } with `d` unit length. */

/* Intersect a spherical (or plano, radius 0) surface whose vertex sits at
   zVertex on the axis. Returns the outward normal UNFLIPPED -- the caller
   decides orientation, exactly as js/light/geom.js refuses to flip a hit
   normal, because silently flipping normals is a whole family of energy-leak
   bugs. Returns null on a miss. */
export function surfaceHit(radiusMm, zVertex, r) {
  if (Math.abs(radiusMm) < 1e-12) {
    /* Plano: a plane at z = zVertex. A ray travelling perpendicular to the axis
       never meets it, and dividing by d.z would give an infinity that survives
       as a plausible-looking coordinate. */
    if (Math.abs(r.d.z) < 1e-12) return null;
    const t = (zVertex - r.o.z) / r.d.z;
    if (t <= 0) return null;
    return { t, n: v.v3(0, 0, 1) };
  }

  /* Sphere centred on the axis, one radius beyond the vertex. */
  const cz = zVertex + radiusMm;
  const m = v.v3(r.o.x, r.o.y, r.o.z - cz);

  const b = v.dot(m, r.d);
  const c = v.dot(m, m) - radiusMm * radiusMm;
  const disc = b * b - c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t0 = -b - sq, t1 = -b + sq;

  /* WHICH root is the surface depends on the direction of travel AND the sign
     of the curvature. Taking -b - sqrt(disc) unconditionally picks the far side
     of the sphere for a negative radius: the lens still traces, it just uses
     the wrong cap, and the image it forms looks like a real image with the
     wrong aberrations. The exclusive-or is the whole rule. */
  const useCloser = (r.d.z > 0) !== (radiusMm < 0);
  let t = useCloser ? Math.min(t0, t1) : Math.max(t0, t1);
  if (t <= 0) {
    t = useCloser ? Math.max(t0, t1) : Math.min(t0, t1);
    if (t <= 0) return null;
  }

  const p = v.add(r.o, v.scale(r.d, t));
  /* Outward from the centre, unflipped -- refract() orients it. */
  return { t, n: v.normalize(v.v3(p.x, p.y, p.z - cz)) };
}

/* Snell. `eta` is n_in/n_out. Returns null on total internal reflection, which
   KILLS the ray rather than reflecting it: that light does not reach the film
   along the intended path, and the reflected branch is a flare pass's business,
   not the primary trace's. */
export function refract(d, n, eta) {
  /* Orient the normal against the incoming ray so cosI is positive; this is the
     one place a normal may be flipped, and it is flipped for the local
     arithmetic only, never stored. */
  let cosI = -v.dot(d, n);
  if (cosI < 0) { n = v.neg(n); cosI = -cosI; }

  const k = 1 - eta * eta * (1 - cosI * cosI);
  if (k < 0) return null;                    /* total internal reflection */

  return v.normalize(v.add(v.scale(d, eta), v.scale(n, eta * cosI - Math.sqrt(k))));
}

/* The circumradius an N-blade iris needs in order to enclose the SAME AREA as a
   circle of radius `a`.

   The blade boundary at angle phi from an edge's midpoint normal is

       r(phi) = rho [ (1-c) k / cos(phi) + c ],   k = cos(pi/N)

   blending the straight chord toward the circumscribed circle. Its area is the
   integral of r^2/2 over the full turn, which has a closed form: with m = pi/N
   and using  int sec^2 = tan,  int sec = ln|sec + tan|,

       A(rho=1) = N [ (1-c)^2 k^2 tan m + 2c(1-c) k ln(sec m + tan m) + c^2 m ]

   and rho then follows from A(rho) = rho^2 A(1) = pi a^2.

   The obvious shortcut -- blend rho linearly between the polygon value and the
   circle value -- is WRONG, and wrong in a way that hides: area goes as rho^2,
   so a linear blend of rho is not a linear blend of area. It is exact at c = 0
   and c = 1 and worst in between, which is precisely where nobody thinks to
   check. It overshot by 9 % on a three-blade iris at half curvature: a third of
   a stop of exposure error produced by a control that is supposed to change
   only the shape of the blur.

   The f-number is a statement about how much light gets through, so the iris
   AREA is what must equal pi a^2. Without this, switching from a circular iris
   to seven blades would darken the image by 13 %. */
export function irisCircumradius(a, blades, curvature) {
  if (blades < 3) return a;

  const c = clamp(curvature, 0, 1);
  const m = PI / blades;
  const k = Math.cos(m);
  const tanM = Math.tan(m);
  const secM = 1 / k;

  const a1 = blades * ((1 - c) * (1 - c) * k * k * tanM
                     + 2 * c * (1 - c) * k * Math.log(secM + tanM)
                     + c * c * m);
  if (a1 <= 0) return a;
  return a * Math.sqrt(PI / a1);
}

/* Is (x, y) inside the iris? Circular when blades < 3, otherwise the blade
   polygon, blended toward a circle by bladeCurvature. */
export function apertureContains(L, xMm, yMm) {
  const r = Math.sqrt(xMm * xMm + yMm * yMm);
  if (L.blades < 3) return r <= L.stopSemiApMm;

  const rho = irisCircumradius(L.stopSemiApMm, L.blades, L.bladeCurvature);
  const th = TWO_PI / L.blades;

  /* Angle to the nearest blade's midpoint, folded into one sector. */
  let phi = Math.atan2(yMm, xMm) - L.bladeRotRad;
  phi = phi % th;
  if (phi < 0) phi += th;
  phi -= th * 0.5;

  /* A straight blade edge is the chord at distance rho cos(pi/N) from the
     centre, so its radius at angle phi is rho cos(pi/N)/cos(phi). Blending that
     toward rho gives the rounded blades a real iris has. */
  const straight = (rho * Math.cos(PI / L.blades)) / Math.cos(phi);
  return r <= lerp(L.bladeCurvature, straight, rho);
}

/* The clear radius that actually clips at surface i: the iris at the stop, the
   mechanical bore everywhere else. */
const clipRadius = (L, i) => (i === L.stopIndex ? L.stopSemiApMm : L.surf[i].semiApMm);

/* Is this point blocked at surface i? THE clip. This, and only this, is where
   vignetting comes from. */
function blockedAt(L, i, p) {
  if (i === L.stopIndex) return !apertureContains(L, p.x, p.y);
  const rad = clipRadius(L, i);
  return p.x * p.x + p.y * p.y > rad * rad;
}

/* Trace one ray from object space through to the rear surface.

   `r` is updated in place to the ray leaving the rear surface, and `tr.value`,
   when a transmittance box is passed, is multiplied by (1 - R_fresnel) at each
   interface. Returns false the moment the ray is clipped by any clear aperture,
   by the iris, or by total internal reflection -- and a clipped ray is what
   mechanical vignetting IS. */
export function trace(L, lambdaNm, r, tr) {
  for (let i = 0; i < L.surf.length; i++) {
    const zv = vertexZ(L, i);
    const hit = surfaceHit(L.surf[i].radiusMm, zv, r);
    if (!hit) return false;

    const p = v.add(r.o, v.scale(r.d, hit.t));
    if (blockedAt(L, i, p)) return false;

    const n = nBefore(L, i, lambdaNm);
    const np = nAfter(L, i, lambdaNm);

    r.o = p;
    if (Math.abs(np - n) > 1e-12) {
      const d2 = refract(r.d, hit.n, n / np);
      if (!d2) return false;                 /* TIR */
      r.d = d2;
      if (tr) {
        const cosI = Math.abs(v.dot(r.d, hit.n));
        tr.value *= 1 - fresnelDielectric(cosI, n / np);
      }
    }
  }
  return true;
}

/* Trace from the FILM outward into the world -- the direction a camera ray
   actually travels. `r` starts on the sensor with a direction of negative z and
   is updated in place to the ray leaving the front surface.

   A separate function rather than a flag on trace(): the surfaces are visited
   in the opposite order and the indices swap at every interface, so a shared
   body would be a chain of conditionals through the one loop that has to stay
   obviously correct. Getting that index pair the wrong way round produces a
   lens that still focuses -- with every index inverted, so it focuses in the
   wrong place and with the wrong aberrations. */
export function traceReverse(L, lambdaNm, r, tr) {
  for (let i = L.surf.length - 1; i >= 0; i--) {
    const zv = vertexZ(L, i);
    const hit = surfaceHit(L.surf[i].radiusMm, zv, r);
    if (!hit) return false;

    const p = v.add(r.o, v.scale(r.d, hit.t));
    if (blockedAt(L, i, p)) return false;

    const n = nAfter(L, i, lambdaNm);        /* the medium we are in */
    const np = nBefore(L, i, lambdaNm);      /* the one we enter     */

    r.o = p;
    if (Math.abs(np - n) > 1e-12) {
      const d2 = refract(r.d, hit.n, n / np);
      if (!d2) return false;
      r.d = d2;
      if (tr) {
        const cosI = Math.abs(v.dot(r.d, hit.n));
        tr.value *= 1 - fresnelDielectric(cosI, n / np);
      }
    }
  }
  return true;
}

/* Axial z of the sensor plane, measured from the FRONT vertex like everything
   else drawn or traced. L.filmZMm is measured from the REAR vertex, and mixing
   the two is a focus error the size of the lens. */
export const filmZ = (L) => vertexZ(L, L.surf.length - 1) + L.filmZMm;

/* Where the marginal and chief rays from an axial object at `distanceM`
   actually cross the axis behind the lens -- the REAL focus, as opposed to the
   paraxial one. Their difference is longitudinal spherical aberration, and it
   is the number that makes focus shift on stopping down visible.

   As pupilFraction -> 0 this must converge to the paraxial back focal distance;
   that it does NOT converge at larger fractions is spherical aberration,
   measured rather than modelled. */
export function realFocusZ(L, lambdaNm, distanceM, pupilFraction) {
  let h = pupilFraction * L.epSemiApMm;
  if (h <= 0) h = 1e-6;

  let o, target;
  if (!Number.isFinite(distanceM)) {
    o = v.v3(h, 0, -10);                     /* parallel to the axis */
    target = v.v3(h, 0, 0);
  } else {
    o = v.v3(0, 0, -distanceM * 1000);
    target = v.v3(h, 0, L.epZMm);
  }

  const r = { o, d: v.normalize(v.sub(target, o)) };
  if (!trace(L, lambdaNm, r, null)) return Infinity;

  /* Where this ray crosses the axis, measured from the REAR vertex so it is
     directly comparable with bfdMm and filmZMm. */
  if (Math.abs(r.d.x) < 1e-15) return Infinity;
  const t = -r.o.x / r.d.x;
  const z = r.o.z + t * r.d.z;
  return z - vertexZ(L, L.surf.length - 1);
}

/* ---- depth of field ----------------------------------------------------- */

/* cocMm is monotone in distance on each side of the focused plane, so a
   bisection is enough and needs no derivative. Solved rather than taken from
   the hyperfocal formula so the answer follows the real lens. */
function solveCoc(L, limit, a, b) {
  for (let i = 0; i < 80; i++) {
    const m = 0.5 * (a + b);
    const c = cocMm(L, m);
    /* An object inside the front focal point images nowhere, which reads as an
       infinite blur -- treat it as "too blurred" rather than letting the
       Infinity escape into the comparison. */
    if (!Number.isFinite(c) || c > limit) a = m; else b = m;
  }
  return 0.5 * (a + b);
}

/* Depth of field: the distances either side of focus at which the defocus blur
   reaches `cocLimitMm`. `far` comes back as Infinity once focus reaches the
   hyperfocal distance, which is the honest answer: everything beyond it is
   acceptably sharp. Returns null if the lens is not focused on anything. */
export function dof(L, cocLimitMm) {
  if (!(cocLimitMm > 0)) return null;
  const s = L.focusDistanceM;
  if (!Number.isFinite(s) || !(s > 0)) {
    /* Focused at infinity: everything from the hyperfocal distance out. */
    return { near: hyperfocalM(L, cocLimitMm), far: Infinity };
  }

  /* Near side: blur grows without bound as the object approaches the lens, so
     the bracket is (something very close, focus). */
  const near = solveCoc(L, cocLimitMm, 1e-4, s);

  /* If a very distant object is still inside the limit, the far side is
     unbounded -- which is what being at or past hyperfocal means. */
  const far = cocMm(L, 1e7) <= cocLimitMm ? Infinity : solveCoc(L, cocLimitMm, 1e7, s);
  return { near, far };
}

/* The focus distance at which the far limit first reaches infinity. */
export function hyperfocalM(L, cocLimitMm) {
  if (!(cocLimitMm > 0)) return Infinity;
  /* With the lens focused at h, infinity blurs by A*|f - s'(h)|/lever;
     searching on h directly keeps this in terms of the same cocMm every other
     answer comes from.

     A SHALLOW clone is enough and is not an oversight: focus() writes only
     filmZMm and focusDistanceM, and cocMm reads only scalars. Neither touches
     surf or glass, so sharing those arrays with the caller's lens is safe. */
  const t = { ...L };
  let lo = 0.05, hi = 1e6;
  for (let i = 0; i < 80; i++) {
    const m = Math.sqrt(lo * hi);            /* geometric: the range is decades */
    if (!focus(t, m)) { lo = m; continue; }
    if (cocMm(t, 1e7) > cocLimitMm) lo = m; else hi = m;
  }
  return Math.sqrt(lo * hi);
}

/* The spot an object ACTUALLY makes on the film, RMS diameter in mm, traced
   through the real glass at its real field position.

   cocMm above is a paraxial statement and models DEFOCUS ALONE. That is the
   whole story on axis, and badly incomplete off it: a simple doublet has no
   correction for coma, astigmatism or field curvature, and by ten or so
   millimetres of field they dominate. The depth-of-field figure can say the
   opposite of what the camera records, and neither is wrong: they are answers
   to different questions. So anything claiming a subject is sharp asks THIS.

   `objectHeightM` is the subject's distance from the optical axis. Returns
   Infinity if no ray gets through -- the subject is outside what the lens
   covers, which is its own kind of "not sharp". */
export function spotMm(L, objectDistanceM, objectHeightM, nrays) {
  if (!(objectDistanceM > 0) || !Number.isFinite(objectDistanceM)) return Infinity;
  if (nrays < 3) nrays = 3;

  const zf = filmZ(L);
  const o = v.v3(objectHeightM * 1000, 0, -objectDistanceM * 1000);

  /* A square grid over the entrance pupil, culled to its disc. Landing points
     are gathered once and reused for both passes: the spot's CENTRE moves off
     axis (that is distortion, and is not blur), so measuring the spread about a
     fixed point would count it as one -- the centroid has to come first. */
  const xs = [], ys = [];
  for (let i = 0; i < nrays; i++) {
    for (let j = 0; j < nrays; j++) {
      const u = -1 + (2 * (i + 0.5)) / nrays;
      const w = -1 + (2 * (j + 0.5)) / nrays;
      if (u * u + w * w > 1) continue;
      const t = v.v3(u * L.epSemiApMm, w * L.epSemiApMm, L.epZMm);
      const r = { o, d: v.normalize(v.sub(t, o)) };
      if (!trace(L, G.LINE_D, r, null)) continue;
      if (Math.abs(r.d.z) < 1e-15) continue;
      const tt = (zf - r.o.z) / r.d.z;
      xs.push(r.o.x + tt * r.d.x);
      ys.push(r.o.y + tt * r.d.y);
    }
  }
  /* Nothing got through: the subject is outside what the lens covers. */
  const n = xs.length;
  if (n < 3) return Infinity;

  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;

  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const X = xs[i] - mx, Y = ys[i] - my;
    s2 += X * X + Y * Y;
  }
  /* Reported as a DIAMETER, so it compares directly with cocMm and with the
     sharpness criterion the user sets. */
  return 2 * Math.sqrt(s2 / n);
}
