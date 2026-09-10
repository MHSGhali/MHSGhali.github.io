/* Sensor point plus random numbers, out to a world ray. From src/os_camera.c.

   THE INVARIANT THIS MODULE OWNS
     One function turns (pixel, sample index, RNG) into a world-space ray
     carrying a wavelength and an importance weight, and it is the ONLY place
     millimetres meet metres. Everything upstream of it is lens space, in mm;
     everything downstream is scene space, in m.

     A radius in mm multiplied by a scene distance in m is a 1000x focus error
     -- and a 1000x focus error does not crash, it just looks slightly soft.

   AND: A VIGNETTED SAMPLE IS STILL A SAMPLE
     When a ray is clipped by the glass, sample() returns false and the caller
     must still COUNT it, contributing zero. Retrying until a ray gets through
     would renormalise the vignetting away -- the corners would come out exactly
     as bright as the centre, which looks entirely plausible and is the opposite
     of what a real lens does.

   THE WEIGHT, DERIVED
     Irradiance at a film point from the rear element is

         E = INT L cos(theta_f) cos(theta_r) / d^2  dA

     Both planes are perpendicular to the axis, so theta_f = theta_r = theta and
     d = Z/cos(theta) with Z the axial gap. The kernel collapses to
     cos^4(theta)/Z^2, and sampling A uniformly over a box of area A_box gives

         weight = A_box cos^4(theta) / Z^2 * T_fresnel(lambda) * inv_pdf_lambda

     [mm^2 / mm^2] is dimensionless-as-steradians, so weight * L in
     W/(m^2 sr nm) yields W/(m^2 nm): spectral irradiance at the film.

     The cos^4 falloff is DERIVED here, not applied. Nothing else in this
     program may multiply by a vignetting factor -- see lens.js. */

import { PI } from "../light/core.js?v=8da2fe8e";
import * as v from "../light/vec3.js?v=8da2fe8e";
import * as R from "../light/rng.js?v=8da2fe8e";
import * as L from "./lens.js?v=8da2fe8e";
import * as PU from "./pupil.js?v=8da2fe8e";
import { pixelHash, lambdaPick } from "./spectral.js?v=8da2fe8e";

const MM_PER_M = 1000.0;

/* Build a camera: mount the lens, size the sensor, and cache the pupil.
   `sensorWMm` fixes the format; the height follows from the render aspect, so a
   square render is a square crop of the format rather than a stretched frame. */
export function build(design, eflMm, fno, sensorWMm, w, h) {
  const c = {
    lens: L.build(design, eflMm, fno),
    width: w,
    height: h,
    sensorWMm,
    sensorHMm: (sensorWMm * h) / w,
    /* Pose. The eye sits at the lens's FRONT VERTEX, so racking focus -- which
       moves the film, not the glass -- leaves the camera's position in the
       world exactly where it was. */
    eye: v.v3(0, 0, 0), fwd: v.v3(0, 0, -1), right: v.v3(1, 0, 0), up: v.v3(0, 1, 0),
    pupil: null,
  };
  lookAt(c, v.v3(0, 0, 0), v.v3(0, 0, -1), v.v3(0, 1, 0));
  /* NO refresh here. The pupil cache costs ~74 000 lens traces, and every
     caller changes the aperture or the focus immediately afterwards,
     which invalidates it -- so building it now is a build thrown away. The
     caller refreshes once, when the lens is finally the lens it wants. */
  return c;
}

/* Where the camera stands and what it points at. Note this does NOT invalidate
   the pupil cache: the cache is a function of the lens and the sensor, and the
   pose is neither. */
export function lookAt(c, eye, target, upHint) {
  c.eye = eye;
  c.fwd = v.normalize(v.sub(target, eye));
  c.right = v.normalize(v.cross(c.fwd, upHint));
  /* Rebuild up from the orthogonalised right so the basis stays orthonormal
     even when upHint is not perpendicular to the view direction. */
  c.up = v.cross(c.right, c.fwd);
}

/* Re-cache the pupil. Needed after any change to aperture, focus or focal
   length; cheap enough to call unconditionally when something changed. */
export function refresh(c) {
  const diag = 0.5 * Math.sqrt(c.sensorWMm * c.sensorWMm + c.sensorHMm * c.sensorHMm);
  c.pupil = PU.build(c.lens, diag);
}

/* Horizontal field of view, degrees, for reporting. */
export const hfovDeg = (c) =>
  (2 * Math.atan2(c.sensorWMm * 0.5, c.lens.eflMm) * 180) / PI;

/* Lens space (mm, +z toward the sensor) to world space (m, +fwd toward the
   scene). The z axis FLIPS: travelling toward the sensor is travelling away
   from what the camera is looking at. */
function lensDirToWorld(c, d) {
  return v.add(v.add(v.scale(c.right, d.x), v.scale(c.up, d.y)), v.scale(c.fwd, -d.z));
}

function lensPointToWorld(c, p) {
  const off = v.add(v.add(v.scale(c.right, p.x), v.scale(c.up, p.y)), v.scale(c.fwd, -p.z));
  return v.add(c.eye, v.scale(off, 1 / MM_PER_M));
}

/* A reusable sample record, so the render loop allocates nothing per ray. */
export const makeSample = () => ({
  o: null, d: null, lambdaNm: 0, bin: 0, weight: 0,
});

const pupilOut = new Float64Array(3);

/* THE function. Returns false when the ray was vignetted -- the caller counts
   the sample anyway, at zero. */
export function sample(c, x, y, sampleIndex, rng, out) {
  const lens = c.lens;

  const wl = lambdaPick(sampleIndex, pixelHash(x, y));
  out.lambdaNm = wl.lambdaNm;
  out.bin = wl.bin;
  out.weight = 0;

  /* Pixel to sensor point, in millimetres.

     TWO sign flips on y, and they are not the same flip. The first is the usual
     image convention: row 0 is the TOP of the picture, while +y on the sensor
     points up. The second is physics: a lens forms an INVERTED image, so a
     point high on the sensor sees the world below the axis. Applying one and
     not the other gives a vertically mirrored render that looks entirely
     plausible until something in the scene is not symmetric. Here they cancel
     on y and leave a single flip on x, which is the lens inversion alone. */
  const px = x + R.f(rng);
  const py = y + R.f(rng);
  const fx = -(px / c.width - 0.5) * c.sensorWMm;
  const fy = (py / c.height - 0.5) * c.sensorHMm;

  const filmZ = L.filmZ(lens);
  const film = v.v3(fx, fy, filmZ);

  if (!PU.sample(c.pupil, fx, fy, R.f(rng), R.f(rng), pupilOut)) return false;
  const area = pupilOut[2];

  const rear = v.v3(pupilOut[0], pupilOut[1], c.pupil.rearZMm);
  const d = v.sub(rear, film);
  const Z = -d.z;                            /* axial gap, film to rear plane */
  if (!(Z > 0)) return false;
  const dist = v.len(d);
  const cosTheta = Z / dist;

  const r = { o: film, d: v.scale(d, 1 / dist) };
  const tr = { value: 1 };
  if (!L.traceReverse(lens, wl.lambdaNm, r, tr)) return false;  /* vignetted */

  const c2 = cosTheta * cosTheta;
  out.weight = ((area * (c2 * c2)) / (Z * Z)) * tr.value * wl.invPdf;

  out.o = lensPointToWorld(c, r.o);
  out.d = v.normalize(lensDirToWorld(c, r.d));
  return true;
}

/* World point to a pixel in the rendered image -- the paraxial inverse of the
   film mapping in sample(), including its two y flips and its x flip.

   Paraxial on purpose: a real trace would land a hair away because the lens
   distorts, and anything drawn over the image matters less for being a pixel
   out than for agreeing with where sample() put the thing underneath it.

   Nothing on this page draws such an overlay yet -- the C uses it to annotate
   the image view. Here its caller is the test that checks sample()'s three sign
   flips, which is worth the function on its own: those flips are invisible
   until something in the scene is not symmetric.

   Returns null for a point at or behind the front vertex, where no pixel
   corresponds to it. */
export function project(c, world) {
  const lens = c.lens;

  /* World to lens space, millimetres. +z in lens space runs toward the sensor,
     so a subject in front of the camera has NEGATIVE z. */
  const off = v.scale(v.sub(world, c.eye), MM_PER_M);
  const lx = v.dot(off, c.right);
  const ly = v.dot(off, c.up);
  const dist = v.dot(off, c.fwd);            /* mm in front of the vertex */
  if (!(dist > 1)) return null;              /* at or behind the lens */

  /* Paraxial conjugate, from the principal planes -- the same expression
     focus() uses, so the projection agrees with where the film is. */
  const sFromPp = dist - (lens.ffdMm + lens.eflMm);
  if (sFromPp <= lens.eflMm) return null;
  const sPrime = 1 / (1 / lens.eflMm - 1 / sFromPp);
  const m = sPrime / dist;

  /* The lens inverts, hence the negation on both axes. */
  const fx = -lx * m;
  const fy = -ly * m;

  /* Film millimetres back to pixels, inverting sample() exactly:
       fx = -(px/W - 0.5) * sensorW
       fy =  (py/H - 0.5) * sensorH  */
  return {
    x: (0.5 - fx / c.sensorWMm) * c.width,
    y: (fy / c.sensorHMm + 0.5) * c.height,
  };
}
