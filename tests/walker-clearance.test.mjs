/* Can the creature actually be built?

   A linkage drawing is allowed to let two bars cross. A machine is not: if two
   members occupy the same space they foul, and the thing does not turn. The
   homepage creature is drawn as solid rods with real thickness, so the question
   has a numeric answer, and this is where it is asked -- over a whole
   revolution, between every pair of members, in three dimensions.

   It is not an idle check. The assembly that used to ship had three pairs of
   members passing through one another for 100% of the turn, and a forward and a
   backward leg sharing one plane on the shaft, which put a whole second leg
   inside the first. Neither is visible in a still; both are obvious once you
   look for them, and impossible to miss once you try to make one.

   Two members that share a PIN are allowed to touch -- that is what a joint is.
   A pin is identified by where it sits in the walking plane rather than by
   which leg it belongs to, because the crankshaft and the two rocker axles run
   the length of the creature and every leg is pinned to all three. */

import test from "node:test";
import assert from "node:assert/strict";

import { buildCreature, advance, members, BUILD, LAYOUT, PLANES } from "../js/walker/creature.js";

/* Shortest distance between two 3D segments. The standard clamped solve; the
   parallel case is what the degenerate-denominator branch is for. */
function segDist(p1, q1, p2, q2) {
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s, t;
  if (a <= 1e-12 && e <= 1e-12) return len(r);
  if (a <= 1e-12) { s = 0; t = clamp(f / e); }
  else {
    const c = dot(d1, r);
    if (e <= 1e-12) { t = 0; s = clamp(-c / a); }
    else {
      const b = dot(d1, d2), denom = a * e - b * b;
      s = denom > 1e-12 ? clamp((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a); }
      else if (t > 1) { t = 1; s = clamp((b - c) / a); }
    }
  }
  return len(sub(add(p1, scale(d1, s)), add(p2, scale(d2, t))));
}
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale = (a, k) => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a) => Math.hypot(a.x, a.y, a.z);
const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

const sharesPin = (m, n) => m.pins.some((p) => n.pins.includes(p));

/* Walks a whole revolution and returns the worst offender, if any. */
function worstFoul() {
  const c = buildCreature();
  const dt = 1 / 240;
  /* One full turn of the crank, sampled finely enough that a member cannot slip
     through another between samples: the fastest joint moves a fraction of a
     rod radius per step at this rate. */
  const steps = Math.ceil((360 / LAYOUT.CRANK_DEG_S) / dt);
  let worst = null;
  for (let step = 0; step < steps; step++) {
    advance(c, dt);
    const mem = members(c);
    for (let i = 0; i < mem.length; i++) {
      for (let j = i + 1; j < mem.length; j++) {
        const m = mem[i], n = mem[j];
        if (sharesPin(m, n)) continue;
        const need = m.r + n.r;
        const d = segDist(m.a, m.b, n.a, n.b);
        if (d >= need) continue;
        const overlap = need - d;
        if (!worst || overlap > worst.overlap) {
          worst = { overlap, gap: d, need, i, j, m, n, step };
        }
      }
    }
  }
  return worst;
}

test("no two members of the creature ever occupy the same space", () => {
  const w = worstFoul();
  assert.equal(
    w, null,
    w && `${w.m.kind}(leg ${w.m.leg}) and ${w.n.kind}(leg ${w.n.leg}) overlap by ` +
         `${w.overlap.toFixed(2)} -- ${w.gap.toFixed(2)} apart, needing ${w.need.toFixed(2)}`,
  );
});

test("every leg has the shaft to itself", () => {
  /* The cheap half of the same guarantee, stated separately because it is the
     one that was wrong: a forward-reaching leg and its backward-reaching
     partner used to be given the same z, so one was drawn inside the other. */
  const c = buildCreature();
  const zs = c.legs.map((l) => l.z);
  assert.equal(new Set(zs).size, zs.length, `legs share a plane: ${zs.join(", ")}`);
  assert.equal(zs.length, PLANES, "PLANES disagrees with the number of legs");
});

test("the bars are thick enough to be real", () => {
  /* The clearance result above means nothing if the rods are hairlines. These
     are the thicknesses the renderer draws and the test measures. */
  assert.ok(BUILD.rodR > 0.5, "rods too thin for the clearance result to mean anything");
  assert.ok(BUILD.jointR >= BUILD.rodR, "a pin should be at least as fat as its bar");
  assert.ok(BUILD.frameR >= BUILD.rodR, "the chassis should be no lighter than a leg bar");
});
