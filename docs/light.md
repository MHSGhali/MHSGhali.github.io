# The light simulator

`pages/light.html`, a browser port of Light-Simulation, the spectral ray tracer
in C. Place lamps and parts, and read the illuminance on every surface, in lux
or watts per square metre, with real shadows and interreflection.

Radiance is carried as 95 bins over 360 to 830 nm, and photometry is an exact
integral against the CIE 1931 observer, so switching units re-projects one
stored measurement rather than applying a correction factor. Direct light solves
in about 15 ms; interreflection accumulates progressively in a Web Worker.
Scenes use the CLI's own format, so a scene downloaded here runs there unchanged.

The port reproduces the C's spectral and colorimetric output to all 18
significant digits, and its 4096-point workcell field to within float32
round-off. PCG32 is ported exactly, so the two draw the same random stream and
Monte Carlo results can be compared as numbers rather than as averages.

## The files

```
js/light/core.js          fundamental constants, from include/lightsim/core.h
js/light/vec3.js          3D vectors and the sampling warps the estimators use
js/light/rng.js           PCG32, ported exactly so runs match the C stream
js/light/spectrum.js      the 95-bin sampled spectral distribution
js/light/cie-data.js      CIE standard tables, transcribed verbatim; data only
js/light/color.js         spectrum to XYZ to sRGB
js/light/units.js         the ONLY radiometric to photometric conversion
js/light/geom.js          rays, intersections, analytic primitives
js/light/bsdf.js          surface scattering
js/light/light.js         emitters, and the flux and shape factorisation
js/light/scene.js         primitive and light aggregation, visibility queries
js/light/scenefile.js     the line-oriented scene format, parsed and written
js/light/integrator.js    the transport estimators
js/light/field.js         per-surface illuminance, solved per vertex
js/light/stats.js         descriptive statistics over a measurement set
js/light/viridis.js       the false-colour ramp, matching the CLI's PPM output
js/light/presets.js       starter scenes, in the C CLI's own format
js/light/solver.worker.js the solver off the main thread
js/light/view3d.js        the viewport: illuminance as vertex colour, lamps, gizmo
js/light/app.js           the page controller
js/light/knowledge.js     what the assistant is told about this tool
js/light/assistant.js     the assistant panel on this page
```

Everything above `solver.worker.js` runs under node and is covered by
`tests/light.test.mjs`.

## Things worth knowing

**`js/light/units.js` is the only place a radiometric quantity becomes a
photometric one.** That is a deliberate chokepoint. The engine stores one
spectral measurement and both readouts are projections of it, which is why
switching between lux and W/m² is instant and why neither can drift from the
other. A second conversion elsewhere would quietly reintroduce exactly the bug
this design exists to prevent.

**There is no BVH in `geom.js`, on purpose.** Scenes here are a handful of
analytic primitives, and an acceleration structure would cost more to build than
the brute-force intersection costs to run.

**The scene format is the C CLI's**, parsed and written by `scenefile.js`. That
compatibility is a feature, not an accident of porting, and it constrains what
can be added to a scene: anything the CLI cannot read breaks the promise.

**PCG32 is ported exactly.** `js/light/rng.js` is not "a random number
generator", it is that one, so that a Monte Carlo result here and a Monte Carlo
result there can be compared directly. Do not swap it for `Math.random` in any
path a test covers. `js/hero-walkers.js` also borrows it, so the homepage's
stone scatter is identical for every visitor.

**`cie-data.js` is data only.** Transcribed tables, no behaviour. If a number in
it looks wrong, check it against the standard rather than adjusting it to taste.

**The worker has no SharedArrayBuffer.** GitHub Pages does not send the headers
that would allow one, so the solver posts results rather than sharing memory,
and `solver.worker.js` carries its parent module's `?v=` across by hand because
`new URL(...)` is not an import specifier the build script can stamp. See
`docs/build-and-test.md`.
