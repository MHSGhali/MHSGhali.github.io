/* CIE colorimetry: spectrum -> XYZ -> sRGB, from src/color.c.

   The colour matching functions are resampled onto the active bin grid once, on
   first use, and exposed as per-bin weight tables so that every spectral
   integral in the engine goes through integrateWeighted(). */

import { interpTable } from "./core.js?v=f56d3836";
import { CIE_LAMBDA, CIE_XBAR, CIE_YBAR, CIE_ZBAR, CIE_COUNT } from "./cie-data.js?v=f56d3836";
import { NBINS, SPECTRAL_STEP_NM, binLambda, integrateWeighted } from "./spectrum.js?v=f56d3836";

let xbar = null, ybar = null, zbar = null, ybarIntegral = 0;

function buildTables() {
  xbar = new Float32Array(NBINS);
  ybar = new Float32Array(NBINS);
  zbar = new Float32Array(NBINS);
  let sumY = 0;
  for (let i = 0; i < NBINS; i++) {
    const l = binLambda(i);
    xbar[i] = interpTable(CIE_LAMBDA, CIE_XBAR, CIE_COUNT, l);
    ybar[i] = interpTable(CIE_LAMBDA, CIE_YBAR, CIE_COUNT, l);
    zbar[i] = interpTable(CIE_LAMBDA, CIE_ZBAR, CIE_COUNT, l);
    sumY += ybar[i];
  }
  ybarIntegral = sumY * SPECTRAL_STEP_NM;
}

/* ybar IS V(lambda). */
export function cmfXbar() { if (!xbar) buildTables(); return xbar; }
export function cmfYbar() { if (!ybar) buildTables(); return ybar; }
export function cmfZbar() { if (!zbar) buildTables(); return zbar; }
/* Integral of ybar over the band, in nm. Needed to normalise relative SPDs. */
export function cmfYbarIntegral() { if (!ybar) buildTables(); return ybarIntegral; }

export function spectrumToXyz(s) {
  return {
    x: integrateWeighted(s, cmfXbar()),
    y: integrateWeighted(s, cmfYbar()),
    z: integrateWeighted(s, cmfZbar()),
  };
}

/* Chromaticity coordinates; independent of overall scale. */
export function xyzChromaticity(c) {
  const sum = c.x + c.y + c.z;
  if (sum === 0) return { x: 0, y: 0 };
  return { x: c.x / sum, y: c.y / sum };
}

export function xyzToLinearSrgb(c) {
  return {
    r: 3.2404542 * c.x - 1.5371385 * c.y - 0.4985314 * c.z,
    g: -0.969266 * c.x + 1.8760108 * c.y + 0.041556 * c.z,
    b: 0.0556434 * c.x - 0.2040259 * c.y + 1.0572252 * c.z,
  };
}

export function srgbEncode(u) {
  if (u <= 0.0031308) return 12.92 * u;
  return 1.055 * Math.pow(u, 1 / 2.4) - 0.055;
}

export function rgbGammaEncode(c) {
  return { r: srgbEncode(c.r), g: srgbEncode(c.g), b: srgbEncode(c.b) };
}
