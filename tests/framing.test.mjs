/* Camera framing for the homepage walker.

   framing.js exists as a separate, three.js-free module precisely so that "is
   the creature actually on screen?" can be asked as a number instead of
   squinted at in a browser -- but nothing asked it until now. These tests pin
   the answer, because the framing deliberately crops: the creature used to be
   fitted whole and read as a grey knot, and the fix is to let the ends of the
   crankshaft run off the sides. That is only safe while the crop stays
   sideways and stays bounded, which is what is checked here. */

import test from "node:test";
import assert from "node:assert/strict";

import { sweptBox, project, fitCamera } from "../js/walker/framing.js";
import { legExtent } from "../js/walker/jansen.js";

/* The homepage's own numbers, from js/hero-walkers.js. */
const LEGS = 6;
const LEG_SPACING = 52;
const FRAMING = { fillX: 1.22, fillY: 0.88 };

/* Shapes to stay SAFE at: everything down to absurdly narrow, because the crop
   must never eat the creature whatever the window does. */
const ASPECTS = [2.4, 1.78, 1.4, 1.0, 0.72];
/* Shapes the hero is actually painted at. main.css hides the background below
   640px, and the hero box is a full-width band a few hundred pixels tall, so
   in practice it is always wider than it is tall. Below about 1.4 the frame is
   width-limited and the creature is legitimately smaller -- promising a fill
   there would be promising something the geometry cannot give. */
const FILL_ASPECTS = [2.4, 1.78, 1.4];
/* Every angle the drag allows. PITCH_LIMIT in hero-walkers.js is ~0.5 rad. */
const YAWS = [0, 0.4, 1.0, Math.PI / 2, 2.4, Math.PI];
const PITCHES = [-0.5, 0, 0.5];

const box = () => sweptBox(legExtent(), LEGS, LEG_SPACING);

function ndcFor(aspect, yaw, pitch) {
  const b = box();
  const f = fitCamera(b, aspect, { ...FRAMING, yaw, pitch });
  return project(
    b.corners.map((c) => spin(c, b, yaw, pitch)),
    f.eye, f.at, f.fovDeg, aspect,
  );
}

/* fitCamera rotates the corners internally; repeat it here so the assertions
   measure what the camera was actually solved against. */
function spin(p, b, yaw, pitch) {
  let x = p.x - b.cx, y = p.y - b.cy, z = p.z;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const nx = x * cy + z * sy;
  z = -x * sy + z * cy; x = nx;
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  return { x: x + b.cx, y: (y * cp - z * sp) + b.cy, z: y * sp + z * cp };
}

test("the creature is never cropped vertically, at any shape or angle", () => {
  for (const aspect of ASPECTS)
    for (const yaw of YAWS)
      for (const pitch of PITCHES) {
        const n = ndcFor(aspect, yaw, pitch);
        const worst = Math.max(-n.y0, n.y1);
        assert.ok(
          worst <= 1,
          `feet or crank clipped at aspect ${aspect}, yaw ${yaw}, pitch ${pitch}: ${worst.toFixed(3)}`,
        );
      }
});

test("the horizontal crop stays bounded -- ends of the crankshaft only", () => {
  for (const aspect of ASPECTS)
    for (const yaw of YAWS)
      for (const pitch of PITCHES) {
        const n = ndcFor(aspect, yaw, pitch);
        const worst = Math.max(-n.x0, n.x1);
        assert.ok(
          worst <= FRAMING.fillX + 0.02,
          `cropped further than asked at aspect ${aspect}, yaw ${yaw}: ${worst.toFixed(3)}`,
        );
      }
});

test("the creature fills the frame it is given", () => {
  /* The point of the crop. Fitted whole, the vertical extent fell as low as a
     third of the frame at some angles, which is what made it unreadable. */
  for (const aspect of FILL_ASPECTS)
    for (const yaw of YAWS) {
      const n = ndcFor(aspect, yaw, 0);
      const height = n.y1 - n.y0;
      assert.ok(
        height >= 0.9,
        `creature too small at aspect ${aspect}, yaw ${yaw}: height ${height.toFixed(3)} of 2`,
      );
    }
});

test("it sits right of centre, clear of the headline", () => {
  /* The text column owns the left of the hero; the mask fades the background
     out there. A framing that re-centres the creature puts it under the
     headline, where its contrast competes with the text's. */
  for (const aspect of ASPECTS.filter((a) => a >= 1.4)) {
    const f = fitCamera(box(), aspect, FRAMING);
    assert.ok(f.shift > 0, `no rightward bias at aspect ${aspect}`);
  }
});

test("a box that is turned end-on is still solved, not backed away from", () => {
  /* Seen down the crankshaft the six legs become a row nearly three times as
     wide. Converging from one side only left it tiny; this is the regression
     that comment in fitCamera describes. */
  const wide = ndcFor(1.78, Math.PI / 2, 0);
  const narrow = ndcFor(1.78, 0, 0);
  const h = (n) => n.y1 - n.y0;
  assert.ok(
    Math.abs(h(wide) - h(narrow)) < 0.75,
    `end-on framing differs too much: ${h(wide).toFixed(2)} vs ${h(narrow).toFixed(2)}`,
  );
});
