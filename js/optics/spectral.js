/* One wavelength per camera path, from src/os_spectral.c.

   THE INVARIANT THIS MODULE OWNS
     Every camera sample carries exactly one wavelength, drawn with a strictly
     positive probability, and the reciprocal of that probability travels with
     it. Nothing downstream may deposit into a bin it did not sample.

   WHY A PATH CANNOT CARRY THE WHOLE SPECTRUM
     js/light/spectrum.js is built on a fixed 95-bin spectrum travelling down
     one geometric path, which is valid because every SCENE material is
     non-dispersive. That invariant still holds. What breaks is upstream of it:
     the LENS is dispersive, so ray GENERATION became wavelength dependent. Two
     rays leaving the rear element from the same sensor point at 450 nm and
     650 nm are different rays, going to different places in the world.

     Carrying 95 bins down one of them and depositing all 95 would average the
     scene over wavelengths that never travelled there -- which is precisely how
     you erase the chromatic aberration the lens exists to produce. So: one
     wavelength, one ray, one bin.

   WHY BIN CENTRES RATHER THAN A CONTINUOUS DRAW
     The wavelength is always a bin CENTRE. Depositing then needs no
     redistribution between neighbours, and reading a spectrum back at that
     wavelength with spectrum.at() is exact to the last bit. Sampling
     continuously would gain nothing -- the scene's own spectra are binned at
     the same resolution -- and would cost an off-by-half-a-bin bug class.

   WHY STRATIFIED RATHER THAN INDEPENDENT
     Independent uniform draws leave gaps and clumps in the spectrum for any one
     pixel, which reads as colour noise. A golden-ratio (additive recurrence)
     sequence over the sample index walks the band evenly, is stateless -- so it
     survives being restarted and split across chunks -- and costs one
     multiply.

   WHY THE DRAW IS NOT UNIFORM
     The C draws uniformly over all 95 bins and says so, with a note that
     inv_pdf "stops being a constant" once there is a sensor response to
     importance-sample against. There is one here: the film records X, Y and Z,
     so a bin's entire contribution to the picture is weighted by the CIE
     observer at that wavelength.

     Uniform draws therefore spend about an eighth of every render on the twelve
     bins below 400 nm and above 700 nm, where the observer is flat zero -- rays
     traced through the glass and out into the scene, and multiplied by zero on
     arrival. The rest are spread over a response that varies more than
     threefold, which is variance bought for nothing.

     Drawing proportional to (xbar + ybar + zbar) and dividing by that same
     probability is the textbook fix. It is still unbiased -- the estimator
     divides by whatever density it drew from -- and every sample now lands
     where the film can see it. */

import { NBINS, binLambda } from "../light/spectrum.js?v=281bca3b";
import { cmfXbar, cmfYbar, cmfZbar } from "../light/color.js?v=281bca3b";

/* A cheap, well-mixed hash of a pixel coordinate.

   A 32-bit integer hash (Wang/Jenkins style): two large odd multipliers and an
   xor-shift finaliser. It only has to decorrelate neighbouring pixels, so
   quality matters more than speed here, and the obvious
   `x * 73856093 ^ y * 19349663` leaves visible diagonal structure at low sample
   counts.

   Math.imul and the >>> 0 are how JavaScript is made to do the C's uint32
   arithmetic: a plain `*` on two large integers loses the low bits to float64
   rounding, and `^` would then mix the wrong ones. */
export function pixelHash(x, y) {
  let h = (Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca77)) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12; h = Math.imul(h, 0x297a2d39) >>> 0;
  h ^= h >>> 15;
  return h >>> 0;
}

const PHI = 0.6180339887498949;

/* The sampling distribution over bins, and its inverse CDF.

   Built once, lazily, because the CIE tables behind it are themselves built
   lazily. `cdf[i]` is the probability of landing at or below bin i; `prob[i]`
   is the probability of bin i itself, which is what invPdf inverts.

   A bin the observer cannot see gets probability zero and is never drawn. That
   loses nothing: its contribution to X, Y and Z is exactly zero, so a sample
   spent there could only ever have added noise to the estimate of nothing. */
let dist = null;
function distribution() {
  if (dist) return dist;
  const xb = cmfXbar(), yb = cmfYbar(), zb = cmfZbar();
  const prob = new Float64Array(NBINS);
  let total = 0;
  for (let i = 0; i < NBINS; i++) {
    const w = xb[i] + yb[i] + zb[i];
    prob[i] = w;
    total += w;
  }
  const cdf = new Float64Array(NBINS);
  let acc = 0;
  for (let i = 0; i < NBINS; i++) {
    prob[i] /= total;
    acc += prob[i];
    cdf[i] = acc;
  }
  /* Close the last one exactly, so a u of 0.999... cannot fall off the end
     through rounding. */
  cdf[NBINS - 1] = 1;
  dist = { prob, cdf };
  return dist;
}

/* Smallest bin whose CDF is above u. Binary search: 95 bins is small enough
   that a linear scan would also do, but this runs once per camera sample and
   the constant matters more than the asymptotics. */
function invertCdf(cdf, u) {
  let lo = 0, hi = NBINS - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] < u) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/* Draw the hero wavelength for one sample.

   `sampleIndex` counts samples within the pixel across every pass, so the
   stratification keeps improving as a render refines instead of restarting.
   `pixelHashValue` decorrelates neighbouring pixels -- without it every pixel
   walks the spectrum in lockstep and the residual noise becomes a visible
   pattern rather than grain. */
export function lambdaPick(sampleIndex, pixelHashValue) {
  /* Additive recurrence with the golden ratio's fractional part. Successive
     samples land in the largest remaining gap, so any prefix of the sequence
     covers the band about as evenly as a prefix can -- and it needs no state,
     which is what lets a pass be restarted or split across chunks without
     changing the result. */
  const offset = (pixelHashValue & 0xffffff) / 0x1000000;
  let u = (sampleIndex * PHI + offset) % 1;
  if (u < 0) u += 1;

  /* The stratified u is spent on the INVERSE CDF rather than on the bin index
     directly, so the sequence still walks the band evenly -- it just walks it
     in units of contribution rather than in units of nanometres. */
  const d = distribution();
  let bin = invertCdf(d.cdf, u);
  /* u can reach 1.0 through rounding; clamping is cheaper than proving it
     cannot, and an out-of-range bin here would be an out-of-bounds write. */
  if (bin < 0) bin = 0;
  if (bin >= NBINS) bin = NBINS - 1;

  return {
    bin,
    lambdaNm: binLambda(bin),
    /* NOT a constant. A caller must use this field rather than assuming
       anything about the density it came from. */
    invPdf: 1 / d.prob[bin],
  };
}
