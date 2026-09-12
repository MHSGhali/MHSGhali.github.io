/* The line-oriented scene description, from src/scenefile.c -- parsed AND
   written, so a scene built in the browser can be downloaded and fed straight
   back to the C CLI.

     # comment
     camera   <eye xyz> <target xyz> <fov_y_deg> <width> <height>
     grid     <origin xyz> <edge_u xyz> <edge_v xyz> <nu> <nv>
     material <name> lambert <albedo>
     material <name> metal   <al|cu|au> <alpha>
     material <name> emit    <radiance>
     plane    <mat> <centre xyz> <normal xyz>
     quad     <mat> <centre xyz> <normal xyz> <half_u xyz> <half_v xyz>
     sphere   <mat> <centre xyz> <radius>
     light point  <xyz> <W|lm> <value> <spd>
     light spot   <xyz> <dir xyz> <total_deg> <falloff_deg> <W|lm> <value> <spd>
     light rect   <centre xyz> <half_u xyz> <half_v xyz> <W|lm> <value> <spd>
     light disk   <centre xyz> <normal xyz> <radius> <W|lm> <value> <spd>
     light sphere <centre xyz> <radius> <W|lm> <value> <spd>
     light sun    <dir xyz> <irradiance W/m2> <spd>

     spd := flat | blackbody <K> | daylight <K> | led <centre_nm> <fwhm_nm>

   A DESCRIPTION, not a Scene: it keeps the authoring parameters the file
   states -- "200 lm of daylight 5000" rather than the 1.085 W that reaches the
   light constructor. The property panel edits these, and writing the file back
   reproduces what was read. buildScene() turns a description into the runtime
   Scene the estimators use. */

import { PI } from "./core.js?v=3d923acb";
import * as v from "./vec3.js?v=3d923acb";
import * as S from "./spectrum.js?v=3d923acb";
import * as U from "./units.js?v=3d923acb";
import * as B from "./bsdf.js?v=3d923acb";
import * as L from "./light.js?v=3d923acb";
import * as G from "./geom.js?v=3d923acb";
import { createScene } from "./scene.js?v=3d923acb";

export function emptyDesc() {
  return { materials: [], prims: [], lights: [], grid: null, camera: null };
}

/* ------------------------------------------------------------------ parse */

class Parser {
  constructor(text) {
    /* Strip comments to end of line, then split on any whitespace. */
    this.toks = text
      .split("\n")
      .map((line) => { const i = line.indexOf("#"); return i >= 0 ? line.slice(0, i) : line; })
      .join(" ")
      .split(/\s+/)
      .filter((t) => t.length > 0);
    this.i = 0;
  }
  next() { return this.i < this.toks.length ? this.toks[this.i++] : null; }
  peek() { return this.i < this.toks.length ? this.toks[this.i] : null; }
  num() {
    const t = this.next();
    if (t === null) throw new Error("unexpected end of file, expected a number");
    const x = Number(t);
    if (!Number.isFinite(x)) throw new Error(`expected a number, got '${t}'`);
    return x;
  }
  vec() { return v.v3(this.num(), this.num(), this.num()); }
}

function parseSpd(p) {
  const t = p.next();
  if (t === null) throw new Error("expected a spectrum");
  switch (t) {
    case "flat": return { kind: "flat" };
    case "blackbody": return { kind: "blackbody", a: p.num() };
    case "daylight": return { kind: "daylight", a: p.num() };
    case "led": return { kind: "led", a: p.num(), b: p.num() };
    default: throw new Error(`unknown spectrum '${t}'`);
  }
}

/* "<W|lm> <value> <spd>". The unit is kept so the file round-trips; the
   conversion to watts happens in buildScene, once, exactly as the C does it
   at load, so no photometric value is ever stored on a light. */
function parseFlux(p) {
  const unit = p.next();
  if (unit !== "W" && unit !== "lm") {
    throw new Error(`flux unit must be W or lm, got '${unit}'`);
  }
  const value = p.num();
  const spd = parseSpd(p);
  return { fluxUnit: unit, fluxValue: value, spd };
}

export function parseScene(text) {
  const d = emptyDesc();
  const p = new Parser(text);
  let t;
  while ((t = p.next()) !== null) {
    switch (t) {
      case "camera": {
        const eye = p.vec(), target = p.vec();
        d.camera = { eye, target, fov: p.num(), width: p.num() | 0, height: p.num() | 0 };
        break;
      }
      case "grid": {
        const o = p.vec(), u = p.vec(), vv = p.vec();
        d.grid = { o, u, v: vv, nu: p.num() | 0, nv: p.num() | 0 };
        break;
      }
      case "material": {
        const name = p.next();
        const kind = p.next();
        if (!name || !kind) throw new Error("material needs a name and a kind");
        if (kind === "lambert") d.materials.push({ name, kind, albedo: p.num() });
        else if (kind === "metal") d.materials.push({ name, kind, metal: p.next(), alpha: p.num() });
        else if (kind === "emit") d.materials.push({ name, kind, radiance: p.num() });
        else throw new Error(`unknown material kind '${kind}'`);
        break;
      }
      case "plane": case "quad": case "sphere": {
        const material = p.next();
        if (!d.materials.some((m) => m.name === material)) {
          throw new Error(`unknown material '${material}'`);
        }
        if (t === "plane") d.prims.push({ kind: "plane", material, c: p.vec(), n: p.vec() });
        else if (t === "quad") {
          d.prims.push({ kind: "quad", material, c: p.vec(), n: p.vec(), ex: p.vec(), ey: p.vec() });
        } else d.prims.push({ kind: "sphere", material, c: p.vec(), r: p.num() });
        break;
      }
      case "light": {
        const kind = p.next();
        if (kind === "point") {
          const pos = p.vec();
          d.lights.push({ kind, p: pos, ...parseFlux(p) });
        } else if (kind === "spot") {
          const pos = p.vec(), dir = p.vec();
          const totalDeg = p.num(), falloffDeg = p.num();
          d.lights.push({ kind, p: pos, dir, totalDeg, falloffDeg, ...parseFlux(p) });
        } else if (kind === "rect") {
          const c = p.vec(), ex = p.vec(), ey = p.vec();
          d.lights.push({ kind, p: c, ex, ey, ...parseFlux(p) });
        } else if (kind === "disk") {
          const c = p.vec(), n = p.vec(), r = p.num();
          d.lights.push({ kind, p: c, n, r, ...parseFlux(p) });
        } else if (kind === "sphere") {
          const c = p.vec(), r = p.num();
          d.lights.push({ kind, p: c, r, ...parseFlux(p) });
        } else if (kind === "sun") {
          const dir = p.vec(), e = p.num();
          d.lights.push({ kind, dir, ePerp: e, spd: parseSpd(p) });
        } else throw new Error(`unknown light kind '${kind}'`);
        break;
      }
      default:
        throw new Error(`unknown directive '${t}'`);
    }
  }
  return d;
}

/* ------------------------------------------------------------- serialise */

const n6 = (x) => {
  /* Short but lossless enough to round-trip through the C's atof. */
  const s = Number(x.toPrecision(9));
  return String(Object.is(s, -0) ? 0 : s);
};
const vs = (a) => `${n6(a.x)} ${n6(a.y)} ${n6(a.z)}`;
const spdStr = (s) =>
  s.kind === "flat" ? "flat"
  : s.kind === "led" ? `led ${n6(s.a)} ${n6(s.b)}`
  : `${s.kind} ${n6(s.a)}`;

export function serializeScene(d) {
  const out = [
    "# Written by the light simulator on mhsghali.github.io.",
    "# Same format as the Light-Simulation CLI: ./lightsim grid this.scene",
    "",
  ];
  for (const m of d.materials) {
    if (m.kind === "lambert") out.push(`material ${m.name} lambert ${n6(m.albedo)}`);
    else if (m.kind === "metal") out.push(`material ${m.name} metal ${m.metal} ${n6(m.alpha)}`);
    else out.push(`material ${m.name} emit ${n6(m.radiance)}`);
  }
  if (d.materials.length) out.push("");
  for (const pr of d.prims) {
    if (pr.kind === "plane") out.push(`plane ${pr.material} ${vs(pr.c)} ${vs(pr.n)}`);
    else if (pr.kind === "quad") {
      out.push(`quad ${pr.material} ${vs(pr.c)} ${vs(pr.n)} ${vs(pr.ex)} ${vs(pr.ey)}`);
    } else out.push(`sphere ${pr.material} ${vs(pr.c)} ${n6(pr.r)}`);
  }
  if (d.prims.length) out.push("");
  for (const l of d.lights) {
    /* A sun states an irradiance, not a flux, and carries no fluxValue at all --
       so the flux clause must not be built for it. */
    const flux = l.kind === "sun" ? "" : `${l.fluxUnit} ${n6(l.fluxValue)} ${spdStr(l.spd)}`;
    if (l.kind === "point") out.push(`light point ${vs(l.p)} ${flux}`);
    else if (l.kind === "spot") {
      out.push(`light spot ${vs(l.p)} ${vs(l.dir)} ${n6(l.totalDeg)} ${n6(l.falloffDeg)} ${flux}`);
    } else if (l.kind === "rect") out.push(`light rect ${vs(l.p)} ${vs(l.ex)} ${vs(l.ey)} ${flux}`);
    else if (l.kind === "disk") out.push(`light disk ${vs(l.p)} ${vs(l.n)} ${n6(l.r)} ${flux}`);
    else if (l.kind === "sphere") out.push(`light sphere ${vs(l.p)} ${n6(l.r)} ${flux}`);
    else if (l.kind === "sun") out.push(`light sun ${vs(l.dir)} ${n6(l.ePerp)} ${spdStr(l.spd)}`);
  }
  if (d.lights.length) out.push("");
  if (d.grid) {
    out.push(`grid ${vs(d.grid.o)} ${vs(d.grid.u)} ${vs(d.grid.v)} ${d.grid.nu} ${d.grid.nv}`);
  }
  if (d.camera) {
    const c = d.camera;
    out.push(`camera ${vs(c.eye)} ${vs(c.target)} ${n6(c.fov)} ${c.width} ${c.height}`);
  }
  return out.join("\n") + "\n";
}

/* ------------------------------------------------------------ build ----- */

export function spdSpectrum(s) {
  switch (s.kind) {
    case "blackbody": return S.blackbody(s.a);
    case "daylight": return S.daylight(s.a);
    case "led": return S.gaussian(s.a, s.b, 1.0);
    default: return S.constant(1.0);
  }
}

function makeMaterial(m) {
  if (m.kind === "lambert") {
    return { bsdf: B.makeLambert(S.constant(m.albedo)), le: S.zero(), emissive: false };
  }
  if (m.kind === "metal") {
    return { bsdf: B.makeConductor(m.metal, m.alpha), le: S.zero(), emissive: false };
  }
  return {
    bsdf: B.makeLambert(S.zero()),
    le: S.constant(m.radiance),
    emissive: true,
  };
}

function makeLight(l) {
  const spd = spdSpectrum(l.spd);
  if (l.kind === "sun") return L.directional(l.dir, l.ePerp, spd);
  /* Lumens are converted to watts here, once, and never stored. */
  const w = l.fluxUnit === "lm" ? U.wattsFromLumens(l.fluxValue, spd) : l.fluxValue;
  switch (l.kind) {
    case "point": return L.point(l.p, w, spd);
    case "spot":
      return L.spot(l.p, l.dir, (l.totalDeg * PI) / 180, (l.falloffDeg * PI) / 180, w, spd);
    case "rect": return L.rect(l.p, l.ex, l.ey, w, spd);
    case "disk": return L.disk(l.p, l.n, l.r, w, spd);
    case "sphere": return L.sphere(l.p, l.r, w, spd);
  }
  throw new Error(`unknown light kind '${l.kind}'`);
}

/* Turn a description into the runtime Scene.

   `surfaces` lists the prims that came from the description's own geometry --
   the ones a field is painted on. Emissive geometry added for area lights is
   deliberately excluded: a lamp is a source, not a receiver. */
export function buildScene(d) {
  const sc = createScene();
  const matIndex = new Map();

  d.materials.forEach((m, i) => {
    matIndex.set(m.name, i);
    sc.mats.push(makeMaterial(m));
  });

  const surfaces = [];
  for (const pr of d.prims) {
    const matId = matIndex.get(pr.material) ?? 0;
    const prim = {
      kind: pr.kind, c: pr.c, n: pr.n ? v.normalize(pr.n) : v.v3(0, 0, 1),
      ex: pr.ex || v.v3(0, 0, 0), ey: pr.ey || v.v3(0, 0, 0),
      r: pr.r || 0, matId, lightId: -1,
    };
    surfaces.push(sc.prims.length);
    sc.prims.push(prim);
  }

  d.lights.forEach((ld, i) => {
    const l = makeLight(ld);
    L.finalize(l, i);
    sc.lights.push(l);

    /* Emissive geometry bound to the area light, so the source is visible to
       BSDF sampling and MIS can weight the two strategies against each other.
       Delta lights have no geometry. */
    if (l.kind === L.RECT || l.kind === L.DISK || l.kind === L.SPHERE) {
      const matId = sc.mats.length;
      sc.mats.push({
        bsdf: B.makeLambert(S.zero()),
        le: S.scale(l.sHat, l.radiance),
        emissive: true,
      });
      const prim = { c: l.p, n: l.n, ex: l.ex, ey: l.ey, r: l.radius, matId, lightId: i };
      prim.kind = l.kind === L.RECT ? G.QUAD : l.kind === L.DISK ? G.DISK : G.SPHERE;
      sc.prims.push(prim);
    }
  });

  return { scene: sc, surfaces };
}
