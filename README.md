# mhsghali.github.io

My personal site. Plain static files — no framework, no bundler, no build step
beyond one Python script that stamps the shared nav and footer into each page.

```
index.html            the whole single-page site
pages/linkage.html    the linkage simulator
pages/light.html      the light simulator
pages/optics.html     the optics simulator
pages/chat.html       the assistant, on its own
css/main.css          design system and every component
js/app.js             theme toggle, mobile nav, scroll reveal
js/hero-walkers.js    the homepage background, driven by the real solver
js/walker/            Jansen's leg, and the camera that keeps it framed
js/linkage/           the mechanism engine and the tool's UI
js/light/             the spectral light engine, its worker and the tool's UI
js/optics/            the lens, the camera and the renderer behind the optics page
js/chat/              the in-browser model, the command grammar and the panel
sw.js                 the service worker that keeps the model resident
partials/             nav and footer, stamped into pages by the build script
scripts/build-site.py stamps the partials and versions every asset URL
js/*/knowledge.js     what the assistant knows about each simulator
js/linkage/generate.js  four-, six- and eight-bar linkages built to order
tests/                the engines' regression tests, the hero's camera framing,
                      the assistant's grammar and gate, and what keeps its
                      prompts from drifting out of step with the code
```

## The linkage simulator

`pages/linkage.html` is a browser port of
[Linkage-Design](https://github.com/MHSGhali/Linkage-Design), my desktop
mechanism editor in C. Build a planar mechanism out of joints, anchors and
rigid bodies and sliders, drive one link with a motor, run it, watch it in 3D,
and export it either as an animated Blender script or as printable STL parts.

The engine — `js/linkage/mechanism.js`, `solver.js`, `linalg.js`, `blender.js`,
`mesh3d.js`, `print3d.js` — is a hand port of the C original's headless core. The SDL front end is not
ported; `editor.js` and `view3d.js` replace it. The port reproduces the C
implementation's results to the last decimal place, including on a chaotic
double pendulum where any divergence would amplify.

## The light simulator

`pages/light.html` is a browser port of
[Light-Simulation](https://github.com/MHSGhali/Light-Simulation), my spectral
ray tracer in C. Place lamps and parts and read the illuminance on every
surface, in lux or W/m², with real shadows and interreflection.

Radiance is carried as 95 bins over 360–830 nm and photometry is an exact
integral against the CIE 1931 observer, so switching units re-projects one
stored measurement rather than applying a correction factor. Direct light
solves in about 15 ms; interreflection accumulates progressively in a Web
Worker. Scenes use the CLI's own format, so one downloaded here runs there
unchanged.

The port reproduces the C's spectral and colorimetric output to all 18
significant digits and its 4096-point workcell field to within float32
round-off. PCG32 is ported exactly, so the two draw the same random stream and
Monte Carlo results can be compared as numbers rather than as averages.

### The two exports

The Blender script writes an ANIMATION: one cylinder per link edge and one
empty per joint, keyframed through a cycle. The STL export writes OBJECTS —
`mesh3d.js` and `print3d.js`, ported from the C's files of the same names.
Link plates, slider rails, headed pins, caps, spacers and a baseplate, with
bodies that share a pin put on separate layers and any gap on a pin packed out
with a washer. Every solid is checked watertight before it is written; one that
fails is left out and said so in the manifest rather than handed to a slicer.

A browser cannot hand over a folder, so the parts arrive as one zip with the
names the C writes into a directory. `zip.js` is a stored-entry writer: STL
compresses poorly and stored entries need no compressor, which keeps the format
small enough to be obviously correct rather than a dependency.

The C also prints gears, racks, cams and Geneva wheels. This engine has pin
joints and sliders only, so those emitters have no counterpart here rather than
a broken one.


## The optics simulator

`pages/optics.html` is a browser port of
[Optics-Simulation](https://github.com/MHSGhali/Optics-Simulation), my
physically-based camera simulator in C. The scene view shows where everything
is — the camera, the cone it sees, the plane it is focused on and the slab
either side of it that counts as sharp. The image view under it shows what the
camera recorded.

Light is traced through a real multi-element lens prescription, surface by
surface, with a refractive index taken from the Sellmeier coefficients of the
actual catalogue glass. Spherical aberration, coma, astigmatism, field
curvature, chromatic aberration, vignetting and distortion are not effects that
get applied — they are what happens when you trace real glass. A ray that misses a clear aperture is dead, and that is the *only*
source of vignetting: there is no darkening factor on the corners anywhere in
the code.

### The rail: a ring, and where its perspective went

The one scene is five coloured targets at 1, 1.5, 2, 3 and 5 m, set out as a
**ring** about the optical axis — five clock positions at the same angular
radius — rather than as a row across the frame.

That is not decoration. Depth of field is an on-axis, defocus-only idea, while
every other aberration grows with how far off the axis the subject sits: coma
roughly with the field angle, astigmatism and field curvature with its square.
The first version of this scene spread the targets along a row so they would not
occlude, which put the outer two at 59 % of a full-frame half-diagonal — and
there the achromat's coma simply beat the defocus. Focused at 5 m, at 100 mm and
f/5, the 5 m target measured 0.44 mm and the 3 m target 0.11 mm. Both numbers
were right, and setting the focus to 5 m did not make the 5 m target sharp. Move
that same target on to the axis and it measures 0.023 mm.

At equal field radius the field aberration is identical for all five and cancels
out of every comparison between them, so **focusing at a target is what makes
that target the sharpest** — which is the only thing this scene was ever for.
Across 300 combinations of design, focal length, aperture and focus distance the
focused target is now within 15 % of the sharpest in 261 of them, against 210 for
the row, and the worst disagreement falls from 10.8× to 3.2×.

**Target size** decides how big the targets really are. *Same in metres* gives
all five a 24 mm radius, so the near one images about five times the diameter of
the far one — ordinary f/(distance − f) perspective, and the default. *Same on
film* scales each radius with its distance so every target lands the same size on
the sensor, which is the better controlled comparison of blur at equal size.

*Same on film* was the original and the only mode, and it was a mistake to ship
alone: a frame whose objects all image the same size looks orthographic, which
is what a **telecentric** lens produces, and the page was read as being one. It
is not. The camera is an ordinary perspective camera and *same in metres* is the
proof. Related: parallel rays entering a lens in a cross-section diagram mean the
object is at infinity, which is simply how such diagrams are drawn — not a sign
of telecentricity, and a telephoto lens drawn the same way looks the same.

### What it shares, and what is new

The C vendors the same `lightsim` core that Light-Simulation does, and that core
is already here in JavaScript — so `js/optics/` imports `js/light/` for spectra,
CIE colour, BSDFs, geometry, lights, scene traversal and PCG32 rather than
carrying a second copy. The engine underneath this page is the one already
checked against the C to eighteen significant digits.

What is new is the lens: `glass.js`, `prescription.js`, `lens.js` (the paraxial
y-nu analysis, the entrance and exit pupils, and the sequential ray
trace), `pupil.js`, `spectral.js`, `camera.js`, `trace.js`, `scenedesc.js`,
`film.js` and `render.js`.

### One wavelength per ray, and why

`js/light/` may carry all 95 bins down one path because every *scene* material
is non-dispersive. The lens is not, so ray *generation* became wavelength
dependent: two rays leaving the rear element from the same sensor point at
450 nm and 650 nm are different rays, going to different places in the world.
Carrying a whole spectrum down one of them would average the scene over
wavelengths that never travelled there, which is exactly how a simulator erases
the chromatic aberration it was built to show. So each camera ray carries one
wavelength and deposits into one bin.

Two deliberate departures from the C, both in `js/optics/`, both commented where
they are:

- **The wavelength is importance-sampled against the CIE observer** rather than
  drawn uniformly over the band. Uniform draws spend an eighth of every render
  on bins the film cannot see at all, and spread the rest over a response that
  varies threefold. Drawing proportional to x̄+ȳ+z̄ and dividing by that same
  probability is unbiased and cuts the variance by about 3.6×. The C's own
  `inv_pdf` field exists for this; it just had no sensor response to use yet.
- **The film accumulates XYZ, not 95 bins.** X, Y and Z are linear functionals
  of the spectrum, so depositing `cmf[bin] × step` per sample gives the same
  numbers as accumulating the spectrum and projecting its mean — exactly, not
  approximately, and in three doubles per pixel instead of ninety-five. The C
  keeps the full spectrum because it writes PFM files; this page has no PFM.

The `IDEAL` design also gains a 20 mm air gap the C does not have. Its two
surfaces sit at the same z there, which a *sequential* tracer visits in
prescription order rather than hit order — so every reverse ray flew past the
sphere, hit the plano behind it, and missed the sphere on the way out. It never
mattered in C, where that design is only ever used for paraxial arithmetic. A
plano surface has zero power at any thickness, so the focal length is still
exactly 100.000000000 mm at every wavelength.

### What this page does not do

The desktop tool lets you arrange the scene, draws the lens in cross-section
with its ray fans, and has undo. This page fixes the scene and gives you the
camera: the lens design, focal length, aperture, focus, sensor, exposure
and sharpness criterion, plus the choice between the placed area lamp and a
uniform overhead sky and that source's own brightness and colour. Sampling is not a control — how many rays it takes to
answer is the program's problem, not the visitor's.

The assistant panel drives all of it without the model; see below.

## The assistant

`pages/chat.html` runs a small quantized language model inside the visitor's own
browser: the weights stream from a CDN once, compile to WebGPU shaders, and
execute on their GPU. There is no server, no API key and no request to anything
of mine. It answers questions about my background, and on the three simulator
pages the same panel drives the tools.

On the simulator pages it reaches **every control those tools have**, and a few
they do not: you can build a mechanism from an empty canvas without touching the
mouse ("start from scratch", "place a joint at -60, 0", "select all", "link
them", "anchor it", "select link 1", "put a motor on it", "run it"), or pick a
lamp out of a light scene and set its flux, colour temperature, cone and
position by name. The canvas numbers nothing, so the panel reads the joints and
the lamps out with numbers, and those numbers are what it takes back.

On the optics page the scene is fixed, so there is nothing to build and the
whole vocabulary is the camera: "stop down to f/16", "open it up", "focus at
5 metres", "use the singlet", "zoom in", "switch to the sky". It answers
with the numbers the lens actually produced rather than the ones that were
asked for — request f/2.8 on a design that is wide open at f/5 and it says so,
with the entrance pupil that really exists.

Two things it does without the model at all, because neither is a matter of
judgement. **A starter can be asked for by what it does**: "create a mechanism
that draws a straight line" is the Hoeken, "something that lifts a platform
straight up" is the scissor lift, "simple harmonic motion" is the Scotch yoke.
Each already traces the point that shows its motion, so running it draws the
answer. And **a linkage of a named size is generated**, not planned: "build me a
six bar linkage with a motor on link 3" produces one that turns.

`js/linkage/generate.js` is a Grashof four-bar with dyads hung off its coupler.
The part worth explaining is why the dyad lengths are what they are. A dyad
added at a guess jams: its coupler point swings through a range of distances
from the new anchor over a revolution, and any pair of lengths that cannot span
that whole range binds partway round. So the coupler point's path is swept
first, its nearest and furthest approach measured, and both dyad links set to
0.62 of the furthest. Equal lengths can always fold to reach anything nearer,
and twice 0.62 leaves a quarter again of slack at full stretch. A test runs
every size through a full revolution against the real solver and checks the
mobility comes out at one, which is the only check here that means anything.

Each simulator carries its own **knowledge document** — `js/linkage/knowledge.js`,
`js/light/knowledge.js` and `js/optics/knowledge.js` — an XML-tagged file holding what the tool can do,
what it cannot, and the rules it enforces, with the live state of the tool
injected as a `<state>` block on every turn. One document serves the planner,
the help text and prose answers, so those three can no longer drift apart, and
the assistant can be honest in both directions:

> **why won't the motor go on?**
> Both ends of that link are anchored, and a motor needs exactly one anchored
> joint to turn about. Free one end and it will go on.  ▸ *unanchor joint 2*

> **can it do gears?**
> No. This tool only has pin joints and sliders; it cannot make gears, racks,
> cams or Geneva wheels.

Getting there needed a fix that was invisible until it was measured: **the topic
gate was refusing the questions the feature exists to answer.** `classify()`
builds its vocabulary from the résumé, and a résumé has never heard the words
*gears*, *cams*, *friction* or *refraction* — so five of seven diagnosis
questions, including that first one, were turned away as off-topic before the
model ever saw them. The gate now takes the domain and unions in that
simulator's own vocabulary, which falls out of the design: the `<limits>`
section names exactly the things people ask for and cannot have, so the document
that answers the question is also what lets the question through.

Only one body of knowledge is ever sent. On a simulator page a question about
the tool gets the tool's document and its state; a question that names Mark gets
the résumé. Beside a simulator, *you* means the assistant and *he* means Mark,
so "what can you do" is a question about the editor. A tool answer comes out at
about 3,400 characters against the résumé's 6,600 — the cheaper path, not the
more expensive one, which matters because WebLLM prefills the whole system
prompt on every single message.

A refusal that knows the remedy offers it as a button. Three gates stand between
a suggestion and the simulator: it is authored by the controller from live state
(or by the model inside `<try>` tags), it is only rendered if the grammar parses
it, and tapping it goes through `ask()` so every precondition is re-checked at
the moment it runs. That last one is what makes a stale chip harmless — it
produces the same helpful refusal again rather than doing the wrong thing. The
chips are never restored from the transcript, because a chip from another page's
conversation would be a live wrong button.

It is deliberately built so that **the model never presses a button**. Every
message is triaged in this order:

1. **Is it a build?** "Build me a crank that spins" names an outcome and no
   steps, which is the one thing a grammar cannot express, so the model writes
   a plan (`js/chat/plan.js`) in the same words a visitor would type. Every line
   goes back through the grammar and a line that does not parse is dropped, so
   a model can propose anything and still cannot invent an action.
2. **Is it a command?** `js/chat/commands.js` matches a closed grammar. The
   message is cut into clauses first, so "place a joint at 0 0, then one at
   60 0, then link them" is three steps in the order they were said. This costs
   nothing and works before the model has downloaded at all.
3. **Is it on topic?** `classify()` in `js/chat/profile.js` refuses anything
   unrelated. A 2B model will answer "who wrote Don Quixote" confidently and
   wrongly, under my name, so that question never reaches the GPU.
4. Only then is prose generated.

That split is the whole design. A wrong sentence about a resume is a wrong
sentence; a wrong tool call reaches into the simulator and changes what the
visitor is looking at, so actions are held to a grammar and answers are not.
`tests/chat.test.mjs` pins both directions of it: that "the scissor lift please"
loads, and that "what is a Scotch yoke" does not.

The planner's instructions go in a **system** message and the visitor's request
in a **user** message. That is not decoration: a small instruct model weights
the two slots differently and drifts into conversation when the rules arrive as
conversation, and putting a stranger's sentence inside the instruction block
makes "ignore the above" indistinguishable from the rules around it.
Instructions in one turn, data in the other.

The planner's hard-won rule is that **a plan is a prefix, not a scattering**.
Asked for something past its depth, a 2B model writes a few good lines and then
starts thinking out loud, and its commentary quotes the very commands it is
reasoning about: `then "link them". This implies anchor is done on one of the
selected` parses as a perfectly good link. Reading commands out of the middle of
prose built a mess of three joints and no motor. So the plan ends at the first
line that is not a command, and lines are rejected as prose before they are
parsed at all. It is also why the summary reports the state the tool ended in
rather than what the last step said: on a plan that half worked, the honest
answer is "3 joints and 2 links, no motor", not "Anchored."

The exception to that rule is a line of commands run together with the newlines
missing, which is what a 2B model produces as it tires: `select link 1 anchor it
select link 2 put a motor on it run it`. That is rejected on length like any
long line, and it was costing the motor off the end of otherwise correct builds.
So a long line with no prose marker in it is split at command boundaries, all or
nothing: every piece must parse, which is what keeps this from being the
scavenging it replaced.

What none of this fixes is the model's grasp of mechanisms, and it should not
pretend to. Asked for "a crank that spins" it builds one; asked for "three bars"
it may close them into a triangle, which is rigid and cannot move, and the tool
then refuses the motor and says so. The plan is shown before it runs and the end
state is reported honestly, so a bad plan is visible rather than silent. When it
matters, the deterministic path is right there: "build me a four bar" loads the
starter in a second, with no model involved at all.

The window is 4096 tokens and the profile is about 3200, so sending all of it
would leave no room for the conversation and would make every answer slower
(WebLLM keeps no prefix cache: the system prompt is prefilled on every message).
`selectContext()` cuts the profile on its own headings and sends only the
sections a question scores against, with term weights from how many sections
each word appears in. Retrieval, without embeddings or a second model.

The engine is held by `sw.js` rather than by the page. A navigation destroys a
page's JavaScript context, so a model owned by the page would be rebuilt every
time you opened one; a service worker outlives navigation, which is what makes
the panel on the linkage page open instantly once the chat page has loaded it.
`js/chat/engine.js` falls back to a dedicated worker where a service worker
cannot be used, and steps down the model ladder when a GPU cannot hold the top
of it. The WebLLM runtime itself is imported lazily, so a visitor who never
opens the panel on a simulator page downloads none of it.

The profile in `js/chat/profile.js` is the only thing to edit to change what it
knows. It deliberately carries no email address and no phone number: the rest of
the site keeps the address out of the served bytes, and a profile string in a
static `.js` file would be the easiest scrape on the site.

## The homepage background

A Strandbeest walking in 3D, on the same solver the linkage tool runs. Three
Jansen legs share one crankshaft, evenly spaced around the turn, and the body
advances at the rate the stance foot sweeps backwards, so a planted foot stays
planted rather than skating. Three is chosen for the silhouette, not for the
gait: with a duty factor near 20% it takes six legs before some foot is always
down, and nothing here simulates weight, so the creature simply reads as
lighter and you can see through it.

`js/walker/jansen.js` holds the thirteen "holy numbers" and the forward
kinematics: two fixed pivots and five circle–circle intersections down to the
foot, after Wang, *Durability-Aware Multi-Objective Optimization of the Jansen
Linkage* (arXiv:2606.22129 §2). Two circles meet in two places and only one
choice at each step assembles into Jansen's leg; that branch was found by
sweeping all thirty-two and keeping the one whose foot path has the published
duty factor of about 20%. `framing.js` solves where to put the camera, against
the creature's own swept size and the viewport's shape.

It deliberately does not fit the whole creature. Framed end to end, legs 52
apart superimpose into a knot of grey sticks at the size that leaves, so the
camera is fitted vertically but allowed to run the ends of the crankshaft off
the sides -- `fillX` above 1, `fillY` below it. The view also opens turned
three-quarters on rather than square: at yaw 0 the camera looks straight down
the crankshaft and every leg hides behind the one in front, which is an angle
problem no amount of zoom fixes. `tests/framing.test.mjs` pins both -- that the
crop never eats the creature vertically at any window shape or drag angle, that
it stays bounded sideways, and that what is left still fills the frame.

On a phone it stops being a backdrop. The text column is the whole width there,
so a creature behind it is behind every word and the mask has nothing to fade it
into; below 640px it leaves the absolute layer and takes a band of its own under
the buttons -- full contrast, still draggable, competing with nothing. The
rightward bias goes with it: `refit()` asks the stylesheet which layout it chose
(a backdrop is positioned, a band is static) rather than keeping its own copy of
the breakpoint.

## Working on it

```
python3 scripts/build-site.py            # after editing partials/, css/ or js/
python3 scripts/build-site.py --check    # non-zero if anything is stale
node --test tests/*.mjs                  # engines, hero framing, chat grammar
python3 -m http.server 8000              # then open http://localhost:8000
```

The build script must be run after any CSS or JS change: it hashes those files
and stamps the hash onto every asset URL, including the ES-module specifiers the
engine uses internally. Without it GitHub Pages will keep serving a visitor
ten-minute-old JavaScript after a deploy.

`sw.js` is the one script the version stamp is deliberately kept off. A service
worker is identified by its script URL, so stamping it would register a fresh
worker on every deploy and leave the old one resident; browsers revalidate a
service worker script on their own. Files started as workers (`solver.worker.js`,
`js/optics/render.worker.js`, `js/chat/worker.js`) are not import specifiers
either, so they copy their parent module's `?v=` across at runtime instead.

The engine tests are ported from the C repos -- `tests/test_mechanism.c` for the
linkage, and `test_lens.c`, `test_camera.c`, `test_glass.c`, `test_spectral.c`
and `test_trace.c` for the optics -- and keep their original names, so a failure
here maps straight back to the test that covers the same behaviour there.
`framing.test.mjs` has no counterpart there -- the desktop tool has no homepage.

Some of `optics.test.mjs` pins behaviour that *looks* like a defect and is not,
because both halves are worth defending: focus decides which target is sharp,
except at the edge of the field, where an uncorrected doublet's coma beats
defocus outright and the depth-of-field slab says the opposite of what the
camera records.

The contact address is never written out in full. `index.html` and
`partials/footer.html` carry it as `data-mailto-user` / `data-mailto-domain`,
and `js/app.js` joins the halves at runtime, so the served HTML holds no
harvestable string and the JSON-LD block carries no `email` field. Both links
ship `hidden` and are revealed only once they have a real `href`, so a script
failure leaves the LinkedIn and GitHub buttons rather than a dead one.
