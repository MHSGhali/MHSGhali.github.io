/* Encodes a mechanism into the URL hash so someone can send you what they
   built.

   Deliberately lossy in one direction: only the DESIGN is stored -- joint
   positions, which links join what, anchors, motors, tracing -- and never the
   frozen rest lengths, accumulated motor angles, or recorded paths. Those are
   all recomputed on load from the positions, which is the same thing the
   editor does when you press Run, so a decoded mechanism is a fresh design
   rather than a paused simulation.

   Dead (tombstoned) entries are dropped and ids renumbered on encode, so a
   long editing session doesn't produce a long link. */

import * as M from "./mechanism.js?v=408e651f";

const b64urlEncode = (s) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const b64urlDecode = (s) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

const r2 = (n) => Math.round(n * 100) / 100;

export function encode(m, gravity) {
  /* Renumber live connectors to a dense 0..n-1 so links can refer to them. */
  const slot = new Map();
  const c = [];
  for (let i = 0; i < m.connectors.length; i++) {
    const conn = m.connectors[i];
    if (!conn.alive) continue;
    slot.set(i, c.length);
    /* [x, y, flags] where flags is bit 0 = anchor, bit 1 = traced. */
    c.push([r2(conn.pos.x), r2(conn.pos.y), (conn.isAnchor ? 1 : 0) | (conn.traced ? 2 : 0)]);
  }

  const l = [];
  for (const link of m.links) {
    if (!link.alive) continue;
    const ids = link.connectorIds.map((id) => slot.get(id));
    if (ids.some((id) => id === undefined)) continue;
    /* [ids, flags, pivotSlot, speed]; flags bit 0 = rigid, bit 1 = driven. */
    l.push([
      ids,
      (link.rigid ? 1 : 0) | (link.isDriven ? 2 : 0),
      link.isDriven ? slot.get(link.pivotConnectorId) : -1,
      link.isDriven ? r2(link.motorSpeedDegS) : 0,
    ]);
  }

  /* [pinSlot, railASlot, railBSlot] per slider. */
  const s2 = [];
  for (const sl of M.liveSliders(m)) {
    const ids = [sl.pinConnectorId, sl.railAId, sl.railBId].map((id) => slot.get(id));
    if (ids.some((id) => id === undefined)) continue;
    s2.push(ids);
  }

  /* v2 adds sliders. A v1 link carries none, so it still decodes; the version
     rises anyway so an older reader rejects a link it would silently mangle. */
  return b64urlEncode(JSON.stringify({ v: 2, g: gravity ? 1 : 0, c, l, s: s2 }));
}

/* Returns { mechanism, gravity } or null if the string isn't a mechanism we
   understand. Anything malformed returns null rather than throwing, because
   this parses whatever happens to be in the address bar. */
export function decode(str) {
  let data;
  try {
    data = JSON.parse(b64urlDecode(str));
  } catch {
    return null;
  }
  if (!data || (data.v !== 1 && data.v !== 2) ||
      !Array.isArray(data.c) || !Array.isArray(data.l)) return null;

  try {
    const m = M.create();
    for (const [x, y, flags] of data.c) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      const id = M.addConnector(m, { x, y }, (flags & 1) !== 0);
      if (flags & 2) M.setTraced(m, id, true);
    }
    for (const [ids, flags, pivot, speed] of data.l) {
      const lid = M.addLink(m, ids);
      if (lid < 0) return null;
      M.setRigid(m, lid, (flags & 1) !== 0);
      if (flags & 2) {
        /* toggleDriven picks the pivot itself and refuses unless exactly one
           of the link's connectors is an anchor, so a hand-edited link that
           claims a motor it can't have simply doesn't get one. */
        if (M.toggleDriven(m, lid, speed)) m.links[lid].motorSpeedDegS = speed;
      }
    }
    for (const ids of Array.isArray(data.s) ? data.s : []) {
      if (!Array.isArray(ids) || ids.length !== 3) return null;
      if (M.addSlider(m, ids[0], ids[1], ids[2]) < 0) return null;
    }
    return { mechanism: m, gravity: data.g === 1 };
  } catch {
    return null;
  }
}
