# Working on this repo

Mark Gerges's personal site, served by GitHub Pages. Plain static files: no
framework, no bundler, no npm, no CI, no linter. Three browser ports of desktop
C simulators (linkage, light, optics), an in-browser language model that answers
questions about the resume and drives those simulators, and a Strandbeest that
walks across the homepage on the real solver rather than along a path.

`README.md` is the narrative, and it is worth reading: it says what was tried and
why it changed. `docs/` is the reference, one file per page or subsystem. Start
at `docs/README.md`.

## Two commands, both non-negotiable

```
python3 scripts/build-site.py          # after ANY edit to partials/, css/ or js/
python3 scripts/build-site.py --check  # exits non-zero if anything is stale
node --test tests/*.mjs                # 214 tests, all green before any commit
python3 -m http.server 8000            # then open http://localhost:8000
```

The build script does two jobs. It stamps `partials/nav.html` and
`partials/footer.html` into the five pages between their `BUILD` markers, and it
hashes every CSS and JS file and stamps `?v=<hash>` onto every asset URL,
including the ES-module specifiers inside the JS files themselves. Skip it and
GitHub Pages keeps serving visitors ten-minute-old JavaScript after a deploy,
which looks exactly like the fix not working.

Never hand-edit a `?v=` tag, and never touch anything between
`<!-- BUILD:nav -->` and `<!-- /BUILD:nav -->`, or the footer pair. The script
owns both. Edit `partials/` and re-run it.

Tests are run by hand. There is no CI to catch this for you.

## Where to look

| Changing | Read |
| --- | --- |
| the homepage, or the walking creature | `docs/homepage.md` |
| the linkage simulator | `docs/linkage.md` |
| the light simulator | `docs/light.md` |
| the optics simulator | `docs/optics.md` |
| the assistant, its grammar, or what it knows | `docs/ask.md` |
| anything visual: colour, spacing, components | `docs/design-system.md` |
| nav, footer, theme, service worker, icons | `docs/site-chrome.md` |
| the build script, the tests, adding a page | `docs/build-and-test.md` |

## Conventions

- **The engines carry no DOM.** `js/walker/`, `js/*/knowledge.js`,
  `js/chat/commands.js`, `js/chat/profile.js` and the physics and optics cores
  are importable under node, which is the only reason the tests can drive them.
  Putting a `document` reference in one of those files silently removes it from
  the test suite. UI goes in `app.js`, `editor.js`, `ui.js` and `view3d.js`.
- **three.js comes from a pinned CDN URL**, imported dynamically so a page that
  never opens a 3D view never pays for it. It is never bundled or vendored.
- **Everything runs on the visitor's machine.** Nothing is uploaded, there is no
  API key anywhere, and the contact address is never written out in full in
  served HTML: it ships in halves and `js/app.js` joins them at runtime.
- **No em dash.** Not the character, not `&mdash;`. Use commas, colons, separate
  sentences, or `--`. There are currently zero em dashes in the repo and that is
  deliberate (commit a542a57).
- **Docs cite real paths.** `tests/docs.test.mjs` checks that every file path
  named in `CLAUDE.md`, `README.md` and `docs/*.md` still exists, that every page
  and every `js/` subsystem is covered by a doc, and that no doc quotes a `?v=`
  stamp (the build script does not version `.md`, so a pasted stamp is wrong
  forever). Rename a module and the docs fail until you fix them.
- **Commit messages** are sentence-case and declarative, describing the
  user-visible outcome. No conventional-commit prefix, no trailing period, and a
  `(#N)` suffix when squash-merged from a PR. For example: "Give the walker
  weight, and four legs it can stand on (#7)".

## What not to do

- Do not add a build step, a package manager, or a dependency. The site's whole
  claim is that it is static files, and every engine here is a port that had to
  match its C original to the digit.
- Do not stamp `sw.js`. A service worker is identified by its script URL, so a
  version on it registers a fresh worker every deploy and strands the old one.
  The build script leaves it alone on purpose.
- Do not add a `fetch()` for page content. There is not one in the repo today,
  and `sw.js` registers no fetch handler, so anything fetched is uncached and
  unversioned.
