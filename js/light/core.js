/* Fundamental constants for the light engine, from include/lightsim/core.h.

   All internal computation is double (which JS numbers are anyway); only bulk
   spectral storage is Float32Array, matching the C's choice of float for the
   type that travels through the inner loop. */

export const PI = Math.PI;
export const INV_PI = 0.31830988618379067154;
export const TWO_PI = 6.28318530717958647692;
export const INV_4PI = 0.07957747154594766788;

/* Maximum luminous efficacy of radiation, at 555 nm. */
export const KM_LM_PER_W = 683.0;

/* SI-2019 exact values. */
export const PLANCK_H = 6.62607015e-34;      /* J s */
export const LIGHT_C = 2.99792458e8;         /* m/s */
export const BOLTZMANN_K = 1.380649e-23;     /* J/K */
export const STEFAN_BOLTZMANN = 5.670374419e-8; /* W/(m^2 K^4) */

export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
export const lerp = (t, a, b) => a + t * (b - a);
export const sqr = (x) => x * x;

/* Linear interpolation into a sorted table, clamped to the endpoint values
   outside it. Used for every resampling in the engine. */
export function interpTable(x, y, n, q) {
  if (q <= x[0]) return y[0];
  if (q >= x[n - 1]) return y[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (x[mid] <= q) lo = mid; else hi = mid;
  }
  const t = (q - x[lo]) / (x[hi] - x[lo]);
  return y[lo] + t * (y[hi] - y[lo]);
}
