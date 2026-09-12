/* Theo Jansen's leg linkage -- the Strandbeest leg -- built on the same
   engine the linkage tool runs.

   THE NUMBERS. The thirteen link lengths are Jansen's "holy numbers", the
   proportions he arrived at by evolutionary search scored on the gait alone.
   They are dimensionless ratios; nothing here depends on the unit.

   THE CONSTRUCTION. Two ground pivots are fixed, the crank centre O = (0,0)
   and the frame pivot G = (-a,-l). With the crank tip J1 = O + m(cos t, sin t),
   every remaining joint is the intersection of two circles:

       J2 = circ(J1, j; G, b)      J3 = circ(J2, e; G, d)
       J4 = circ(J1, k; G, c)      J5 = circ(J3, f; J4, g)
       F  = circ(J4, i; J5, h)          <- the foot

   That is the forward-kinematic model in Wang, "Durability-Aware
   Multi-Objective Optimization of the Jansen Linkage" (arXiv:2606.22129),
   section 2. Two circles meet in two places, so the thirty-two combinations are
   thirty-two different linkages; BRANCH below says which of them this is, and
   the comment there says what it was chosen for.

   WHY BOTH A CONSTRUCTION AND A MECHANISM. The construction places the joints
   for the starting pose. From there the linkage is handed to the real solver,
   as seven rigid bodies on ten revolute joints, and it is the solver that runs
   it -- so the background is the same engine as the tool, not a canned
   animation. The two agree to about 1e-7 of a link length over a revolution. */

import * as M from "../linkage/mechanism.js?v=3d923acb";
import * as S from "../linkage/solver.js?v=3d923acb";

/* Thirteen lengths, but only six distinct ones.

   Jansen's own "holy numbers" are thirteen separate values, six of which sit
   between 36.7 and 41.5 and differ only in the third significant figure. That
   is what an evolutionary search returns; it is not what anyone building the
   thing would choose. Collapsing those six onto a single bar length leaves a
   linkage with six lengths to cut instead of thirteen, which is why physical
   desktop Jansen walkers are built this way, and it costs little: the leg still
   behaves like Jansen's, and what it gives up in optimality it repays in being
   a machine rather than a table of constants.

   They are dimensionless ratios; nothing here depends on the unit. */
export const HOLY = {
  a: 40.0, b: 40.0, c: 40.0, d: 40.0, e: 56.4, f: 40.0, g: 40.0,
  h: 64.3, i: 50.0, j: 50.0, k: 64.3, l: 9.1, m: 15.0,
};

/* WHICH ASSEMBLY. Five circle-circle intersections, two solutions each, so the
   same thirteen bars go together thirty-two different ways and every one of
   them is a real linkage with a real gait. The choice is not cosmetic and it is
   not obvious; this one was found by sweeping all thirty-two and scoring them,
   and it is worth writing down what it was scored on, because an earlier
   version of this file chose differently and the difference decides how many
   legs the creature needs and whether it could be built at all.

     DUTY. This assembly keeps its foot down for 65% of the turn against about
     20% for the classic one: a long flat stance rather than a deep arc. That is
     what lets FOUR legs always keep two feet on the ground. At 20% it takes ten
     legs to manage the same, and two feet is not a luxury -- with only one down
     a planar body has nothing to fix its pitch by and it topples.

     CLEARANCE. No two members of this leg ever cross each other, at any angle
     of the crank. The classic assembly has three pairs that pass through one
     another for the whole revolution -- G-J2 through J1-J4, and J2-J3 through
     both J1-J4 and G-J4 -- which a drawing gets away with and a machine does
     not. tests/walker-clearance.test.mjs holds this.

   What it gives up is stride: the foot advances 13.4 per radian of crank rather
   than 34.5, and lifts 13 rather than 27, so this is a slower and flatter-footed
   walker than the classic leg. For something that has to carry its own weight on
   four legs and be buildable, that is the right way round. */
const BRANCH = [1, 1, -1, 1, -1];

function circ(p1, r1, p2, r2, sign) {
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const D = Math.hypot(dx, dy);
  if (D > r1 + r2 || D < Math.abs(r1 - r2) || D === 0) return null;
  const t = (r1 * r1 - r2 * r2 + D * D) / (2 * D);
  const hh = Math.sqrt(Math.max(0, r1 * r1 - t * t));
  return {
    x: p1.x + (t * dx) / D + sign * (hh * dy) / D,
    y: p1.y + (t * dy) / D - sign * (hh * dx) / D,
  };
}

/* Every joint of the leg at crank angle `theta`, in the frame where the crank
   centre is the origin and y points up. `dir` of -1 mirrors the leg in x, so a
   creature can be built to walk either way. */
export function pose(theta, dir = 1) {
  const { a, b, c, d, e, f, g, h, i, j, k, l, m } = HOLY;
  const O = { x: 0, y: 0 };
  const G = { x: -a, y: -l };
  const J1 = { x: m * Math.cos(theta), y: m * Math.sin(theta) };
  const J2 = circ(J1, j, G, b, BRANCH[0]);
  const J3 = J2 && circ(J2, e, G, d, BRANCH[1]);
  const J4 = circ(J1, k, G, c, BRANCH[2]);
  const J5 = J3 && J4 && circ(J3, f, J4, g, BRANCH[3]);
  const F = J4 && J5 && circ(J4, i, J5, h, BRANCH[4]);
  if (!J2 || !J3 || !J4 || !J5 || !F) return null;
  const out = { O, G, J1, J2, J3, J4, J5, F };
  if (dir < 0) for (const key of Object.keys(out)) out[key] = { x: -out[key].x, y: out[key].y };
  return out;
}

/* The leg as a mechanism the solver can run: seven rigid bodies, ten revolute
   joints, one degree of freedom. Returns the mechanism and the connector ids,
   so a renderer can find the foot without guessing at indices.

   THE TWO ARGUMENTS ARE INDEPENDENT, and it matters. `dir` mirrors the leg's
   GEOMETRY in x; `shaftDegS` is the sense and speed of the crankshaft it hangs
   from. These used to be one thing -- the motor was set to speed * dir, on the
   reasoning that mirroring a leg reverses the crank it needs for the same gait
   -- and that is true of a whole mirrored CREATURE, walking the other way. It
   is exactly wrong for a pair of legs that face opposite ways on ONE shaft,
   which is the thing a body needs to stand on, and it fails silently: the legs
   look right, the gait looks right, and the creature pushes itself forwards and
   backwards in equal measure and stands still.

   So the two cases are now the caller's to say:

       buildLeg(+s, +1)   a forward-reaching leg
       buildLeg(+s, -1)   its partner reaching back off the SAME shaft; both
                          feet sweep the same way, so both push the same way
       buildLeg(-s, -1)   a mirrored creature, walking the other way */
export function buildLeg(shaftDegS = 60, dir = 1) {
  const p = pose(0, dir);
  const m = M.create();
  const id = {};
  for (const key of ["O", "G", "J1", "J2", "J3", "J4", "J5", "F"]) {
    id[key] = M.addConnector(m, p[key], key === "O" || key === "G");
  }
  M.addLink(m, [id.O, id.J1]);              /* m -- the crank            */
  M.addLink(m, [id.J1, id.J2]);             /* j                         */
  M.addLink(m, [id.G, id.J2, id.J3]);       /* b, d, e -- rocks about G  */
  M.addLink(m, [id.J1, id.J4]);             /* k                         */
  M.addLink(m, [id.G, id.J4]);              /* c                         */
  M.addLink(m, [id.J3, id.J5]);             /* f                         */
  M.addLink(m, [id.J4, id.J5, id.F]);       /* g, h, i -- the foot       */
  M.toggleDriven(m, 0, shaftDegS);
  S.freeze(m);
  return { mechanism: m, id };
}

/* The box one leg sweeps over a full revolution. Measured, not written down,
   so the camera that has to frame it follows the linkage if it ever changes. */
export function legExtent(samples = 720) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let n = 0; n < samples; n++) {
    const p = pose((n / samples) * 2 * Math.PI);
    if (!p) continue;
    for (const key of Object.keys(p)) {
      const q = p[key];
      if (q.x < x0) x0 = q.x;
      if (q.x > x1) x1 = q.x;
      if (q.y < y0) y0 = q.y;
      if (q.y > y1) y1 = q.y;
    }
  }
  return { x0, x1, y0, y1 };
}

/* Gait constants, measured from the construction rather than written down, so
   they follow the numbers above if those ever change.

   `advancePerRadian` is what makes the creature WALK rather than skate: during
   the stance the foot travels backwards relative to the body at this rate, so
   a body moving forwards at the same rate leaves the planted foot still. The
   classic proportions do not hold that speed perfectly constant -- the stance
   velocity varies about a quarter either side of its mean, which is one of the
   things later optimizations of the leg set out to improve -- so a little foot
   slip is inherent to the design, not to this simulation of it. */
export function gait(samples = 2000) {
  const pts = [];
  for (let n = 0; n < samples; n++) {
    const p = pose((n / samples) * 2 * Math.PI);
    if (p) pts.push(p.F);
  }
  const ys = pts.map((q) => q.y);
  const lo = Math.min(...ys), hi = Math.max(...ys);
  const threshold = lo + 0.15 * (hi - lo);   /* the paper's stance test */
  let sum = 0, n = 0;
  for (let s = 0; s < pts.length; s++) {
    if (pts[s].y >= threshold) continue;
    const q = pts[s], r = pts[(s + 1) % pts.length];
    sum += (r.x - q.x) / ((2 * Math.PI) / pts.length);
    n++;
  }
  return {
    footLow: lo,
    footHigh: hi,
    duty: n / pts.length,
    advancePerRadian: n ? sum / n : 0,
  };
}

/* The box a MIRRORED PAIR sweeps: one leg and its reflection, which is what
   hangs off each pin of the crankshaft. The camera has to frame the pair, not
   the leg, and the difference is not small -- a leg reaches from -107 to +25 of
   the crank centre, so the pair reaches ±107 and the creature is two thirds
   wider than a single row of legs would be. Measured, like legExtent, so the
   framing follows the linkage. */
export function pairExtent(samples = 720) {
  const e = legExtent(samples);
  return { x0: Math.min(e.x0, -e.x1), x1: Math.max(e.x1, -e.x0), y0: e.y0, y1: e.y1 };
}

/* Whether the foot is on the ground at this crank angle, by the same 15%-of-
   travel test gait() uses to measure the duty factor. Exported so the leg
   count and the phasing can be chosen against the leg's own geometry rather
   than against a number someone wrote down: with five pins carrying a mirrored
   pair each, this is what says at least two feet are always planted.

   Mirroring does not touch y, so a mirrored leg is tested with its OWN crank
   parameter and no sign to remember. */
let stanceThreshold = null;
export function inStance(theta) {
  if (stanceThreshold === null) {
    const g = gait();
    stanceThreshold = g.footLow + 0.15 * (g.footHigh - g.footLow);
  }
  const p = pose(theta);
  return !!p && p.F.y < stanceThreshold;
}
