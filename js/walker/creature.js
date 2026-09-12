/* The creature itself: ten legs, one crankshaft, one body with weight.

   Kept apart from the renderer, and free of three.js, for the same reason
   framing.js is: the questions worth asking about a walking machine have
   numeric answers. Does it keep two feet on the ground? Does it go as fast as
   its own leg geometry says it should? Does it still do both at a fifth of the
   frame rate? A module that imports nothing but the solver can be asked those
   directly in a test, and tests/walker-physics.test.mjs does. hero-walkers.js
   is then only the part that draws it.

   It also means the test and the homepage cannot disagree about what the
   creature IS. The layout below is the single copy.

   HOW THE LEGS ARE ARRANGED. Two pins on the shaft, each carrying a mirrored
   pair: one leg reaching forwards, one back, four in all. The count follows
   from the leg, not the other way round. A planar body needs TWO feet down at
   every instant -- two contacts fix a height and an angle, one fixes neither
   and the creature pivots about it and topples -- so four legs need each leg
   planted for at least half the turn. This leg is planted for 65% of it, which
   clears that; the classic Jansen assembly manages 20% and needs ten legs to
   reach the same guarantee. jansen.js's BRANCH comment is where that comes from.

   THE MIRROR IS IN THE GEOMETRY ONLY. Both rows hang off one shaft, so both
   cranks turn the same way and only the leg is reflected. Reflecting the crank
   as well gives the other useful thing, a mirrored creature walking the other
   way, and reaching for that here fails silently: the legs look right, the gait
   looks right, and the two rows push forwards and backwards in equal measure
   and the creature stands still on the spot. */

import * as S from "../linkage/solver.js?v=3d923acb";
import { buildLeg, pairExtent, inStance } from "./jansen.js?v=3d923acb";
import * as B from "./body.js?v=3d923acb";

export const LAYOUT = {
  PINS: 2,               /* each carrying a mirrored pair, so four legs */
  LEG_SPACING: 18,       /* along the crankshaft; every leg gets its own plane */
  CRANK_DEG_S: 46,       /* one turn every eight seconds */
  /* Where the rear row of pins sits relative to the front row.

     With two or more feet down the contacts very nearly DETERMINE the body's
     tilt: two points in a plane fix a height and an angle, so pitch is not a
     free oscillation the body settles out of but a pose the gait dictates frame
     by frame. (That is also why stiffening the body against it does not help --
     quadrupling the rotational inertia makes the rocking worse, not better.)
     What matters is therefore not where the planted feet are but whether they
     are at the same HEIGHT: two feet 60 apart whose stance heights differ by
     three tilt the creature three degrees, and no amount of mass will argue.

     So this is chosen by measuring the tilt itself. Because the creature walks
     quasi-statically its pose at any crank angle is exactly the lower convex
     hull of its feet, which makes that a geometry question rather than a
     dynamics one -- every offset can be scored in microseconds. 119 degrees is
     the best of them, and it rides essentially level. */
  REAR_OFFSET: (119 * Math.PI) / 180,
};

/* Leg planes along the crankshaft: one per leg, so no two legs can ever share
   space. See the clearance test. */
export const PLANES = LAYOUT.PINS * 2;

/* How the camera frames it. Here rather than in the renderer so the framing
   test measures the homepage's own numbers instead of a copy of them.

   `fillY` is lower than it needs to be, deliberately. Fitted to 0.88 the feet
   reach 94% of the way down the frame at the angles the visitor can drag to,
   which leaves nothing between them and the bottom edge of the hero -- and that
   edge is a hard horizontal cut across the page, because the lit ground plane
   is a different tone from the page behind it. At 0.70 the feet stop around
   85% and the bottom seventh of the canvas is empty ground, which is room for
   main.css to fade the whole thing out into the page instead of clipping it.
   The creature is smaller for it, but still fills the frame it is given; the
   framing test holds that at above 0.9. */
export const FRAMING = { fillX: 1.22, fillY: 0.70, fillPlane: 0.96, bias: 0.46 };

export function buildCreature() {
  const { PINS, LEG_SPACING, CRANK_DEG_S, REAR_OFFSET } = LAYOUT;
  const params = S.defaultParams();
  const legs = [];
  for (let n = 0; n < PINS; n++) {
    const pin = (n / PINS) * 2 * Math.PI;
    /* One shaft speed, two geometries. accumulatedAngleRad is the motor's own
       state, so setting it here is exactly what a phase offset is.

       Each leg gets its OWN plane on the shaft rather than sharing one with its
       partner. They used to share, which put a forward-reaching leg and a
       backward-reaching one in exactly the same plane, passing through each
       other for the whole revolution. */
    for (const [dir, phase] of [[1, pin], [-1, pin + REAR_OFFSET]]) {
      const { mechanism, id } = buildLeg(CRANK_DEG_S, dir);
      mechanism.links[0].accumulatedAngleRad = phase;
      S.solveAtCurrentAngle(mechanism, params);
      const k = legs.length;
      legs.push({ mechanism, id, dir, z: (k - (PINS * 2 - 1) / 2) * LEG_SPACING });
    }
  }

  const physics = B.defaultPhysics();
  const extent = pairExtent();
  const feetPrev = legs.map(footOf);
  const body = B.createBody({
    feet: legs.length,
    span: extent.x1 - extent.x0,
    height: extent.y1 - extent.y0,
    y: B.restHeight(feetPrev, physics.groundY),
  });
  return { legs, params, physics, body, extent, feetPrev, rideY: body.y };
}

export function footOf(leg) {
  const q = leg.mechanism.connectors[leg.id.F].pos;
  return { x: q.x, y: q.y };
}

/* One frame. The legs are kinematic and know nothing about the ground; the
   body is dynamic and knows nothing about linkages. The feet are the only thing
   the two share, which is why this is four lines. */
export function advance(c, dt) {
  for (const leg of c.legs) S.advance(leg.mechanism, dt, c.params);
  const feetNow = c.legs.map(footOf);
  B.step(c.body, dt, c.feetPrev, feetNow, c.physics);
  c.feetPrev = feetNow;
  return c;
}

/* How many feet are on the ground at this angle of the shaft, from the leg's
   own geometry rather than from a contact solve. This is the thing the leg
   count was chosen against, so it is worth being able to ask without running
   the physics at all. */
export function supportCount(shaftRad) {
  const { PINS, REAR_OFFSET } = LAYOUT;
  let n = 0;
  for (let k = 0; k < PINS; k++) {
    const pin = (k / PINS) * 2 * Math.PI;
    if (inStance(shaftRad + pin)) n++;
    /* A mirrored leg's own parameter runs opposite to the shaft's: reflecting
       the geometry reflects which way round its crank traces the same path. */
    if (inStance(-(shaftRad + pin + REAR_OFFSET))) n++;
  }
  return n;
}



/* ---- how it is built ------------------------------------------------------

   The bar thicknesses live here rather than in the renderer because they are
   not a drawing choice: they decide whether two members that pass close to one
   another actually foul, and tests/walker-clearance.test.mjs has to measure the
   same creature that gets drawn. A radius that only existed in the renderer
   would be a radius nothing could check. */
export const BUILD = {
  rodR: 0.95,      /* the leg's own bars */
  jointR: 1.3,     /* pins. Barely over the rod, so a joint reads as a pivot
                      rather than as a bead swelling out of the line it sits on */
  frameR: 1.5,     /* the chassis rails, which carry the creature */
  strutR: 1.2,
};

/* The three pin axes the whole creature hangs from: the crankshaft itself and
   the two rocker pivots, one per row. Every leg is anchored to all three, so
   they run the length of the creature as real axles. */
export function axes(c) {
  const front = c.legs[0], rear = c.legs[1];
  const at = (leg, key) => leg.mechanism.connectors[leg.id[key]].pos;
  return [
    { key: "O", p: at(front, "O") },
    { key: "Gf", p: at(front, "G") },
    { key: "Gr", p: at(rear, "G") },
  ];
}

/* Every member the creature is made of, in 3D, for the pose it is in now.

   This is the single description of the machine: the renderer builds a mesh per
   entry and the clearance test measures between them, so the thing on screen
   and the thing under test cannot drift apart.

   `pins` names the axes a member is pinned to. Two members that share a pin are
   allowed to touch -- that is what a joint IS -- and a pin is identified by its
   position in the walking plane rather than by which leg it belongs to, because
   the axles genuinely run through every leg on the shaft. */
export function members(c) {
  const { LEG_SPACING } = LAYOUT;
  const zEnd = ((PLANES - 1) / 2) * LEG_SPACING + LEG_SPACING * 0.55;
  const out = [];

  for (let n = 0; n < c.legs.length; n++) {
    const leg = c.legs[n];
    const pos = (cid) => leg.mechanism.connectors[cid].pos;
    for (const l of leg.mechanism.links) {
      if (!l.alive) continue;
      /* The crank link is the throw, drawn as webs and a pin by the crankshaft
         below. Drawing it here as well would put a bar across the leg plane
         where the real thing has a gap for the rocker to sweep through. */
      if (l.isDriven) continue;
      for (let i = 0; i < l.connectorIds.length; i++) {
        for (let j = i + 1; j < l.connectorIds.length; j++) {
          const ca = l.connectorIds[i], cb = l.connectorIds[j];
          const a = pos(ca), b = pos(cb);
          out.push({
            kind: l.isDriven ? "crank" : "rod",
            leg: n,
            a: { x: a.x, y: a.y, z: leg.z },
            b: { x: b.x, y: b.y, z: leg.z },
            r: BUILD.rodR,
            pins: [pinKey(a), pinKey(b)],
          });
        }
      }
    }
  }

  /* ---- the crankshaft ----------------------------------------------------

     Built as a crankshaft actually is: main journals running on the axis in the
     bays between the legs, and at each leg station a THROW -- a web out to the
     offset pin, the pin itself, and a web back. The leg's own bars pivot on
     that pin, sitting in the gap between the two webs.

     This is not decoration. Run a plain rod straight down the axis through
     every leg station instead, and the leg's J1-J4 rocker sweeps clean through
     it twice a revolution, because that bar passes within a few units of the
     crank centre. There is nothing on the axis to hit at a leg station on a
     real crank, and there is nothing here either. */
  const HALF_WEB = BUILD.rodR + BUILD.frameR + 1.2;   /* half a throw's width */
  const stations = c.legs
    .map((leg) => ({ z: leg.z, pin: leg.mechanism.connectors[leg.id.J1].pos }))
    .sort((u, v) => u.z - v.z);
  const axis = axes(c)[0].p;

  /* Main journals: the straight runs on the axis, between the throws. */
  const edges = [-zEnd, ...stations.flatMap((st) => [st.z - HALF_WEB, st.z + HALF_WEB]), zEnd];
  for (let i = 0; i < edges.length; i += 2) {
    if (edges[i + 1] - edges[i] < 1e-6) continue;
    out.push({
      kind: "journal", leg: -1,
      a: { x: axis.x, y: axis.y, z: edges[i] }, b: { x: axis.x, y: axis.y, z: edges[i + 1] },
      r: BUILD.frameR, pins: [pinKey(axis)],
    });
  }

  /* Throws: a web each side of the leg, and the pin they carry between them. */
  for (const st of stations) {
    for (const z of [st.z - HALF_WEB, st.z + HALF_WEB]) {
      out.push({
        kind: "web", leg: -1,
        a: { x: axis.x, y: axis.y, z }, b: { x: st.pin.x, y: st.pin.y, z },
        r: BUILD.frameR, pins: [pinKey(axis), pinKey(st.pin)],
      });
    }
    out.push({
      kind: "pin", leg: -1,
      a: { x: st.pin.x, y: st.pin.y, z: st.z - HALF_WEB },
      b: { x: st.pin.x, y: st.pin.y, z: st.z + HALF_WEB },
      r: BUILD.frameR * 0.8, pins: [pinKey(st.pin)],
    });
  }

  /* The two rocker axles run the whole length: every leg's G is pinned to them,
     so unlike the crank axis there is nothing merely passing by. */
  for (const ax of axes(c).slice(1)) {
    out.push({
      kind: "rail", leg: -1,
      a: { x: ax.p.x, y: ax.p.y, z: -zEnd }, b: { x: ax.p.x, y: ax.p.y, z: zEnd },
      r: BUILD.frameR, pins: [pinKey(ax.p)],
    });
  }

  /* Bulkheads, outside the outermost leg plane rather than threaded between the
     legs: they brace the three rails into one rigid frame and cannot foul a leg
     because no leg reaches that far along the shaft. */
  const [O, Gf, Gr] = axes(c).map((ax) => ax.p);
  for (const z of [-zEnd, zEnd]) {
    for (const [p, q] of [[O, Gf], [O, Gr], [Gf, Gr]]) {
      out.push({
        kind: "bulkhead", leg: -1,
        a: { x: p.x, y: p.y, z }, b: { x: q.x, y: q.y, z },
        r: BUILD.strutR,
        pins: [pinKey(p), pinKey(q)],
      });
    }
  }
  return out;
}

/* A pin is the same pin wherever it appears along the shaft, so it is keyed by
   its position in the walking plane. Rounded, because the solver lands a pivot
   within about 1e-9 of where the construction put it, not exactly on it. */
export function pinKey(p) {
  return Math.round(p.x * 1e3) / 1e3 + "," + Math.round(p.y * 1e3) / 1e3;
}
