# Building and testing

There is no build system. There is one Python script with no dependencies
outside the standard library, and a test suite that runs on node's own runner.
Nothing is compiled, nothing is minified, and what is in the repo is what the
browser gets, apart from two stamps the script applies.

```
python3 scripts/build-site.py          # after ANY edit to partials/, css/ or js/
python3 scripts/build-site.py --check  # exits non-zero if anything is stale
node --test tests/*.mjs                # the whole suite, 214 tests
node --test tests/optics.test.mjs      # or just one file
python3 -m http.server 8000            # then open http://localhost:8000
```

Serve it rather than opening `index.html` off disk. The pages are ES modules and
the assistant needs a secure context: WebGPU is absent over a `file://` or plain
`http://` address that is not localhost, which `js/chat/engine.js` detects and
explains rather than failing as "your browser is too old".

## What the build script does

`scripts/build-site.py`, 186 lines, two jobs.

**It stamps the shared chrome into the pages.** `partials/nav.html` and
`partials/footer.html` are the only copies of the nav and footer. The script
substitutes each one into every page between a marker pair:

```html
<!-- BUILD:nav -->
...replaced wholesale, every run...
<!-- /BUILD:nav -->
```

A page missing either marker pair is a hard error and the script exits. Two
placeholders are expanded on the way in: `{{ROOT}}` becomes the relative path
back to the site root (`""` for `index.html`, `"../"` for everything in
`pages/`), and `{{HOME}}` is empty on `index.html` so that `#about` scrolls
instead of navigating. The nav link matching the current page gets
`aria-current="page"` added; `index.html` is skipped there because its nav
entries are in-page anchors.

**It versions every asset URL.** It walks `css/` and `js/`, hashes the contents
with any existing `?v=` stripped first (which is what makes the stamp a fixed
point instead of a hash that changes every time it is written), and rewrites two
things: `href`/`src` attributes in the five pages, and relative ES-module
specifiers inside every `.js` file under `js/`. So a single run can touch 58
files, and that is normal.

This exists because GitHub Pages serves assets with `max-age=600`. Without a
version in the URL a visitor keeps running ten-minute-old JavaScript after a
deploy.

Three things are deliberately outside it:

- **`sw.js` is never stamped.** A service worker is identified by its script URL,
  so a version on it would register a fresh worker on every deploy and leave the
  old one resident. Browsers revalidate a worker script on their own.
- **Worker entry points are not import specifiers.** `js/light/solver.worker.js`,
  `js/optics/render.worker.js` and `js/chat/worker.js` are started with
  `new URL(...)`, which the regex cannot see, so each one copies its parent
  module's `?v=` across at runtime instead. See `startWorker()` in
  `js/light/app.js` and `workerUrl()` in `js/chat/engine.js`.
- **Markdown is not stamped at all.** The script versions only `.css` and `.js`.
  Never paste a stamped URL into a doc: it will be wrong after the next deploy
  and nothing will correct it. `tests/docs.test.mjs` fails on one.

`--check` runs everything and writes nothing, printing `all pages up to date` or
the list of stale files, and exits 1 if anything is stale. Run it before
committing.

## Adding a page

1. Create the HTML in `pages/`, with both marker pairs and `{{ROOT}}`-relative
   asset URLs.
2. Add it to the `PAGES` dict in `scripts/build-site.py` with its root prefix.
3. Add it to `sitemap.xml` by hand. Nothing generates that file.
4. Add its link to `partials/nav.html`, which puts it on every other page too.
5. Give it a favicon in `assets/images/` if it is a tool page. Every tool page
   has its own.
6. Document it: `tests/docs.test.mjs` requires every page to be claimed by a row
   in `docs/README.md`.
7. Run the build script, then the tests.

## The test suite

Ten files, node's built-in runner, flat `test()` calls and no describe blocks.
They are run from the repo root. There is no CI, so nobody runs them but you.

| File | Covers |
| --- | --- |
| `tests/linkage.test.mjs` | The mechanism model, the solver, the Blender export and `vec2`. Ported from the C `test_mechanism.c`, original test names kept. |
| `tests/light.test.mjs` | Spectrum, colour, units, vectors, geometry, BSDF, lights, scene. Deterministic results must match the C exactly; the Monte Carlo checks share the PCG32 stream with it. |
| `tests/optics.test.mjs` | The largest file. Glass, lens, camera, spectral sampling, tracing, environment and focus, ported from five C test files. |
| `tests/print3d.test.mjs` | The STL export: watertight solids, link plates, rails, capsules, layer separation, and a well-formed zip. |
| `tests/chat.test.mjs` | The command grammar and the topic gate, from both ends: that they fire on what people actually type, and stay quiet on questions that merely mention a mechanism. |
| `tests/knowledge.test.mjs` | What the assistant is told about each tool, pinned to the code that must honour it: every offered command parses, every named preset exists, prompts fit the context window. |
| `tests/framing.test.mjs` | The homepage camera: the creature is never cropped vertically, and the sideways crop stays bounded at every window shape and view angle. |
| `tests/walker-clearance.test.mjs` | No two members of the creature occupy the same space over a full revolution. |
| `tests/walker-physics.test.mjs` | It stays on its feet, walks at the speed the kinematics predict, and does the same thing at any frame rate. |
| `tests/docs.test.mjs` | That these docs still name files that exist, cover every page and subsystem, and quote no version stamp. |

The engine tests are ports and keep their original C names, so a failure here
maps straight back to the test covering the same behaviour in the desktop repo.
`framing.test.mjs`, the two walker files and `docs.test.mjs` have no counterpart
there.

Some of `tests/optics.test.mjs` pins behaviour that looks like a defect and is
not. Focus decides which target is sharp, except at the edge of the field, where
an uncorrected doublet's coma beats defocus outright and the depth-of-field slab
says the opposite of what the camera records. Both halves are worth defending.

## Why the engines have no DOM in them

Every file the tests import has to run under node. That is why the physics, the
optics, the spectral core, the command grammar, the topic gate and the three
knowledge documents contain no `document` and no `window`, and why the
three.js-dependent drawing lives in separate files (`view3d.js`, `editor.js`,
`js/hero-walkers.js`) that the tests never touch. `js/walker/framing.js` exists
as its own module for exactly this reason: "is the creature actually on screen?"
is a question worth answering in numbers rather than by squinting at a browser.

Adding a DOM reference to one of those modules does not fail anything. It just
quietly removes the file from the test suite.
