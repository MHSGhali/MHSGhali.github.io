/* ---------------------------------------------------------------
   Building a working N-bar linkage to order.

   Asking a 2B model to invent six-bar geometry does not work, and it is the
   wrong tool for it: a six-bar that MOVES is a solved problem in kinematics,
   not a matter of judgement. So this is deterministic. The model is still
   welcome to plan a mechanism joint by joint; when a visitor asks for "a six
   bar linkage" by name they get one that runs.

   The construction is a Grashof four-bar with dyads hung off its coupler,
   which is the standard way six- and eight-bar chains are built (this is a
   Stephenson III with one dyad). The mobility works out at one for every size
   here: with b bars counting the ground and j pin joints, 3(b-1) - 2j = 1.

   The part worth explaining is how the dyad lengths are chosen. A dyad added
   at a guess jams: its coupler point swings through a range of distances from
   the new anchor over a crank revolution, and any pair of link lengths that
   cannot span that whole range binds partway round. So the coupler point's
   path is swept first, its nearest and furthest approach to the new anchor
   measured, and both dyad links set to 0.62 of the furthest. Equal lengths can
   always fold to reach anything nearer, and 2 x 0.62 = 1.24 of the furthest
   leaves a quarter again of slack at full stretch. Fitted to the real motion,
   so it cannot bind.

   No DOM in here.
   --------------------------------------------------------------- */

import * as M from "./mechanism.js?v=4c85dc67";

/* The same three helpers presets.js is written with, for the same reason: a
   mechanism has to be stated as lengths, because a link's rest lengths are
   captured from where its joints are the moment it is created. */
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

function couplerPoint(a, b, u, v) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  const ux = dx / d, uy = dy / d;
  return { x: a.x + ux * u - uy * v, y: a.y + uy * u + ux * v };
}

const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

/* The base four-bar: ground 400, crank 100, coupler 350, rocker 300. Grashof,
   with the crank shortest, so it turns all the way round rather than stalling
   at a limit position -- which matters more here than in a preset, because
   everything else hangs off its motion. */
const BASE = { o2: { x: -200, y: 0 }, o4: { x: 200, y: 0 }, crank: 100, coupler: 350, rocker: 300 };

/* Where a point carried by the coupler goes over one crank revolution. */
function sweepCouplerPoint(u, v, steps = 180) {
  const path = [];
  for (let i = 0; i < steps; i++) {
    const th = (i / steps) * Math.PI * 2;
    const a = { x: BASE.o2.x + BASE.crank * Math.cos(th), y: BASE.o2.y + BASE.crank * Math.sin(th) };
    const b = circleIntersect(a, BASE.coupler, BASE.o4, BASE.rocker, -1);
    if (!b) continue;
    path.push(couplerPoint(a, b, u, v));
  }
  return path;
}

/* A dyad: two links from `from` to a new ground, sized so the pair can span
   every distance the swept path ever puts between them. */
function planDyad(path, ground) {
  let near = Infinity, far = 0;
  for (const p of path) {
    const d = dist(p, ground);
    if (d < near) near = d;
    if (d > far) far = d;
  }
  const len = far * 0.62;
  return { len, near, far };
}

export const SIZES = [4, 6, 8];

/* Returns { mechanism, joints, links, anchors, motorLink, note }, where
   `joints` and `links` are the 1-based numbers the assistant refers to. */
export function buildBars(bars, { motorLink = 1 } = {}) {
  if (!SIZES.includes(bars)) return null;

  const m = M.create();
  const anchors = [];

  /* The four-bar every size starts from. */
  const o2 = M.addConnector(m, { ...BASE.o2 }, true);
  const o4 = M.addConnector(m, { ...BASE.o4 }, true);
  const aPos = { x: BASE.o2.x + BASE.crank, y: BASE.o2.y };
  const bPos = circleIntersect(aPos, BASE.coupler, BASE.o4, BASE.rocker, -1);
  const a = M.addConnector(m, aPos);
  const b = M.addConnector(m, bPos);
  anchors.push(o2, o4);

  const crank = M.addLink(m, [o2, a]);
  const linkIds = [crank];

  if (bars === 4) {
    linkIds.push(M.addLink(m, [a, b]), M.addLink(m, [b, o4]));
  } else {
    /* The coupler carries the point each dyad hangs from, so it is a ternary
       plate rather than a bar: the apex is rigidly part of the coupler, which
       is what makes the whole thing one mechanism instead of two. */
    const cPos = couplerPoint(aPos, bPos, 210, 65);
    const c = M.addConnector(m, cPos);

    /* Both apexes are decided before the coupler is created, so it can be made
       once carrying all of them. Building it with three joints and replacing it
       with a four-joint one left a tombstone in mechanism.links, and a tombstone
       is exactly what pulls the numbers here apart from the numbers the editor
       shows: it counts alive links, so every link after the hole was reported
       one too high and "select link 3" landed on a link with no anchor. */
    const couplerJoints = [a, b, c];
    let e = -1;
    let ePos = null;
    if (bars === 8) {
      ePos = couplerPoint(aPos, bPos, 120, -90);
      e = M.addConnector(m, ePos);
      couplerJoints.push(e);
    }
    linkIds.push(M.addLink(m, couplerJoints), M.addLink(m, [b, o4]));

    /* First dyad, hung below the coupler's path. */
    const path1 = sweepCouplerPoint(210, 65);
    const g1 = { x: Math.round(cPos.x), y: Math.round(cPos.y) + 300 };
    const d1 = planDyad(path1, g1);
    const o6 = M.addConnector(m, g1, true);
    const dPos = circleIntersect(cPos, d1.len, g1, d1.len, 1)
      || { x: (cPos.x + g1.x) / 2, y: (cPos.y + g1.y) / 2 };
    const d = M.addConnector(m, dPos);
    anchors.push(o6);
    linkIds.push(M.addLink(m, [c, d]), M.addLink(m, [d, o6]));

    if (bars === 8) {
      /* A second dyad off the other coupler apex, so the two do not simply
         mirror each other. The apex itself was placed above, with the coupler. */
      const path2 = sweepCouplerPoint(120, -90);
      const g2 = { x: Math.round(ePos.x), y: Math.round(ePos.y) - 300 };
      const d2 = planDyad(path2, g2);
      const o8 = M.addConnector(m, g2, true);
      const fPos = circleIntersect(ePos, d2.len, g2, d2.len, -1)
        || { x: (ePos.x + g2.x) / 2, y: (ePos.y + g2.y) / 2 };
      const f = M.addConnector(m, fPos);
      anchors.push(o8);
      linkIds.push(M.addLink(m, [e, f]), M.addLink(m, [f, o8]));
    }
  }

  /* Every number handed back is the number the EDITOR will show, worked out
     from the mechanism itself rather than from the order things were built in.
     The two agree today because nothing here deletes any more, but a reader of
     this file should not have to know that to trust the report. */
  const aliveLinks = [];
  m.links.forEach((l, id) => { if (l.alive) aliveLinks.push(id); });
  const aliveJoints = [];
  m.connectors.forEach((c, id) => { if (c.alive) aliveJoints.push(id); });
  const linkNo = (id) => aliveLinks.indexOf(id) + 1;

  /* The motor. Only a link with exactly one anchored joint can take one, so a
     request for an impossible one is reported rather than silently ignored. */
  const drivable = linkIds.filter((id) =>
    m.links[id].connectorIds.filter((cid) => m.connectors[cid].isAnchor).length === 1);
  const wantId = linkIds[Math.max(0, Math.min(linkIds.length - 1, (motorLink | 0) - 1))];
  const chosen = drivable.includes(wantId) ? wantId : drivable[0];
  let note = "";
  if (chosen !== wantId) {
    note = `Link ${linkNo(wantId)} has no anchored joint of its own, so it cannot be `
      + `driven; the motor went on link ${linkNo(chosen)} instead.`;
  }
  if (chosen !== undefined) M.toggleDriven(m, chosen, 90);

  return {
    mechanism: m,
    bars,
    joints: aliveJoints.length,
    links: aliveLinks.length,
    anchors: anchors.map((id) => aliveJoints.indexOf(id) + 1),
    motorLink: chosen === undefined ? null : linkNo(chosen),
    drivable: drivable.map(linkNo).sort((x, y) => x - y),
    note,
  };
}
