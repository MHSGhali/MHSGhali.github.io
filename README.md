# mhsghali.github.io

My personal site. Plain static files — no framework, no bundler, no build step
beyond one Python script that stamps the shared nav and footer into each page.

```
index.html            the whole single-page site
pages/linkage.html    the linkage simulator
pages/light.html      the light simulator
css/main.css          design system and every component
js/app.js             theme toggle, mobile nav, scroll reveal
js/hero-walkers.js    the homepage background, driven by the real solver
js/walker/            Jansen's leg, and the camera that keeps it framed
js/linkage/           the mechanism engine and the tool's UI
js/light/             the spectral light engine, its worker and the tool's UI
partials/             nav and footer, stamped into pages by the build script
scripts/build-site.py stamps the partials and versions every asset URL
tests/                the engine's regression tests
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

## The homepage background

A Strandbeest walking in 3D, on the same solver the linkage tool runs. Six
Jansen legs share one crankshaft — the fewest for which a foot is always on the
ground — and the body advances at the rate the stance foot sweeps backwards, so
a planted foot stays planted rather than skating.

`js/walker/jansen.js` holds the thirteen "holy numbers" and the forward
kinematics: two fixed pivots and five circle–circle intersections down to the
foot, after Wang, *Durability-Aware Multi-Objective Optimization of the Jansen
Linkage* (arXiv:2606.22129 §2). Two circles meet in two places and only one
choice at each step assembles into Jansen's leg; that branch was found by
sweeping all thirty-two and keeping the one whose foot path has the published
duty factor of about 20%. `framing.js` solves where to put the camera, against
the creature's own swept size and the viewport's shape, so it stays wholly on
screen at any window shape and any angle you drag it to.

## Working on it

```
python3 scripts/build-site.py            # after editing partials/, css/ or js/
python3 scripts/build-site.py --check    # non-zero if anything is stale
node --test tests/*.mjs                  # both engines' regression tests
python3 -m http.server 8000              # then open http://localhost:8000
```

The build script must be run after any CSS or JS change: it hashes those files
and stamps the hash onto every asset URL, including the ES-module specifiers the
engine uses internally. Without it GitHub Pages will keep serving a visitor
ten-minute-old JavaScript after a deploy.

The tests are ported from `tests/test_mechanism.c` in the C repo and keep their
original names, so a failure here maps straight back to the test that covers the
same behaviour there.
