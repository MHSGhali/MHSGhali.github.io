/* The ONLY radiometric -> photometric conversion in the engine, from
   src/units.c.

   Design rule (do not violate): every internal quantity is stored as a
   radiometric Spectrum. Nothing anywhere holds a photometric value, and no
   accumulator carries a unit tag. Photometric numbers exist only as the return
   value of the functions below, called at report time.

   Tagging scalars with a unit was considered and rejected in the C: it lets a
   photometric value enter an accumulator later scaled by a radiometric BSDF,
   and nothing catches it. Keeping the photometric value unreachable outside
   this layer prevents that error class structurally. */

import { KM_LM_PER_W } from "./core.js?v=8156b23a";
import { integrate, integrateWeighted, normalizeTo, copy } from "./spectrum.js?v=8156b23a";
import { cmfYbar } from "./color.js?v=8156b23a";

export const RADIOMETRIC = "radiometric";
export const PHOTOMETRIC = "photometric";

/* Band integral of the spectrum: the radiometric scalar. */
export const radiometric = (s) => integrate(s);

/* Km * integral( S(lambda) * V(lambda) d lambda ), with V == CIE ybar. */
export const photometric = (s) => KM_LM_PER_W * integrateWeighted(s, cmfYbar());

/* Luminous efficacy of radiation, lm/W, relative to the power inside the
   simulated band only.

   CAUTION: the literature usually quotes LER against TOTAL radiant power across
   all wavelengths. For a source with significant out-of-band emission (any
   incandescent/blackbody source) the two differ enormously -- 121.6 vs 16.4
   lm/W for a 2856 K blackbody. Use luminousEfficacyTotal when the out-of-band
   power is known. */
export function luminousEfficacyBand(s) {
  const p = radiometric(s);
  return p > 0 ? photometric(s) / p : 0;
}

export function luminousEfficacyTotal(s, totalRadiantPower) {
  return totalRadiantPower > 0 ? photometric(s) / totalRadiantPower : 0;
}

/* Radiant flux (W) equivalent to a luminous flux (lm) for a given spectral
   shape. This is the one place a lumen enters the system; callers convert here
   and hand watts to the light constructors, so no lumen is ever stored. */
export function wattsFromLumens(lumens, spd) {
  const hat = normalizeTo(copy(spd), 1.0);
  const lmPerW = photometric(hat);
  return lmPerW > 0 ? lumens / lmPerW : 0;
}

export function quantityValue(s, sys) {
  return sys === PHOTOMETRIC ? photometric(s) : radiometric(s);
}

const UNITS = {
  flux:       { photometric: "lm",     radiometric: "W" },
  irradiance: { photometric: "lx",     radiometric: "W/m²" },
  intensity:  { photometric: "cd",     radiometric: "W/sr" },
  radiance:   { photometric: "cd/m²", radiometric: "W/(m² sr)" },
  exitance:   { photometric: "lm/m²", radiometric: "W/m²" },
};
const SYMBOLS = {
  flux:       { photometric: "Φv", radiometric: "Φe" },
  irradiance: { photometric: "Ev",      radiometric: "Ee" },
  intensity:  { photometric: "Iv",      radiometric: "Ie" },
  radiance:   { photometric: "Lv",      radiometric: "Le" },
  exitance:   { photometric: "Mv",      radiometric: "Me" },
};
export const quantityUnit = (q, sys) => (UNITS[q] || {})[sys] || "?";
export const quantitySymbol = (q, sys) => (SYMBOLS[q] || {})[sys] || "?";
