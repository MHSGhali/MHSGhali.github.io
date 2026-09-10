/* The image buffer, and the one place physical units become pixels.
   From src/film.c and the tonemap in viewer/main.c.

   WHY THIS HOLDS XYZ AND NOT 95 BINS
     The C's Film stores a full SpectrumAcc per pixel, because ls_film_write_pfm
     dumps it in physical units for offline analysis. At 256x170 that would be
     16 MB of accumulator in a worker, rebuilt on every settings change, and it
     would buy nothing here: this page has no PFM export and the only consumer
     of a pixel is the tonemap below.

     Three doubles per pixel instead, and this is EXACT rather than an
     approximation. Each sample deposits weight * L into exactly one bin b, and
     X, Y and Z are linear functionals of the spectrum -- each is
     sum_i s[i] * cmf[i] * step. So adding weight * L * cmf[b] * step to three
     running sums, and dividing by n at the end, gives the same numbers as
     accumulating the spectrum and calling spectrumToXyz() on its mean. The test
     suite pins that equality rather than asserting it here.

     js/light/field.js makes the same argument in its own header for storing two
     integrals per light instead of 95 bins. This is that idea applied to a
     pixel.

   WHERE NOISE DOES NOT GO
     The film holds NOISE-FREE values. Sensor noise -- shot, read, quantisation
     -- would belong at development, applied once, and does not live here.
     Applying it per Monte Carlo sample would average it away as the sample
     count rose, so the control would visibly stop doing anything at high
     quality. A real photograph is one readout, not the mean of a thousand. */

import { SPECTRAL_STEP_NM } from "../light/spectrum.js?v=008be1e5";
import { cmfXbar, cmfYbar, cmfZbar, xyzToLinearSrgb, srgbEncode } from "../light/color.js?v=008be1e5";
import { clamp } from "../light/core.js?v=008be1e5";

export function create(width, height) {
  const n = width * height;
  return {
    width, height,
    xyz: new Float64Array(n * 3),
    n: new Float64Array(n),        /* samples per pixel */
  };
}

export function clear(f) {
  f.xyz.fill(0);
  f.n.fill(0);
}

/* Per-bin deposit weights: cmf * bin width, so a deposit is three multiplies.
   Built once; the CIE tables behind them are themselves lazily built and
   cached by js/light/color.js. */
let dep = null;
function depositTable() {
  if (dep) return dep;
  const xb = cmfXbar(), yb = cmfYbar(), zb = cmfZbar();
  const nb = xb.length;
  dep = new Float64Array(nb * 3);
  for (let i = 0; i < nb; i++) {
    dep[i * 3] = xb[i] * SPECTRAL_STEP_NM;
    dep[i * 3 + 1] = yb[i] * SPECTRAL_STEP_NM;
    dep[i * 3 + 2] = zb[i] * SPECTRAL_STEP_NM;
  }
  return dep;
}

/* Deposit one sample's radiance at one bin, and COUNT it.

   `value` is weight * L, and it may legitimately be zero: a vignetted sample
   still lands here. Skipping it instead would renormalise the vignetting away
   and make the corners exactly as bright as the centre. */
export function add(f, x, y, bin, value) {
  const d = depositTable();
  const p = (y * f.width + x) * 3;
  const b = bin * 3;
  f.xyz[p] += value * d[b];
  f.xyz[p + 1] += value * d[b + 1];
  f.xyz[p + 2] += value * d[b + 2];
  f.n[y * f.width + x] += 1;
}

/* Tone-mapped sRGB bytes, ready for putImageData.

   `exposure` is a VIEW GAIN and nothing more -- it does not touch the film,
   which stays in physical units. Writes into `out` (RGBA, 4 bytes per pixel) so
   a progressive render reuses one buffer. */
export function tonemap(f, exposure, out) {
  const np = f.width * f.height;
  for (let i = 0; i < np; i++) {
    const n = f.n[i];
    const o = i * 4;
    if (n <= 0) {
      out[o] = out[o + 1] = out[o + 2] = 0;
      out[o + 3] = 255;
      continue;
    }
    const p = i * 3;
    const inv = 1 / n;
    const c = xyzToLinearSrgb({ x: f.xyz[p] * inv, y: f.xyz[p + 1] * inv, z: f.xyz[p + 2] * inv });
    /* Gamma-encode AFTER the gain, and clamp after that: a saturated highlight
       must clip at white rather than wrap, and an out-of-gamut colour can come
       back negative from the matrix above. */
    out[o] = clamp(srgbEncode(c.r * exposure), 0, 1) * 255 + 0.5;
    out[o + 1] = clamp(srgbEncode(c.g * exposure), 0, 1) * 255 + 0.5;
    out[o + 2] = clamp(srgbEncode(c.b * exposure), 0, 1) * 255 + 0.5;
    out[o + 3] = 255;
  }
  return out;
}

/* Mean samples per pixel, for the status line. Every pixel gets the same count
   in this renderer, so pixel 0 is representative -- but averaging is honest and
   costs nothing at these sizes. */
export function samplesPerPixel(f) {
  const np = f.width * f.height;
  if (np === 0) return 0;
  let s = 0;
  for (let i = 0; i < np; i++) s += f.n[i];
  return s / np;
}
