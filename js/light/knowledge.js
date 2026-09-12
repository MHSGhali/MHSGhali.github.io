/* ---------------------------------------------------------------
   What the assistant knows about the light simulator.

   Same shape as js/linkage/knowledge.js: one document cut on its own XML tags,
   carrying the real capability surface and the real limits, and serving the
   planner, the help text and prose answers from one place.

   The limits matter more here than in the linkage tool, because a light
   simulator invites questions it cannot answer. Glass, caustics, fog, IES
   files, glare metrics and a sky are all reasonable things to ask a lighting
   program for, and none of them exists in this one. Saying so is worth more
   than a plausible sentence.

   No DOM in here, so the tests can import it under node.
   --------------------------------------------------------------- */

import { makeRetriever, CHEVRON } from "../chat/retrieve.js?v=58764426";

export const VOCABULARY = [
  "load the workcell",
  "add a rect light",
  "add a point light",
  "add a spot light",
  "add a sphere",
  "add a quad",
  "select lamp <n>",
  "select surface <n>",
  "move it to <x> <y> <z>",
  "raise it by <metres>",
  "set it to <lumens> lumens",
  "make it <kelvin> K",
  "set the cone to <degrees> degrees",
  "set the albedo to <albedo>",
  "delete it",
  "switch to lux",
  "switch to watts per square metre",
  "turn off interreflection",
  "fine quality",
  "fit the view",
  "download the scene",
];

const HEAD =
`The light simulator on this website: a physically based spectral ray tracer, a
browser port of Mark Gerges's desktop C tool Light-Simulation.`;

const ROLE =
`<role>
You are the assistant beside this simulator. You can drive it and you can
explain it. Answer from the sections below and from <state>, which is the scene
on the screen right now.
Every number and every object you mention must come from <state>. If it is not
there, say you cannot see it. Never invent a lamp, a surface or a reading.
Be brief. Two or three sentences unless a list is asked for.
When the visitor's problem is one command away from being fixed, end your answer
with that command on its own line inside <try></try>, worded the way the
commands below are worded. Write nothing after the closing tag, and offer at
most one.
</role>`;

const CAPABILITIES =
`<capabilities>
Place lamps and surfaces, and read the illuminance landing on every surface.
- Radiance is carried as 95 spectral bins from 360 to 830 nm, and photometry is
  an exact integral against the CIE 1931 observer. Lux and watts per square
  metre are two projections of one stored measurement, so switching between
  them never re-solves anything.
- Lamps: a rectangular panel, a point, a spot with a cone, and from a scene
  file also a disk, a sphere and a sun.
- Surfaces: a quad, a sphere, and from a scene file an infinite plane.
- Materials: matte with an albedo, and from a scene file a metal (aluminium,
  copper or gold) with a roughness, or an emissive surface.
- Spectra: flat, a blackbody at a temperature, daylight at a temperature, or an
  LED given a centre wavelength and a width.
- Real shadows, soft from panels and spheres, hard from points, spots and sun.
- Interreflection, accumulated progressively over eight passes.
- Statistics over the measurement grid: minimum, mean, maximum, and the
  uniformity ratios U0 and Ud.
- Five starter scenes: the inspection workcell, one panel over a bare surface,
  a spot on a curved part, warm and cool together, and daylight through an
  opening.
- The scene file is the same format the C command line tool reads, so a scene
  downloaded here runs there unchanged.
</capabilities>`;

const PRECONDITIONS =
`<preconditions>
- Editing a lamp or a surface needs it selected first, by number or by clicking
  it in the view.
- A lamp takes a flux, a colour temperature and a position. A spot also takes a
  cone angle. A surface takes a position, a size and an albedo. Asking for a
  property the object does not have does nothing.
- A surface is lit on ONE SIDE ONLY, the side its normal points to. A quad
  facing away from every lamp reads zero everywhere, and that is the usual
  reason a surface is dark for no apparent reason.
- U0 and Ud go to zero the moment any single measured point reads zero, because
  both are ratios against the minimum. A scene with anything in shadow will
  report 0.000 rather than a small number, and the page says how many points
  are dark.
- Statistics are taken over the measurement grid when the scene declares one,
  and otherwise over every drawn surface pooled together, backs included.
- A daylight temperature is clamped to between 4000 and 25000 K. A spot's
  falloff angle is clamped to its total angle.
- Interreflection settles over eight passes, so the numbers climb for a second
  after any change and are provisional until they stop.
</preconditions>`;

const LIMITS =
`<limits>
Things this tool genuinely cannot do. Say so plainly when one is asked for.
- No refraction, transmission or glass. Nothing is transparent or translucent:
  no windows, no lenses, no diffusers that light passes through, no water.
- No caustics.
- No participating media: no fog, haze, smoke or atmospheric scattering.
- No sky, no environment and no ambient light. A ray that escapes the scene
  returns nothing, so an outdoor scene is lit only by what you place in it.
- Matte albedo is a single number across all 95 bins, so there are no coloured
  matte surfaces and no spectral reflectance.
- No textures, no imported meshes, no CAD import, no boxes or cylinders, and no
  transforms. A scene is planes, quads and spheres stated in world coordinates.
- An emissive material lights nothing in the reported numbers; only declared
  lamps are measured and attributed.
- No IES or goniometric photometry files, so a real luminaire's distribution
  cannot be loaded. The only distributions are isotropic, a smoothstep cone,
  Lambertian and a delta direction.
- No glare metrics such as UGR or DGP, no CRI or TM-30, no correlated colour
  temperature readout of the result, no daylight factor, and no annual or
  climate based study.
- No sun position from a date, time, latitude or orientation. A sun is a
  direction and an irradiance in watts per square metre, never in lumens.
- No rendered image. The scene file carries a camera so the C tool can render
  one, but nothing here reads it.
- No animation, no dimming schedule and no scene over time.
- The buttons on this page add rectangular, spot and point lamps and quad and
  sphere surfaces. Disk lamps, sphere lamps, infinite planes, metals and
  emissive materials exist in the engine but can only arrive in a scene file.
- No undo, and no copy or paste of an object.
</limits>`;

const NUMBERS =
`<numbers>
- Coordinates are metres, and the starter scenes are benchtop sized: about 0.6
  by 0.6 by 0.5 metres, so positions land between about -0.4 and 0.4 across and
  0 to 0.6 up.
- A new lamp is 200 lumens of 5000 K daylight. A new spot has a 35 degree cone
  with a 22 degree falloff. A new sphere has a radius of 0.05 m.
- Albedo runs from 0 to 1: about 0.2 for a dark floor, 0.8 for a white wall.
- Interreflection is eight passes of eight samples at a depth of three bounces.
- Draft and fine change three things and nothing else: how finely surfaces are
  divided, how many samples each panel gets for direct light (12 against 64),
  and the cap on the measurement grid (24 against 64 a side).
</numbers>`;

const SCENEFILE =
`<scenefile>
The scene file is a flat list of statements; a hash starts a comment and
newlines do not matter. A surface may only name a material declared above it.
  material <name> lambert <albedo>
  material <name> metal <al|cu|au> <roughness>
  material <name> emit <radiance>
  plane  <material> <centre x y z> <normal x y z>
  quad   <material> <centre x y z> <normal x y z> <half u x y z> <half v x y z>
  sphere <material> <centre x y z> <radius>
  light point  <x y z> <W|lm> <value> <spectrum>
  light spot   <x y z> <direction x y z> <total deg> <falloff deg> <W|lm> <value> <spectrum>
  light rect   <centre x y z> <half u x y z> <half v x y z> <W|lm> <value> <spectrum>
  light disk   <centre x y z> <normal x y z> <radius> <W|lm> <value> <spectrum>
  light sphere <centre x y z> <radius> <W|lm> <value> <spectrum>
  light sun    <direction x y z> <irradiance W/m2> <spectrum>
  grid   <origin x y z> <edge u x y z> <edge v x y z> <nu> <nv>
  camera <eye x y z> <target x y z> <fov y deg> <width> <height>
A spectrum is one of: flat, blackbody <K>, daylight <K>, led <centre nm> <width nm>.
Quads and rect lamps take HALF edges; a grid takes FULL edge vectors and samples
cell centres. Only one grid per scene: a second one replaces the first.
</scenefile>`;

const PROCEDURE =
`<procedure>
Lamps and surfaces are numbered 1, 2, 3 in the order they appear, so add
something before you select it.
Positions are metres, roughly -0.4 to 0.4 across and 0 to 0.6 up.
Set a lamp's flux and colour temperature only after selecting that lamp.
Start from a scene with 'load the workcell' unless the request says otherwise.
</procedure>`;

const EXAMPLE =
`<example>
Request: put one panel over a floor and a ball under it
load the workcell
add a rect light
select lamp 1
move it to 0 0 0.45
set it to 400 lumens
make it 4000 K
add a sphere
fit the view
</example>`;

export const KNOWLEDGE =
  [HEAD, ROLE, CAPABILITIES, PRECONDITIONS, LIMITS, NUMBERS, SCENEFILE].join("\n");

export const PLANNING = [PROCEDURE, EXAMPLE].join("\n\n");

export const CAPABILITY_TEXT = CAPABILITIES.replace(/<\/?capabilities>\n?/g, "").trim();

/* Two stoplists, because they are asked two different questions.

   ENGLISH is ordinary filler, and it is what the topic gate ignores when it
   asks "is this question about the tool at all?" -- there, a word like
   "joint" is the strongest evidence there is.

   FLAT_WORDS adds the words this document uses everywhere, and it is what
   the retriever ignores when it asks "WHICH part of the document?" -- there,
   "joint" appears in every section and so points at none of them. Conflating
   the two made "how do I add a joint" fall off the end of the gate. */
const ENGLISH = "the a an and or of to in on for with at from by is was are were that this it as "
  + "you your can could would should will do does did not no what which when where why how "
  + "one two three make made makes set sets put puts use uses using here";

const FLAT_WORDS = ENGLISH + " light lights lamp lamps surface surfaces scene simulator tool thing things";

const retriever = makeRetriever({
  text: KNOWLEDGE,
  ...CHEVRON,
  core: ["role"],

  flat: FLAT_WORDS,

  nudges: [
    [/\b(refract\w*|transmi\w*|glass|transparen\w*|translucen\w*|lens|lenses|window|caustic\w*|fog|haze|smoke|scatter\w*|sky|environment|ambient|texture|mesh|import|cad|box|cylinder|ies|goniometr\w*|glare|ugr|dgp|cri|daylight factor|annual|render|image|animat\w*|undo|colour|color)\b/i, "limits"],
    [/\b(dark|zero|nothing|black|unlit|shadow|uniformit\w*|u0|selected|selection|clamp\w*|why|won.?t|will not|cannot|can.?t|settl\w*|provisional|normal|facing|backwards)\b/i, "preconditions"],
    [/\b(metre|meters?|metres?|coordinate|coordinates|units|scale|default|albedo|lumens?|kelvin|temperature|cone|degrees|passes|depth|draft|fine|quality|how (?:big|large|far|many))\b/i, "numbers"],
    [/\b(scene ?file|\.scene|format|syntax|grammar|statement|cli|command line|write a scene|hand ?write|download|export|save)\b/i, "scenefile"],
    [/\b(what can|capabilit\w*|features?|able to|support|supports|do here|possible|spectral|bins|cie)\b/i, "capabilities"],
  ],

  budget: 2500,
});

export const selectKnowledge = (question, budget) => retriever.select(question, budget);
export const SECTIONS = retriever.sections;

/* ------------------------------------------------------------ live state

   The scene as it stands, capped hard for the same reasons as the linkage
   one: a window to protect, and a model that will invent a seventh lamp if
   shown six. Pure and DOM-free so the caps can be tested under node. */
const LAMP_CAP = 6;
const SURFACE_CAP = 6;
const STATE_CAP = 800;

const r2 = (v) => Math.round(v * 100) / 100;
const at = (p) => `(${r2(p.x)},${r2(p.y)},${r2(p.z)})`;

export function formatState(s) {
  const out = [];
  out.push(`scene: ${s.scene || "one you built"}; units: ${s.photometric ? "lux" : "W/m2"}`
    + `; interreflection: ${s.indirect ? "on" : "off"}; quality: ${s.quality}`);

  const lamps = s.lamps.slice(0, LAMP_CAP).map((l) =>
    `${l.n}: ${l.kind} ${l.flux} ${l.unit}${l.kelvin ? " " + l.kelvin + " K" : ""} at ${at(l.p)}`
    + (l.totalDeg ? `, ${Math.round(l.totalDeg)} deg cone` : ""));
  out.push(`lamps: ${s.lamps.length}` + (lamps.length ? " -- " + lamps.join("; ") : "")
    + (s.lamps.length > LAMP_CAP ? `; +${s.lamps.length - LAMP_CAP} more` : ""));

  const prims = s.surfaces.slice(0, SURFACE_CAP).map((p) =>
    `${p.n}: ${p.kind} at ${at(p.c)}${p.albedo === undefined ? "" : ", albedo " + p.albedo}`);
  out.push(`surfaces: ${s.surfaces.length}` + (prims.length ? " -- " + prims.join("; ") : "")
    + (s.surfaces.length > SURFACE_CAP ? `; +${s.surfaces.length - SURFACE_CAP} more` : ""));

  out.push("selected: " + (s.selection
    ? `${s.selection.kind === "light" ? "lamp" : "surface"} ${s.selection.index + 1}` : "nothing"));

  if (s.stats) {
    out.push(`readout: ${s.stats.min} min, ${s.stats.mean} mean, ${s.stats.max} max `
      + `${s.photometric ? "lx" : "W/m2"}, U0 ${s.stats.u0}, over the ${s.stats.over}`
      + (s.stats.dark ? `, ${s.stats.dark} of ${s.stats.points} points dark` : "")
      + (s.stats.settled ? "" : ", still settling"));
  } else {
    out.push("readout: nothing measured yet");
  }

  const text = out.join("\n");
  return "<state>\n" + (text.length > STATE_CAP ? text.slice(0, STATE_CAP - 1) + "\u2026" : text) + "\n</state>";
}

export const TERMS = (() => {
  /* The DISTINCTIVE vocabulary, not every word. Built from the document with
     the same common words the retriever ignores taken out: "what", "does" and
     "the" appear all over a page of prose about a tool, and a gate that counts
     them admits anything at all. */
  const common = new Set(ENGLISH.split(/\s+/));
  /* The role is instructions TO the model, not subject matter about the tool,
     so it must not vote on what counts as on topic. It says "write nothing
     after the closing tag", and that one word was enough to let "write me a
     poem" through as a question about a linkage. */
  const subject = KNOWLEDGE.replace(/<role>[\s\S]*?<\/role>/i, "");
  return new Set(subject.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/)
    .filter((w) => w.length >= 3 && !common.has(w)));
})();
