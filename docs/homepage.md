# The homepage

`index.html` is the whole single-page site: hero, about, experience, projects,
education, patent and publications, contact. Everything else in `pages/` is a
tool. It is real static markup with no client-side rendering, so a crawler and a
visitor with JavaScript off both get the entire document; `js/app.js` only adds
behaviour on top of what is already there.

One thing on this page is not decoration in the usual sense. The creature
walking behind the headline is a Strandbeest being simulated live, on the same
constraint solver the linkage tool runs, with a body that has mass and falls
under gravity. That is the page's claim about the rest of the site, so it has
its own section below and its own tests.

## The page itself

- **`index.html`** carries a JSON-LD block near the top for search engines.
  Deliberately no `email` field: the contact address is never written out in the
  served bytes.
- **The hero** (`section.hero`) holds the headline, the role line, the lead
  paragraph, and two buttons. The primary one is a single button that names one
  simulator at a time and rotates through all three, with `js/app.js` carrying
  the `href` along with whichever face is showing, so a click always lands where
  the label reads. All three faces sit in one grid cell, so the button is as
  wide as the longest label and never resizes under the pointer. With JavaScript
  off nothing rotates and the first face stands alone, already linked.
- **The stats strip** under the hero, and then the standard sections, which are
  all built from the same handful of classes described in
  `docs/design-system.md`: `.grid`, `.card`, `.tl-item` for the experience
  timeline, `.eyebrow` for the section labels.
- **The scroll reveal** hides sections behind a `.js` class that only a live
  script sets, so a script that fails to load leaves the page plain rather than
  blank. `scripts/build-site.py` and `js/app.js` between them make sure that
  holds for what a visitor sees, not only for the markup.
- **The contact section** reveals its mail link only once `js/app.js` has joined
  the address halves. See `docs/site-chrome.md`.

## The creature

Four modules, none of which import three.js, plus one renderer that does.

```
js/walker/jansen.js     Jansen's thirteen link lengths and the leg's kinematics
js/walker/body.js       one rigid body, 3 DOF, penalty contacts and friction
js/walker/creature.js   ten legs, one crankshaft, and what the machine is made of
js/walker/framing.js    where to put the camera so the thing is on screen
js/hero-walkers.js      the only file here that draws anything
```

**It walks because it is held up.** Five pins on one crankshaft, each carrying a
mirrored pair of Jansen legs that reach opposite ways, and a body with mass and
rotational inertia that falls under gravity and is carried by whichever feet are
touching the ground. Its forward speed is an output of the contact forces, not a
number chosen to look right, and `tests/walker-physics.test.mjs` checks that the
speed which comes out agrees with what the leg geometry predicts.

**Why ten legs and not three.** The page used to slide three legs forwards at
the rate a planted foot sweeps backwards. The number was right and the creature
still skated, because nothing was ever held up by anything. Jansen's classic
proportions have a duty factor near 20%, which leaves three legs with no foot
down at all for two fifths of every turn. That does not matter when nothing has
weight and is fatal the moment something does. This assembly keeps a foot down
for about 65% of the turn instead, which is what lets four legs always keep two
on the ground.

**It has to be buildable.** `tests/walker-clearance.test.mjs` checks that no two
members ever occupy the same space over a full revolution, which is why
`js/walker/creature.js` and not the renderer owns the bar thicknesses: the
renderer and the clearance test have to be looking at the same machine.

**The renderer.** `js/hero-walkers.js` draws it and nothing else. It imports
three.js from a pinned CDN URL, and if that import fails the page simply has no
background, which is why this is a background and not content. Points worth
knowing before editing it:

- `preserveDrawingBuffer` is not optional. A WebGL buffer's contents are
  undefined once composited, so a single still frame goes blank the moment the
  loop stops, which it does under `prefers-reduced-motion`.
- Every repaint goes through `draw()`, including the ones that happen while the
  animation loop is not running. Resizing the renderer clears the buffer, so a
  resize that only sets a dirty flag leaves a blank canvas.
- The camera and the creature are wrapped together, anchored on the camera, so
  they can never wrap a frame apart and throw the creature across the screen.
- The creature is drawn in the page's own ink and inverts with the theme: light
  on a dark page, dark on a light one, the same way the linkage tool strokes a
  mechanism. That is not automatic in a lit 3D scene. Metalness is kept very low
  (a metallic surface has no diffuse colour at all and there is no environment
  map here, so a metallic bar renders near black whatever colour it is given),
  and the light and dark branches of `applyTheme()` are deliberately not mirror
  images: on a dark page the ambient carries the load so the creature stays
  brighter than the page even in its own shade, while on a light page dark ink
  stays dark under any key and the shadows are worth having.
- The stones exist because the camera travels with the creature over featureless
  ground, so without them it walks on the spot. They are laid beside the track
  rather than under it, and recycled on a treadmill from a fixed pool.

`js/walker/framing.js` solves the camera against the creature's swept size and
the viewport shape, and `tests/framing.test.mjs` pins the result: never cropped
vertically, cropped sideways only as far as the ends of the crankshaft, at every
window shape from a phone band to a wide desktop hero. The framing also asks the
stylesheet which layout it chose, by reading whether the host is positioned or
static, so `css/main.css` and the renderer cannot disagree about where the phone
breakpoint is.
