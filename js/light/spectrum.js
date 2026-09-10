/* Fixed-size sampled spectral distribution, from src/spectrum.c.

   UNIT CONVENTION (read this before touching any spectral code):

     Every Spectrum holds a SPECTRAL DENSITY PER NANOMETRE. So an irradiance
     spectrum is W/(m^2 nm), a radiance spectrum W/(m^2 sr nm), a flux spectrum
     W/nm. The band-integrated quantity is recovered by integrate(), which
     multiplies by the bin width in NANOMETRES.

     Choosing per-nm rather than per-metre keeps values human-scaled and avoids
     the 1e9 factor that silently wrecks radiometric integrals. Planck's law is
     per-metre by physics convention, so blackbody() converts on the way in --
     that is the ONE place the conversion happens.

   REPRESENTATION
     Float32Array(NBINS), matching the C's choice of float for the type that
     travels through the inner loop. Reductions accumulate in a JS number
     (double), as the C does: a 95-term sum in float loses several digits.

   DISPERSION
     Carrying all bins along one geometric path is only valid because every
     material in this engine is NON-DISPERSIVE: wavelength changes the value of
     the BSDF but never the sampled direction. Adding a dispersive dielectric
     would require replacing this with hero-wavelength sampling. Do not add one
     casually. */

import { PLANCK_H, LIGHT_C, BOLTZMANN_K, STEFAN_BOLTZMANN, PI, interpTable } from "./core.js?v=281bca3b";
import { CIE_DAYLIGHT_LAMBDA, CIE_S0, CIE_S1, CIE_S2, CIE_DAYLIGHT_COUNT } from "./cie-data.js?v=281bca3b";

export const LAMBDA_MIN_NM = 360;
export const LAMBDA_MAX_NM = 830;
export const SPECTRAL_STEP_NM = 5;
export const NBINS = (LAMBDA_MAX_NM - LAMBDA_MIN_NM) / SPECTRAL_STEP_NM + 1; /* 95 */

/* Centre wavelength of bin i, in nanometres. */
export const binLambda = (i) => LAMBDA_MIN_NM + i * SPECTRAL_STEP_NM;

/* The bin a wavelength falls in, clamped to the band. Nearest bin, matching
   monochromatic()'s rounding, so a wavelength that came FROM binLambda(i)
   round-trips back to exactly i. */
export function binIndex(lambdaNm) {
  const i = Math.floor((lambdaNm - LAMBDA_MIN_NM) / SPECTRAL_STEP_NM + 0.5);
  return i < 0 ? 0 : i > NBINS - 1 ? NBINS - 1 : i;
}

/* The value at one wavelength -- the C's ls_spectrum_at.

   A single-bin read, NOT an interpolation between neighbours. The optics page's
   camera samples one hero wavelength per path and that wavelength is always a
   bin CENTRE, so this is exact to the last bit and needs no redistribution on
   the way back out. Interpolating here would quietly make it approximate for
   the one caller that depends on it being exact. */
export const at = (s, lambdaNm) => s[binIndex(lambdaNm)];

/* ---- construction ---- */

export const zero = () => new Float32Array(NBINS);

export function constant(value) {
  return new Float32Array(NBINS).fill(value);
}

/* Single-bin spike whose band integral equals `power`. The value stored is
   power/step, so the integral is exactly `power`. */
export function monochromatic(lambdaNm, power) {
  const s = zero();
  if (lambdaNm < LAMBDA_MIN_NM || lambdaNm > LAMBDA_MAX_NM) return s;
  let i = Math.floor((lambdaNm - LAMBDA_MIN_NM) / SPECTRAL_STEP_NM + 0.5);
  i = Math.min(NBINS - 1, Math.max(0, i));
  s[i] = power / SPECTRAL_STEP_NM;
  return s;
}

/* Planck spectral radiance, W/(m^2 sr m), converted to per-nm by the 1e-9. */
export function blackbody(temperatureK) {
  const s = zero();
  if (temperatureK <= 0) return s;
  const c1 = 2.0 * PLANCK_H * LIGHT_C * LIGHT_C;
  const c2 = (PLANCK_H * LIGHT_C) / BOLTZMANN_K;
  for (let i = 0; i < NBINS; i++) {
    const l = binLambda(i) * 1e-9; /* metres */
    const l5 = l * l * l * l * l;
    const e = Math.exp(c2 / (l * temperatureK)) - 1.0;
    s[i] = (c1 / (l5 * e)) * 1e-9;
  }
  return s;
}

/* Total radiance across ALL wavelengths, W/(m^2 sr) -- Stefan-Boltzmann.
   Needed because a Spectrum is truncated to the visible band and so cannot
   supply the out-of-band power that LER against total power requires. */
export function blackbodyTotalRadiance(temperatureK) {
  const t2 = temperatureK * temperatureK;
  return (STEFAN_BOLTZMANN * t2 * t2) / PI;
}

/* CIE D-series daylight illuminant: chromaticity from CCT, then
   S = S0 + M1*S1 + M2*S2. Relative units. */
export function daylight(cctK) {
  let t = cctK;
  if (t < 4000) t = 4000;
  if (t > 25000) t = 25000;
  const xd =
    t <= 7000
      ? -4.607e9 / (t * t * t) + 2.9678e6 / (t * t) + 0.09911e3 / t + 0.244063
      : -2.0064e9 / (t * t * t) + 1.9018e6 / (t * t) + 0.24748e3 / t + 0.23704;
  const yd = -3.0 * xd * xd + 2.87 * xd - 0.275;

  const denom = 0.0241 + 0.2562 * xd - 0.7341 * yd;
  const m1 = (-1.3515 - 1.7703 * xd + 5.9114 * yd) / denom;
  const m2 = (0.03 - 31.4424 * xd + 30.0717 * yd) / denom;

  const s = zero();
  for (let i = 0; i < NBINS; i++) {
    const l = binLambda(i);
    const s0 = interpTable(CIE_DAYLIGHT_LAMBDA, CIE_S0, CIE_DAYLIGHT_COUNT, l);
    const s1 = interpTable(CIE_DAYLIGHT_LAMBDA, CIE_S1, CIE_DAYLIGHT_COUNT, l);
    const s2 = interpTable(CIE_DAYLIGHT_LAMBDA, CIE_S2, CIE_DAYLIGHT_COUNT, l);
    s[i] = s0 + m1 * s1 + m2 * s2;
  }
  return s;
}

/* Gaussian lobe, a serviceable model of a single-die LED. The band integral
   equals `power`. */
export function gaussian(centerNm, fwhmNm, power) {
  const s = zero();
  if (fwhmNm <= 0) return s;
  const sigma = fwhmNm / 2.354820045030949; /* 2*sqrt(2*ln2) */
  for (let i = 0; i < NBINS; i++) {
    const d = (binLambda(i) - centerNm) / sigma;
    s[i] = Math.exp(-0.5 * d * d);
  }
  return normalizeTo(s, power);
}

/* Resample an arbitrary tabulated SPD (sorted by wavelength) onto the bin grid. */
export function fromSamples(lambdaNm, value, n) {
  const s = zero();
  if (n <= 0) return s;
  for (let i = 0; i < NBINS; i++) s[i] = interpTable(lambdaNm, value, n, binLambda(i));
  return s;
}

/* ---- elementwise ops. `out` avoids allocating in the indirect loop. ---- */

export function add(a, b, out = zero()) {
  for (let i = 0; i < NBINS; i++) out[i] = a[i] + b[i];
  return out;
}
export function mul(a, b, out = zero()) {
  for (let i = 0; i < NBINS; i++) out[i] = a[i] * b[i];
  return out;
}
export function scale(a, s, out = zero()) {
  for (let i = 0; i < NBINS; i++) out[i] = a[i] * s;
  return out;
}
export function copy(a, out = zero()) {
  out.set(a);
  return out;
}
export function addScaledInplace(a, b, w) {
  for (let i = 0; i < NBINS; i++) a[i] += b[i] * w;
  return a;
}
export function mulInplace(a, b) {
  for (let i = 0; i < NBINS; i++) a[i] *= b[i];
  return a;
}
export function isBlack(a) {
  for (let i = 0; i < NBINS; i++) if (a[i] !== 0) return false;
  return true;
}
export function max(a) {
  let m = a[0];
  for (let i = 1; i < NBINS; i++) if (a[i] > m) m = a[i];
  return m;
}
export function mean(a) {
  let sum = 0;
  for (let i = 0; i < NBINS; i++) sum += a[i];
  return sum / NBINS;
}

/* ---- integration ----
   THE single place bin width is applied. Every spectral integral in the engine
   must go through one of these two; never hand-roll the loop.

   Rectangle (bin-centred) rule: each sample represents a bin of width
   SPECTRAL_STEP centred on its wavelength.

   A trapezoid rule was considered and REJECTED in the C, for a reason worth
   repeating here: it weights the first and last samples by 1/2, so a
   monochromatic spike in an edge bin would integrate to half its power --
   energy silently vanishing at the band edges with no way for a caller to
   notice. The rectangle rule makes monochromatic() carry exactly its stated
   power in EVERY bin, which is the invariant the 683 lm/W test depends on. */

export function integrate(a) {
  let sum = 0;
  for (let i = 0; i < NBINS; i++) sum += a[i];
  return sum * SPECTRAL_STEP_NM;
}

export function integrateWeighted(a, weight) {
  let sum = 0;
  for (let i = 0; i < NBINS; i++) sum += a[i] * weight[i];
  return sum * SPECTRAL_STEP_NM;
}

/* Rescale so the band integral equals `target`. No-op on a black spectrum. */
export function normalizeTo(a, target) {
  const cur = integrate(a);
  if (cur === 0) return a;
  return scale(a, target / cur, a);
}

/* ---- accumulators ----
   Float64Array, because float loses ~3 significant digits over 1e8 samples.
   The Spectrum itself stays float32: it is the type that travels through the
   inner loop, where footprint matters. */

export const accZero = () => new Float64Array(NBINS);

export function accAddScaled(acc, s, w) {
  for (let i = 0; i < NBINS; i++) acc[i] += s[i] * w;
}

export function accMean(acc, n) {
  const s = zero();
  if (n === 0) return s;
  const inv = 1 / n;
  for (let i = 0; i < NBINS; i++) s[i] = acc[i] * inv;
  return s;
}
