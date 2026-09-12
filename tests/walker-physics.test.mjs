/* Does the homepage creature actually walk?

   It used to be carried: the whole thing slid forwards at `advancePerRadian`,
   the rate a planted foot sweeps backwards, and nothing was ever held up by
   anything. Now it has a body with mass and feet that push, which is worth
   having only if it is true -- and "it looks right in a browser" is not a way
   to know that. walker/creature.js and walker/body.js import no three.js
   precisely so these questions can be asked as numbers.

   The best of them is the third. `advancePerRadian` was the thing that moved
   the creature and is now a PREDICTION the contact physics has to reproduce,
   from the other end: gravity, normal forces, Coulomb friction and ten legs
   that know nothing about it. The two agreeing to a couple of percent is the
   single strongest evidence that the walk is real rather than staged. */

import test from "node:test";
import assert from "node:assert/strict";

import { LAYOUT, buildCreature, advance, supportCount, footOf } from "../js/walker/creature.js";
import { gait } from "../js/walker/jansen.js";

const OMEGA = (LAYOUT.CRANK_DEG_S * Math.PI) / 180;
/* Negative: the stance foot sweeps forwards relative to the body, so the body
   goes the other way. */
const PREDICTED = -gait().advancePerRadian * OMEGA;

function walk(seconds, dt = 1 / 60) {
  const c = buildCreature();
  const log = [];
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    advance(c, dt);
    log.push({ t: (i + 1) * dt, x: c.body.x, y: c.body.y, pitch: c.body.pitch });
  }
  /* The first turns are the creature settling onto its feet from the pose it
     was seeded in. Steady state is what the claims below are about. */
  return { c, log, steady: log.filter((r) => r.t > 10) };
}

function speedOf(steady) {
  const a = steady[0], b = steady[steady.length - 1];
  return (b.x - a.x) / (b.t - a.t);
}

test("at least two feet are on the ground at every angle of the crank", () => {
  /* This is what the leg count was chosen for, and it is the whole reason the
     creature can be given weight at all. Three pins and four pins both top out
     at one foot, which means the body pivoting about a single contact. */
  for (let d = 0; d < 720; d++) {
    const shaft = (d / 720) * 2 * Math.PI;
    const n = supportCount(shaft);
    assert.ok(n >= 2, `only ${n} feet down at shaft angle ${(d / 2).toFixed(1)} deg`);
  }
});

test("four legs are enough because the leg keeps its foot down", () => {
  /* Pins the reasoning, not just the answer. A planar body needs two feet down
     at all times, so N legs need each leg planted for at least half the turn.
     This assembly manages 65%, which is the whole reason the creature can be
     four-legged; the classic Jansen assembly manages 20% and needs ten legs to
     make the same promise. If anyone changes BRANCH or the proportions, this is
     what says whether four legs still work. */
  const duty = gait().duty;
  assert.ok(duty > 0.5, `duty is ${(duty * 100).toFixed(0)}%; four legs need over 50%`);
  assert.equal(LAYOUT.PINS * 2, 4, "the creature is meant to have four legs");
});

test("both rows of legs push the same way", () => {
  /* The failure this guards against is silent and total. Mirror the crank along
     with the leg and every leg still moves correctly, the gait still looks
     right, and the two rows shove the creature forwards and backwards in equal
     measure so it stands still on the spot. */
  const c = buildCreature();
  const before = c.legs.map(footOf);
  for (let i = 0; i < 30; i++) advance(c, 1 / 600);
  const after = c.legs.map(footOf);

  /* Only the planted feet, by the same 15%-of-travel test gait() uses: a foot
     in mid-swing travels the other way and says nothing about propulsion. */
  const g = gait();
  const planted = g.footLow + 0.15 * (g.footHigh - g.footLow);
  let front = 0, rear = 0;
  for (let i = 0; i < c.legs.length; i++) {
    if (before[i].y >= planted) continue;
    const dx = after[i].x - before[i].x;
    if (c.legs[i].dir > 0) front += dx; else rear += dx;
  }
  assert.ok(front !== 0 && rear !== 0, "no planted feet found to compare");
  assert.ok(
    Math.sign(front) === Math.sign(rear),
    `rows fight each other: front sweeps ${front.toFixed(2)}, rear ${rear.toFixed(2)}`,
  );
});

test("it walks at the speed its own leg geometry predicts", () => {
  const { steady } = walk(60);
  const speed = speedOf(steady);
  const ratio = speed / PREDICTED;
  assert.ok(
    ratio > 0.8 && ratio < 1.2,
    `physics and kinematics disagree: ${speed.toFixed(2)} against ${PREDICTED.toFixed(2)} units/s`,
  );
});

test("it stays on its feet", () => {
  const { c, steady } = walk(120);
  const ys = steady.map((r) => r.y);
  const pitches = steady.map((r) => Math.abs(r.pitch));

  assert.equal(c.body.reseats, 0, "the numerical guard in body.js fired; something is diverging");
  assert.ok(ys.every(Number.isFinite), "ride height went non-finite");

  /* It rides within a few units of where it was seated, neither sinking through
     the ground nor climbing off it, and it barely tilts at all.

     The tilt bound is tight on purpose. With two feet down the contacts all but
     dictate the body's pitch, so this is not measuring a margin of stability --
     it is measuring whether the two rows of legs are planting their feet at the
     same height, which is what LAYOUT.REAR_OFFSET is chosen for. It rocks
     through about a degree and a half at the chosen offset and through far more
     at most others, so a loose bound here would let that choice rot unnoticed.
     It still bobs, and that is a gait rather than a defect. */
  const rest = c.rideY;
  assert.ok(
    Math.min(...ys) > rest - 6 && Math.max(...ys) < rest + 6,
    `ride height drifted: ${Math.min(...ys).toFixed(1)}..${Math.max(...ys).toFixed(1)} from ${rest.toFixed(1)}`,
  );
  const worst = (Math.max(...pitches) * 180) / Math.PI;
  assert.ok(worst < 2.5, `pitching too far: ${worst.toFixed(2)} deg peak`);

  const bob = Math.max(...ys) - Math.min(...ys);
  assert.ok(bob > 0.1 && bob < 8, `bob is ${bob.toFixed(1)} units; it should walk, not glide or lurch`);
});

test("a planted foot stays planted", () => {
  /* The difference between walking and skating, stated as a number. A foot in
     contact should be standing still on the ground while the body travels over
     it -- that is the whole definition -- so its world position is what to
     watch, not the body's.

     Slip is weighted by how deep each foot is pressed into the ground, which
     stands in for how much load it carries. That is the honest measure: this
     leg keeps a foot down for 65% of the turn, and at the ends of so long a
     stance a foot is barely touching. Counting a skimming toe the same as one
     holding the creature up reports scuffing that nothing is actually standing
     on. Weighted, it is about 17% of the body's speed; unweighted, 29%.

     It is not zero and it cannot be. The foot's speed along its stance is far
     from constant, so several feet down at once are asking the body for
     different velocities and the lightest-loaded gives way. That is the price
     of the long flat stance that lets the creature stand on four legs at all;
     the classic Jansen assembly holds a foot far more steadily and needs ten
     legs to keep two of them down. Real Strandbeests scuff on sand for exactly
     this reason. A figure near one would mean the feet were being dragged and
     nothing was being pushed. */
  const dt = 1 / 240;
  const c = buildCreature();
  for (let i = 0; i < 240 * 25; i++) advance(c, dt);

  const worldFeet = () => {
    const cs = Math.cos(c.body.pitch), sn = Math.sin(c.body.pitch);
    return c.feetPrev.map((f) => {
      const rx = cs * f.x - sn * f.y, ry = sn * f.x + cs * f.y;
      return { x: c.body.x + rx, load: c.physics.groundY - (c.body.y + ry) };
    });
  };

  const startX = c.body.x;
  let prev = worldFeet(), slip = 0, weight = 0, contacts = 0;
  const frames = 240 * 20;
  for (let i = 0; i < frames; i++) {
    advance(c, dt);
    const now = worldFeet();
    for (let k = 0; k < now.length; k++) {
      if (now[k].load <= 0 || prev[k].load <= 0) continue;
      const w = Math.min(now[k].load, prev[k].load);
      slip += Math.abs(now[k].x - prev[k].x) * w;
      weight += w;
      contacts++;
    }
    prev = now;
  }
  assert.ok(contacts > 0, "no feet were ever in contact");

  const slipRate = slip / weight / dt;
  const bodySpeed = Math.abs(c.body.x - startX) / (frames * dt);
  const ratio = slipRate / bodySpeed;
  assert.ok(
    ratio < 0.3,
    `feet are skating, not walking: loaded feet slip at ${(ratio * 100).toFixed(0)}% of the body's speed`,
  );
});

test("the walk does not depend on the frame rate", () => {
  /* A browser hands back whatever it hands back, and hero-walkers.js clamps a
     frame at 1/20 s. The contacts are the stiffest thing in the simulation, so
     they run on a fixed substep underneath; this is what says that works. */
  const speeds = [1 / 120, 1 / 60, 1 / 30, 1 / 20].map((dt) => speedOf(walk(40, dt).steady));
  const lo = Math.min(...speeds), hi = Math.max(...speeds);
  assert.ok(
    Math.abs(hi - lo) < Math.abs(PREDICTED) * 0.05,
    `frame rate changes the walk: ${speeds.map((s) => s.toFixed(2)).join(", ")}`,
  );
});

test("it is deterministic", () => {
  /* Nothing here is stochastic, and a background that differs run to run would
     mean the contact solve is reading uninitialised state somewhere. */
  const a = walk(20).log;
  const b = walk(20).log;
  assert.deepEqual(a[a.length - 1], b[b.length - 1]);
});
