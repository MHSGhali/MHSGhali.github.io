/* Ported from the C tool's tests/test_mechanism.c.

   These are the sixteen engine tests from that suite, kept under their
   original names so a failure here maps straight back to the C test that
   covers the same behaviour. (The other four tests there cover the SDL
   toolbar, which this port replaces with a web UI.)

   Run: node --test tests/ */

import test from "node:test";
import assert from "node:assert/strict";

import * as M from "../js/linkage/mechanism.js";
import * as S from "../js/linkage/solver.js";
import { exportBlenderScript, EXPORT_FRAMES } from "../js/linkage/blender.js";
import * as v from "../js/linkage/vec2.js";

const close = (actual, expected, tol, msg) =>
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${msg}: expected ${expected}, got ${actual} (diff ${Math.abs(actual - expected)})`
  );

/* The four-bar family used throughout: O2=(0,0), O4=(4,0), crank 1,
   coupler 3, rocker 2. B is left at a geometrically valid theta=0 assembly,
   NOT at a test's chosen seed -- freeze() captures rest lengths from whatever
   the CURRENT positions are, so B must still be at the correct design geometry
   at that moment. Move B to an imperfect seed only AFTER freezing, so the seed
   serves purely as Newton's warm start without corrupting the rest lengths. */
function buildFourBar() {
  const m = M.create();
  const o2 = M.addConnector(m, { x: 0, y: 0 }, true);
  const o4 = M.addConnector(m, { x: 4, y: 0 }, true);
  const a = M.addConnector(m, { x: 1, y: 0 });
  const b = M.addConnector(m, { x: 10 / 3, y: (4 * Math.SQRT2) / 3 });
  M.addLink(m, [o2, a]);
  M.addLink(m, [a, b]);
  M.addLink(m, [b, o4]);
  M.toggleDriven(m, 0, 0);
  return { m, o2, o4, a, b };
}

test("four_bar_reduces_to_closed_form", () => {
  const { m, a, b } = buildFourBar();
  S.freeze(m);
  m.connectors[b].pos = { x: 3, y: 1 }; /* imperfect seed, set only after freezing */
  m.links[0].accumulatedAngleRad = Math.PI / 2;
  const params = S.defaultParams();
  const converged = S.solveAtCurrentAngle(m, params);

  assert.ok(converged, "four-bar solve converges");
  close(m.connectors[a].pos.x, 0, 1e-6, "four-bar A.x");
  close(m.connectors[a].pos.y, 1, 1e-6, "four-bar A.y");
  close(m.connectors[b].pos.x, (44 + 4 * Math.SQRT2) / 17, 1e-6, "four-bar B.x");
  close(m.connectors[b].pos.y, (6 + 16 * Math.SQRT2) / 17, 1e-6, "four-bar B.y");
});

test("ternary_link_rigidity", () => {
  /* A ternary link {A,P2,P3}: every internal pair is held, including the
     non-consecutive P2-P3. Driven only 10 degrees, because a one-shot solve
     from the unrotated design pose can otherwise land on the other branch. */
  const m = M.create();
  const o2 = M.addConnector(m, { x: 0, y: 0 }, true);
  const o4 = M.addConnector(m, { x: 6, y: 0 }, true);
  const a = M.addConnector(m, { x: 2, y: 0 });
  const p2 = M.addConnector(m, { x: 4, y: 2 });
  const p3 = M.addConnector(m, { x: 5, y: -1 });
  M.addLink(m, [o2, a]);
  M.addLink(m, [a, p2, p3]);
  M.addLink(m, [p3, o4]);
  M.toggleDriven(m, 0, 0);

  const restAP2 = v.dist(m.connectors[a].pos, m.connectors[p2].pos);
  const restAP3 = v.dist(m.connectors[a].pos, m.connectors[p3].pos);
  const restP2P3 = v.dist(m.connectors[p2].pos, m.connectors[p3].pos);

  S.freeze(m);
  m.links[0].accumulatedAngleRad = Math.PI / 18; /* 10 degrees */
  assert.ok(S.solveAtCurrentAngle(m, S.defaultParams()), "ternary-link solve converges");

  close(v.dist(m.connectors[a].pos, m.connectors[p2].pos), restAP2, 1e-5, "ternary A-P2 stays rigid");
  close(v.dist(m.connectors[a].pos, m.connectors[p3].pos), restAP3, 1e-5, "ternary A-P3 stays rigid");
  close(v.dist(m.connectors[p2].pos, m.connectors[p3].pos), restP2P3, 1e-5,
    "ternary P2-P3 stays rigid (non-consecutive pair)");
});

test("dead_center_singularity_is_solved", () => {
  /* Driven to the exact fully-extended dead centre. Anywhere with B.y == 0
     the Jacobian's y-column is exactly zero, so seeding B on that degenerate
     line exercises the singular direction head-on: damping has to restrain it
     or the solve either divides through a singular matrix or runs away. */
  const { m, a, b } = buildFourBar();
  S.freeze(m);
  m.connectors[b].pos = { x: 1.5, y: 0 };
  m.links[0].accumulatedAngleRad = Math.PI;
  const params = S.defaultParams();
  S.solveAtCurrentAngle(m, params);

  close(m.connectors[a].pos.x, -1, 1e-6, "dead-center A.x");
  close(m.connectors[a].pos.y, 0, 1e-6, "dead-center A.y");
  close(m.connectors[b].pos.x, 2, 1e-3, "dead-center B.x");
  close(m.connectors[b].pos.y, 0, 1e-3, "dead-center B.y");
  assert.ok(!S.hasLengthViolation(m, params.lengthTolAbs, params.lengthTolRel),
    "dead-center solve leaves no length violation");
});

test("near_null_direction_does_not_stall_the_solve", () => {
  /* A pendulum hanging straight down: dx == 0, so moving sideways changes the
     rod's length only to second order. Per-diagonal damping barely restrains
     that direction, every proposed step is rejected, and the rod silently
     stretches. This is the shape of a motorless mechanism under gravity. */
  const m = M.create();
  const o = M.addConnector(m, { x: 400, y: 200 }, true);
  const bob = M.addConnector(m, { x: 400, y: 400 });
  M.addLink(m, [o, bob]);

  S.freeze(m); /* rest length 200 */
  const params = S.defaultParams();

  /* Displace it the way a fast-moving gravity step would: mostly sideways,
     dropping it off the constraint circle. */
  m.connectors[bob].pos = { x: 388, y: 401 };
  S.solveAtCurrentAngle(m, params);

  close(v.dist(m.connectors[o].pos, m.connectors[bob].pos), 200, 1e-6,
    "the rod is pulled back to its rest length");
  assert.ok(!S.hasLengthViolation(m, params.lengthTolAbs, params.lengthTolRel),
    "no length violation is reported after the correction");
});

test("motorless_mechanism_falls_under_gravity", () => {
  const m = M.create();
  const o = M.addConnector(m, { x: 400, y: 200 }, true);
  const bob = M.addConnector(m, { x: 600, y: 200 });
  M.addLink(m, [o, bob]);
  assert.ok(!M.hasDrivenLink(m), "mechanism reports having no driven link");

  S.freeze(m);
  const params = S.defaultParams();
  params.gravity = { x: 0, y: 400 };

  const startY = m.connectors[bob].pos.y;
  let everViolated = false;
  for (let f = 0; f < 600; f++) {
    S.advance(m, 1 / 60, params);
    if (S.hasLengthViolation(m, params.lengthTolAbs, params.lengthTolRel)) {
      everViolated = true;
      break;
    }
  }

  assert.ok(!everViolated, "a motorless pendulum never spuriously binds while swinging");
  assert.ok(m.connectors[bob].pos.y > startY + 50, "gravity actually swung the bob downward");
  close(v.dist(m.connectors[o].pos, m.connectors[bob].pos), 200, 1e-3,
    "the rod held its length for the whole swing");
});

test("connector_tracing", () => {
  const m = M.create();
  const o2 = M.addConnector(m, { x: 0, y: 0 }, true);
  const a = M.addConnector(m, { x: 1, y: 0 });
  M.addLink(m, [o2, a]);
  M.toggleDriven(m, 0, 0);
  M.setTraced(m, a, true);

  S.freeze(m);
  M.clearTraces(m);
  const params = S.defaultParams();

  for (const angle of [0, Math.PI / 2, Math.PI]) {
    m.links[0].accumulatedAngleRad = angle;
    S.solveAtCurrentAngle(m, params);
    M.traceStep(m);
  }

  assert.equal(m.connectors[a].path.length, 3, "traced connector recorded one point per step");
  close(m.connectors[a].path[0].x, 1, 1e-9, "path point 0 x");
  close(m.connectors[a].path[0].y, 0, 1e-9, "path point 0 y");
  close(m.connectors[a].path[1].x, 0, 1e-9, "path point 1 x");
  close(m.connectors[a].path[1].y, 1, 1e-9, "path point 1 y");
  close(m.connectors[a].path[2].x, -1, 1e-9, "path point 2 x");
  close(m.connectors[a].path[2].y, 0, 1e-9, "path point 2 y");

  M.clearTraces(m);
  assert.ok(m.connectors[a].path.length === 0 && m.connectors[a].traced,
    "clear_traces resets count but keeps flag");

  M.setTraced(m, a, false);
  assert.equal(m.connectors[a].path.length, 0, "untracing discards the path");
});

test("mechanism_clone_is_independent_deep_copy", () => {
  const m = M.create();
  const o2 = M.addConnector(m, { x: 0, y: 0 }, true);
  const a = M.addConnector(m, { x: 1, y: 0 });
  const b = M.addConnector(m, { x: 1, y: 1 });
  M.addLink(m, [o2, a]);
  M.addLink(m, [a, b]);
  M.toggleDriven(m, 0, 45);
  M.setTraced(m, b, true);
  S.freeze(m);
  M.traceStep(m);

  const clone = M.clone(m);

  /* Mutate the original after cloning; the clone must be unaffected -- this
     is exactly the property undo relies on. */
  m.connectors[a].pos = { x: 99, y: 99 };
  M.setAnchor(m, b, true);
  M.deleteLink(m, 1);

  assert.equal(clone.connectors.length, 3, "clone connector count matches");
  assert.equal(clone.links.length, 2, "clone link count matches");
  close(clone.connectors[a].pos.x, 1, 1e-12, "clone A.x unaffected by later mutation");
  assert.equal(clone.connectors[b].isAnchor, false, "clone B isAnchor unaffected by later mutation");
  assert.ok(clone.links[1].alive, "clone link 1 still alive after original's was deleted");
  assert.ok(clone.connectors[b].traced, "clone connector B traced flag preserved");
  assert.equal(clone.connectors[b].path.length, 1, "clone connector B path preserved");
  assert.ok(clone.links[0].isDriven, "clone link 0 isDriven preserved");
  close(clone.links[0].restDist[0], 1, 1e-12, "clone link 0 restDist preserved");
});

test("export_blender_script", () => {
  /* A Grashof crank-rocker (ground 400, crank 100, coupler 350, rocker 300:
     s+l = 500 <= p+q = 650, crank shortest), so the crank turns all the way
     round and the export has a full cycle of real motion to record. */
  const m = M.create();
  const bx = 100 + (300 * 300 - 300 * 300 + 350 * 350) / (2 * 300);
  const by = Math.sqrt(350 * 350 - (bx - 100) * (bx - 100));
  const o2 = M.addConnector(m, { x: 0, y: 0 }, true);
  const o4 = M.addConnector(m, { x: 400, y: 0 }, true);
  const a = M.addConnector(m, { x: 100, y: 0 });
  const b = M.addConnector(m, { x: bx, y: by });
  M.addLink(m, [o2, a]);
  M.addLink(m, [a, b]);
  M.addLink(m, [b, o4]);
  M.toggleDriven(m, 0, 90);

  const buf = exportBlenderScript(m, S.defaultParams());
  assert.ok(typeof buf === "string" && buf.length > 0, "exportBlenderScript returns a script");

  assert.ok(buf.includes("unit_settings.system = 'METRIC'"), "script sets metric units");
  assert.ok(buf.includes("def make_joint("), "script builds joints");
  assert.ok(buf.includes("def make_rod("), "script builds rods");
  assert.ok(buf.includes('("Anchor_0", True)'), "script names the anchor joints");
  assert.ok(buf.includes('("Joint_2", False)'), "script names the moving joints");
  assert.ok(buf.includes('("Link0_c0c2"'), "script includes a rod for the crank link");
  assert.ok(buf.includes('("Link1_c2c3"'), "script includes a rod for the coupler link");

  assert.ok(buf.includes("FRAMES = ["), "script emits a per-frame position table");
  assert.ok(buf.includes("keyframe_insert('location'"), "script keyframes rod position");
  assert.ok(buf.includes("keyframe_insert('rotation_quaternion'"), "script keyframes rod orientation");
  assert.ok(buf.includes("keyframe_insert('scale'"), "script keyframes rod length");
  assert.ok(buf.includes("scene.frame_end"), "script sets the scene frame range");
  assert.ok(buf.includes("'LINEAR'"), "script uses linear interpolation between samples");

  const rows = buf.split("\n").filter((l) => l.startsWith("    [("));
  assert.equal(rows.length, EXPORT_FRAMES, "a fully rotating mechanism records every animation frame");

  /* A static export would repeat one pose. Compare the first row against one
     a quarter of the way through rather than the last: the crank completes
     exactly one revolution, so the final frame lands back on the start. */
  assert.notEqual(rows[0], rows[Math.floor(EXPORT_FRAMES / 4)],
    "the recorded frames are not all the same pose");
});

test("export_animation_actually_moves", () => {
  const m = M.create();
  const o2 = M.addConnector(m, { x: 0, y: 0 }, true);
  const a = M.addConnector(m, { x: 100, y: 0 });
  M.addLink(m, [o2, a]);
  M.toggleDriven(m, 0, 90);

  const buf = exportBlenderScript(m, S.defaultParams());
  const frames = buf.slice(buf.indexOf("FRAMES = ["));
  assert.ok(frames.length > 0, "frame table present");
  assert.ok(frames.includes("(100.0000,0.0000)"), "first frame holds the starting pose");
  assert.ok(frames.includes("(-99.") || frames.includes("(-100."),
    "the crank tip swings to the opposite side");
});

test("gravity_moves_free_unconstrained_connector", () => {
  /* A single free connector with no links: the Gauss-Newton stage has nothing
     to project against, so this isolates the Verlet gravity step. Starting at
     rest (prevPos == pos, set by freeze), one step of dt moves it by
     gravity * dt^2 exactly. */
  const m = M.create();
  const a = M.addConnector(m, { x: 0, y: 0 });

  S.freeze(m);
  const params = S.defaultParams();
  assert.ok(params.gravity.x === 0 && params.gravity.y === 0, "gravity is off by default");
  params.gravity = { x: 0, y: 100 };

  S.advance(m, 1, params);
  close(m.connectors[a].pos.y, 100, 1e-9, "gravity displaces an unconstrained connector by g*dt^2");
  close(m.connectors[a].pos.x, 0, 1e-9, "gravity does not introduce sideways drift");
});

test("gravity_preserves_rigid_constraint", () => {
  const m = M.create();
  const o = M.addConnector(m, { x: 0, y: 0 }, true);
  const p = M.addConnector(m, { x: 50, y: 0 });
  M.addLink(m, [o, p]);

  S.freeze(m);
  const params = S.defaultParams();
  params.gravity = { x: 0, y: 500 };

  for (let i = 0; i < 30; i++) S.advance(m, 1 / 60, params);

  close(v.dist(m.connectors[o].pos, m.connectors[p].pos), 50, 1e-3,
    "gravity-driven pendulum keeps its rod length rigid");
  assert.ok(m.connectors[p].pos.y > 1, "gravity pulls the pendulum bob downward over time");
});

test("variable_link_holds_its_length_when_nothing_forces_it", () => {
  const m = M.create();
  const o = M.addConnector(m, { x: 0, y: 0 }, true);
  const a = M.addConnector(m, { x: 50, y: 0 });
  const lid = M.addLink(m, [o, a]);

  assert.ok(m.links[lid].rigid, "links default to rigid");
  M.setRigid(m, lid, false);
  assert.ok(!m.links[lid].rigid, "setRigid can turn rigidity off");

  S.freeze(m); /* rest = 50 */
  const params = S.defaultParams();

  /* Simulate having dragged A far away in edit mode, then run one frame. */
  m.connectors[a].pos = { x: 500, y: 0 };
  S.solveAtCurrentAngle(m, params);

  close(v.dist(m.connectors[o].pos, m.connectors[a].pos), 50, 1e-3,
    "a variable link still pulls back to its rest length when unforced");
});

test("variable_link_stretches_only_as_far_as_forced", () => {
  /* B is held exactly 150 from O4 by a RIGID link, so it can never come
     closer than 250 to O2 -- yet the VARIABLE link O2-B only wants to be 100
     long. It must stretch, but only to 250: the least the geometry leaves. */
  const m = M.create();
  const o2 = M.addConnector(m, { x: 0, y: 0 }, true);
  const o4 = M.addConnector(m, { x: 400, y: 0 }, true);
  const b = M.addConnector(m, { x: 250, y: 0 });
  M.addLink(m, [b, o4]);
  const variableId = M.addLink(m, [o2, b]);
  M.setRigid(m, variableId, false);

  S.freeze(m);
  /* Freeze captures rest lengths from the current layout (150 and 250);
     shorten what the variable link wants so it is genuinely forced. */
  m.links[variableId].restDist[0] = 100;

  const params = S.defaultParams();
  S.solveAtCurrentAngle(m, params);

  close(v.dist(m.connectors[b].pos, m.connectors[o4].pos), 150, 1e-3,
    "the rigid link is held exactly at its rest length");
  close(v.dist(m.connectors[o2].pos, m.connectors[b].pos), 250, 1e-3,
    "the variable link stretches only as far as the rigid geometry forces");
  assert.ok(!S.hasLengthViolation(m, params.lengthTolAbs, params.lengthTolRel),
    "a forced variable link does not count as the mechanism binding");
});

test("toggling_back_to_rigid_reenforces_constraint", () => {
  const m = M.create();
  const o = M.addConnector(m, { x: 0, y: 0 }, true);
  const a = M.addConnector(m, { x: 50, y: 0 });
  const lid = M.addLink(m, [o, a]);

  M.setRigid(m, lid, false);
  S.freeze(m);
  const params = S.defaultParams();

  /* Re-freezing after toggling back to rigid captures whatever the CURRENT
     distance is as the new fixed length. */
  M.setRigid(m, lid, true);
  m.connectors[a].pos = { x: 50, y: 500 };
  S.freeze(m);
  const expectedLen = v.dist(m.connectors[o].pos, m.connectors[a].pos);
  m.connectors[a].pos = v.add(m.connectors[a].pos, { x: 10, y: 10 });
  S.solveAtCurrentAngle(m, params);

  close(v.dist(m.connectors[o].pos, m.connectors[a].pos), expectedLen, 1e-3,
    "re-enabled rigidity restores the (new) fixed length");
});

test("jam_detection", () => {
  /* A four-bar that binds as soon as the crank turns: ground 400, crank 100,
     coupler 150, rocker 150. B must be 150 from A and 150 from O4, needing
     |A - O4| <= 300. At crank angle 0 that is exactly 300; at any other angle
     A swings away and the loop cannot close without stretching. */
  const m = M.create();
  const o2 = M.addConnector(m, { x: 0, y: 0 }, true);
  const o4 = M.addConnector(m, { x: 400, y: 0 }, true);
  const a = M.addConnector(m, { x: 100, y: 0 });
  const b = M.addConnector(m, { x: 250, y: 0 });
  M.addLink(m, [o2, a]);
  M.addLink(m, [a, b]);
  M.addLink(m, [b, o4]);
  M.toggleDriven(m, 0, 0);

  S.freeze(m);
  const params = S.defaultParams();

  S.solveAtCurrentAngle(m, params);
  assert.ok(!S.hasLengthViolation(m, 0.02, 0.0001),
    "the assemblable starting position reports no violation");

  m.links[0].accumulatedAngleRad = Math.PI / 4;
  S.solveAtCurrentAngle(m, params);

  assert.ok(S.hasLengthViolation(m, 0.02, 0.0001),
    "driving past the linkage's limit is reported as a length violation");

  /* Confirm the report reflects a real stretch, not solver noise. */
  const span = v.dist(m.connectors[a].pos, m.connectors[o4].pos);
  assert.ok(span > 300.25, "the required span really exceeds coupler + rocker");
  const couplerLen = v.dist(m.connectors[a].pos, m.connectors[b].pos);
  const rockerLen = v.dist(m.connectors[b].pos, m.connectors[o4].pos);
  assert.ok(Math.abs(couplerLen - 150) > 0.25 || Math.abs(rockerLen - 150) > 0.25,
    "at least one fixed link is visibly off its rest length");
});

test("working_mechanism_reports_no_jam", () => {
  /* The same four-bar at app-scale coordinates (hundreds of units), to
     confirm the jam check is scale-aware rather than tied to an absolute
     residual tolerance. */
  const m = M.create();
  const o2 = M.addConnector(m, { x: 0, y: 0 }, true);
  const o4 = M.addConnector(m, { x: 400, y: 0 }, true);
  const a = M.addConnector(m, { x: 100, y: 0 });
  const b = M.addConnector(m, { x: 1000 / 3, y: (400 * Math.SQRT2) / 3 });
  M.addLink(m, [o2, a]);
  M.addLink(m, [a, b]);
  M.addLink(m, [b, o4]);
  M.toggleDriven(m, 0, 0);

  S.freeze(m);
  const params = S.defaultParams();

  for (let step = 1; step <= 10; step++) {
    m.links[0].accumulatedAngleRad = (Math.PI / 4) * (step / 10);
    S.solveAtCurrentAngle(m, params);
    assert.ok(!S.hasLengthViolation(m, 0.02, 0.0001),
      `a solvable four-bar never reports a length violation (step ${step})`);
  }
});
