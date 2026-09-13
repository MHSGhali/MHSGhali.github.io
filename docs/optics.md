# The optics simulator

`pages/optics.html`, a browser port of Optics-Simulation, the physically-based
camera in C. Light is traced through real multi-element lens prescriptions,
surface by surface, with a per-wavelength refractive index taken from the
Sellmeier coefficients of the actual catalogue glass. Aberration, vignetting,
depth of field and distortion are not effects applied afterwards. They are what
happens when you trace real glass.

This page imports `js/light/` rather than duplicating it: the same 95-bin
spectra, the same CIE 1931 photometry, the same PCG32 stream. The engine
underneath is therefore the one already checked against the C to eighteen
significant digits. What is new here is the lens.

## The files

```
js/optics/glass.js        refractive index against wavelength (Sellmeier)
js/optics/prescription.js lens designs as inert data; a prescription has no behaviour
js/optics/lens.js         a mounted lens: scaled, stopped, focused, traceable
js/optics/pupil.js        where on the rear element a sensor point can usefully aim
js/optics/spectral.js     one wavelength per camera path, CIE-importance-sampled
js/optics/camera.js       sensor point plus random numbers to a world ray
js/optics/trace.js        a scalar path tracer, deliberately not js/light/integrator.js
js/optics/scenedesc.js    the scene, and where it becomes tracer-readable
js/optics/film.js         the image buffer; where physical units become pixels
js/optics/render.js       settings in, pixels out, with no worker vocabulary
js/optics/render.worker.js the renderer off the main thread
js/optics/settings.js     every setting as data; the one place one can be changed
js/optics/scene3d.js      the camera and its subjects seen from outside, three.js-free
js/optics/view3d.js       the scene viewport, drawing scene3d.js with three.js
js/optics/app.js          the page: two viewports, camera controls, one worker
js/optics/knowledge.js    what the assistant is told about this tool
js/optics/assistant.js    the assistant panel on this page
```

`render.js` is deliberately free of worker vocabulary so `node --test` can
render a frame directly. That is why `tests/optics.test.mjs` can be 73 tests
deep rather than a handful of unit checks.

## Things worth knowing

**One wavelength per ray, and it is not an optimisation.** Because the glass is
dispersive, a single path is only ever taken by one colour. Carrying a whole
spectrum down a path that one wavelength actually took is precisely how a
simulator erases the chromatic aberration it was built to show. Two deliberate
departures from the C follow from this: the wavelength is CIE-importance-sampled
in `spectral.js`, and `film.js` accumulates XYZ rather than 95 bins.

**Vignetting has no darkening factor anywhere.** A ray that misses a clear
aperture is dead, and that is the only source of it. If the corners are not
getting dark, the aperture stack is wrong, not the falloff curve.

**Exposure is a viewing gain and never re-traces.** The film holds absolute
spectral measurements, so exposure is applied once at the moment those become
colours. Changing it re-develops the frame that is already there. Aperture,
focus and focal length change which rays exist, so they start again. Keep that
boundary: moving exposure into the trace would cost a full render per slider
drag.

**The two lighting modes are not balanced to one exposure**, and auto-exposure
is deliberately absent. A 2000 lx overcast sky is a couple of stops brighter
than the key lamp it replaces, so switching blows the highlights until you bring
exposure down. That is what a real light meter does, and auto-exposure would
hide the one thing the aperture control exists to show.

**The depth-of-field figures are on-axis, from defocus alone**, which is what
depth of field has always meant. Off axis an uncorrected doublet adds coma and
astigmatism that no depth-of-field formula knows about, so a sphere inside the
drawn slab can still be soft near the frame edge. The render is the honest
answer and the slab is the textbook one. `tests/optics.test.mjs` pins both,
because both are worth defending, and a failure there that looks like a bug may
be the test doing its job.

**`settings.js` is the single place a setting changes.** Adding a control means
adding it there, not threading a new argument through `render.js`.

**`prescription.js` holds no behaviour.** A lens design is data; `lens.js` is
what mounts it, scales it, stops it down and focuses it. Keeping those apart is
what lets a new design be added without touching the tracer.
