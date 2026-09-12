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

import { makeRetriever, CHEVRON } from "../chat/retrieve.js?v=82f4d047";

export const VOCABULARY = [
  "load the depth rail",
  "fit the achromat",
  "use the singlet",
  "use the ideal lens",
  "set the focal length to <focal> mm",
  "open up to f/<fno>",
  "stop down to f/<fno>",
  "I want more depth of field",
  "make the depth of field shallower",
  "focus at <metres> m",
  "focus at infinity",
  "focus closer",
  "focus further away",
  "zoom in",
  "zoom out",
  "make the sensor <sensor> mm",
  "full frame",
  "render at <pixels> px",
  "set the exposure to <exposure>",
  "make it brighter",
  "make it darker",
  "switch to the sky",
  "switch to the lamps",
  "set the lamp to <lumens> lumens",
  "make the lamp <kelvin> K",
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
Every number you mention must come from <state>, carrying the name <state> gives
it: a number and its label travel together. The field of view is in degrees and
the entrance pupil is in millimetres, and neither is the other. If a number is
not in <state>, say you cannot see it. Never invent a reading, a distance or a
lens.
Be brief: two or three sentences, and never two paragraphs. Answer the question
asked and stop -- do not restate it, do not summarise yourself, and do not add a
second explanation of the same thing.
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
- Three lens designs, all selectable, all 100 mm, and what separates them is
  COLOUR -- where blue light and red light come to a focus relative to each
  other:
    IDEAL, dispersionless: blue and red focus in exactly the same place. It is
      ideal in COLOUR and in its first-order numbers, not in its rays -- a
      single spherical surface still has spherical aberration, and at f/5 it
      has slightly more of it than the achromat does.
    SINGLET, one uncorrected N-BK7 element: their focal lengths differ by about
      1.5 %. It is meant to fringe; that is what it is here for.
    ACHROMAT, a Fraunhofer N-BK7 and F2 cemented doublet: two glasses paired so
      that difference nearly cancels, down to about 0.06 %.
  Because they share a focal length they frame identically, so what changes
  between them is fidelity and nothing else.
- Focal length from 12 to 400 mm, and the design is rescaled to it exactly.
- Aperture from f/1 to f/45, limited by the glass: a design whose front element
  is too small simply cannot open that wide, and it reports the f-number it
  actually passes rather than the one asked for.
- Focus from 0.15 m to 1000 m, or infinity. Focusing moves the film, not the
  glass, so the camera does not walk while racking.
- Sensor width from 4 to 80 mm at 3:2, a render grid from 64 to 640 px, and an
  exposure that is a viewing gain applied after the fact.
- One scene, the depth rail: five coloured targets at 1, 1.5, 2, 3 and 5 m,
  arranged as a ring about the optical axis so all five sit the same distance
  off it. Two sizings
  -- all the same size ON FILM, or all the same size IN METRES, which is the one
  that shows perspective.
- Two lighting modes: the placed rectangular key lamp, or a uniform overhead
  sky. A choice, not a blend. The sky lights the scene but is not photographed,
  so the background is black in both modes and switching between them changes
  the lighting and nothing else.
- The scene view draws the camera, the cone it sees, the focus plane, and the
  depth of field as a box around it labelled NEAR and FAR, all at their true
  distances. The box is left OPEN at an end that has no limit -- past the
  hyperfocal distance there is no far face, because there is no far limit.
- Derived readouts: focal length, field of view, entrance pupil, T-stop, back
  focus, film position, chromatic error, blur at 6 m, image circle, the on-axis
  sharp limits, the hyperfocal distance, and the line pairs per millimetre the
  sharpness criterion works out to.
</capabilities>`;

const CONTROLS =
`<controls>
What each control does, and what changes on screen when it moves.
- DESIGN: which lens is mounted. Changes the aberration, not the framing -- all
  three are 100 mm, so what differs is how faithfully the image is formed.
- FOCAL: rescales the whole prescription. Longer is a narrower field and a
  bigger subject. The f-number and the aberration character do not change.
- APERTURE: does two things at once, always both. Opening up (a smaller
  f-number) lets in more light AND makes the depth of field shallower. This is
  where brightness comes from here, which is why exposure is not a substitute.
- FOCUS: the distance the film is set for. What sits there is sharp; everything
  else blurs by how far it is from it.
- TARGET SIZE: how big the five rail targets really are. SAME IN METRES gives
  them all a 30 mm radius, so the near one images about five times the diameter
  of the far one -- ordinary 1/distance perspective, and the default. SAME ON
  FILM scales each target's radius with its distance so all five land the same
  size on the sensor, which isolates focus as the only difference between them
  but makes the picture look flat, like an orthographic or telecentric
  projection. It is a property of the SCENE, not of the lens.
- SENSOR WIDTH: the film format. Wider sees more at the same focal length, and
  demands a bigger image circle from the lens.
- RENDER: how many pixels wide the photograph is computed at. Quality and speed;
  the field of view does not change with it.
- EXPOSURE: a viewing gain applied when the measurements become pixels. Instant,
  because it traces no ray. It is a darkroom control rather than a camera one:
  a photographer would change brightness with the aperture.
- CIRCLE OF CONFUSION: the DIAMETER of the biggest blur spot that still counts
  as sharp, in millimetres on the film. Sharpness is not a property a lens has
  -- a point images as a small disc, and "in focus" means nothing until you say
  how big a disc you will accept. This is that number, and it is what the
  depth-of-field box, the AXIS SHARP limits, the hyperfocal distance and the
  SHARP marking on each target are all measured against. It moves those and
  nothing about the photograph: no ray is re-traced, so a half-converged render
  keeps converging.
  It was labelled SHARP IF until recently; both names mean this control.
  IT IS NOT MTF. A modulation transfer function is contrast measured against
  spatial frequency, and nothing in this program computes one. What connects the
  two is a rule of thumb: a blur circle of diameter c destroys detail finer than
  roughly 1/c line pairs per millimetre, so 0.030 mm is about 33 lp/mm and the
  range 0.002 to 0.2 mm spans 500 down to 5 lp/mm. The RESOLVING readout is that
  reciprocal. Say plainly that it is a geometric cutoff standing in for a curve
  that would really roll off gradually, and never claim the page draws MTF.
- LIGHTING: the placed key lamp or a uniform sky, and each mode shows its own
  source's two controls. LAMP and LAMP COLOUR set the panel's flux in lumens
  and its colour temperature; AMBIENT and SKY COLOUR do the same for the dome
  in lux. Only the pair belonging to the source in use is on screen.
</controls>`;

const READOUTS =
`<readouts>
What the derived numbers mean. Every one is measured from the mounted lens.
- FOCAL: the focal length the built lens actually has.
- H FIELD: degrees across the frame.
- PUPIL: entrance pupil diameter -- the aperture seen from in front, through the
  glass ahead of it. Focal length over it is the f-number.
- T-STOP: the f-stop corrected for the light the glass really transmits. Every
  surface here is uncoated, so each one REFLECTS a few percent away and less
  light arrives than the geometry promises. A T-stop is therefore always a
  slower number than the f-stop it comes from.
- BACK FOCUS: where the film sits at infinity. FILM AT: where it sits now.
- COLOUR ERR: chromatic aberration as a percentage of focal length -- how far
  apart blue and red focus. Singlet about -1.5 %, achromat about -0.06 %.
- BLUR AT 6 M: the defocus blur a subject at 6 m makes on the film, in mm.
  Compare it against CIRCLE OF CONFUSION.
- COVERS: the image circle the design throws, against the diagonal the sensor
  needs. First smaller than second means the corners are outside what it covers.
- AXIS SHARP FROM/TO: the near and far limits of sharpness on the axis, from
  defocus alone. Off the axis they can be badly optimistic -- see
  <preconditions>. The per-target SPOT beside each target in the scene view is
  the honest figure.
- AXIS HYPERFOCAL: focus there and everything from about half of it out is
  sharp.
- RESOLVING: the CIRCLE OF CONFUSION said as a spatial frequency, 1/c line pairs
  per millimetre -- 0.030 mm is about 33 lp/mm. A geometric rule of thumb for
  comparing against the cycles/mm a lens is usually quoted at, NOT a modulation
  transfer function; see CIRCLE OF CONFUSION in <controls>.
- SAMPLES: rays per pixel traced so far. Still refining until it stops climbing.
</readouts>`;

const PRECONDITIONS =
`<preconditions>
- The scene is FIXED. Nothing in it can be added, moved, deleted or recoloured.
  The camera is what changes; the scene never does.
- The aperture is limited by the glass. The shipped 100 mm achromat has a 20 mm
  front element, so it is wide open at about f/5 and asking for f/2.8 gives f/5
  with the pupil that really exists.
- Focus must be outside the front focal point. Asking to focus closer than that
  cannot be done and is refused rather than approximated.
- Exposure is a VIEWING GAIN, applied when the measurements become pixels. It
  never re-traces a ray and it is not a photographic control; brightness in this
  program comes from the aperture. Switching to the sky puts more light on the
  subjects than the key lamp it replaces, so it may clip until the exposure
  comes down -- but the background is black either way, so the exposure is
  comparable between the two in a way it was not when the sky was visible.
- The image refines progressively. It is grainy for the first second and keeps
  improving for as long as it is left alone, so a reading taken immediately
  after a change is provisional.
- FOCUSING AT A TARGET MAKES THAT TARGET THE SHARPEST. All five sit at the same
  angular radius from the optical axis -- a ring, at five clock positions -- so
  they share their field aberration exactly and it cancels out of any comparison
  between them. Set the focus to 3 m and the 3 m target is the sharpest thing in
  frame; set it to 5 m and the 5 m one is. That is the whole point of the scene.
- There are still TWO sharpness figures, and they answer different questions.
  The depth-of-field slab (AXIS SHARP FROM/TO) is paraxial, ON AXIS, and from
  defocus alone. The per-target SPOT is the real ray traced through the real
  glass at that target's real field position, and it is the one the rendered
  image agrees with. Quote the SPOT when asked what looks sharp.
  They no longer disagree about WHICH target, but the slab can still promise a
  sharpness the glass cannot deliver: at 100 mm and f/8 focused at 2 m the box
  runs 1.91 m to 2.10 m at a 0.030 mm criterion, while the traced spot at the
  2 m target -- zero defocus, dead in the middle of that box -- is 0.046 mm. The
  lens is aberration limited there; the slab counts defocus only. So a target
  inside the box is not automatically sharp, and the SPOT beside it is what says
  whether it is.
  The scene view marks the sharpest target SHARPEST whether or not it met the
  criterion, and labels the focus plane FILM SET FOR rather than FOCUS, because
  that plane is where the film is placed and is not a claim about what the lens
  resolves there.
- The shipped achromat leaves about 0.032 mm of spherical aberration on axis
  wide open, which is just over the 0.030 mm the sharpness criterion asks for.
  So at the default settings nothing formally qualifies as sharp, and one third
  of a stop down it does. That is the lens being aberration limited at f/5, not
  a fault.
- THIS IS AN ORDINARY PERSPECTIVE CAMERA, and under SAME ON FILM it does not
  look like one. A fixed 24 mm sphere images 47.4 px across at 1 m and 8.7 px
  at 5 m at the default settings: f/(distance - f) and nothing else. Under SAME ON FILM every
  target images the same size because the SCENE scales their radii with their
  distance, not because the lens is telecentric. It is not telecentric, and
  there is no telecentric mode. Offer SAME IN METRES to anyone who says the
  image has no perspective in it.
- Parallel rays entering a lens in a cross-section diagram mean the OBJECT IS AT
  INFINITY, which is the standard way such a diagram is drawn. They are not a
  sign of telecentricity, and a telephoto lens drawn with the same object at
  infinity has exactly the same parallel input rays. What varies with the lens
  in that picture is where the rays cross the axis and by how much they miss.
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
- No MTF. There is no modulation transfer function, no contrast-against-spatial-
  frequency curve and no MTF50 figure, for this lens or any other. The CIRCLE OF
  CONFUSION control and the RESOLVING readout are a geometric blur diameter and
  its reciprocal, which is a rule of thumb standing in for a curve, not the
  curve. Say so rather than describing a plot the page cannot draw.
- No diffraction of any kind, so there is no diffraction limit, no Airy disc, no
  softening on stopping right down, and no starburst or sunstar on a bright
  point. Blur here is geometric only: it is where rays land, never how they
  interfere.
- No iris blades. The aperture is a circle at every setting, so there is no
  blade count, no blade curve and no aperture-shaped bokeh. A real iris is a
  ring of overlapping leaves and its polygon is what shapes a defocused
  highlight; that is a real effect and this does not have it.
- No polarisation, no fluorescence and no participating media.
- No undo, and no way to save the rendered image out.
</limits>`;

const NUMBERS =
`<numbers>
- The camera stands at the origin looking down the axis; every distance is from
  there, in metres.
- It starts as the achromat at 100 mm, f/5, focused at 2 m, with a 36 mm sensor,
  320 px wide and an exposure of 100.
- The depth rail's targets sit at 1, 1.5, 2, 3 and 5 m, and are coloured red,
  amber, green, cyan and violet in that order -- so the green one is at 2 m, and
  a target can be named by its colour. They are arranged as a RING about the
  optical axis, five clock positions at one angular radius, so all five carry
  the same field aberration and it cancels out of any comparison between them.
  Their SIZES are what TARGET SIZE chooses: 24 mm radius each under SAME IN
  METRES, or a radius scaling with distance under SAME ON FILM. All five reflect
  the same 0.48 of the light falling on them. Hue is the ONLY thing that differs between
  them apart from focus: they are equally bright on purpose, because the eye
  reads brightness as sharpness and a darker target would look defocused for the
  wrong reason.
- The key lamp is a 1 m square panel at (1.6, 1.8, -1.4) facing down, and
  starts at 20800 lumens and 5500 K. Both are adjustable: 0 to 1e7 lumens, and
  1200 to 20000 K. The sky defaults to 2000 lx at 6500 K, a bright overcast
  day.
- Sharpness is judged against a 0.030 mm circle of confusion, the number every
  depth-of-field table has used for a century on a 36 mm frame -- roughly the
  sensor diagonal over 1500, and about 33 line pairs per millimetre.
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
  surface, or the stop, is dead. There is no darkening factor applied to the
  corners anywhere in the program, so a dark corner means rays aimed at it hit
  the edge of real glass.
- The f-number is set from the ENTRANCE pupil, which is the image of the stop
  formed by the glass in front of it, not from focal length over diameter
  directly. Ignoring that magnification is wrong by 10 to 20 % on a real design.
- The circle of confusion is computed from the EXIT pupil and the real film
  position, not from the textbook thin-lens expression, which assumes both
  pupils are the same size.
- The wavelength is drawn in proportion to the CIE observer's response, so no
  ray is spent on a wavelength the film cannot see.
</how>`;

const PROCEDURE =
`<procedure>
The scene is fixed. You set the camera and nothing else: you cannot add, move or
delete anything, and there is no other arrangement to switch to.
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
  [HEAD, ROLE, CAPABILITIES, CONTROLS, READOUTS, PRECONDITIONS, LIMITS, NUMBERS, HOW].join("\n");

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
    /* No bare "why": it is in a third of all questions, and forcing a section
       bypasses the byte budget by design, so one loose word here drags a whole
       paragraph into every prompt. */
    [/\b(clip\w*|blown|too bright|too dark|grain\w*|noisy|provisional|refus\w*|cannot|can.?t|won.?t|wide open|corner|corners|dark corner|soft)\b/i, "preconditions"],
    /* "circle of confusion" and "coc" used to force <numbers> as well as
       <controls>, which put the worst prompt on this page at 1562 tokens for a
       one-line question. <controls> now carries the whole answer -- the
       definition, the 0.030 mm default and the lp/mm equivalence -- so the
       second section was paying for a repetition. */
    [/\b(default|defaults|how (?:big|far|many|much)|distance|distances|metre|meters?|metres?|millimet\w*|hyperfocal|chromatic|abbe|lumens?|kelvin|lux)\b/i, "numbers"],
    /* "Why is the corner dark" is answered in <how> -- vignetting is geometric
       and a dark corner means rays aimed at it hit the edge of real glass.
       Without the corner words here it pulled <preconditions>, which mentions
       the image circle but never says what makes a corner go dark, and the
       model filled the gap from the state block and got the wrong number. */
    [/\b(wavelength|spectral|dispersion|sellmeier|vignett\w*|pupil|entrance pupil|exit pupil|stop|area|estimator|sampling|how does it|why does|corner|corners|falloff|fall.?off|darker at the edge)\b/i, "how"],
    [/\b(what can|capabilit\w*|features?|able to|support|supports|do here|possible|designs?|achromat|singlet)\b/i, "capabilities"],
    /* "What does X do" is the commonest question a control invites, and until
       <controls> existed the answer came back as whatever section happened to
       mention X -- for the aperture, the paragraph explaining why it will not
       open past f/5, which is a different question. */
    [/\b(?:what|which|how)\b[^.]{0,24}\b(?:does|do|is|are)\b[^.]{0,24}\b(?:aperture|f.?number|f.?stop|focal|focus|sensor|render|resolution|exposure|sharp if|circle of confusion|coc|lighting|design|control|slider|setting)\b/i, "controls"],
    [/\b(t.?stop|entrance pupil|exit pupil|back focus|film at|colour err|color err|image circle|covers|hyperfocal|blur at|h field|field of view|derived|read ?out|read ?outs|samples)\b/i, "readouts"],
    /* THE QUESTION THAT BUILT THIS ROW. "Is this MTF?" retrieved neither the
       section defining the criterion nor the one defining the readout, so the
       model would have answered a question about this program from general
       optics -- and the likeliest general answer, that a sharpness number is an
       MTF figure, is exactly the thing that is not true here.

       Sent to <controls> rather than to <readouts> because the CIRCLE OF
       CONFUSION entry carries the whole answer: what the number is, the 1/c
       relationship, the numbers it works out to, and the plain statement that
       nothing here computes a transfer function. One section, not two. */
    [/\b(mtf|modulation transfer|line ?pairs?|lp.?mm|cycles.?(?:per.?)?mm|spatial frequency|resolving power)\b/i, "controls"],
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
  /* Only the source that is actually lighting the scene, so the model cannot
     quote the other one's numbers at a visitor -- and only when the numbers are
     actually there. A snapshot is assembled by hand in more than one place, and
     a missing field must go quiet rather than print the word "undefined" into
     the prompt, where the model will read it as a value and repeat it. */
  const sky = /ambient/i.test(String(s.lighting));
  const lit = sky
    ? (s.ambientLux != null && s.ambientCctK != null ? `, sky ${s.ambientLux} lx at ${s.ambientCctK} K` : "")
    : (s.lampLm != null && s.lampCctK != null ? `, lamp ${s.lampLm} lm at ${s.lampCctK} K` : "");
  out.push(`scene: ${s.scene}${s.sizing ? `, targets ${s.sizing}` : ""}`
    + `; lighting: ${s.lighting}${lit}`);
  out.push(`lens: ${s.design}, ${n2(s.focalMm)} mm at f/${n2(s.fno)}`
    + `, focused at ${n2(s.focusM)} m`
    );
  out.push(`sensor: ${n2(s.sensorWMm)} mm wide, rendering ${s.resW} px`
    + `, exposure x${n2(s.exposure)}, sharp within ${s.cocLimitMm} mm`);

  if (s.derived) {
    const d = s.derived;
    /* Units spelled out on every one of these. "20.41 deg across" sat two lines
       above "covers 20.07 mm", and the model answered a question about the
       image circle with the field of view -- two plausible numbers a decimal
       apart, one of which was not a length at all. */
    out.push(`measured: focal length ${n2(d.eflMm)} mm`
      + `, field of view ${n2(d.hfovDeg)} degrees`
      + `, entrance pupil ${n2(d.pupilMm)} mm, T/${n2(d.tstop)}`
      + `, colour error ${n2(d.colourErrPct)} %`);
    out.push(`sharp on axis: ${n2(d.nearM)} m to ${n2(d.farM)} m`
      + `; hyperfocal ${n2(d.hyperfocalM)} m`
      + `; image circle ${n2(d.coversMm)} mm against the ${n2(d.coveredMm)} mm diagonal `
      + `the sensor needs`);
  } else {
    out.push("measured: the lens has not been built yet");
  }
  out.push(`render: ${s.spp ? `${Math.round(s.spp)} samples a pixel so far` : "not started"}`);
  if (s.targets && s.targets.length) {
    out.push("targets, with the spot each really makes on the film: " + s.targets
      .map((t) => `${t.label}${t.colour ? ` the ${t.colour} one` : ""} at ${t.depthM} m`
        + `${Number.isFinite(t.spotMm) ? `, spot ${n2(t.spotMm)} mm` : ""}`
        + `${t.sharp ? " (within the sharpness limit)" : ""}`)
      .join("; "));
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
