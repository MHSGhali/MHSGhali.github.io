/* Viridis control points (matplotlib), linearly interpolated -- the ramp from
   src/film.c, so the browser's false colour matches the CLI's PPM output and
   the Blender export.

   Perceptually uniform and legible in greyscale, which a rainbow ramp is not:
   a rainbow introduces bands that look like features of the data and are not. */

import { clamp, lerp } from "./core.js?v=7a60899b";

const VIRIDIS = [
  [0.267004, 0.004874, 0.329415], [0.282623, 0.140926, 0.457517],
  [0.253935, 0.265254, 0.529983], [0.206756, 0.371758, 0.553117],
  [0.163625, 0.471133, 0.558148], [0.127568, 0.566949, 0.550556],
  [0.134692, 0.658636, 0.517649], [0.266941, 0.748751, 0.440573],
  [0.477504, 0.821444, 0.318195], [0.741388, 0.873449, 0.149561],
  [0.993248, 0.906157, 0.143936],
];

/* t is clamped to [0,1]. Returns linear (not gamma-encoded) sRGB in [0,1]. */
export function viridis(t) {
  const N = VIRIDIS.length;
  t = clamp(t, 0, 1) * (N - 1);
  let i = Math.floor(t);
  if (i >= N - 1) i = N - 2;
  const u = t - i;
  return {
    r: lerp(u, VIRIDIS[i][0], VIRIDIS[i + 1][0]),
    g: lerp(u, VIRIDIS[i][1], VIRIDIS[i + 1][1]),
    b: lerp(u, VIRIDIS[i][2], VIRIDIS[i + 1][2]),
  };
}

/* Pack into 8-bit RGB for a canvas or a DataTexture. */
export function viridisBytes(t, out, o) {
  const c = viridis(t);
  out[o] = (c.r * 255 + 0.5) | 0;
  out[o + 1] = (c.g * 255 + 0.5) | 0;
  out[o + 2] = (c.b * 255 + 0.5) | 0;
  return out;
}
