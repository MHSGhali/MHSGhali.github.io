# The linkage simulator

`pages/linkage.html`, a browser port of Linkage-Design, the desktop mechanism
editor in C. Build a planar mechanism out of joints, anchors, rigid bodies and
sliders, drive one link with a motor, run it, watch it in 3D, and export it
either as an animated Blender script or as printable STL parts.

The headless core of the C original is hand-ported and reproduces its results to
the last decimal place, including on a chaotic double pendulum where any
divergence would amplify. The SDL front end is not ported at all: `editor.js`
and `view3d.js` replace it.

## The files

```
js/linkage/mechanism.js   the data model, port of src/mechanism.c
js/linkage/solver.js      the constraint solver, port of src/solver.c
js/linkage/linalg.js      dense Gaussian elimination with partial pivoting
js/linkage/vec2.js        2D vector helpers, transliterated from src/vec2.h
js/linkage/generate.js    builds a working N-bar linkage to order
js/linkage/presets.js     the starter mechanisms
js/linkage/serialize.js   encodes a design into the URL hash
js/linkage/editor.js      the 2D canvas: interaction, selection, undo, drawing
js/linkage/view3d.js      the live 3D view, one cylinder per link, one sphere per joint
js/linkage/mesh3d.js      flat outlines to printable prism solids, port of src/mesh3d.c
js/linkage/print3d.js     mechanism to bolt-together parts, port of src/print3d.c
js/linkage/zip.js         a minimal stored-entry ZIP writer for the STL export
js/linkage/blender.js     the animated Blender script, port of src/export.c
js/linkage/app.js         the page controller: toolbar, status line, exports
js/linkage/knowledge.js   what the assistant is told about this tool
js/linkage/assistant.js   what a chat command means in this editor
```

The split that matters: everything above `editor.js` runs under node and is
covered by `tests/linkage.test.mjs` and `tests/print3d.test.mjs`. Everything
from `editor.js` down touches the DOM or three.js and is not tested. Keep new
engine behaviour above the line.

## Things worth knowing

**The solver is the same one the homepage runs.** `js/walker/jansen.js` builds
Jansen's leg out of this mechanism engine, so a change to `solver.js` moves the
creature on the homepage as well as the mechanism on this page, and
`tests/walker-physics.test.mjs` will notice.

**Editing is disabled while it runs**, and `preRunSnapshot` in `editor.js` is
what lets Run return the mechanism to the layout you designed rather than
leaving it wherever the motor stopped.

**Framing is handed over the moment you touch it.** `autoFramed` in `editor.js`
is true only while the camera is still the one Fit chose; any manual pan or zoom
releases it, so panning in to watch one joint during a run is not yanked back
when the trace grows.

**The two exports are different in kind.** The Blender script is an animation:
it carries the motion. The STL export is geometry: `mesh3d.js` turns flat
outlines into prisms, `print3d.js` separates the parts onto layers so they do
not fuse, and `zip.js` exists only so the result can be handed over as a folder.
`tests/print3d.test.mjs` checks the solids are watertight and the zip is
well-formed, because neither failure is visible until a slicer rejects it.

**The URL hash is deliberately lossy.** `serialize.js` encodes the design, not
the run state. A shared link reproduces the mechanism someone built, not the
frame they were looking at.

**`generate.js` builds linkages to order**: a Grashof four-bar plus dyads, which
is what lets the assistant answer "make me a six-bar" with something that
actually moves. `tests/knowledge.test.mjs` cross-checks that every starter named
in `knowledge.js` exists in `presets.js`, so renaming a preset without updating
the prose fails the suite rather than producing a confident wrong answer.

## The assistant on this page

`js/linkage/assistant.js` mounts the same chat panel the Ask page uses and gives
it a controller, so a parsed command presses the editor's buttons directly. The
model never does that: commands are matched against a closed grammar in
`js/chat/commands.js` and executed exactly. See `docs/ask.md`.

`js/linkage/knowledge.js` is the document the model is given about this tool,
tagged into sections (`<capabilities>`, `<preconditions>`, `<limits>` and so on)
so only the part a question touches is sent. It is a prompt, which makes it the
easiest thing here to get quietly wrong, so `tests/knowledge.test.mjs` re-parses
every command form it offers through the real grammar.
