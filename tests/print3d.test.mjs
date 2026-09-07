/* The STL export: geometry that fails silently if it is wrong.

   A mesh that is not closed is not a solid, and a slicer given one will either
   refuse it or quietly print something else -- so the property worth testing
   is not "did it produce triangles" but "is every solid watertight". These
   check that on the shapes the exporter actually builds, including the ones
   the C's own comments call out as the hard cases.

   Run: node --test tests/ */

import test from "node:test";
import assert from "node:assert/strict";

import * as G from "../js/linkage/mesh3d.js";
import * as M from "../js/linkage/mechanism.js";
import { exportPrintableParts, defaultPrintParams } from "../js/linkage/print3d.js";
import { makeZip } from "../js/linkage/zip.js";
import { PRESETS, buildPreset } from "../js/linkage/presets.js";

const solid = (outer, holes = []) => {
  const m = G.createMesh();
  const ok = G.extrude(m, { outer, holes }, 0, 3);
  return { ok, closed: ok && G.isClosed(m), mesh: m };
};

test("a swept ring is one closed solid", () => {
  const r = solid(G.circle({ x: 0, y: 0 }, 10, 32), [G.circle({ x: 0, y: 0 }, 3, 32)]);
  assert.ok(r.ok, "a washer sweeps");
  assert.ok(r.closed, "and closes");
});

test("link plates close for one, two, three and many pins", () => {
  const sets = [
    [{ x: 0, y: 0 }],
    [{ x: 0, y: 0 }, { x: 60, y: 0 }],
    [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 20, y: 45 }],
    [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 20, y: 45 }, { x: -15, y: 20 }, { x: 30, y: -25 }],
  ];
  for (const pins of sets) {
    const r = solid(G.hullOffset(pins, 6, 12), pins.map((p) => G.circle(p, 1.7, 32)));
    assert.ok(r.closed, `${pins.length}-pin plate is a closed solid`);
  }
});

test("collinear pins collapse to a capsule and still close", () => {
  /* The hull of three collinear points is two points, which the offset has to
     round into a capsule rather than trying to walk a degenerate polygon. */
  const pins = [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 60, y: 0 }];
  const r = solid(G.hullOffset(pins, 6, 12), pins.map((p) => G.circle(p, 1.7, 32)));
  assert.ok(r.closed, "a bar with a mid pin is a closed solid");
});

test("a rail closes with a slot and two mounting holes", () => {
  const a = { x: 0, y: 0 }, b = { x: 80, y: 0 };
  const ea = { x: -13, y: 0 }, eb = { x: 93, y: 0 };
  const r = solid(G.stadium(ea, eb, 3.7, 12),
                  [G.stadium(a, b, 1.7, 8), G.circle(ea, 1.5, 32), G.circle(eb, 1.5, 32)]);
  assert.ok(r.closed, "a slotted rail is a closed solid");
});

test("a row of holes on one line does not stall the seam search", () => {
  /* The case the C singles out: seams to holes at the same height can land on
     one another, leaving a polygon with no ear anywhere. Baseplates come out
     this way routinely. */
  const anchors = [-40, -20, 0, 20, 40].map((x) => ({ x, y: 0 }));
  const r = solid(G.hullOffset(anchors, 14, 12), anchors.map((p) => G.circle(p, 1.7, 32)));
  assert.ok(r.closed, "a baseplate with anchors in a row is a closed solid");
});

test("an unclosed soup is rejected", () => {
  const m = G.createMesh();
  G.addTri(m, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
  assert.ok(!G.isClosed(m), "a lone triangle is not a solid");
});

test("every preset exports with no part failing its watertight check", () => {
  for (const preset of PRESETS) {
    const { mechanism } = buildPreset(preset.id);
    const out = exportPrintableParts(mechanism);
    assert.ok(out.written > 0, `${preset.id}: something was written`);
    assert.equal(out.failed, 0, `${preset.id}: no part failed to sweep or close`);
    /* One STL per part, and every one carries a name a slicer can open. */
    for (const f of out.files) assert.ok(f.name.endsWith(".stl"), `${preset.id}: ${f.name}`);
  }
});

test("parts that share a pin are put on different layers", () => {
  /* Two bodies on one pin at the same height would occupy the same space. */
  const { mechanism } = buildPreset("four-bar");
  const out = exportPrintableParts(mechanism);
  assert.ok(out.layers >= 2, "a four-bar needs at least two layers");
});

test("an empty mechanism writes nothing", () => {
  const out = exportPrintableParts(M.create());
  assert.equal(out.written, 0, "nothing drawn, nothing to print");
  assert.equal(out.files.length, 0);
});

test("a lone anchor yields a baseplate and no link plates", () => {
  /* The baseplate is what holds the anchors, so it does not need a link to
     exist -- but there is no body to plate, and nothing to pin to it. */
  const m = M.create();
  M.addConnector(m, { x: 0, y: 0 }, true);
  const out = exportPrintableParts(m);
  const names = out.files.map((f) => f.name);
  assert.ok(names.includes("baseplate.stl"), "the plate is written");
  assert.ok(!names.some((n) => n.startsWith("link_")), "but no link plates");
  assert.equal(out.failed, 0);
});

test("the archive is a well-formed zip", () => {
  const { mechanism } = buildPreset("yoke");
  const out = exportPrintableParts(mechanism);
  const entries = [{ name: "MANIFEST.txt", bytes: out.manifest }, ...out.files];
  const zip = makeZip(entries);

  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  assert.equal(view.getUint32(0, true), 0x04034b50, "starts with a local file header");
  /* The end-of-central-directory record is the last 22 bytes when there is no
     archive comment, and it has to agree about how many entries there are. */
  const eocd = zip.length - 22;
  assert.equal(view.getUint32(eocd, true), 0x06054b50, "ends with the central directory record");
  assert.equal(view.getUint16(eocd + 8, true), entries.length, "entry count matches");
  assert.equal(view.getUint16(eocd + 10, true), entries.length);
  const centralStart = view.getUint32(eocd + 16, true);
  assert.equal(view.getUint32(centralStart, true), 0x02014b50, "central directory is where it says");
});

test("a written STL has the header and triangle count its bytes claim", () => {
  const m = G.createMesh();
  assert.ok(G.extrude(m, { outer: G.circle({ x: 0, y: 0 }, 5, 16), holes: [] }, 0, 2));
  const bytes = G.writeStl(m, "disc");
  const tris = G.triCount(m);
  assert.equal(bytes.length, 84 + tris * 50, "binary STL is 84 bytes plus 50 per triangle");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(80, true), tris, "the count in the header is the count written");
});
