# Site chrome

Everything shared between pages that is not the design system: the nav and
footer, the script that makes them work, the reusable viewport control, the
service worker, and the handful of files at the repo root that tell browsers and
crawlers what this site is.

## The nav and footer

```
partials/nav.html     the only copy of the nav
partials/footer.html  the only copy of the footer
```

Neither is loaded at runtime. `scripts/build-site.py` stamps both into every
page between `BUILD` markers, expanding `{{ROOT}}` (the relative path back to
the site root) and `{{HOME}}` (empty on `index.html`, so `#about` scrolls
instead of navigating) and adding `aria-current="page"` to the link for the page
being built. So the pages are real static HTML with nothing for a crawler to
miss, and the markup still lives in one place.

Editing a partial and not re-running the script means the change appears on no
page at all. `--check` catches it. See `docs/build-and-test.md`.

Adding a nav link means editing `partials/nav.html` once and re-running.

## `js/app.js`

Plain ES5 in an IIFE, no modules, loaded with `defer` on every page. It is
deliberately the least clever file in the repo, because everything else depends
on it having run.

- **Theme.** An inline script in each page's head settles the theme before paint
  so there is no flash. `js/app.js` repeats the same rule, so the theme is still
  right if the inline script was the thing that failed, and it never *writes* a
  preference: a theme the visitor has not chosen must not become a stored
  choice, or the toggle would have nothing to fall back to. On toggle it
  dispatches a `themechange` event, which is how the canvases and the 3D views
  find out. See `docs/design-system.md`.
- **`.js` on the root element**, set before paint, which is what gates the
  scroll reveal so a script failure leaves the page plain rather than blank.
- **The mobile nav**, the sticky nav border, and the scroll reveal, which
  respects `prefers-reduced-motion` by simply showing everything.
- **The year stamp** in the footer.
- **The rotating hero button**, which carries its `href` with whichever face is
  showing so a click always lands where the label reads.
- **The contact address**, assembled at runtime. `index.html` and
  `partials/footer.html` carry it as `data-mailto-user` and
  `data-mailto-domain`, so the served HTML holds no harvestable string and the
  JSON-LD block carries no `email` field. Both links ship `hidden` and are
  revealed only once they have a real `href`, so a script failure leaves the
  LinkedIn and GitHub buttons rather than a dead one. Do not undo this by
  writing the address into markup.

## `js/viewcontrol.js`

The navigation wheel in the corner of a 3D viewport: drag to spin, arrows to
tilt, plus and minus to zoom. One widget, used by all three tool pages, so a
change to it changes every viewport. It is not used on the homepage, where the
creature is dragged directly.

## `sw.js`

Twenty-six lines, and it caches nothing. It registers **no fetch handler on
purpose**, so it never intercepts or caches ordinary requests for the site.
It exists only to host the WebLLM engine handler, which is what lets the
language model stay resident when a visitor walks from the Ask page to a
simulator. `skipWaiting()` on install, `clients.claim()` on activate.

It is also the one script the build script deliberately never versions: a
service worker is identified by its script URL, so a stamp would register a
fresh worker on every deploy and strand the old one. Browsers revalidate a
worker script on their own.

## The files at the root

```
.nojekyll     stops GitHub Pages running the markup through Jekyll
robots.txt    allows everything, and points at the sitemap
sitemap.xml   five URLs, maintained by hand; nothing generates it
```

`sitemap.xml` and the canonical URLs in every page point at
`mhsghali.github.io`, which is the GitHub Pages host for the account. The local
checkout directory is named differently; that is a folder name and means
nothing. If you add a page, add it to the sitemap by hand.

`docs/` is not linked from any page and is not in the sitemap, and
`tests/docs.test.mjs` checks that it stays that way. It is repo documentation,
not part of the site. Because `.nojekyll` is set, a `.md` file here would be
served raw rather than rendered if anyone did link to it.

## Icons

`assets/images/` holds one favicon per tool page plus the iOS touch icon. A new
tool page should get its own, because the tab icon is how someone with four of
these open tells them apart.
