# The design system

One stylesheet, `css/main.css`, about 950 lines, no preprocessor and no
framework. It is monochrome and dark-first, with light mode reached through a
`data-theme` attribute on the root element. Every page on the site is built out
of the handful of components described here, so it is worth reading before
adding a new one: the answer is usually that the component already exists.

## Colour is a value scale, not a palette

There is no hue anywhere. That is the central constraint and it is what makes
everything else consistent.

```
--bg            the page
--bg-elev       a raised surface
--bg-elev-2     a surface on a surface
--surface-line  borders, rules, the quietest visible mark
--text-faint    the quietest legible text
--text-dim      secondary text
--text          body text
--accent        the far end of the scale
```

`--accent` is not a colour, it is a **position**: the far end of the value
scale, white on black and black on white. It marks whatever should carry the
most emphasis, a driven motor link, a traced path, the primary button, a focused
control. Everything else is placed between `--text` and `--surface-line` by value
alone. If you find yourself wanting a colour to distinguish two things, the
answer here is a different position on that scale.

Light mode redefines the same eight tokens under `:root[data-theme="light"]` and
nothing else changes. Adding a colour that is defined in only one of the two
blocks is the one reliable way to break a theme.

## Theme switching, and the canvases

The theme is settled before paint by an inline script in the head of every page,
which reads `localStorage` and falls back to the OS preference, so there is no
flash. `js/app.js` toggles it and then dispatches a `themechange` event on
`window`.

That event matters because four things on this site draw themselves and cannot
inherit CSS: the linkage editor canvas, the three 3D views, and the homepage
creature. Each one reads the computed custom properties off the root element and
repaints. The pattern is always the same, `readPalette()` in
`js/linkage/editor.js` and `applyTheme()` in `js/hero-walkers.js` being the two
clearest examples. If you add a token and a canvas should use it, the canvas has
to be told: nothing cascades into a WebGL scene.

A lit 3D scene needs more than a swapped colour to invert with the theme. See
the note in `docs/homepage.md` about metalness and ambient, which is the trap.

## Components

| Class | What it is |
| --- | --- |
| `.wrap` | the page measure, `--maxw` wide with a side gutter |
| `.section` | vertical rhythm between page sections |
| `.eyebrow` | the small mono label above a section, with a rule trailing off it |
| `.grid`, `.grid-2`, `.grid-3` | auto-fit columns that collapse on their own |
| `.card` | a bordered panel; `a.card` is the linked variant |
| `.btn`, `.btn-primary` | the two buttons |
| `.icon-btn` | a square icon button, used by the nav and the theme toggle |
| `.tag`, `.tag.hot` | the skill chips |
| `.tl-item` | one entry in the experience timeline |
| `.tool-head` | a tool page's title and standfirst, side by side above 900px |
| `.toolbar`, `.tbtn` | a tool's button row |
| `.stage`, `.viewport` | the two side-by-side viewports on a tool page |
| `.howto` | the collapsible explainer at the foot of a tool page |
| `.panel-hint` | small quiet prose inside a panel |
| `.keys` | the definition list a tool uses to document its controls |
| `.reveal` | a section that fades in on scroll |
| `.sheen` | the fixed brushed-metal backdrop behind everything |

`.tool-head` is worth one paragraph because it was got wrong once. It used to be
a wrapping flex row, which paired the title and the standfirst only when the
heading happened to be short enough to leave room, so the same markup read one
way on Light and another on Optics. The columns are explicit now.

## Two rules that are load-bearing

**The reveal is gated on `.js`.** `.js .reveal { opacity: 0 }` and only
`js/app.js` ever adds `.in`. An ungated rule would leave every section but the
hero invisible if that script failed to load or threw, and the page would be a
headline and a footer. With the gate, no JavaScript means no hiding. Never write
a rule that hides content without that gate.

**Reduced motion is honoured throughout**, including by the homepage animation
loop, which stops entirely rather than slowing down.

## Breakpoints

900px is the main one: the tool pages go from two viewports side by side to one
at a time, and `.tool-head` stacks. 640px and 760px handle the narrow end of the
homepage. The homepage creature has its own set, fading the background out as
the window narrows and then moving it out from behind the text into a band of
its own below 640px.

`js/walker/framing.js` does not hardcode that breakpoint. It asks the stylesheet
which layout it chose, by checking whether the host element is positioned or
static, so the two cannot disagree about where the boundary is. Copy that trick
rather than duplicating a number if you need the same thing again.
