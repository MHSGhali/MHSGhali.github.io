/* Every setting, as data. From viewer/inspect.h and inspect.c.

   THE INVARIANT THIS MODULE OWNS
     There is exactly one place a setting can be changed, and one place its
     bounds live. A value typed into a box and a value set by a button both go
     through set(), so neither can produce a state the other cannot.

     The failure mode that buys is a control that clamps on one path and not
     another -- an aperture that stops at f/1.0 when typed but goes to f/0.2
     when set from a URL, producing a lens the tracer cannot build and a blank
     viewport with no explanation.

   FREE OF THE DOM
     The field list and the edit semantics are exercised headlessly by the test
     suite; app.js only renders what this produces and feeds edits back. This is
     the same split the C makes, and for the same reason.

   MULTIPLICATIVE VERSUS LINEAR
     Focal length, aperture, focus distance and the sample counts all span
     decades. Those are marked `logarithmic`, which is how a photographer thinks
     about every one of them: stops, not millimetres of aperture. Here it
     decides the step a number input takes and how a value is formatted, since
     there is no drag-to-scrub. */

import { clamp } from "../light/core.js?v=901aad0b";
import * as P from "./prescription.js?v=901aad0b";
import * as SD from "./scenedesc.js?v=901aad0b";

export function defaults() {
  return {
    /* lens */
    design: P.ACHROMAT_100,
    focalMm: 100.0,
    fno: 5.0,
    focusM: 2.0,
    blades: 0,               /* 0 = perfect circle, else 3..14 */
    curvature: 0.0,          /* 0 straight blades, 1 circular */
    rotDeg: 0.0,

    /* scene */
    preset: SD.RAIL,
    lightMode: SD.LAMPS,
    ambientLux: 2000.0,
    ambientCctK: 6500.0,

    /* sensor and image */
    sensorWMm: 36.0,
    resW: 320,               /* render width; height follows the sensor */
    exposure: 100.0,
    cocLimitMm: 0.030,       /* the blur that still counts as sharp */

    /* Sampling. NOT controls: they are here because the renderer needs them,
       not because anyone should have to choose them. The panel offers the lens,
       the scene and the sensor -- the things a photographer actually sets --
       and how many rays it takes to answer is the program's problem.

       4 samples per pass keeps a pass near a tenth of a second at the default
       grid, which is short enough that a newer request can pre-empt it mid-drag,
       and the picture then refines for as long as anyone watches it. */
    spp: 4,
    depth: 5,
  };
}

/* 3:2, the aspect of the 36 x 24 mm format the sensor width names. Derived
   rather than stored so the render grid and the sensor cannot disagree. */
export function resH(resW) {
  const h = Math.round((resW * 2) / 3);
  return h < 2 ? 2 : h;
}

/* THE field table. Ranges are the C's, with two deliberate exceptions marked
   below -- both because this renders on ONE worker where the C fans out across
   every core. */
export const FIELDS = [
  { id: "design", section: "LENS", label: "design", enumOf: () => P.IDS, names: P.NAMES },
  { id: "focalMm", section: "LENS", label: "focal", unit: "mm", lo: 12, hi: 400, log: true },
  { id: "fno", section: "LENS", label: "aperture", unit: "f/", lo: 1, hi: 45, log: true },
  { id: "focusM", section: "LENS", label: "focus", unit: "m", lo: 0.15, hi: 1000, log: true },
  /* 0 is a perfect circle; 1 and 2 are not irises, so the range skips them.
     set() enforces that gap rather than the input's step doing it. */
  { id: "blades", section: "LENS", label: "blades", unit: "", lo: 0, hi: 14, int: true },
  { id: "curvature", section: "LENS", label: "blade curve", unit: "", lo: 0, hi: 1 },
  { id: "rotDeg", section: "LENS", label: "blade angle", unit: "deg", lo: 0, hi: 90 },

  { id: "preset", section: "SCENE", label: "scene", enumOf: () => SD.PRESETS, names: SD.PRESET_NAMES },
  { id: "lightMode", section: "SCENE", label: "lighting", enumOf: () => SD.LIGHT_MODES, names: SD.MODE_NAMES },
  /* The dome's own controls appear only when the dome is what is lighting the
     scene. A lux figure sitting next to lamps that are doing the work would be
     two answers to one question. */
  { id: "ambientLux", section: "SCENE", label: "ambient", unit: "lx", lo: 0, hi: SD.AMBIENT_MAX_LX,
    log: true, when: (s) => s.lightMode === SD.AMBIENT },
  { id: "ambientCctK", section: "SCENE", label: "sky colour", unit: "K", lo: SD.CCT_MIN_K, hi: SD.CCT_MAX_K,
    log: true, when: (s) => s.lightMode === SD.AMBIENT },

  { id: "sensorWMm", section: "SENSOR", label: "width", unit: "mm", lo: 4, hi: 80, log: true },
  /* The C allows 1600. One worker cannot usefully fill that -- a pass has to
     stay short enough that a newer request can pre-empt it mid-drag -- and
     progressive accumulation recovers the quality at a smaller grid anyway. */
  { id: "resW", section: "SENSOR", label: "render", unit: "px", lo: 64, hi: 640, log: true, int: true },
  { id: "exposure", section: "SENSOR", label: "exposure", unit: "x", lo: 1e-4, hi: 1e6, log: true },
  { id: "cocLimitMm", section: "SENSOR", label: "sharp if", unit: "mm", lo: 0.002, hi: 0.2, log: true },

]; /* Sampling is deliberately absent -- see defaults(). */

export const FIELD_BY_ID = Object.fromEntries(FIELDS.map((f) => [f.id, f]));

/* The fields visible for a given state, in order. */
export const visibleFields = (s) => FIELDS.filter((f) => !f.when || f.when(s));

/* Apply an edit, clamped. Returns true if the stored value actually moved, so
   the caller knows whether to restart the render. THE one path. */
export function set(s, id, value) {
  const f = FIELD_BY_ID[id];
  if (!f) return false;

  let next;
  if (f.enumOf) {
    const options = f.enumOf();
    next = options.includes(value) ? value : s[id];
  } else {
    let x = Number(value);
    if (!Number.isFinite(x)) return false;
    x = clamp(x, f.lo, f.hi);
    if (f.int) x = Math.round(x);
    /* An iris needs at least three blades. Two would be a slit and one is not a
       shape at all, so the range 1..2 is a hole rather than a limit -- and the
       hole has to be enforced HERE, not by an input's step attribute, or a
       value arriving from a URL would land in it. */
    if (id === "blades" && x > 0 && x < 3) x = s[id] > 0 ? 0 : 3;
    next = x;
  }

  if (next === s[id]) return false;
  s[id] = next;
  return true;
}

/* True if anything that affects the RENDERED IMAGE differs.

   Exposure and the sharpness criterion are excluded on purpose: exposure is a
   view gain applied at tone-map time, and the sharpness limit only moves the
   depth-of-field numbers. Neither is a change to the photograph, and neither
   should throw away a half-converged render. */
export function imageDiffers(a, b) {
  for (const f of FIELDS) {
    if (f.id === "exposure" || f.id === "cocLimitMm") continue;
    if (a[f.id] !== b[f.id]) return true;
  }
  return false;
}

/* Format a value the way its field wants to be read. */
export function format(id, value) {
  const f = FIELD_BY_ID[id];
  if (!f) return String(value);
  if (f.enumOf) return (f.names && f.names[value]) || String(value);
  if (!Number.isFinite(value)) return "∞";
  if (f.int) return String(Math.round(value));
  /* Logarithmic fields span decades, so a fixed number of decimals is either
     noise at the top of the range or nothing at the bottom -- but decimals are
     the only thing that should vary. toPrecision() was the obvious way to write
     this and it is wrong here: three significant figures cannot spell 2000 in
     positional notation, so it silently switches to "2.00e+3" and a lux box
     reads like a physics paper. Exponential is right only where a plain number
     would be unreadable, which is the far ends of the exposure range. */
  const abs = Math.abs(value);
  if (abs !== 0 && (abs >= 1e6 || abs < 1e-3)) return value.toExponential(2);
  if (abs >= 100) return value.toFixed(0);
  if (abs >= 1) return value.toFixed(2);
  return value.toFixed(3);
}

/* The step a number input should take. Logarithmic fields get a step scaled to
   where they currently are, so one press is a sensible fraction of the value
   rather than a fixed amount that is useless at one end of the range. */
export function step(id, value) {
  const f = FIELD_BY_ID[id];
  if (!f || f.enumOf) return 1;
  if (f.int) return 1;
  if (f.log) {
    const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(value) || f.lo)));
    return Math.max(mag / 10, f.lo / 10);
  }
  return (f.hi - f.lo) / 100;
}

/* ---- sharing ----

   The same convention the other two tools use: a named preset, or the whole
   state as compact query pairs. Everything goes back through set(), so a
   hand-edited link cannot produce a state the panel could not. */
export function toHash(s) {
  const d = defaults();
  const parts = [];
  for (const f of FIELDS) {
    if (s[f.id] !== d[f.id]) parts.push(`${f.id}=${s[f.id]}`);
  }
  return parts.length ? parts.join("&") : `preset=${s.preset}`;
}

/* Returns whether the hash was UNDERSTOOD, not whether it moved anything.

   Those differ, and the difference is a bug: a link back to the shipped camera
   is `#preset=rail`, so a visitor who had stopped down to f/16 and then pasted
   a colleague's default link got `false` -- nothing had changed relative to the
   defaults this function was handed -- and the page kept f/16 while the address
   bar claimed otherwise. A link is a whole state; whether it happens to differ
   from the one on screen is not this function's business. */
export function fromHash(hash, s) {
  const text = hash.replace(/^#/, "");
  if (!text) return false;

  const named = /^preset=([\w-]+)$/.exec(text);
  if (named) {
    if (!SD.PRESETS.includes(named[1])) return false;
    set(s, "preset", named[1]);
    return true;
  }

  let understood = false;
  for (const pair of text.split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const id = pair.slice(0, eq);
    const raw = decodeURIComponent(pair.slice(eq + 1));
    if (!FIELD_BY_ID[id]) continue;
    set(s, id, FIELD_BY_ID[id].enumOf ? raw : Number(raw));
    understood = true;
  }
  return understood;
}
