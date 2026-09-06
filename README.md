# mhsghali.github.io

My personal site. Plain static files — no framework, no bundler, no build step
beyond one Python script that stamps the shared nav and footer into each page.

```
index.html            the whole single-page site
pages/linkage.html    the linkage simulator
css/main.css          design system and every component
js/app.js             theme toggle, mobile nav, scroll reveal
js/hero-linkage.js    the homepage hero, driven by the real solver
js/linkage/           the mechanism engine and the tool's UI
partials/             nav and footer, stamped into pages by the build script
scripts/build-site.py stamps the partials and versions every asset URL
tests/                the engine's regression tests
```

## The linkage simulator

`pages/linkage.html` is a browser port of
[Linkage-Design](https://github.com/MHSGhali/Linkage-Design), my desktop
mechanism editor in C. Build a planar mechanism out of joints, anchors and
rigid bodies, drive one link with a motor, run it, watch it in 3D, and export
an animated Blender script.

The engine — `js/linkage/mechanism.js`, `solver.js`, `linalg.js`, `blender.js` —
is a hand port of the C original's headless core. The SDL front end is not
ported; `editor.js` and `view3d.js` replace it. The port reproduces the C
implementation's results to the last decimal place, including on a chaotic
double pendulum where any divergence would amplify.

## Working on it

```
python3 scripts/build-site.py            # after editing partials/, css/ or js/
python3 scripts/build-site.py --check    # non-zero if anything is stale
node --test tests/linkage.test.mjs       # the engine's 16 regression tests
python3 -m http.server 8000              # then open http://localhost:8000
```

The build script must be run after any CSS or JS change: it hashes those files
and stamps the hash onto every asset URL, including the ES-module specifiers the
engine uses internally. Without it GitHub Pages will keep serving a visitor
ten-minute-old JavaScript after a deploy.

The tests are ported from `tests/test_mechanism.c` in the C repo and keep their
original names, so a failure here maps straight back to the test that covers the
same behaviour there.
