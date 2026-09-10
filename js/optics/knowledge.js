/* ---------------------------------------------------------------
   What the assistant knows about the optics simulator.

   Same shape as js/light/knowledge.js: one document cut on its own XML tags,
   carrying the real capability surface and the real limits, and serving the
   planner, the help text and prose answers from one place.

   The limits matter more here than in either sibling, because a camera
   simulator invites questions it cannot answer. Flare, coatings, a zoom, image
   stabilisation, a real sensor with noise and an ISO, tilt and shift, and any
   lens anybody has actually owned are all reasonable things to ask a camera
   program for, and none of them exists in this one. Saying so is worth more
   than a plausible sentence.

   No DOM in here, so the tests can import it under node.
   --------------------------------------------------------------- */

import { makeRetriever, CHEVRON } from "../chat/retrieve.js?v=6aaa6367";

export const VOCABULARY = [
  "load the depth rail",
  "show me the bokeh lights",
  "fit the achromat",
  "use the singlet",
  "use the ideal lens",
  "set the focal length to <focal> mm",
  "open up to f/<fno>",
  "stop down to f/<fno>",
  "focus at <metres> m",
  "focus at infinity",
  "<blades> blades",
  "set the blade curve to <curve>",
  "make the sensor <sensor> mm",
  "full frame",
  "render at <pixels> px",
  "set the exposure to <exposure>",
  "make it brighter",
  "make it darker",
  "switch to the sky",
  "switch to the lamps",
  "set the sky to <lux> lx",
  "make the sky <kelvin> K",
  "fit the view",
  "what is sharp",
  "reset",
];

const HEAD =
`The optics simulator on this website: a physically based camera, tracing light
through real glass surface by surface. A browser port of Mark Gerges's desktop C
tool Optics-Simulation.`;

const ROLE =
`<role>
You are the assistant beside this camera simulator. You can drive it and you can
explain it. Answer from the sections below and from <state>, which is the camera
and the scene on the screen right now.
Every number you mention must come from <state>. If it is not there, say you
cannot see it. Never invent a reading, a distance or a lens.
Be brief. Two or three sentences unless a list is asked for.
When the visitor's problem is one command away from being fixed, end your answer
with that command on its own line inside <try></try>, worded the way the
commands below are worded. Write nothing after the closing tag, and offer at
most one.
</role>`;

const CAPABILITIES =
`<capabilities>
Set up a camera and see what it records.
- Light is traced through a multi-element lens prescription, surface by surface,
  with a refractive index from the Sellmeier coefficients of the real catalogue
  glass. Aberration is not applied afterwards; it is what the trace produces.
- Three lens designs: an ideal aberration-free lens, an uncorrected N-BK7
  singlet, and a Fraunhofer N-BK7 and F2 cemented achromat doublet.
- Focal length from 12 to 400 mm, and the design is rescaled to it exactly.
- Aperture from f/1 to f/45, limited by the glass: a design whose front element
  is too small simply cannot open that wide, and it reports the f-number it
  actually passes rather than the one asked for.
- Focus from 0.15 m to 1000 m, or infinity. Focusing moves the film, not the
  glass, so the camera does not walk while racking.
- An iris of 3 to 14 straight blades, rounded by a blade curve, or a perfect
  circle. The blade count changes the shape of the blur and the number of
  starburst spikes, never the exposure.
- Sensor width from 4 to 80 mm at 3:2, a render grid from 64 to 640 px, and an
  exposure that is a viewing gain applied after the fact.
- Two scenes: the depth rail, five identical targets at 1, 1.5, 2, 3 and 5 m;
  and the bokeh lights, twelve small bright sources at 6 m.
- Two lighting modes: the placed rectangular key lamp, or a uniform overhead
  sky. A choice, not a blend.
- The scene view draws the camera, the cone it sees, the focus plane and the
  near and far limits of acceptable sharpness, all at their true distances.
- Derived readouts: focal length, field of view, entrance pupil, T-stop, back
  focus, film position, chromatic error, blur at 6 m, image circle, the on-axis
  sharp limits and the hyperfocal distance.
</capabilities>`;

const PRECONDITIONS =
`<preconditions>
- The scene is FIXED. Nothing in it can be added, moved, deleted or recoloured.
  The camera is what changes, and the choice of which of the two scenes is in
  front of it.
- The aperture is limited by the glass. The shipped 100 mm achromat has a 20 mm
  front element, so it is wide open at about f/5 and asking for f/2.8 gives f/5
  with the pupil that really exists.
- Focus must be outside the front focal point. Asking to focus closer than that
  cannot be done and is refused rather than approximated.
- Exposure is a VIEWING GAIN, applied when the measurements become pixels. It
  never re-traces a ray and it is not a photographic control; brightness in this
  program comes from the aperture. Switching to the sky is about two stops
  brighter than the key lamp it replaces, so it clips until the exposure comes
  down.
- The image refines progressively. It is grainy for the first second and keeps
  improving for as long as it is left alone, so a reading taken immediately
  after a change is provisional.
- The depth-of-field numbers are ON AXIS and come from defocus alone. Off axis
  an uncorrected doublet adds coma and astigmatism that no depth-of-field
  formula knows about, so a target inside the sharp limits can still be visibly
  soft near the edge of the frame. The rendered image is the honest answer.
- The 100 mm designs cover a 20 mm image circle, which is smaller than a 36 mm
  sensor. The corners are outside what the lens covers, and the page says so.
</preconditions>`;

const LIMITS =
`<limits>
Things this tool genuinely cannot do. Say so plainly when one is asked for.
- The scene cannot be edited. No adding, moving, deleting, resizing or
  recolouring an object or a lamp, and no importing anything. The desktop C
  version does all of that; this page does not.
- No lens cross-section view and no ray fan diagram. The desktop version draws
  them; this page has the scene view and the image view only.
- No ISO, no shutter speed and no exposure triangle. There is one exposure
  number and it is a viewing gain. Motion blur does not exist because nothing
  moves.
- No sensor model: no shot noise, no read noise, no quantisation, no colour
  filter array, no white balance and no raw file. The grain in the image is
  Monte Carlo sampling, not a sensor.
- No lens flare, no ghosting and no veiling glare. Light reflected at a glass
  surface is dropped rather than followed.
- No anti-reflection coatings. Every surface is uncoated, which is why the
  T-stop is noticeably slower than the f-stop.
- No zoom, no macro, no teleconverter, no tilt or shift, no image stabilisation
  and no autofocus.
- No aspherical, cylindrical, freeform or diffractive surfaces. Every surface is
  spherical or flat.
- No real photographic prescriptions: no double Gauss, Tessar, telephoto or
  retrofocus, and no lens by brand or model name. Three designs only, and two of
  them exist to be compared with each other.
- No diffraction of any kind, so there is no diffraction limit, no Airy disc and
  no softening on stopping right down. Blur here is geometric only.
- No polarisation, no fluorescence and no participating media.
- No undo, and no way to save the rendered image out.
</limits>`;

const NUMBERS =
`<numbers>
- The camera stands at the origin looking down the axis; every distance is from
  there, in metres.
- It starts as the achromat at 100 mm, f/5, focused at 2 m, a circular iris, a
  36 mm sensor, 320 px wide and an exposure of 100.
- The depth rail's targets sit at 1, 1.5, 2, 3 and 5 m. Each one's size and
  offset scale with its distance, so all five subtend the same angle and the
  only difference in the image is focus. The 2 m target is the warm-coloured
  one.
- The bokeh scene's twelve sources sit at 6 m, 30 mm across, 5800 lumens at
  3000 K.
- The key lamp is a 1 m square panel at (1.6, 1.8, -1.4), 20800 lumens at
  5500 K, facing down. The sky defaults to 2000 lx at 6500 K, a bright overcast
  day.
- Sharpness is judged against a 0.030 mm circle of confusion, the number every
  depth-of-field table has used for a century on a 36 mm frame.
- At the default settings the sharp band on the axis runs from about 1.94 to
  2.06 m, and the hyperfocal distance is about 67 m.
- The singlet's chromatic error is about -1.54 % of its focal length; the
  achromat's is about -0.06 %, roughly twenty-five times better. That pair of
  numbers is what the two designs exist to show.
</numbers>`;

const HOW =
`<how>
- One camera ray carries ONE wavelength, because the glass is dispersive: rays
  at 450 and 650 nm leaving the same point on the film go to different places in
  the world. Carrying a whole spectrum down one of them would average the scene
  over wavelengths that never travelled there, which is how a simulator erases
  the chromatic aberration it was built to show.
- Vignetting is entirely geometric. A ray that misses the clear aperture of any
  surface, or the iris, is dead. There is no darkening factor applied to the
  corners anywhere in the program, so a dark corner means rays aimed at it hit
  the edge of real glass.
- The f-number is set from the ENTRANCE pupil, which is the image of the iris
  formed by the glass in front of it, not from focal length over diameter
  directly. Ignoring that magnification is wrong by 10 to 20 % on a real design.
- The circle of confusion is computed from the EXIT pupil and the real film
  position, not from the textbook thin-lens expression, which assumes both
  pupils are the same size.
- An N-blade iris is sized to enclose the same AREA as the circle it replaces,
  so changing the blade count changes the shape of the blur and not the
  exposure. Wide open its corners can reach past the barrel and be clipped,
  which is real mechanical vignetting rather than an exception to that rule.
- The wavelength is drawn in proportion to the CIE observer's response, so no
  ray is spent on a wavelength the film cannot see.
</how>`;

const PROCEDURE =
`<procedure>
The scene is fixed: you can choose which of the two arrangements is in front of
the camera, and set the camera. You cannot add, move or delete anything.
Distances are metres and focal lengths are millimetres.
Set the lens design before the focal length and aperture, because a design has
its own limits.
Exposure is a viewing gain; reach for it when the picture is too dark or clipped,
not to change the depth of field.
</procedure>`;

const EXAMPLE =
`<example>
Request: show me how shallow a fast portrait lens is
load the depth rail
fit the achromat
set the focal length to 135 mm
open up to f/2.8
focus at 2 m
fit the view
</example>`;

export const KNOWLEDGE =
  [HEAD, ROLE, CAPABILITIES, PRECONDITIONS, LIMITS, NUMBERS, HOW].join("\n");

export const PLANNING = [PROCEDURE, EXAMPLE].join("\n\n");

export const CAPABILITY_TEXT = CAPABILITIES.replace(/<\/?capabilities>\n?/g, "").trim();

/* Two stoplists, for the two different questions asked of them -- see the note
   in js/light/knowledge.js. */
const ENGLISH = "the a an and or of to in on for with at from by is was are were that this it as "
  + "you your can could would should will do does did not no what which when where why how "
  + "one two three make made makes set sets put puts use uses using here";

const FLAT_WORDS = ENGLISH + " lens camera image scene simulator tool thing things light";

const retriever = makeRetriever({
  text: KNOWLEDGE,
  ...CHEVRON,
  core: ["role"],

  flat: FLAT_WORDS,

  nudges: [
    [/\b(flare|ghost\w*|glare|coat\w*|iso|shutter|noise|grain|raw|white balance|zoom|macro|tilt|shift|stabilis\w*|stabiliz\w*|autofocus|asphere|aspheric\w*|freeform|diffract\w*|airy|polaris\w*|polariz\w*|fog|undo|save|export|edit|move|add|delete|double gauss|tessar|telephoto|retrofocus|canon|nikon|sony|leica|zeiss)\b/i, "limits"],
    [/\b(clip\w*|blown|too bright|too dark|grain\w*|noisy|provisional|refus\w*|cannot|can.?t|won.?t|wide open|corner|corners|dark corner|image circle|cover\w*|soft|why)\b/i, "preconditions"],
    [/\b(default|defaults|how (?:big|far|many|much)|distance|distances|metre|meters?|metres?|millimet\w*|circle of confusion|coc|hyperfocal|chromatic|abbe|lumens?|kelvin|lux)\b/i, "numbers"],
    [/\b(wavelength|spectral|dispersion|sellmeier|vignett\w*|pupil|entrance pupil|exit pupil|blade|blades|iris|area|estimator|sampling|how does it|why does)\b/i, "how"],
    [/\b(what can|capabilit\w*|features?|able to|support|supports|do here|possible|designs?|achromat|singlet)\b/i, "capabilities"],
  ],

  budget: 2500,
});

export const selectKnowledge = (question, budget) => retriever.select(question, budget);
export const SECTIONS = retriever.sections;

/* ------------------------------------------------------------ live state

   The camera as it stands. Capped for the same reason as the siblings: a
   window to protect, and a model that will invent a fourth lens design if
   shown three. Pure and DOM-free so the caps can be tested under node. */
const STATE_CAP = 800;

const n2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : "infinity");

export function formatState(s) {
  const out = [];
  out.push(`scene: ${s.scene}; lighting: ${s.lighting}`
    + (s.lighting === "ambient" ? `, sky ${s.ambientLux} lx at ${s.ambientCctK} K` : ""));
  out.push(`lens: ${s.design}, ${n2(s.focalMm)} mm at f/${n2(s.fno)}`
    + `, focused at ${n2(s.focusM)} m`
    + `; iris: ${s.blades >= 3 ? `${s.blades} blades, curve ${n2(s.curvature)}` : "a circle"}`);
  out.push(`sensor: ${n2(s.sensorWMm)} mm wide, rendering ${s.resW} px`
    + `, exposure x${n2(s.exposure)}, sharp within ${s.cocLimitMm} mm`);

  if (s.derived) {
    const d = s.derived;
    out.push(`measured: ${n2(d.eflMm)} mm actual, ${n2(d.hfovDeg)} deg across`
      + `, pupil ${n2(d.pupilMm)} mm, T/${n2(d.tstop)}`
      + `, colour error ${n2(d.colourErrPct)} %`);
    out.push(`sharp on axis: ${n2(d.nearM)} m to ${n2(d.farM)} m`
      + `; hyperfocal ${n2(d.hyperfocalM)} m`
      + `; covers ${n2(d.coversMm)} mm of the ${n2(d.coveredMm)} mm the sensor needs`);
  } else {
    out.push("measured: the lens has not been built yet");
  }
  out.push(`render: ${s.spp ? `${Math.round(s.spp)} samples a pixel so far` : "not started"}`);
  if (s.targets && s.targets.length) {
    out.push("targets: " + s.targets.map((t) => `${t.label} at ${t.depthM} m${t.sharp ? " (sharp)" : ""}`).join("; "));
  }

  const text = out.join("\n");
  return "<state>\n" + (text.length > STATE_CAP ? text.slice(0, STATE_CAP - 1) + "…" : text) + "\n</state>";
}

export const TERMS = (() => {
  const common = new Set(ENGLISH.split(/\s+/));
  /* The role is instructions TO the model, not subject matter, so it must not
     vote on what counts as on topic -- see js/light/knowledge.js. */
  const subject = KNOWLEDGE.replace(/<role>[\s\S]*?<\/role>/i, "");
  return new Set(subject.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/)
    .filter((w) => w.length >= 3 && !common.has(w)));
})();
