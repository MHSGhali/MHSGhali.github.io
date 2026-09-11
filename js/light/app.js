/* Page controller for the light simulator: scene state, the worker, the 3D
   view, the property panel, and the readouts. */

import { createView } from "./view3d.js?v=14550619";
import { PRESETS, presetById } from "./presets.js?v=14550619";
import { parseScene, serializeScene, buildScene } from "./scenefile.js?v=14550619";
import { viridis } from "./viridis.js?v=14550619";
import { stats } from "./stats.js?v=14550619";
import * as v from "./vec3.js?v=14550619";

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/* ------------------------------------------------------------------ state */

const state = {
  desc: null,
  photometric: true,     /* lux vs W/m^2 */
  includeIndirect: true, /* full vs direct-only */
  quality: "draft",
  selection: null,       /* {kind:'light'|'prim', index} */
  surfaces: [],          /* {primId, nverts, pos, nor} */
  lastStats: null,       /* what the stats line last said, for the assistant */
  nlights: 0,
  weights: null,
  direct: null,
  indRad: null,
  indLum: null,
  pass: 0,
  passes: 0,
  gen: 0,
  scale: { lo: 0, hi: 1 },
  message: "",
};

let view = null;
let worker = null;
let solveTimer = 0;

/* Eight passes of eight samples each. Enough to settle visibly, few enough
   that a change is not chasing a solve that will not finish. */
const INDIRECT_PASSES = 8;
const DEPTH = 3;

/* ---------------------------------------------------------------- worker */

function startWorker() {
  /* Carry this module's ?v= tag onto the worker URL. new URL() would otherwise
     drop the query, leaving the one file the build script cannot reach through
     an import specifier served from cache after a deploy. */
  const workerUrl = new URL("./solver.worker.js", import.meta.url);
  const version = new URL(import.meta.url).search;
  if (version) workerUrl.search = version;
  worker = new Worker(workerUrl, { type: "module" });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.gen !== state.gen) return; /* a newer request has superseded this one */
    if (m.type === "geometry") {
      state.nlights = m.nlights;
      state.weights = m.weights;
      state.surfaces = m.surfaces.map((s) => ({
        primId: s.primId, hidden: !!s.hidden,
        pos: s.pos, nor: s.nor, idx: s.idx, nverts: s.pos.length / 3,
      }));
      state.gridIndex = state.surfaces.findIndex((s) => s.hidden);
      state.direct = null; state.indRad = null; state.indLum = null;
      state.pass = 0; state.passes = m.passes || 0;
      view && view.setSurfaces(state.surfaces);
    } else if (m.type === "direct") {
      state.direct = m.direct;
      repaint();
      say(`direct solved · ${state.quality}`);
    } else if (m.type === "indirect") {
      state.indRad = m.indRad;
      state.indLum = m.indLum;
      state.pass = m.pass;
      state.passes = m.passes;
      repaint();
      say(m.pass >= m.passes
        ? "converged · direct + interreflection"
        : `interreflection pass ${m.pass}/${m.passes}…`);
    } else if (m.type === "error") {
      say("scene error: " + m.message, true);
    }
  };
  worker.onerror = (e) => say("solver failed: " + e.message, true);
}

function solve(immediate = false) {
  clearTimeout(solveTimer);
  const go = () => {
    if (!worker) return;
    state.gen++;
    worker.postMessage({
      type: "solve",
      gen: state.gen,
      sceneText: serializeScene(state.desc),
      quality: state.quality,
      depth: DEPTH,
      indirectPasses: INDIRECT_PASSES,
    });
    say("solving…");
    /* min/mean/max keep changing while interreflection accumulates. Without
       this the numbers just drift with no sign they are provisional, and a
       visitor who reads one early reads a wrong one. Cleared on converge. */
    $("#stats").classList.add("unsettled");
  };
  if (immediate) go();
  else solveTimer = setTimeout(go, 90); /* coalesce a drag into one solve */
}

/* --------------------------------------------------------------- shading */

/* Collapse the stored per-light rows to one number per vertex. No re-solve:
   this is the whole reason attribution is stored instead of a spectrum. */
function shadeSurface(si) {
  const s = state.surfaces[si];
  const nl = state.nlights;
  const out = new Float64Array(s.nverts);
  const dw = state.photometric ? state.weights.lum : state.weights.rad;
  const dir = state.direct ? state.direct[si] : null;
  const ind = state.includeIndirect
    ? (state.photometric ? state.indLum : state.indRad)
    : null;
  const ia = ind ? ind[si] : null;
  for (let i = 0; i < s.nverts; i++) {
    let sum = 0;
    for (let li = 0; li < nl; li++) {
      if (dir) sum += dir[i * nl + li] * dw[li];
      if (ia) sum += ia[i * nl + li];
    }
    out[i] = sum;
  }
  return out;
}

function repaint() {
  if (!view || !state.direct || !state.weights) return;
  const shaded = state.surfaces.map((_, i) => shadeSurface(i));

  /* One scale across every DRAWN surface, so the floor and the wall are
     comparable. The top of the ramp is the 99th percentile rather than the
     maximum: a single near-field vertex right under a lamp would otherwise
     flatten everything else to the bottom of the ramp. */
  const all = [];
  shaded.forEach((a, i) => {
    if (state.surfaces[i].hidden) return;
    for (let k = 0; k < a.length; k++) all.push(a[k]);
  });
  all.sort((a, b) => a - b);
  const lo = 0;
  const hi = all.length ? Math.max(all[Math.floor(all.length * 0.99)], 1e-6) : 1;
  state.scale = { lo, hi };

  shaded.forEach((values, i) => view.setField(i, values, lo, hi, viridis));
  drawLegend();
  /* Uniformity is reported over the measurement grid when the scene defines
     one -- that is the plane a lighting study actually quotes U0 and Ud for.
     Averaged over every surface in the room they would be meaningless. */
  const gi = state.gridIndex;
  updateStats(gi >= 0 ? Array.from(shaded[gi]).sort((a, b) => a - b) : all,
              gi >= 0 ? "measurement grid" : "all surfaces");
  state.shaded = shaded;
}

const unitLabel = () => (state.photometric ? "lx" : "W·m⁻²");

function drawLegend() {
  const c = $("#legend");
  const ctx = c.getContext("2d");
  const w = (c.width = c.clientWidth * 2);
  const h = (c.height = 18 * 2);
  for (let x = 0; x < w; x++) {
    const col = viridis(x / (w - 1));
    ctx.fillStyle = `rgb(${col.r * 255 | 0},${col.g * 255 | 0},${col.b * 255 | 0})`;
    ctx.fillRect(x, 0, 1, h);
  }
  $("#legend-lo").textContent = "0";
  $("#legend-hi").textContent = `${fmt(state.scale.hi)} ${unitLabel()}`;
}

const fmt = (x) =>
  x >= 1000 ? Math.round(x).toLocaleString() : x >= 10 ? x.toFixed(0) : x.toFixed(2);

/* Whether the numbers on screen are final. Direct-only is done the moment the
   direct pass lands; with interreflection on, every pass moves them, so they
   are provisional until the last one. Mirrors what say() reports, so the
   status line and the stats never disagree about whether this is the answer. */
function settled() {
  if (!state.direct) return false;
  if (!state.includeIndirect) return true;
  return state.passes > 0 && state.pass >= state.passes;
}

function updateStats(sorted, over) {
  if (!sorted || !sorted.length) return;
  $("#stats").classList.toggle("unsettled", !settled());
  const st = stats(sorted);
  /* Kept for the assistant panel, which reads the same numbers back in words.
     Formatted here rather than there so the two can never disagree about what
     the solver said. */
  let dark = 0;
  for (let i = 0; i < sorted.length; i++) if (sorted[i] <= 0) dark++;
  state.lastStats = {
    min: fmt(st.min), mean: fmt(st.mean), max: fmt(st.max),
    u0: st.u0.toFixed(3), over, settled: settled(),
    dark, points: sorted.length,
  };
  $("#stats").innerHTML =
    `<b>${fmt(st.min)}</b> min &nbsp; <b>${fmt(st.mean)}</b> mean &nbsp; ` +
    `<b>${fmt(st.max)}</b> max ${unitLabel()} &nbsp;·&nbsp; ` +
    `<b>U₀</b> ${st.u0.toFixed(3)} &nbsp; <b>U<sub>d</sub></b> ${st.ud.toFixed(3)}` +
    `<span class="over"> over the ${over}</span>`;

  /* A single unlit point drives both uniformity ratios to zero, so say why
     rather than leaving two zeroes looking like a broken solve. The C prints
     the same caveat. */
  $("#zeros").textContent = dark
    ? `${dark} of ${sorted.length} points receive no light at all, which is why the uniformity ratios are zero.`
    : "";
}

function say(text, warn = false) {
  state.message = text;
  const n = $("#msg");
  n.textContent = text;
  n.classList.toggle("warn", warn);
}

/* ----------------------------------------------------------------- scene */

function loadText(text, label) {
  try {
    state.desc = parseScene(text);
  } catch (e) {
    say("scene error: " + e.message, true);
    return false;
  }
  state.selection = null;
  refreshLamps();
  buildPanel();
  solve(true);
  frameView();
  if (label) say(label);
  return true;
}

function refreshLamps() {
  if (!view) return;
  view.setLamps(state.desc.lights);
  state.desc.lights.forEach((l, i) => view.placeLamp(i, l));
}

function sceneBounds() {
  const b = { min: { x: 1e9, y: 1e9, z: 1e9 }, max: { x: -1e9, y: -1e9, z: -1e9 } };
  const add = (p, pad = 0) => {
    b.min.x = Math.min(b.min.x, p.x - pad); b.max.x = Math.max(b.max.x, p.x + pad);
    b.min.y = Math.min(b.min.y, p.y - pad); b.max.y = Math.max(b.max.y, p.y + pad);
    b.min.z = Math.min(b.min.z, p.z - pad); b.max.z = Math.max(b.max.z, p.z + pad);
  };
  for (const p of state.desc.prims) {
    if (p.kind === "sphere") add(p.c, p.r);
    else if (p.kind === "quad") {
      add(v.add(v.add(p.c, p.ex), p.ey)); add(v.sub(v.sub(p.c, p.ex), p.ey));
      add(v.add(v.sub(p.c, p.ex), p.ey)); add(v.sub(v.add(p.c, p.ex), p.ey));
    } else add(p.c, 0.5);
  }
  for (const l of state.desc.lights) if (l.p) add(l.p, l.r || 0.05);
  if (b.min.x > b.max.x) { b.min = { x: -0.5, y: -0.5, z: 0 }; b.max = { x: 0.5, y: 0.5, z: 0.5 }; }
  return b;
}

const frameView = () => view && view.frame(sceneBounds());

/* --------------------------------------------------------------- panel */

function buildPanel() {
  const panel = $("#panel");
  panel.innerHTML = "";
  const sel = state.selection;
  if (!sel) {
    panel.appendChild(el("p", "panel-hint",
      "Click a lamp or a surface in the view to edit it. Drag the gizmo to move it."));
    return;
  }

  const row = (label, node) => {
    const r = el("div", "prow");
    r.appendChild(el("label", null, label));
    r.appendChild(node);
    panel.appendChild(r);
    return node;
  };
  const numberInput = (value, step, onChange) => {
    const i = el("input");
    i.type = "number";
    i.step = step;
    i.value = String(Number(value.toPrecision(6)));
    i.addEventListener("change", () => { onChange(Number(i.value)); commit(); });
    return i;
  };
  const vecRow = (label, obj, onChange) => {
    const wrap = el("div", "vec3");
    for (const k of ["x", "y", "z"]) {
      const i = el("input");
      i.type = "number";
      i.step = "0.01";
      i.value = String(Number(obj[k].toPrecision(6)));
      i.addEventListener("change", () => { obj[k] = Number(i.value); onChange && onChange(); commit(); });
      wrap.appendChild(i);
    }
    row(label, wrap);
  };
  const select = (label, options, value, onChange) => {
    const s = el("select");
    for (const o of options) {
      const opt = el("option", null, o.label);
      opt.value = o.value;
      s.appendChild(opt);
    }
    s.value = value;
    s.addEventListener("change", () => { onChange(s.value); commit(); });
    return row(label, s);
  };

  if (sel.kind === "light") {
    const l = state.desc.lights[sel.index];
    panel.appendChild(el("h3", null, `Light ${sel.index + 1} — ${l.kind}`));
    if (l.p) vecRow("position", l.p, () => view.placeLamp(sel.index, l));
    if (l.kind === "rect") {
      vecRow("half edge u", l.ex, () => view.placeLamp(sel.index, l));
      vecRow("half edge v", l.ey, () => view.placeLamp(sel.index, l));
    }
    if (l.kind === "disk") {
      vecRow("normal", l.n, () => view.placeLamp(sel.index, l));
      row("radius", numberInput(l.r, "0.005", (x) => { l.r = x; view.placeLamp(sel.index, l); }));
    }
    if (l.kind === "sphere") {
      row("radius", numberInput(l.r, "0.005", (x) => { l.r = x; view.placeLamp(sel.index, l); }));
    }
    if (l.kind === "spot") {
      vecRow("aim", l.dir, () => view.placeLamp(sel.index, l));
      row("cone °", numberInput(l.totalDeg, "1", (x) => { l.totalDeg = x; }));
      row("falloff °", numberInput(l.falloffDeg, "1", (x) => { l.falloffDeg = x; }));
    }
    if (l.kind === "sun") vecRow("direction", l.dir, () => {});

    if (l.kind === "sun") {
      row("irradiance W·m⁻²", numberInput(l.ePerp, "1", (x) => { l.ePerp = x; }));
    } else {
      row("flux", numberInput(l.fluxValue, "1", (x) => { l.fluxValue = x; }));
      select("flux unit", [{ value: "lm", label: "lumens" }, { value: "W", label: "watts" }],
        l.fluxUnit, (u) => {
          /* A lamp is not silently re-rated: converting the number as well as
             the label would change the light, which is not what picking a unit
             should do. Both are honest ways to state the same lamp. */
          l.fluxUnit = u;
        });
    }

    select("spectrum", [
      { value: "flat", label: "flat" },
      { value: "blackbody", label: "blackbody" },
      { value: "daylight", label: "daylight" },
      { value: "led", label: "LED" },
    ], l.spd.kind, (k) => {
      l.spd = k === "led" ? { kind: k, a: 620, b: 25 }
        : k === "flat" ? { kind: k }
        : { kind: k, a: k === "blackbody" ? 3000 : 5000 };
      buildPanel();
    });
    if (l.spd.kind === "blackbody" || l.spd.kind === "daylight") {
      row("temperature K", numberInput(l.spd.a, "100", (x) => { l.spd.a = x; }));
    }
    if (l.spd.kind === "led") {
      row("centre nm", numberInput(l.spd.a, "5", (x) => { l.spd.a = x; }));
      row("FWHM nm", numberInput(l.spd.b, "1", (x) => { l.spd.b = x; }));
    }
    const del = el("button", "tbtn", "Delete this light");
    del.addEventListener("click", () => {
      state.desc.lights.splice(sel.index, 1);
      state.selection = null;
      refreshLamps(); buildPanel(); solve(true);
    });
    panel.appendChild(del);
  } else {
    const p = state.desc.prims[sel.index];
    panel.appendChild(el("h3", null, `Surface ${sel.index + 1} — ${p.kind}`));
    vecRow("centre", p.c);
    if (p.kind === "quad") { vecRow("normal", p.n); vecRow("half edge u", p.ex); vecRow("half edge v", p.ey); }
    if (p.kind === "plane") vecRow("normal", p.n);
    if (p.kind === "sphere") row("radius", numberInput(p.r, "0.005", (x) => { p.r = x; }));

    const mat = state.desc.materials.find((m) => m.name === p.material);
    select("material", state.desc.materials.map((m) => ({ value: m.name, label: m.name })),
      p.material, (n) => { p.material = n; buildPanel(); });
    if (mat && mat.kind === "lambert") {
      row("albedo", numberInput(mat.albedo, "0.05", (x) => { mat.albedo = Math.max(0, Math.min(1, x)); }));
    }
    if (mat && mat.kind === "metal") {
      select("metal", [{ value: "al", label: "aluminium" }, { value: "cu", label: "copper" },
                       { value: "au", label: "gold" }], mat.metal, (m) => { mat.metal = m; });
      row("roughness α", numberInput(mat.alpha, "0.02", (x) => { mat.alpha = Math.max(0, x); }));
    }
    const del = el("button", "tbtn", "Delete this surface");
    del.addEventListener("click", () => {
      state.desc.prims.splice(sel.index, 1);
      state.selection = null;
      buildPanel(); solve(true);
    });
    panel.appendChild(del);
  }
}

function commit() {
  refreshLamps();
  solve();
}

/* ------------------------------------------------------------- selection */

function selectFrom(hit) {
  if (!hit) { state.selection = null; view.attachGizmo(null); buildPanel(); return; }
  if (hit.lightIndex !== undefined) {
    state.selection = { kind: "light", index: hit.lightIndex };
    view.attachGizmo(view.lampObject(hit.lightIndex));
  } else {
    const primId = hit.primId;
    const idx = state.desc.prims.findIndex((_, i) => i === primId);
    state.selection = idx >= 0 ? { kind: "prim", index: idx } : null;
    view.attachGizmo(null);
  }
  buildPanel();
}

/* ------------------------------------------------- the assistant's hands

   The pointer picks a lamp or a surface for a person with a mouse; these do the
   same by number, and edit whatever is picked. Every one of them ends in the
   same three calls the properties panel makes, so a change asked for in words
   and a change typed into a box land identically. */

function sceneSummary() {
  return {
    lights: state.desc.lights.map((l, i) => ({
      n: i + 1, kind: l.kind, p: l.p, flux: l.fluxValue, unit: l.fluxUnit, spd: l.spd,
      totalDeg: l.totalDeg,
    })),
    prims: state.desc.prims.map((p, i) => ({
      n: i + 1, kind: p.kind, c: p.c, material: p.material,
      albedo: (state.desc.materials.find((m) => m.name === p.material) || {}).albedo,
    })),
    selection: state.selection,
  };
}

/* `n` is what sceneSummary hands out: 1-based, the number the panel reads. */
function selectByNumber(kind, n) {
  const list = kind === "light" ? state.desc.lights : state.desc.prims;
  const obj = list[n - 1];
  if (!obj) return null;
  state.selection = { kind, index: n - 1 };
  view.attachGizmo(kind === "light" ? view.lampObject(n - 1) : null);
  buildPanel();
  return { n, kind: obj.kind, obj };
}

const round = (x) => Math.round(x * 1000) / 1000;

function editSelection(patch) {
  const sel = state.selection;
  if (!sel) return null;
  const obj = sel.kind === "light" ? state.desc.lights[sel.index] : state.desc.prims[sel.index];
  if (!obj) return null;
  const said = [];

  if (patch.flux && sel.kind === "light") {
    obj.fluxValue = Number(patch.flux.value);
    if (patch.flux.unit) obj.fluxUnit = patch.flux.unit;
    said.push(`${obj.fluxValue} ${obj.fluxUnit === "lm" ? "lm" : "W"}`);
  }
  if (patch.temperature !== undefined && sel.kind === "light") {
    /* A temperature only means something on a blackbody or daylight spectrum,
       so asking for one switches to daylight rather than being ignored. */
    if (obj.spd.kind !== "blackbody" && obj.spd.kind !== "daylight") obj.spd = { kind: "daylight" };
    obj.spd.a = patch.temperature;
    said.push(`${patch.temperature} K`);
  }
  if (patch.cone !== undefined && sel.kind === "light" && obj.kind === "spot") {
    obj.totalDeg = patch.cone;
    obj.falloffDeg = Math.min(obj.falloffDeg ?? patch.cone * 0.6, patch.cone);
    said.push(`a ${patch.cone}° cone`);
  }
  const at = sel.kind === "light" ? obj.p : obj.c;
  if (patch.position) {
    for (const k of ["x", "y", "z"]) if (patch.position[k] !== undefined) at[k] = patch.position[k];
    said.push(`(${round(at.x)}, ${round(at.y)}, ${round(at.z)}) m`);
  }
  if (patch.move) {
    for (const k of ["x", "y", "z"]) at[k] += patch.move[k] || 0;
    said.push(`(${round(at.x)}, ${round(at.y)}, ${round(at.z)}) m`);
  }
  if (patch.radius !== undefined && obj.kind === "sphere") {
    obj.r = Math.max(0.001, patch.radius);
    said.push(`a ${round(obj.r)} m radius`);
  }
  if (patch.albedo !== undefined && sel.kind === "prim") {
    const mat = state.desc.materials.find((m) => m.name === obj.material);
    if (mat && mat.kind === "lambert") {
      mat.albedo = Math.max(0, Math.min(1, patch.albedo));
      /* The material is shared by name, so say so rather than letting a change
         to "wall" look like a change to one wall. */
      said.push(`material “${mat.name}” at albedo ${mat.albedo}`);
    }
  }
  if (!said.length) return null;
  refreshLamps();
  buildPanel();
  solve(true);
  return said;
}

function deleteSelected() {
  const sel = state.selection;
  if (!sel) return null;
  const list = sel.kind === "light" ? state.desc.lights : state.desc.prims;
  const obj = list[sel.index];
  if (!obj) return null;
  list.splice(sel.index, 1);
  state.selection = null;
  view.attachGizmo(null);
  refreshLamps();
  buildPanel();
  solve(true);
  return `${sel.kind === "light" ? "lamp" : "surface"} ${sel.index + 1}, the ${obj.kind}`;
}

/* Read the field back where the pointer is, with the per-source breakdown the
   attribution rows make free. */
function probe(hit) {
  const out = $("#probe");
  if (!hit || hit.surfaceIndex < 0 || !state.direct || !state.shaded) {
    out.textContent = "";
    return;
  }
  const values = state.shaded[hit.surfaceIndex];
  const vi = hit.faceIndex;
  if (!values || vi < 0 || vi >= values.length) { out.textContent = ""; return; }
  const nl = state.nlights;
  const dw = state.photometric ? state.weights.lum : state.weights.rad;
  const ind = state.includeIndirect ? (state.photometric ? state.indLum : state.indRad) : null;
  const parts = [];
  for (let li = 0; li < nl; li++) {
    let s = state.direct[hit.surfaceIndex][vi * nl + li] * dw[li];
    if (ind) s += ind[hit.surfaceIndex][vi * nl + li];
    parts.push(`L${li + 1} ${fmt(s)}`);
  }
  out.innerHTML = `<b>${fmt(values[vi])} ${unitLabel()}</b> &nbsp;·&nbsp; ${parts.join(" &nbsp; ")}`;
}

/* ------------------------------------------------------------- share link */

const b64url = (bytes) => {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64url = (s) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function encodeScene(text) {
  const raw = new TextEncoder().encode(text);
  if (typeof CompressionStream === "undefined") return "r" + b64url(raw);
  const cs = new CompressionStream("deflate-raw");
  const buf = await new Response(new Blob([raw]).stream().pipeThrough(cs)).arrayBuffer();
  return "z" + b64url(new Uint8Array(buf));
}
async function decodeScene(hash) {
  const tag = hash[0], body = unb64url(hash.slice(1));
  if (tag === "r") return new TextDecoder().decode(body);
  if (tag !== "z" || typeof DecompressionStream === "undefined") return null;
  const ds = new DecompressionStream("deflate-raw");
  const buf = await new Response(new Blob([body]).stream().pipeThrough(ds)).arrayBuffer();
  return new TextDecoder().decode(buf);
}

function download(name, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/* ------------------------------------------------------------------ init */

async function main() {
  const host = $("#viewport");
  view = await createView(host, {
    onFit: () => frameView(),
    onGizmoMove: () => {
      const sel = state.selection;
      if (!sel || sel.kind !== "light") return;
      const obj = view.lampObject(sel.index);
      const l = state.desc.lights[sel.index];
      if (obj && l.p) { l.p.x = obj.position.x; l.p.y = obj.position.y; l.p.z = obj.position.z; }
      buildPanel();
      solve();
    },
  });
  if (view.failed) {
    $("#vp-note").textContent =
      "The 3D view needs three.js, which could not be loaded. Nothing else on this page works without it.";
    return;
  }
  $("#vp-note").hidden = true;

  startWorker();

  for (const p of PRESETS) {
    const o = el("option", null, p.name);
    o.value = p.id;
    $("#preset").appendChild(o);
  }

  /* pointer: click selects, hover probes */
  view.domElement.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    selectFrom(view.pick(e.clientX, e.clientY));
  });
  view.domElement.addEventListener("pointermove", (e) => probe(view.pick(e.clientX, e.clientY)));

  $("#preset").addEventListener("change", () => {
    const p = presetById($("#preset").value);
    loadText(p.text, p.blurb);
    history.replaceState(null, "", location.pathname + location.search);
  });
  /* The three state buttons show both options; `aria-pressed` says which is
     live, and CSS lights that half. Nothing rewrites their text, so the pair
     stays readable and a screen reader gets the same fact the eye does. */
  const setToggle = (sel, on) => $(sel).setAttribute("aria-pressed", String(on));
  $("#btn-units").addEventListener("click", () => {
    state.photometric = !state.photometric;
    setToggle("#btn-units", state.photometric);
    /* No re-solve: both unit systems are dot products against the same rows. */
    repaint();
    say(`showing ${state.photometric ? "illuminance in lux" : "irradiance in W·m⁻²"} — no re-solve needed`);
  });
  $("#btn-mode").addEventListener("click", () => {
    state.includeIndirect = !state.includeIndirect;
    setToggle("#btn-mode", state.includeIndirect);
    repaint();
  });
  $("#btn-quality").addEventListener("click", () => {
    state.quality = state.quality === "draft" ? "fine" : "draft";
    setToggle("#btn-quality", state.quality === "fine");
    solve(true);
  });
  $("#btn-fit").addEventListener("click", frameView);
  $("#btn-scene").addEventListener("click", () => {
    download("scene.scene", serializeScene(state.desc), "text/plain");
    say("downloaded scene.scene — the C CLI reads it: ./lightsim grid scene.scene");
  });
  $("#btn-share").addEventListener("click", async () => {
    const url = location.origin + location.pathname + "#" + await encodeScene(serializeScene(state.desc));
    history.replaceState(null, "", url);
    try {
      await navigator.clipboard.writeText(url);
      say("link copied — it carries the whole scene");
    } catch {
      say("this page's address now holds the scene — copy it from the address bar");
    }
  });

  const addLight = (kind) => {
    const b = sceneBounds();
    const z = b.max.z > b.min.z ? b.max.z * 0.9 : 0.4;
    const base = { fluxUnit: "lm", fluxValue: 200, spd: { kind: "daylight", a: 5000 } };
    const p = { x: 0, y: 0, z };
    if (kind === "rect") {
      state.desc.lights.push({ kind, p, ex: { x: 0.05, y: 0, z: 0 }, ey: { x: 0, y: -0.05, z: 0 }, ...base });
    } else if (kind === "point") {
      state.desc.lights.push({ kind, p, ...base });
    } else if (kind === "spot") {
      state.desc.lights.push({ kind, p, dir: { x: 0, y: 0, z: -1 }, totalDeg: 35, falloffDeg: 22, ...base });
    }
    state.selection = { kind: "light", index: state.desc.lights.length - 1 };
    refreshLamps(); buildPanel(); solve(true);
  };
  $("#add-rect").addEventListener("click", () => addLight("rect"));
  $("#add-point").addEventListener("click", () => addLight("point"));
  $("#add-spot").addEventListener("click", () => addLight("spot"));

  const addPrim = (kind) => {
    if (!state.desc.materials.length) {
      state.desc.materials.push({ name: "matte", kind: "lambert", albedo: 0.5 });
    }
    const material = state.desc.materials[0].name;
    if (kind === "sphere") state.desc.prims.push({ kind, material, c: { x: 0, y: 0, z: 0.08 }, r: 0.05 });
    else {
      state.desc.prims.push({
        kind: "quad", material, c: { x: 0, y: 0, z: 0.2 }, n: { x: 0, y: 0, z: 1 },
        ex: { x: 0.15, y: 0, z: 0 }, ey: { x: 0, y: 0.15, z: 0 },
      });
    }
    state.selection = { kind: "prim", index: state.desc.prims.length - 1 };
    buildPanel(); solve(true);
  };
  $("#add-quad").addEventListener("click", () => addPrim("quad"));
  $("#add-sphere").addEventListener("click", () => addPrim("sphere"));

  /* The viewport carries no themed chrome -- a surface's colour IS its
     measurement -- so only the legend needs repainting. */
  window.addEventListener("themechange", drawLegend);

  /* Open on a shared scene if the URL carries one, else the workcell. */
  let loaded = false;
  /* The assistant on the Ask page links here with a scene NAMED rather than
     encoded, so #preset=workcell opens that one. Checked before decodeScene,
     which would only reject it as a malformed share code. */
  const named = /^#preset=([\w-]+)$/.exec(location.hash);
  if (named && PRESETS.some((p) => p.id === named[1])) {
    const p = presetById(named[1]);
    $("#preset").value = p.id;
    loaded = loadText(p.text, p.blurb);
    history.replaceState(null, "", location.pathname + location.search);
  }
  if (!loaded && location.hash.length > 2) {
    try {
      const text = await decodeScene(location.hash.slice(1));
      if (text) loaded = loadText(text, "loaded a shared scene from this link");
    } catch { /* fall through to the preset */ }
  }
  if (!loaded) {
    const p = PRESETS[0];
    $("#preset").value = p.id;
    loadText(p.text, p.blurb);
  }
  window.addEventListener("themechange", () => view.markDirty());

  /* --- the assistant --------------------------------------------------

     Loaded on demand: the panel is chrome around the tool, and the tool must
     not wait on it. Every action below goes through the control the visitor
     could have clicked, rather than reaching into `state` itself, so the
     buttons' pressed states and status line stay the single source of truth
     about what the scene is doing. */
  const assistantHost = $("#assistant");
  if (assistantHost) {
    import("./assistant.js?v=14550619").then(({ mountAssistant }) => {
      const click = (sel) => $(sel).click();
      mountAssistant(assistantHost, {
        loadPreset(id) {
          const p = presetById(id);
          if (!p || p.id !== id) return null;
          $("#preset").value = p.id;
          $("#preset").dispatchEvent(new Event("change"));
          return p;
        },
        units: () => state.photometric,
        setUnits: (photometric) => { if (state.photometric !== photometric) click("#btn-units"); },
        indirect: () => state.includeIndirect,
        setIndirect: (on) => { if (state.includeIndirect !== on) click("#btn-mode"); },
        quality: () => state.quality,
        setQuality: (q) => { if (state.quality !== q) click("#btn-quality"); },
        addLight: (kind) => click("#add-" + kind),
        addPrim: (kind) => click("#add-" + kind),
        fit: frameView,
        stats: () => state.lastStats,
        scene: sceneSummary,
        select: selectByNumber,
        edit: editSelection,
        remove: deleteSelected,
        download: () => click("#btn-scene"),
        share: () => click("#btn-share"),
      });
    }).catch((e) => {
      console.warn("the assistant panel could not be loaded", e);
      assistantHost.remove();
    });
  }
}

main();
