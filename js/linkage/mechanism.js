/* The mechanism data model, ported from the C tool's src/mechanism.c.

   Two things about the shape of this are load-bearing and are kept exactly as
   the C has them:

   1. Deletion is a TOMBSTONE (`alive = false`), never a splice. Ids are array
      indices and every other module -- the solver, tracing, the Blender
      exporter, the URL serializer -- addresses connectors and links by id. If
      ids shifted on delete, a link would silently start referring to a
      different joint.

   2. A link's rest lengths are the condensed upper triangle of the pairwise
      distances between ALL of its own connectors, indexed by pairIndex().
      That is what makes a ternary-or-larger link (a plate, not a bar) rigid:
      every internal distance is held, not just consecutive ones. */

import * as v from "./vec2.js?v=e7629c32";

/* Condensed upper-triangular pair index for i<j among k items (0-indexed). */
export function pairIndex(i, j, k) {
  return ((i * (2 * k - i - 1)) / 2 + (j - i - 1)) | 0;
}

export function create() {
  return { connectors: [], links: [], sliders: [] };
}

/* Deep copy. Used for the undo stack and by the Blender exporter, which
   simulates a private copy so exporting never disturbs what is on screen. */
export function clone(src) {
  return {
    connectors: src.connectors.map((c) => ({
      pos: { x: c.pos.x, y: c.pos.y },
      prevPos: { x: c.prevPos.x, y: c.prevPos.y },
      isAnchor: c.isAnchor,
      selected: c.selected,
      traced: c.traced,
      path: c.path.map((p) => ({ x: p.x, y: p.y })),
      alive: c.alive,
    })),
    links: src.links.map((l) => ({
      connectorIds: l.connectorIds.slice(),
      restDist: Float64Array.from(l.restDist),
      rigid: l.rigid,
      isDriven: l.isDriven,
      pivotConnectorId: l.pivotConnectorId,
      motorSpeedDegS: l.motorSpeedDegS,
      accumulatedAngleRad: l.accumulatedAngleRad,
      frozenLocalOffset: l.frozenLocalOffset
        ? l.frozenLocalOffset.map((p) => ({ x: p.x, y: p.y }))
        : null,
      selected: l.selected,
      alive: l.alive,
    })),
    sliders: (src.sliders || []).map((s2) => ({
      pinConnectorId: s2.pinConnectorId,
      railAId: s2.railAId,
      railBId: s2.railBId,
      selected: s2.selected,
      alive: s2.alive,
    })),
  };
}

/* Returns the new connector's id. */
export function addConnector(m, pos, isAnchor = false) {
  m.connectors.push({
    pos: { x: pos.x, y: pos.y },
    prevPos: { x: pos.x, y: pos.y },
    isAnchor,
    selected: false,
    traced: false,
    path: [],
    alive: true,
  });
  return m.connectors.length - 1;
}

export function deleteLink(m, linkId) {
  const l = m.links[linkId];
  if (!l || !l.alive) return;
  l.connectorIds = [];
  l.restDist = new Float64Array(0);
  l.frozenLocalOffset = null;
  l.isDriven = false;
  l.pivotConnectorId = -1;
  l.selected = false;
  l.alive = false;
}

/* Deletes a connector and cascades to every link that used it: there is no
   partial link surgery, matching the C. */
export function deleteConnector(m, connectorId) {
  const c = m.connectors[connectorId];
  if (!c || !c.alive) return;

  for (let li = 0; li < m.links.length; li++) {
    const l = m.links[li];
    if (!l.alive) continue;
    if (l.connectorIds.includes(connectorId)) deleteLink(m, li);
  }

  /* A slider needs all three of its connectors; losing any one kills it. */
  for (let si = 0; si < m.sliders.length; si++) {
    const sl = m.sliders[si];
    if (!sl.alive) continue;
    if (sl.pinConnectorId === connectorId || sl.railAId === connectorId ||
        sl.railBId === connectorId) deleteSlider(m, si);
  }

  c.path = [];
  c.traced = false;
  c.alive = false;
  c.selected = false;
}

/* Creates a rigid link joining the given connectors (>=2, all alive); rest
   lengths are captured from their current positions. Returns the new link's
   id, or -1 on invalid input. */
export function addLink(m, connectorIds) {
  const count = connectorIds.length;
  if (count < 2) return -1;
  for (const cid of connectorIds) {
    if (!m.connectors[cid] || !m.connectors[cid].alive) return -1;
  }

  const restDist = new Float64Array((count * (count - 1)) / 2);
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      restDist[pairIndex(i, j, count)] = v.dist(
        m.connectors[connectorIds[i]].pos,
        m.connectors[connectorIds[j]].pos
      );
    }
  }

  m.links.push({
    connectorIds: connectorIds.slice(),
    restDist,
    rigid: true,
    isDriven: false,
    pivotConnectorId: -1,
    motorSpeedDegS: 0,
    accumulatedAngleRad: 0,
    frozenLocalOffset: null,
    selected: false,
    alive: true,
  });
  return m.links.length - 1;
}

/* Whether a link's pairwise distances are enforced by the solver. A
   non-rigid ("variable") link may change length, but only as far as the rest
   of the geometry actually forces it to -- see solver.solveAtCurrentAngle. */
export function setRigid(m, linkId, rigid) {
  const l = m.links[linkId];
  if (!l || !l.alive) return;
  l.rigid = rigid;
}

export function hasDrivenLink(m) {
  return m.links.some((l) => l.alive && l.isDriven);
}

/* Clearing an anchor also un-drives any link that was pivoting on it: a motor
   needs a grounded pivot to rotate around. */
export function setAnchor(m, connectorId, isAnchor) {
  const c = m.connectors[connectorId];
  if (!c || !c.alive) return;

  c.isAnchor = isAnchor;
  if (isAnchor) return;

  for (const l of m.links) {
    if (l.alive && l.isDriven && l.pivotConnectorId === connectorId) {
      l.isDriven = false;
      l.pivotConnectorId = -1;
      l.frozenLocalOffset = null;
    }
  }
}

/* Turning "driven" on requires exactly one of the link's own connectors to be
   an anchor -- it becomes the pivot. Returns false without changing anything
   otherwise. Turning it off always succeeds. */
export function toggleDriven(m, linkId, defaultSpeedDegS) {
  const l = m.links[linkId];
  if (!l || !l.alive) return false;

  if (l.isDriven) {
    l.isDriven = false;
    l.pivotConnectorId = -1;
    l.frozenLocalOffset = null;
    return true;
  }

  let anchorCount = 0;
  let pivot = -1;
  for (const cid of l.connectorIds) {
    if (m.connectors[cid].isAnchor) { anchorCount++; pivot = cid; }
  }
  if (anchorCount !== 1) return false;

  l.frozenLocalOffset = null;
  l.isDriven = true;
  l.pivotConnectorId = pivot;
  l.motorSpeedDegS = defaultSpeedDegS;
  l.accumulatedAngleRad = 0;
  return true;
}

/* ---- sliders and pins-in-slots --------------------------------------------

   One connector held on the LINE through two others. That single primitive is
   both of the sliding joints a planar mechanism needs, exactly as in the C
   (src/joints.h): with anchors for rails it is a prismatic joint sliding on
   ground -- a crank-slider piston, a scissor lift's foot -- and with a moving
   link's connectors it is a pin running in that link's slot, which is what a
   Whitworth quick-return and a Scotch yoke are built from.

   The rail is a LINE, not a segment: the C constrains only the perpendicular
   offset, so a pin may travel past either rail connector. Draw the rails long
   enough to cover the travel and it reads as a slot either way. */

/* Returns the new slider's id, or -1 if the three connectors are not three
   distinct live ones. */
export function addSlider(m, pinConnectorId, railAId, railBId) {
  const ids = [pinConnectorId, railAId, railBId];
  if (new Set(ids).size !== 3) return -1;
  for (const id of ids) {
    const c = m.connectors[id];
    if (!c || !c.alive) return -1;
  }
  m.sliders.push({
    pinConnectorId, railAId, railBId, selected: false, alive: true,
  });
  return m.sliders.length - 1;
}

export function deleteSlider(m, sliderId) {
  const sl = m.sliders[sliderId];
  if (!sl || !sl.alive) return;
  sl.alive = false;
  sl.selected = false;
}

/* Every live slider whose three connectors are all still alive. The solver,
   the renderers and the exporter all want exactly this list. */
export function liveSliders(m) {
  return (m.sliders || []).filter(
    (sl) => sl.alive &&
      m.connectors[sl.pinConnectorId]?.alive &&
      m.connectors[sl.railAId]?.alive &&
      m.connectors[sl.railBId]?.alive
  );
}

/* The slider whose rail passes within `distThresh` of p, or -1. Measured to
   the drawn SEGMENT rather than the infinite line the solver uses, so a click
   far off the end of a rail does not select it. */
export function pickSlider(m, p, distThresh) {
  let best = -1, bestD = distThresh;
  for (let i = 0; i < m.sliders.length; i++) {
    const sl = m.sliders[i];
    if (!sl.alive) continue;
    const a = m.connectors[sl.railAId], b = m.connectors[sl.railBId];
    if (!a?.alive || !b?.alive) continue;
    const d = pointSegmentDist(p, a.pos, b.pos);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/* Untracing discards the recorded path; clearTraces keeps the flag. */
export function setTraced(m, connectorId, traced) {
  const c = m.connectors[connectorId];
  if (!c || !c.alive) return;
  c.traced = traced;
  if (!traced) c.path = [];
}

export function clearTraces(m) {
  for (const c of m.connectors) {
    if (c.alive && c.traced) c.path = [];
  }
}

/* Call once per simulation frame, after resolving positions. */
export function traceStep(m) {
  for (const c of m.connectors) {
    if (!c.alive || !c.traced) continue;
    c.path.push({ x: c.pos.x, y: c.pos.y });
  }
}

/* The extent of everything DRAWN: every live joint, and every point of every
   recorded trace. Both views frame from this rather than from the joints
   alone, because a coupler curve routinely swings well outside the linkage
   that draws it -- the drag-link preset's trace is four times the height of
   its own joint box, so framing on joints alone cuts most of it off.

   Returns null when there is nothing to frame. */
export function bounds(m) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  let any = false;
  const put = (p) => {
    any = true;
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  };
  for (const c of m.connectors) {
    if (!c.alive) continue;
    put(c.pos);
    if (c.traced) for (const p of c.path) put(p);
  }
  return any ? { x0, x1, y0, y1 } : null;
}

/* Nearest alive connector within `radius` of p, or -1. */
export function pickConnector(m, p, radius) {
  let best = -1;
  let bestD2 = radius * radius;
  for (let i = 0; i < m.connectors.length; i++) {
    if (!m.connectors[i].alive) continue;
    const d2 = v.dist2(m.connectors[i].pos, p);
    if (d2 <= bestD2) { bestD2 = d2; best = i; }
  }
  return best;
}

function pointSegmentDist(p, a, b) {
  const ab = v.sub(b, a);
  const len2 = v.dot(ab, ab);
  let t = len2 > 1e-12 ? v.dot(v.sub(p, a), ab) / len2 : 0;
  t = Math.min(1, Math.max(0, t));
  return v.dist(p, v.add(a, v.scale(ab, t)));
}

/* Nearest alive link with a pairwise edge within `distThresh` of p, or -1. */
export function pickLinkEdge(m, p, distThresh) {
  let best = -1;
  let bestD = distThresh;
  for (let li = 0; li < m.links.length; li++) {
    const l = m.links[li];
    if (!l.alive) continue;
    for (let i = 0; i < l.connectorIds.length; i++) {
      for (let j = i + 1; j < l.connectorIds.length; j++) {
        const d = pointSegmentDist(
          p,
          m.connectors[l.connectorIds[i]].pos,
          m.connectors[l.connectorIds[j]].pos
        );
        if (d <= bestD) { bestD = d; best = li; }
      }
    }
  }
  return best;
}
