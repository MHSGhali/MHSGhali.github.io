/* The scene, and the one place it becomes something the tracer can read.
   From src/os_stage.c and the build half of src/os_scenedesc.c.

   WHAT IS AND IS NOT HERE
     The C's OsSceneDesc is an editable document: tombstoned ids, add/delete,
     selection, undo. All of that exists to keep a visitor's edits alive across
     settings changes, and this page has no edits to keep -- the camera and the
     objects are fixed where the preset puts them. So a preset builds straight
     into a scene, and the authoring layer is absent rather than ported and
     unused. What survives is the half that matters: the CLAMPS, and the build.

   THE CLAMPS ARE NOT TASTE
     Each one guards a way js/light/light.js can be made to throw:
     finalize() derives radiance from area and then checks that the flux implied
     by the geometry matches the flux it was given, and that the spectral shape
     integrates to one. A zero-area light divides by zero; a colour temperature
     below about 1200 K underflows every visible bin so the shape cannot be
     normalised. Both throw inside a worker build, nowhere near the control that
     was moved.

   COORDINATES
     Y-up, and the camera sits at the origin looking down -z. That is what makes
     -centre.z a literal distance in metres, and it is why every depth in this
     file is written that way. Note this is NOT the Z-up convention of
     js/light/ -- the geometry and light modules take arbitrary vectors and do
     not care, but anything that assumes an up axis (the 3D view) must use this
     one. */

import { PI, clamp } from "../light/core.js?v=7a60899b";
import * as v from "../light/vec3.js?v=7a60899b";
import * as S from "../light/spectrum.js?v=7a60899b";
import * as B from "../light/bsdf.js?v=7a60899b";
import * as Lt from "../light/light.js?v=7a60899b";
import * as G from "../light/geom.js?v=7a60899b";
import * as U from "../light/units.js?v=7a60899b";
import { spectrumToXyz } from "../light/color.js?v=7a60899b";
import { createScene } from "../light/scene.js?v=7a60899b";

/* ---- limits ---- */
export const POS_LIMIT_M = 50.0;
export const SIZE_MIN_M = 1.0e-4;
export const SIZE_MAX_M = 20.0;
export const FLUX_MAX_LM = 1.0e7;
export const CCT_MIN_K = 1200.0;
export const CCT_MAX_K = 20000.0;
export const AMBIENT_MAX_LX = 1.0e6;
/* A perfect reflector is an idealisation no real surface reaches, and taken
   literally it makes the equilibrium radiance of a closed room, Le/(1-rho),
   diverge. */
const RHO_MAX = 0.99;

/* WHERE THE LIGHT COMES FROM -- a choice, not a blend.

   LAMPS is placed light: sources with a position, so things have a lit side, a
   shadow side and a terminator between them. That is what makes a scene look
   three-dimensional, and it is what you want when the lighting is the subject.

   AMBIENT is a uniform dome of the same radiance in every direction. Nothing
   casts a shadow, nothing has a terminator, and every surface is lit by exactly
   as much sky as it can see. Flat, and deliberately so: shadow contrast reads
   as sharpness to the eye, so a scene with no shadows at all is the honest
   place to judge FOCUS. The C has already had one focus question confused by a
   terminator.

   The dome LIGHTS the scene and is not PHOTOGRAPHED -- see the camera-ray note
   in trace.js. The background stays black, as it is under the lamp, so
   switching modes changes the lighting and nothing else.

   A choice rather than two independent switches because they are answers to the
   same question, and because the interesting comparison is A against B -- a
   scene half-lit by each is a third thing that answers neither. */
export const LAMPS = "lamps";
export const AMBIENT = "ambient";
export const LIGHT_MODES = [LAMPS, AMBIENT];
export const MODE_NAMES = { [LAMPS]: "LAMPS", [AMBIENT]: "AMBIENT" };

export const RAIL = "rail";
/* One scene, so the panel hides the selector -- see settings.js. The list and
   the lookup stay because everything downstream is written against them, and a
   second scene is then a one-line addition rather than a refactor. */
export const PRESETS = [RAIL];
export const PRESET_NAMES = { [RAIL]: "RAIL" };

/* ---- Smits' RGB-to-reflectance basis, from src/color.c -------------------

   Object colours are authored as RGB, which is not a spectrum, and this engine
   is spectral all the way down. Smits' basis is the standard reconstruction:
   build the colour out of white, the two secondaries either side of it and one
   primary, all of which are smooth, so the result is a plausible reflectance
   rather than a spiky one that would produce colours no pigment can.

   The band this engine samples (360-830 nm) is wider than the table on both
   sides; fromSamples() holds the endpoint value out to the edges, which is the
   conventional and physically harmless choice for a reflectance that is by
   definition flat-ish outside the visible range. */
const SMITS_L = [380, 417.777778, 455.555556, 493.333333, 531.111111,
                 568.888889, 606.666667, 644.444444, 682.222222, 720];
const SMITS_WHITE   = [1.0000, 1.0000, 0.9999, 0.9993, 0.9992, 0.9998, 1.0000, 1.0000, 1.0000, 1.0000];
const SMITS_CYAN    = [0.9710, 0.9426, 1.0007, 1.0007, 1.0007, 1.0007, 0.1564, 0.0000, 0.0000, 0.0000];
const SMITS_MAGENTA = [1.0000, 1.0000, 0.9685, 0.2229, 0.0000, 0.0458, 0.8369, 1.0000, 1.0000, 0.9959];
const SMITS_YELLOW  = [0.0001, 0.0000, 0.1088, 0.6651, 1.0000, 1.0000, 0.9996, 0.9586, 0.9685, 0.9840];
const SMITS_RED     = [0.1012, 0.0515, 0.0000, 0.0000, 0.0000, 0.0000, 0.8325, 1.0149, 1.0149, 1.0149];
const SMITS_GREEN   = [0.0000, 0.0000, 0.0273, 0.7937, 1.0000, 0.9418, 0.1719, 0.0000, 0.0000, 0.0025];
const SMITS_BLUE    = [1.0000, 1.0000, 0.8916, 0.3323, 0.0000, 0.0000, 0.0003, 0.0369, 0.0483, 0.0496];

const smitsAdd = (acc, basis, w) => { for (let i = 0; i < acc.length; i++) acc[i] += w * basis[i]; };

/* A cached D65, used only to measure the uplift's luminance. */
let d65 = null;
const daylightWhite = () => (d65 ||= S.daylight(6504));

export function spectrumFromRgbReflectance(rgb) {
  /* Clamp on the way in: an out-of-gamut or over-unity colour must not be able
     to produce a reflectance above 1. */
  const r = clamp(rgb[0], 0, 1), g = clamp(rgb[1], 0, 1), b = clamp(rgb[2], 0, 1);

  const acc = new Float64Array(SMITS_L.length);
  if (r <= g && r <= b) {
    smitsAdd(acc, SMITS_WHITE, r);
    if (g <= b) { smitsAdd(acc, SMITS_CYAN, g - r); smitsAdd(acc, SMITS_BLUE, b - g); }
    else        { smitsAdd(acc, SMITS_CYAN, b - r); smitsAdd(acc, SMITS_GREEN, g - b); }
  } else if (g <= r && g <= b) {
    smitsAdd(acc, SMITS_WHITE, g);
    if (r <= b) { smitsAdd(acc, SMITS_MAGENTA, r - g); smitsAdd(acc, SMITS_BLUE, b - r); }
    else        { smitsAdd(acc, SMITS_MAGENTA, b - g); smitsAdd(acc, SMITS_RED, r - b); }
  } else {
    smitsAdd(acc, SMITS_WHITE, b);
    if (r <= g) { smitsAdd(acc, SMITS_YELLOW, r - b); smitsAdd(acc, SMITS_GREEN, g - r); }
    else        { smitsAdd(acc, SMITS_YELLOW, g - b); smitsAdd(acc, SMITS_RED, r - g); }
  }

  let s = S.fromSamples(SMITS_L, acc, SMITS_L.length);
  /* The basis curves themselves exceed 1 slightly (cyan peaks at 1.0007, red at
     1.0149), so clamp per bin rather than trusting the construction. */
  for (let i = 0; i < S.NBINS; i++) s[i] = clamp(s[i], 0, 1);

  /* Correct the LUMINANCE exactly, leaving only chromaticity error.

     Smits' basis reproduces a colour approximately, and the approximation is
     worst in the saturated corners. But the quantity this simulator reports is
     photometric, so of the two errors it is luminance that must not drift: a
     sphere authored at 60 % grey has to reflect 60 % of the light, whatever its
     hue does. One scalar fixes it. */
  const white = daylightWhite();
  const seen = S.mul(s, white);
  const yWhite = spectrumToXyz(white).y;
  const yGot = yWhite > 0 ? spectrumToXyz(seen).y / yWhite : 0;
  const yWant = 0.2126 * r + 0.7152 * g + 0.0722 * b;   /* sRGB luminance row */
  if (yGot > 1e-9 && yWant > 0) s = S.scale(s, yWant / yGot);

  /* Final cap. The bound is just below 1, not at it -- see RHO_MAX. */
  for (let i = 0; i < S.NBINS; i++) s[i] = clamp(s[i], 0, RHO_MAX);
  return s;
}

/* ---- the presets --------------------------------------------------------

   A preset is the whole scene. The camera always looks down -z from the origin,
   which is what makes -centre.z a distance. */

/* Targets on a rail at exactly known distances, staggered across the frame so
   they do not occlude one another. This is the depth-of-field article: focus at
   2.0 m and the 2.0 m target must be the sharp one. */
function presetRail(d) {
  const DEPTHS = [1.0, 1.5, 2.0, 3.0, 5.0];
  const NAMES = ["1M", "1.5M", "2M", "3M", "5M"];
  /* Each target's offset and radius scale WITH its distance, so every one
     subtends the same angle and lands the same size on the sensor. That is the
     point of the rail: the only difference between them in the image is how far
     out of focus they are.

     Their angular POSITIONS have to differ, though, and that is a separate
     thing -- at a fixed offset they stack in depth and only the nearest is
     visible. The fractions stay inside 0.18, the tangent of the half-angle a
     100 mm lens covers on full frame. */
  const FRAC = [-0.140, -0.070, 0.0, 0.070, 0.140];

  /* One hue each, so a target can be named in a sentence and so the five stay
     apart under a flat sky, where neutral greys are nearly indistinguishable.

     EQUAL LUMINANCE, deliberately. All five reflect 0.48 of the light falling
     on them and differ only in hue. The rail exists to show that the sole
     difference between these targets is how far out of focus they are; a
     brighter or darker one would be a second difference, and the eye reads
     brightness as sharpness readily enough to confuse the demonstration this
     scene is for.

     The values are moderate rather than saturated for two reasons: Smits'
     reconstruction in spectrumFromRgbReflectance is least faithful in the
     saturated corners, and a reflectance near 1.0 in any band is not a paint
     anybody has. Each comes back within 0.0005 of 0.48 through the uplift, and
     the closest pair sits 0.079 apart in chromaticity. */
  const COLOURS = [
    ["red",    [0.995, 0.343, 0.320]],
    ["amber",  [0.724, 0.449, 0.072]],
    ["green",  [0.169, 0.599, 0.212]],
    ["cyan",   [0.118, 0.565, 0.706]],
    ["violet", [0.650, 0.377, 0.996]],
  ];

  for (let i = 0; i < 5; i++) {
    const dist = DEPTHS[i];
    d.objects.push({
      kind: "sphere",
      centre: v.v3(FRAC[i] * dist, 0, -dist),
      radius: 0.030 * dist,
      rgb: COLOURS[i][1],
      colour: COLOURS[i][0],
      name: NAMES[i],
    });
  }

  /* NO BACKDROP. The targets stand in empty space, and what is behind them is
     whatever the lighting says is behind them: nothing under LAMPS, the sky
     itself under AMBIENT.

     The C had a plane at -12 m here, on the argument that out-of-focus
     background is worth seeing. It is, but it is a WALL, and a wall bounces
     light back onto the subjects, occludes the dome behind them, and gives
     every silhouette a second edge to be confused with the first. */

  /* One big soft key light, off to the side and above, so the spheres are
     shaded rather than flat and the terminator is visible.

     20800 lm at 5500 K is the same lamp the C's hard-coded stage had, restated
     in the unit it is now authored in: that scene used 120 W radiant, and a
     5500 K blackbody is worth about 173 lm/W inside the simulated band. */
  d.lights.push({
    kind: "rect",
    centre: v.v3(1.6, 1.8, -1.4),
    sizeU: 1.0, sizeV: 1.0,
    fluxLm: 20800.0, cctK: 5500.0,
    name: "KEY",
  });
}

/* Seed a description from one of the presets. `id` is unused while there is
   only one, and kept so adding a second changes this function and nothing that
   calls it. */
export function preset(id) {
  const d = {
    objects: [],
    lights: [],
    camEye: v.v3(0, 0, 0),
    camTarget: v.v3(0, 0, -1),
    /* The dome is authored even though a preset starts on lamps, so switching
       to it lands on a usable scene rather than on black. 2000 lx at 6500 K is
       a bright overcast day -- the lighting a lightbox or a softbox tent is
       trying to imitate, and roughly what the rail's key lamp puts on the near
       targets, so the two modes are comparable at one exposure. */
    lightMode: LAMPS,
    /* The lamp's brightness and colour sit at scene level, exactly as the
       dome's do, because while there is one lamp they ARE the scene's lighting
       rather than a property of some object in it. If a second lamp is ever
       added these move back onto the lights themselves. */
    lampLm: 20800.0,
    lampCctK: 5500.0,
    ambientLux: 2000.0,
    ambientCctK: 6500.0,
  };
  presetRail(d);
  return d;
}

/* ---- clamping ---- */

const clampPos = (p) => v.v3(
  clamp(p.x, -POS_LIMIT_M, POS_LIMIT_M),
  clamp(p.y, -POS_LIMIT_M, POS_LIMIT_M),
  clamp(p.z, -POS_LIMIT_M, POS_LIMIT_M)
);

export function clampObject(o) {
  return {
    ...o,
    centre: clampPos(o.centre),
    radius: clamp(o.radius ?? SIZE_MIN_M, SIZE_MIN_M, SIZE_MAX_M),
    rgb: [clamp(o.rgb[0], 0, 1), clamp(o.rgb[1], 0, 1), clamp(o.rgb[2], 0, 1)],
  };
}

export function clampLight(l) {
  return {
    ...l,
    centre: clampPos(l.centre),
    radius: clamp(l.radius ?? SIZE_MIN_M, SIZE_MIN_M, SIZE_MAX_M),
    sizeU: clamp(l.sizeU ?? SIZE_MIN_M, SIZE_MIN_M, SIZE_MAX_M),
    sizeV: clamp(l.sizeV ?? SIZE_MIN_M, SIZE_MIN_M, SIZE_MAX_M),
    fluxLm: clamp(l.fluxLm, 0, FLUX_MAX_LM),
    cctK: clamp(l.cctK, CCT_MIN_K, CCT_MAX_K),
  };
}

/* ---- building ----------------------------------------------------------

   Assemble the flat scene the tracer reads. THE only place an emissive prim is
   paired with its light, and the only place a lumen becomes a watt. */
export function build(d) {
  const sc = createScene();
  const markers = [];

  /* ---- subjects ---- */
  for (const raw of d.objects) {
    const o = clampObject(raw);

    const matId = sc.mats.length;
    sc.mats.push({
      /* Authored as a colour and uplifted to a smooth spectrum. The uplift is
         not invertible, so rgb stays the source of truth for the 3D view. */
      bsdf: B.makeLambert(spectrumFromRgbReflectance(o.rgb)),
      le: S.zero(),
      emissive: false,
      rgb: o.rgb,
    });

    const prim = o.kind === "plane"
      ? { kind: G.PLANE, c: o.centre, n: v.normalize(o.normal || v.v3(0, 1, 0)),
          ex: v.v3(0, 0, 0), ey: v.v3(0, 0, 0), r: 0, matId, lightId: -1 }
      : { kind: G.SPHERE, c: o.centre, n: v.v3(0, 0, 1),
          ex: v.v3(0, 0, 0), ey: v.v3(0, 0, 0), r: o.radius, matId, lightId: -1 };

    /* The ground truth the stage exists to provide, recorded against the prim
       that was actually built -- derived, so it cannot drift from where the
       object really is. */
    markers.push({ label: o.name, prim: sc.prims.length, depthM: -o.centre.z,
                   centre: o.centre, rgb: o.rgb, colour: o.colour, radius: o.radius });
    sc.prims.push(prim);
  }

  /* ---- lights, each with the emissive face that IS it ----

     THE only place the pairing is made. A light and the prim carrying its
     emissive material are created together here and exist only for the life of
     this build, so they cannot drift apart. Under AMBIENT no lamp is emitted at
     all -- the mode is a choice, not a blend. */
  const lampMarkers = [];
  if (d.lightMode === LAMPS) {
    d.lights.forEach((raw) => {
      /* Scene-level brightness and colour win over whatever the preset seeded,
         so the panel's number is the one that renders. */
      const l = clampLight({
        ...raw,
        fluxLm: d.lampLm ?? raw.fluxLm,
        cctK: d.lampCctK ?? raw.cctK,
      });
      const spd = S.blackbody(l.cctK);
      /* Lumens in, watts stored. js/light/units.js owns this conversion, and
         no lumen is ever stored past this line. */
      const watts = U.wattsFromLumens(l.fluxLm, spd);

      const id = sc.lights.length;
      /* NOTE the half-edges: js/light/light.js's rect takes ex and ey as HALF
         the panel's extent (its area is 4|ex x ey|), where the C authors a full
         width. cross(ex, ey) then points at -y, so the panel faces DOWN, which
         is what an overhead key light is. */
      const ex = v.v3(l.sizeU * 0.5, 0, 0);
      const ey = v.v3(0, 0, l.sizeV * 0.5);
      const lt = l.kind === "rect"
        ? Lt.rect(l.centre, ex, ey, watts, spd)
        : Lt.sphere(l.centre, l.radius, watts, spd);
      lt.fluxAuthoredLm = l.fluxLm;
      Lt.finalize(lt, id);
      sc.lights.push(lt);

      const matId = sc.mats.length;
      sc.mats.push({
        bsdf: B.makeLambert(S.zero()),
        /* The face carries the light's OWN radiance, so what the camera sees
           and what next-event estimation samples agree by construction. */
        le: S.scale(lt.sHat, lt.radiance),
        emissive: true,
      });

      const prim = l.kind === "rect"
        ? { kind: G.QUAD, c: l.centre, ex, ey, n: lt.n, r: 0, matId, lightId: id }
        : { kind: G.SPHERE, c: l.centre, ex: v.v3(0, 0, 0), ey: v.v3(0, 0, 0),
            n: v.v3(0, 0, 1), r: l.radius, matId, lightId: id };
      lampMarkers.push({ ...l, prim: sc.prims.length });
      sc.prims.push(prim);
    });
  }

  /* ---- the dome ----

     Built here rather than in the tracer for the same reason lamps are: this is
     the one place a photometric number becomes a radiometric one. The lux the
     panel holds is the illuminance on a surface facing the sky, and a uniform
     dome of radiance L delivers exactly pi*L there -- so the radiance is E/pi,
     and wattsFromLumens does the photometric half of the conversion, per unit
     area, exactly as it does for a lamp's flux.

     The dome carries NO GEOMETRY: no prim, no entry in sc.lights. It cannot be
     hit, so the tracer samples it as a separate strategy. */
  const env = { on: false, le: S.zero() };
  if (d.lightMode === AMBIENT) {
    const lux = clamp(d.ambientLux, 0, AMBIENT_MAX_LX);
    const cct = clamp(d.ambientCctK, CCT_MIN_K, CCT_MAX_K);
    const shape = S.normalizeTo(S.blackbody(cct), 1.0);
    /* Lux in, W/m^2 out: the same algebra as lumens to watts, one factor of
       area down on both sides. */
    const ePerp = U.wattsFromLumens(lux, shape);
    env.on = true;
    env.le = S.scale(shape, ePerp / PI);
  }

  return { scene: sc, env, markers, lamps: lampMarkers };
}

/* Radiance arriving from direction `dir`, at one wavelength.

   `dir` is unused while the dome is uniform. It is a parameter anyway because
   it is the seam a gradient sky or an imported HDRI arrives at, and a caller
   that already passes the direction needs no edit when one does. */
export const envRadiance = (env, dir, lambdaNm) =>
  (env && env.on ? S.at(env.le, lambdaNm) : 0);
