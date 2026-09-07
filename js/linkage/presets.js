/* Starter mechanisms.

   A blank canvas is a dead end for a visitor, so the page opens on one of
   these and the rest are one click away.

   Every preset is built from lengths rather than typed-in coordinates: a
   link's rest lengths are captured from its connectors' positions at the
   moment it is created, so the starting pose has to BE the design geometry
   exactly. circleIntersect() places each joint where its two lengths actually
   meet, which keeps the numbers below readable as a design (ground 400, crank
   100, coupler 350...) instead of as a table of solved coordinates.

   The engine's y axis points down, as in the desktop tool, so gravity is
   +y and mechanisms that should sit above their ground line use negative y. */

import * as M from "./mechanism.js?v=3c8f0a84";

/* Where two circles meet: radius ra about a, radius rb about b. `sign`
   picks which of the two intersections. Returns null if they don't reach. */
function circleIntersect(a, ra, b, rb, sign = 1) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  if (d > ra + rb || d < Math.abs(ra - rb) || d === 0) return null;
  const t = (ra * ra - rb * rb + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, ra * ra - t * t));
  return {
    x: a.x + (t * dx) / d + sign * (h * dy) / d,
    y: a.y + (t * dy) / d - sign * (h * dx) / d,
  };
}

/* A point on ray a->b at distance `len` from a. Used for coupler points that
   extend past the end of a link. */
function along(a, b, len) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  return { x: a.x + (dx / d) * len, y: a.y + (dy / d) * len };
}

function fourBar() {
  /* Grashof crank-rocker: ground 400, crank 100, coupler 350, rocker 300.
     s + l = 500 <= p + q = 650 with the crank shortest, so the crank turns
     all the way round instead of binding at a limit position. */
  const m = M.create();
  const O2 = { x: -200, y: 0 }, O4 = { x: 200, y: 0 };
  const A = { x: -100, y: 0 };
  const B = circleIntersect(A, 350, O4, 300, -1);

  const o2 = M.addConnector(m, O2, true);
  const o4 = M.addConnector(m, O4, true);
  const a = M.addConnector(m, A);
  const b = M.addConnector(m, B);
  M.addLink(m, [o2, a]);
  M.addLink(m, [a, b]);
  M.addLink(m, [b, o4]);
  M.toggleDriven(m, 0, 90);
  M.setTraced(m, b, true);
  return m;
}

function hoeken() {
  /* Hoeken's straight-line linkage, in its classic 1 : 2 : 2.5 : 2.5
     proportions (crank : ground : coupler : rocker), with the tracing point
     five crank-lengths along the coupler. The crank rotates fully and P runs
     very nearly straight over the bottom half of the stroke -- the reason
     these were worth designing before anyone could machine a good slideway. */
  const m = M.create();
  const r = 100;
  const O2 = { x: -100, y: 0 }, O4 = { x: 100, y: 0 };
  const A = { x: -100, y: -r };
  const B = circleIntersect(A, 2.5 * r, O4, 2.5 * r, -1);
  const P = along(A, B, 5 * r);

  const o2 = M.addConnector(m, O2, true);
  const o4 = M.addConnector(m, O4, true);
  const a = M.addConnector(m, A);
  const b = M.addConnector(m, B);
  const p = M.addConnector(m, P);
  M.addLink(m, [o2, a]);
  M.addLink(m, [a, b, p]); /* ternary coupler: A, B and the tracing point */
  M.addLink(m, [b, o4]);
  M.toggleDriven(m, 0, 60);
  M.setTraced(m, p, true);
  return m;
}

function dragLink() {
  /* A Grashof double-crank: the GROUND is the shortest link, so both side
     links rotate fully and the driven one drags the other round at a varying
     speed. Ground 100, driver 200, coupler 250, follower 200. */
  const m = M.create();
  const O2 = { x: -50, y: 0 }, O4 = { x: 50, y: 0 };
  const A = { x: -50, y: -200 };
  const B = circleIntersect(A, 250, O4, 200, -1);

  const o2 = M.addConnector(m, O2, true);
  const o4 = M.addConnector(m, O4, true);
  const a = M.addConnector(m, A);
  const b = M.addConnector(m, B);
  M.addLink(m, [o2, a]);
  M.addLink(m, [a, b]);
  M.addLink(m, [b, o4]);
  M.toggleDriven(m, 0, 90);
  M.setTraced(m, b, true);
  return m;
}

function ternaryPlate() {
  /* A four-bar whose coupler is a triangular PLATE rather than a bar. Every
     internal distance of a link is held, not just consecutive ones, so the
     three joints move as one rigid body and the apex traces a coupler curve
     no single bar could produce. */
  const m = M.create();
  const O2 = { x: -180, y: 0 }, O4 = { x: 180, y: 0 };
  const A = { x: -180, y: -120 };
  const B = circleIntersect(A, 300, O4, 220, -1);
  /* Apex of the coupler triangle: 200 from A, 200 from B, on the far side. */
  const C = circleIntersect(A, 200, B, 200, -1);

  const o2 = M.addConnector(m, O2, true);
  const o4 = M.addConnector(m, O4, true);
  const a = M.addConnector(m, A);
  const b = M.addConnector(m, B);
  const c = M.addConnector(m, C);
  M.addLink(m, [o2, a]);
  M.addLink(m, [a, b, c]);
  M.addLink(m, [b, o4]);
  M.toggleDriven(m, 0, 70);
  M.setTraced(m, c, true);
  return m;
}

function doublePendulum() {
  /* No motor at all. A mechanism with nothing driving it runs under gravity,
     and the solver projects each integrated step back onto the rigid-link
     constraints -- so the rods stay exactly rigid while the motion goes
     chaotic. Trace both bobs and the difference is easy to see. */
  const m = M.create();
  const o = M.addConnector(m, { x: 0, y: -150 }, true);
  const p1 = M.addConnector(m, { x: 160, y: -150 });
  const p2 = M.addConnector(m, { x: 300, y: -150 });
  M.addLink(m, [o, p1]);
  M.addLink(m, [p1, p2]);
  M.setTraced(m, p2, true);
  return m;
}

export const PRESETS = [
  { id: "four-bar", name: "Four-bar crank-rocker",
    blurb: "Grashof proportions, so the crank turns all the way round. The coupler point traces the classic figure.",
    gravity: false, build: fourBar },
  { id: "hoeken", name: "Hoeken straight-line",
    blurb: "Turns rotation into very nearly straight motion, with no slideway anywhere in it.",
    gravity: false, build: hoeken },
  { id: "drag-link", name: "Drag link",
    blurb: "The ground is the shortest link, so both cranks rotate fully and the follower runs at a varying speed.",
    gravity: false, build: dragLink },
  { id: "ternary", name: "Triangular coupler plate",
    blurb: "The coupler is a rigid three-joint plate, not a bar. Its apex traces a curve no single bar could.",
    gravity: false, build: ternaryPlate },
  { id: "pendulum", name: "Double pendulum",
    blurb: "No motor: it runs under gravity alone, and the rods stay exactly rigid while the motion goes chaotic.",
    gravity: true, build: doublePendulum },
];

export function buildPreset(id) {
  const preset = PRESETS.find((p) => p.id === id) || PRESETS[0];
  return { mechanism: preset.build(), gravity: preset.gravity, preset };
}
