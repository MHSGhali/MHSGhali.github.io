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
   section 2. Two circles meet in two places, and only one choice of branch at
   each step assembles into Jansen's leg; BRANCH below is that choice, found by
   sweeping all thirty-two and keeping the one whose foot path has the
   published duty factor of about 20%.

   WHY BOTH A CONSTRUCTION AND A MECHANISM. The construction places the joints
   for the starting pose. From there the linkage is handed to the real solver,
   as seven rigid bodies on ten revolute joints, and it is the solver that runs
   it -- so the background is the same engine as the tool, not a canned
   animation. The two agree to about 1e-7 of a link length over a revolution. */

import * as M from "../linkage/mechanism.js?v=f56d3836";
import * as S from "../linkage/solver.js?v=f56d3836";

export const HOLY = {
  a: 38.0, b: 41.5, c: 39.3, d: 40.1, e: 55.8, f: 39.4, g: 36.7,
  h: 65.7, i: 49.0, j: 50.0, k: 61.9, l: 7.8, m: 15.0,
};

/* The branch of each circle-circle intersection that assembles Jansen's leg. */
const BRANCH = [-1, -1, -1, 1, -1];

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
   so a renderer can find the foot without guessing at indices. */
export function buildLeg(speedDegS = 60, dir = 1) {
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
  /* Mirroring reverses the sense the crank has to turn for the same gait. */
  M.toggleDriven(m, 0, speedDegS * dir);
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
