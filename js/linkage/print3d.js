/* Writing a mechanism out as parts you can print and then bolt together.
   A port of the C tool's src/print3d.c.

   This is a different thing from the Blender export next door. That one writes
   an ANIMATION: skeleton bars and marker empties that show the motion. This
   one writes OBJECTS: STL solids with real thickness and real holes, plus a
   manifest telling you what each one is and how the pile goes together.

   Three things have to be true for the printed pile to move the way the screen
   does, and each is handled here:

     - Every pin needs a hole to go through, at a matched running fit.
     - Two parts that share a pin must not occupy the same space. Parts are
       assigned LAYERS -- a graph colouring over "shares a joint" -- and any
       empty layer in a pin's stack gets a spacer washer, so nothing rubs and
       nothing floats.
     - A slider's rail needs a slot for its pin and a way to bolt down.

   The C also prints gears, racks, cams and Geneva wheels. This engine has no
   such joints -- it is pin joints and sliders -- so those emitters have no
   counterpart here rather than a broken one.

   Units are millimetres, matching 1 world unit = 1 mm. */

import * as M from "./mechanism.js?v=82f4d047";
import * as G from "./mesh3d.js?v=82f4d047";

/* How round a hole or a boss is drawn. A pin hole is only a few millimetres
   across, so this is already finer than a printer can resolve. */
const HOLE_SEG = 32;
const BOSS_SEG = 12;
/* A press fit is this much UNDER the nominal pin, so the two grip. */
const PRESS_INTERFERENCE = 0.05;
/* The baseplate is stiffer than the parts standing on it. */
const BASE_THICKNESS_FACTOR = 1.5;
/* How far the baseplate reaches past the outermost anchor. */
const BASE_MARGIN = 8.0;
/* How far a pin stands proud of the top layer, for its cap to grip. */
const PIN_CAP_ENGAGEMENT = 1.6;
/* How tall a pin's head is. */
const PIN_HEAD_HEIGHT = 1.6;
/* In the exploded view, how far apart consecutive levels are pulled, as a
   multiple of the plate thickness. Far enough to see between them. */
const EXPLODE_SPREAD = 7.0;

/* Defaults tuned for a hobby FDM printer with a 0.4 mm nozzle. */
export function defaultPrintParams() {
  return {
    pinDiameter: 3.0,
    thickness: 3.0,
    clearance: 0.4,
    layerGap: 0.4,
    wall: 2.0,
    m3Hardware: false,   /* size holes for M3 screws instead of printed pins */
    baseplate: true,
    assembly: true,      /* also write the machine assembled, and pulled apart */
  };
}

/* ---- layers ------------------------------------------------------------
   Two bodies that share a pin cannot both sit at z = 0. Colour the "shares a
   joint" graph; the colour is the layer. */

function buildLayers(m) {
  const links = m.links;
  const layer = new Array(links.length).fill(-1);
  const live = [];
  for (let i = 0; i < links.length; i++) if (links[i].alive) live.push(i);

  const shares = (a, b) =>
    links[a].connectorIds.some((c) => links[b].connectorIds.includes(c));

  /* Greedy colouring, busiest first: the body that conflicts with the most
     others is hardest to place, so place it while every layer is free. */
  const degree = new Map(live.map((i) => [i, 0]));
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      if (shares(live[i], live[j])) {
        degree.set(live[i], degree.get(live[i]) + 1);
        degree.set(live[j], degree.get(live[j]) + 1);
      }
    }
  }
  const order = live.slice().sort((a, b) => degree.get(b) - degree.get(a));

  let maxLayer = 0;
  for (const li of order) {
    const taken = new Set();
    for (const lj of order) {
      if (lj === li || layer[lj] < 0) continue;
      if (shares(li, lj)) taken.add(layer[lj]);
    }
    let c = 0;
    while (taken.has(c)) c++;
    layer[li] = c;
    if (c > maxLayer) maxLayer = c;
  }
  return { layer, maxLayer };
}

/* ---- context ----------------------------------------------------------- */

function createCtx(m, p) {
  return {
    m, p,
    files: [],          /* { name, bytes } */
    man: [],            /* manifest lines */
    written: 0, failed: 0, warnings: 0,
    /* Every part, stamped where it belongs -- once touching, once pulled
       apart. These say how the pile goes together; the individual STLs only
       say what to print. */
    assembled: G.createMesh(),
    exploded: G.createMesh(),
    shelfGap: p.thickness * EXPLODE_SPREAD,
    topShelf: 0,
  };
}

const runningHole = (c) => (c.p.m3Hardware ? 3.4 : c.p.pinDiameter + c.p.clearance);
const pressHole = (c) => (c.p.m3Hardware ? 2.9 : c.p.pinDiameter - PRESS_INTERFERENCE);
const bossRadius = (c) => runningHole(c) * 0.5 + c.p.wall;

/* Everything is measured from the TOP FACE of the baseplate, which is z = 0;
   the plate itself hangs below. Layer 0 does not sit straight on the plate: a
   pin through a joint that is NOT anchored has to get its head in somewhere,
   and that somewhere is the gap underneath. */
const partStandoff = (c) => PIN_HEAD_HEIGHT + c.p.layerGap;
const layerBase = (c, l) => partStandoff(c) + l * (c.p.thickness + c.p.layerGap);
const layerTop = (c, l) => layerBase(c, l) + c.p.thickness;
const place = (angle, offset, z, shelf) => ({ angle, offset, z, shelf });
const onLayer = (c, l, angle, offset) =>
  place(angle, offset, layerBase(c, Math.max(0, l)), Math.max(0, l) + 1);

function warn(c, msg) {
  c.man.push(`  ! ${msg}`);
  c.warnings++;
}

/* Appends `src` to `dst`, turned and moved into place. */
function stamp(dst, src, at, lift) {
  const ca = Math.cos(at.angle), sa = Math.sin(at.angle);
  for (const q of src.verts) {
    dst.verts.push({
      x: q.x * ca - q.y * sa + at.offset.x,
      y: q.x * sa + q.y * ca + at.offset.y,
      z: q.z + at.z + lift,
    });
  }
}

function recordPlacements(c, mesh, places) {
  if (!c.p.assembly) return;
  for (const at of places) {
    stamp(c.assembled, mesh, at, 0);
    stamp(c.exploded, mesh, at, at.shelf * c.shelfGap);
    if (at.shelf > c.topShelf) c.topShelf = at.shelf;
  }
}

/* Writes a finished mesh out and stamps it into the assembly wherever it
   belongs -- which for a pin or a spacer is several places at once. */
function publish(c, name, what, where, mesh, ok, places) {
  if (ok && !G.isClosed(mesh)) {
    ok = false;
    warn(c, `${name}: the sweep did not close up, so it was not written.`);
  }
  if (ok) {
    c.files.push({ name: `${name}.stl`, bytes: G.writeStl(mesh, name) });
    c.man.push(`  ${name.padEnd(26)} ${what.padEnd(38)} ${where}, ${G.triCount(mesh)} triangles`);
    recordPlacements(c, mesh, places);
    c.written++;
  } else {
    c.failed++;
  }
  return ok;
}

/* Extrudes one region, checks it is a solid, writes it and logs it. */
function emitPlaced(c, name, what, layer, outer, holes, thickness, places) {
  if (outer.length < 3) { c.failed++; warn(c, `${name}: no outline to sweep.`); return false; }
  const mesh = G.createMesh();
  let ok = G.extrude(mesh, { outer, holes }, 0, thickness);
  if (!ok) {
    warn(c, `${name}: could not be swept into a solid -- its outline crosses itself, ` +
            `or a hole falls outside it.`);
  }
  return publish(c, name, what, `layer ${layer}, ${thickness.toFixed(1)} mm thick`, mesh, ok, places);
}

const emit = (c, name, what, layer, outer, holes, thickness, at) =>
  emitPlaced(c, name, what, layer, outer, holes, thickness, [at]);

/* Two joints can sit on the same spot -- a scissor's two feet share a pivot --
   and punching the same hole twice is a hole overlapping itself, which is not
   a region anything can be swept from. One pin goes through both parts anyway,
   so one hole is the right answer. */
function addHole(holes, at, diameter) {
  if (!(diameter > 0.05)) return;
  for (const h of holes) {
    let cx = 0, cy = 0;
    for (const q of h) { cx += q.x; cy += q.y; }
    cx /= h.length; cy /= h.length;
    if (Math.hypot(cx - at.x, cy - at.y) < 1e-6) return;
  }
  const loop = G.circle(at, diameter * 0.5, HOLE_SEG);
  if (loop.length) holes.push(loop);
}

const isDrivenPivot = (m, cid) =>
  m.links.some((l) => l.alive && l.isDriven && l.pivotConnectorId === cid);

/* ---- parts -------------------------------------------------------------- */

/* A flat plate covering the link's pins, with a running hole at each. The
   outline is the convex hull of the pins grown by a wall's worth, so a two-pin
   bar comes out as a dogbone and a ternary link as a rounded triangle. */
function emitLinkPlate(c, layers, li) {
  const l = c.m.links[li];
  const pins = l.connectorIds
    .filter((cid) => cid >= 0 && c.m.connectors[cid] && c.m.connectors[cid].alive)
    .map((cid) => c.m.connectors[cid].pos);
  if (pins.length < 1) return;

  const outer = G.hullOffset(pins, bossRadius(c), BOSS_SEG);
  const holes = [];
  for (const cid of l.connectorIds) {
    if (cid < 0 || !c.m.connectors[cid] || !c.m.connectors[cid].alive) continue;
    /* A body driven about this pin has to grip the shaft that turns it;
       everything else has to spin on it. */
    const grip = l.isDriven && l.pivotConnectorId === cid;
    addHole(holes, c.m.connectors[cid].pos, grip ? pressHole(c) : runningHole(c));
  }
  /* A plate is drawn round the pins where they actually are, so it is already
     in world coordinates and only has to be lifted to its layer. */
  emit(c, `link_${li}`, `link plate, ${pins.length} pin${pins.length === 1 ? "" : "s"}` +
       (l.isDriven ? ", motor-driven" : ""),
       layers.layer[li], outer, holes, c.p.thickness,
       onLayer(c, layers.layer[li], 0, { x: 0, y: 0 }));
}

/* A bar with a slot the pin runs in, and a mounting hole beyond each end so it
   can be pinned to the baseplate. */
function emitRail(c, si, sl) {
  const a = c.m.connectors[sl.railAId].pos;
  const b = c.m.connectors[sl.railBId].pos;
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length < 1e-6) return null;

  const ux = (b.x - a.x) / length, uy = (b.y - a.y) / length;
  const pad = bossRadius(c) * 2.2;
  const ea = { x: a.x - ux * pad, y: a.y - uy * pad };
  const eb = { x: b.x + ux * pad, y: b.y + uy * pad };

  const slotR = runningHole(c) * 0.5;
  const outer = G.stadium(ea, eb, slotR + c.p.wall, BOSS_SEG);
  const holes = [G.stadium(a, b, slotR, 8)];
  addHole(holes, ea, pressHole(c));
  addHole(holes, eb, pressHole(c));

  const ok = emit(c, `rail_${si}`, `slider rail, ${length.toFixed(1)} mm of travel`, 0,
                  outer, holes, c.p.thickness, onLayer(c, 0, 0, { x: 0, y: 0 }));
  /* Only a rail that was actually written needs bolting down. Reporting the
     mounts regardless would put two holes at the origin of the baseplate, for
     a part that is not there. */
  return ok ? [ea, eb] : null;
}

/* A headed pin, plus the cap that goes on the far end of it. `places` says
   every joint this length of pin belongs in, so the assembly gets one at each
   while only one STL is written. */
function emitPin(c, length, places, capPlaces) {
  const shaftR = c.p.pinDiameter * 0.5;
  const headR = shaftR + c.p.wall;
  const mesh = G.createMesh();
  let ok = G.extrude(mesh, { outer: G.circle({ x: 0, y: 0 }, headR, HOLE_SEG), holes: [] },
                     0, PIN_HEAD_HEIGHT);
  /* Head and shaft are two separate closed solids sitting face to face, not
     one shell. A slicer unions overlapping bodies, which is exactly what a
     printer does with them, and the closedness check is happy either way
     because every edge still has its partner within its own solid. */
  ok = G.extrude(mesh, { outer: G.circle({ x: 0, y: 0 }, shaftR, HOLE_SEG), holes: [] },
                 PIN_HEAD_HEIGHT, PIN_HEAD_HEIGHT + length) && ok;

  const label = length.toFixed(1);
  publish(c, `pin_${label}mm`, c.p.m3Hardware ? "pin (unused in M3 mode)" : "headed pin",
          `x${places.length}`, mesh, ok, places);

  /* The cap that stops the stack sliding back off the pin. */
  const capHoles = [];
  addHole(capHoles, { x: 0, y: 0 }, pressHole(c));
  emitPlaced(c, `cap_${label}mm`, `push-on cap for pin_${label}mm, x${places.length}`, 0,
             G.circle({ x: 0, y: 0 }, headR, HOLE_SEG), capHoles,
             PIN_CAP_ENGAGEMENT, capPlaces);
}

function emitSpacer(c, height, places) {
  const holes = [];
  addHole(holes, { x: 0, y: 0 }, runningHole(c) + 0.1);
  emitPlaced(c, `spacer_${height.toFixed(2)}mm`,
             `spacer washer, ${height.toFixed(2)} mm tall, x${places.length}`, 0,
             G.circle({ x: 0, y: 0 }, runningHole(c) * 0.5 + c.p.wall, HOLE_SEG),
             holes, height, places);
}

/* ---- the whole job ------------------------------------------------------ */

/* Returns { files, manifest, report, written, failed, warnings }. `files` is
   one entry per STL; the caller decides how to deliver them. */
export function exportPrintableParts(mechanism, params = defaultPrintParams()) {
  const p = { ...defaultPrintParams(), ...params };
  const m = mechanism;
  const c = createCtx(m, p);
  const layers = buildLayers(m);

  c.man.push("Linkage Design -- printable parts");
  c.man.push("=================================");
  c.man.push("");
  c.man.push("Units are millimetres. Every solid here has been checked watertight.");
  c.man.push("");
  c.man.push("Settings");
  c.man.push(`  pin diameter     ${p.pinDiameter.toFixed(2)} mm`);
  c.man.push(`  plate thickness  ${p.thickness.toFixed(2)} mm`);
  c.man.push(`  running fit      ${runningHole(c).toFixed(2)} mm hole (clearance ${p.clearance.toFixed(2)})`);
  c.man.push(`  press fit        ${pressHole(c).toFixed(2)} mm hole`);
  c.man.push(`  layer gap        ${p.layerGap.toFixed(2)} mm`);
  c.man.push(`  wall             ${p.wall.toFixed(2)} mm`);
  c.man.push(`  fasteners        ${p.m3Hardware ? "M3 hardware" : "printed pins"}`);
  c.man.push("");
  c.man.push("Parts");

  for (let li = 0; li < m.links.length; li++) {
    if (m.links[li].alive) emitLinkPlate(c, layers, li);
  }

  /* Rails, remembering where they need pinning down. */
  const extraMounts = [];
  for (const sl of M.liveSliders(m)) {
    const si = m.sliders.indexOf(sl);
    const mounts = emitRail(c, si, sl);
    if (mounts) extraMounts.push(...mounts);
  }

  /* Which layers each joint actually carries, so pins can be cut to length and
     the holes in the stack filled. */
  const n = m.connectors.length;
  const lowest = new Array(n).fill(99), highest = new Array(n).fill(-1);
  const used = Array.from({ length: n }, () => new Set());
  for (let li = 0; li < m.links.length; li++) {
    if (!m.links[li].alive || layers.layer[li] < 0) continue;
    for (const cid of m.links[li].connectorIds) {
      if (cid < 0 || cid >= n) continue;
      const lay = layers.layer[li];
      if (lay < lowest[cid]) lowest[cid] = lay;
      if (lay > highest[cid]) highest[cid] = lay;
      used[cid].add(lay);
    }
  }

  c.man.push("");
  c.man.push("Assembly");
  c.man.push(`  The baseplate's top face is height 0. Layer 0 stands ${partStandoff(c).toFixed(2)} mm above it --`);
  c.man.push("  room for a pin head at a joint that is not anchored -- and each layer");
  c.man.push(`  above that is a further ${(p.thickness + p.layerGap).toFixed(2)} mm up.`);

  /* Pins and spacers: one STL per distinct size, but one PLACE per joint, so
     the assembly shows a pin standing in every hole. */
  const baseThickness = p.thickness * BASE_THICKNESS_FACTOR;
  const pinKinds = new Map();     /* length -> { places, capPlaces } */
  const spacerKinds = new Map();  /* height -> places */
  const pinShelf = layers.maxLayer + 2;

  for (let cid = 0; cid < n; cid++) {
    const conn = m.connectors[cid];
    if (!conn || !conn.alive || highest[cid] < 0) continue;
    const at = conn.pos;
    const anchored = p.baseplate && conn.isAnchor;

    /* An anchored pin is pressed through the baseplate and headed underneath
       it. A moving one cannot be headed under the plate -- the plate is solid
       there -- so its head goes in the standoff gap ABOVE the plate, resting
       on it, which is what that gap is for. */
    const headBottom = anchored ? -baseThickness - PIN_HEAD_HEIGHT : 0;
    const shaftTop = layerTop(c, highest[cid]) + PIN_CAP_ENGAGEMENT;
    const length = Math.ceil((shaftTop - (headBottom + PIN_HEAD_HEIGHT)) * 2) / 2;

    if (!pinKinds.has(length)) pinKinds.set(length, { places: [], capPlaces: [] });
    const kind = pinKinds.get(length);
    kind.places.push(place(0, at, headBottom, pinShelf));
    kind.capPlaces.push(place(0, at, layerTop(c, highest[cid]), pinShelf));

    /* Anything on the pin below the lowest occupied layer, or in a gap between
       two occupied ones, has to be packed out. */
    for (let lay = 0; lay <= highest[cid]; lay++) {
      if (used[cid].has(lay)) continue;
      const h = p.thickness + p.layerGap;
      if (!spacerKinds.has(h)) spacerKinds.set(h, []);
      spacerKinds.get(h).push(place(0, at, layerBase(c, lay), lay + 1));
    }
  }

  if (!p.m3Hardware) {
    for (const [length, k] of pinKinds) emitPin(c, length, k.places, k.capPlaces);
  } else {
    c.man.push("  Hardware to buy:");
    for (const [length, k] of pinKinds) {
      c.man.push(`    ${k.places.length} x M3 screw, at least ${Math.ceil(length)} mm long, with a nut`);
    }
  }
  for (const [h, places] of spacerKinds) emitSpacer(c, h, places);

  /* The baseplate, which is what actually holds the anchors apart. */
  if (p.baseplate) {
    const anchors = [];
    for (let i = 0; i < n; i++) {
      if (m.connectors[i] && m.connectors[i].alive && m.connectors[i].isAnchor) {
        anchors.push({ cid: i, pos: m.connectors[i].pos });
      }
    }
    const pts = anchors.map((a) => a.pos).concat(extraMounts);
    if (pts.length >= 1) {
      const outer = G.hullOffset(pts, BASE_MARGIN, BOSS_SEG);
      const holes = [];
      for (const a of anchors) {
        /* Where a motor has to reach through, leave the hole open; everywhere
           else grip the pin. */
        addHole(holes, a.pos, isDrivenPivot(m, a.cid) ? runningHole(c) : pressHole(c));
      }
      for (const mt of extraMounts) addHole(holes, mt, pressHole(c));
      emit(c, "baseplate", "ground plate; holds every anchor", 0, outer, holes,
           baseThickness, place(0, { x: 0, y: 0 }, -baseThickness, 0));
    }
  }

  /* The two views of the whole thing. Neither is a part to print: they are
     what tells you which part goes where, which a folder of separate STLs
     cannot say on its own. */
  if (p.assembly && G.triCount(c.assembled) > 0) {
    c.man.push("");
    c.man.push("How it goes together");
    if (!G.shellsAreClosed(c.assembled)) {
      warn(c, "the assembled view has an open edge in it, which means a part was " +
              "placed wrong; trust the individual parts over it.");
    }
    c.files.push({ name: "assembly.stl", bytes: G.writeStl(c.assembled, "assembly") });
    c.man.push(`  ${"assembly".padEnd(26)} ${"every part where it belongs".padEnd(38)} ${G.triCount(c.assembled)} triangles`);
    c.files.push({ name: "assembly_exploded.stl", bytes: G.writeStl(c.exploded, "assembly_exploded") });
    c.man.push(`  ${"assembly_exploded".padEnd(26)} ${"the same, lifted apart by layer".padEnd(38)} ${G.triCount(c.exploded)} triangles`);
    c.man.push(`  Layers are pulled ${c.shelfGap.toFixed(1)} mm apart in the exploded view; pins and caps`);
    c.man.push("  sit above everything, over the holes they drop into.");
    c.man.push("  Neither file is a part to print. They are several solids touching,");
    c.man.push("  not one watertight shell -- open them to see what goes where.");
  }

  c.man.push("");
  c.man.push(`${c.written} part${c.written === 1 ? "" : "s"} written` +
             (c.failed ? `, ${c.failed} could not be` : "") +
             (c.warnings ? `, ${c.warnings} warning${c.warnings === 1 ? "" : "s"} above` : "") + ".");

  return {
    files: c.files,
    manifest: c.man.join("\n") + "\n",
    written: c.written,
    failed: c.failed,
    warnings: c.warnings,
    layers: layers.maxLayer + 1,
    report: `${c.written} part${c.written === 1 ? "" : "s"}, ${layers.maxLayer + 1} layer` +
            `${layers.maxLayer === 0 ? "" : "s"}` +
            (c.warnings ? `, ${c.warnings} warning${c.warnings === 1 ? "" : "s"}` : "") +
            " -- see MANIFEST.txt.",
  };
}
