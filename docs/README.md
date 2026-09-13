# docs

Reference material, one file per page or subsystem. `README.md` at the repo root
is the narrative version of the same site and says why things are the way they
are; these files say what is where and what the rules are. `CLAUDE.md` is the
entry point for anyone, human or agent, about to change something.

```
homepage.md         index.html, js/hero-walkers.js, js/walker/
linkage.md          pages/linkage.html, js/linkage/
light.md            pages/light.html, js/light/
optics.md           pages/optics.html, js/optics/
ask.md              pages/chat.html, js/chat/
design-system.md    css/main.css
site-chrome.md      partials/, js/app.js, js/viewcontrol.js, sw.js
build-and-test.md   scripts/build-site.py, tests/
```

That map is not decoration. `tests/docs.test.mjs` reads it: every `.md` in this
folder must appear in it, every row must name a file that exists, and every page
and every `js/` subsystem must be claimed by one of the rows. Add a doc and you
add a line here, or the suite fails.

What the tests cannot check is whether the prose is still true. They pin the
paths, not the paragraphs. When you change how something works, the doc that
claims to explain it is part of the change.

## Reading order

If you are new to the repo, `build-and-test.md` first: it is short and it is the
part that will bite you. Then whichever of the five page docs covers what you are
touching. `design-system.md` matters more than it sounds like it does, because
every page is built out of the handful of components it describes.
