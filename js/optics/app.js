/* The optics page: two viewports, a panel of camera controls, and one worker.

   WHAT DRIVES WHAT
     Every control writes through settings.set(), which clamps. If the change
     touched the photograph, the worker is asked for a new render; if it only
     touched exposure, the worker re-tonemaps the film it already has, because
     exposure is a view gain and the film is in physical units. The scene
     diagram is rebuilt on the main thread either way -- it is a few hundred
     line segments and it must not wait for a render to know where the focus
     plane went. */

import * as ST from "./settings.js?v=4c85dc67";
import * as SD from "./scenedesc.js?v=4c85dc67";
import * as S3 from "./scene3d.js?v=4c85dc67";
import * as LENS from "./lens.js?v=4c85dc67";
import { createView } from "./view3d.js?v=4c85dc67";
import { derivedOf } from "./render.js?v=4c85dc67";

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const settings = ST.defaults();

const panel = $("#panel");
const derivedHost = $("#derived");
const imageCanvas = $("#image");
const imageNote = $("#image-note");
const sceneNote = $("#scene-note");
const statusCounts = $("#status-counts");
const statusMsg = $("#status-msg");
const stage = $("#stage");

let view = null;
let worker = null;
let gen = 0;
let derived = null;
let markers = [];
let lensForDiagram = null;
let renderTimer = 0;
let passesSeen = 0;

/* ---- the worker ---- */

function startWorker() {
  const url = new URL("./render.worker.js", import.meta.url);
  /* A worker started from a URL is not an import specifier, so build-site.py
     never reaches it. Carry this module's own ?v= across by hand, or a deploy
     would leave a fresh page driving a stale renderer. */
  const version = new URL(import.meta.url).search;
  if (version) url.search = version;
  const w = new Worker(url, { type: "module" });
  w.onmessage = (e) => onWorkerMessage(e.data);
  w.onerror = (e) => {
    statusMsg.textContent = "The renderer failed to start.";
    statusMsg.classList.add("warn");
    console.warn("optics worker:", e.message || e);
  };
  return w;
}

function onWorkerMessage(msg) {
  if (msg.gen !== gen) return;              /* a stale result; drop it */

  if (msg.type === "error") {
    statusMsg.textContent = msg.message;
    statusMsg.classList.add("warn");
    imageNote.textContent = "Nothing to render.";
    return;
  }

  if (msg.type === "built") {
    /* Deliberately NOT taking msg.derived: rebuildDiagram already computed the
       same numbers from the same settings, synchronously, and this message
       arrives a render behind the control that caused it. The markers are the
       part only the worker knows. */
    markers = msg.markers || [];
    statusMsg.textContent = "";
    statusMsg.classList.remove("warn");
    imageCanvas.width = msg.width;
    imageCanvas.height = msg.height;
    imageNote.textContent = "Tracing…";
    passesSeen = 0;
    renderDerived();
    updateStatus();
    return;
  }

  if (msg.type === "pass") {
    const ctx = imageCanvas.getContext("2d");
    ctx.putImageData(new ImageData(msg.rgb, imageCanvas.width, imageCanvas.height), 0, 0);
    imageNote.textContent = "";
    passesSeen = msg.spp;
    updateStatus();
  }
}

/* A new photograph. Debounced, so dragging a number through ten values costs
   one render rather than ten. */
function requestRender(delay = 90) {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    gen++;
    /* Assembled from the field table, never by hand -- see renderRequest(). */
    worker.postMessage({ type: "render", gen, settings: ST.renderRequest(settings) });
  }, delay);
}

/* Exposure only. No ray is traced. */
function requestExpose() {
  worker.postMessage({ type: "expose", gen, exposure: settings.exposure });
}

/* ---- the scene diagram ----

   Built here, on the main thread, from the same lens the worker is building
   from the same settings. It is a few hundred segments, so it is instant, and
   it must not wait for a render: dragging focus should move the focus plane
   while the picture is still resolving. */
function rebuildDiagram() {
  const desc = SD.preset(settings.preset, settings.sizing);
  desc.lightMode = settings.lightMode;
  desc.lampLm = settings.lampLm;
  desc.lampCctK = settings.lampCctK;
  desc.ambientLux = settings.ambientLux;
  desc.ambientCctK = settings.ambientCctK;

  let lens = null;
  try {
    lens = LENS.build(settings.design, settings.focalMm, settings.fno);
    if (!LENS.focus(lens, settings.focusM)) lens = null;
  } catch {
    /* The worker reports the reason; the diagram just draws what it can. */
    lens = null;
  }
  lensForDiagram = lens;

  const sensorH = (settings.sensorWMm * ST.resH(settings.resW)) / settings.resW;

  /* The readouts come from the SAME lens the diagram is about to be drawn from,
     right now, rather than from whatever the worker last sent back. The worker
     agrees -- it calls the same function on the same settings -- but it does so
     a render later, and a number that lags a control by a render is a number
     that is wrong every time anyone reads it immediately after changing
     something. */
  derived = lens ? derivedOf(lens, settings.sensorWMm, sensorH, settings.cocLimitMm) : null;
  renderDerived();
  updateStatus();

  const diagram = S3.build(desc, lens, settings.sensorWMm, sensorH, settings.cocLimitMm);
  if (view && !view.failed) view.setDiagram(diagram);
}

/* ---- the panel ---- */

function commit(id, value) {
  const before = { ...settings };
  if (!ST.set(settings, id, value)) { buildPanel(); return; }

  /* Showing or hiding the dome's rows changes the panel's shape, so it is
     rebuilt wholesale rather than patched. It is twenty rows. */
  buildPanel();
  rebuildDiagram();
  writeHash();

  if (ST.imageDiffers(before, settings)) requestRender();
  else if (before.exposure !== settings.exposure) requestExpose();
  /* Anything else -- the sharpness criterion -- moved only the derived
     numbers, and rebuildDiagram has already refreshed them. */
}

/* Scrolling the page must not edit the camera.

   A focused number input takes the wheel as an increment, and a focused select
   takes it as a change of option -- so a visitor who clicks a field, then
   scrolls down to look at the picture, silently re-focuses their lens on the
   way past. It happened during testing: the focal length arrived at 88.8 mm
   with nobody having typed anything.

   Blurring on the way in is the fix. The handler runs before the default
   action, so by the time the browser would apply the increment the field is no
   longer focused and there is nothing to increment; the page scrolls instead,
   which is what the gesture meant. Passive, because it never preventDefaults --
   stopping the scroll outright would fix the edit by breaking the scroll. */
function dontEditOnScroll(node) {
  node.addEventListener("wheel", () => {
    if (document.activeElement === node) node.blur();
  }, { passive: true });
  return node;
}

function numberRow(f) {
  const row = el("div", "prow");
  row.appendChild(el("label", null, f.unit ? `${f.label} (${f.unit})` : f.label));
  const input = el("input");
  input.type = "number";
  input.min = f.lo;
  input.max = f.hi;
  input.step = ST.step(f.id, settings[f.id]);
  input.value = ST.format(f.id, settings[f.id]);
  input.setAttribute("aria-label", `${f.label}${f.unit ? ` in ${f.unit}` : ""}`);
  input.addEventListener("change", () => commit(f.id, Number(input.value)));
  row.appendChild(dontEditOnScroll(input));
  return row;
}

function selectRow(f) {
  const row = el("div", "prow");
  row.appendChild(el("label", null, f.label));
  const sel = el("select");
  sel.setAttribute("aria-label", f.label);
  for (const opt of f.enumOf()) {
    const o = el("option", null, (f.names && f.names[opt]) || opt);
    o.value = opt;
    if (opt === settings[f.id]) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener("change", () => commit(f.id, sel.value));
  row.appendChild(dontEditOnScroll(sel));
  return row;
}

function buildPanel() {
  panel.textContent = "";
  let section = null;
  let host = null;
  for (const f of ST.visibleFields(settings)) {
    if (f.section !== section) {
      section = f.section;
      const group = el("div", "pgroup");
      group.appendChild(el("h3", null, section));
      panel.appendChild(group);
      host = group;
    }
    host.appendChild(f.enumOf ? selectRow(f) : numberRow(f));
  }
  syncLightingButton();
}

/* Everything the panel reports but does not set. Read-only, and every number
   comes from the same lens the renderer used -- so a figure on screen cannot
   disagree with the picture beside it. */
const M = (x, digits = 2) => (Number.isFinite(x) ? x.toFixed(digits) : "∞");

function renderDerived() {
  derivedHost.textContent = "";
  const group = el("div", "pgroup");
  group.appendChild(el("h3", null, "DERIVED"));
  if (!derived) {
    group.appendChild(el("p", "panel-hint", "Waiting for the lens…"));
    derivedHost.appendChild(group);
    return;
  }
  const d = derived;
  const rowHost = el("div", "derived-rows");
  const rows = [
    ["focal", `${M(d.eflMm)} mm`],
    ["h field", `${M(d.hfovDeg)}°`],
    ["pupil", `${M(d.pupilMm)} mm`],
    ["t-stop", `T/${M(d.tstop)}`],
    ["back focus", `${M(d.bfdMm)} mm`],
    ["film at", `${M(d.filmZMm)} mm`],
    ["colour err", `${M(d.colourErrPct, 3)} %`],
    ["blur at 6 m", `${M(d.blurAt6mMm, 3)} mm`],
    /* Two numbers in one row because they are one question: does the design
       cover the format it is mounted on? The note under the block says which
       way round they are when they disagree. */
    ["covers", `${M(d.coversMm)} / ${M(d.coveredMm)} mm`],
    ["axis sharp from", `${M(d.nearM)} m`],
    ["axis sharp to", `${M(d.farM)} m`],
    ["axis hyperfocal", `${M(d.hyperfocalM)} m`],
    /* Last, because it qualifies the same criterion the three rows above it
       use -- it is that criterion said in the other unit. */
    ["resolving", `${M(d.resolvingLpMm, 0)} lp/mm`],
  ];
  for (const [k, v] of rows) {
    const row = el("div", "prow prow-ro");
    row.appendChild(el("label", null, k));
    row.appendChild(el("span", "mono", v));
    rowHost.appendChild(row);
  }
  group.appendChild(rowHost);
  /* The one honest caveat, next to the numbers it qualifies rather than in a
     collapsed section below the fold. */
  if (d.coversMm < d.coveredMm) {
    const warn = el("p", "panel-hint", "This design's image circle is smaller than the sensor: the corners are outside what it covers.");
    group.appendChild(warn);
  }
  derivedHost.appendChild(group);
}

function updateStatus() {
  const h = ST.resH(settings.resW);
  const bits = [`${settings.resW}×${h}`, `${passesSeen.toFixed(0)} spp`];
  if (derived) bits.push(`f/${M(derived.fNumber)} · ${M(derived.eflMm, 0)} mm`);
  statusCounts.textContent = bits.join("  ·  ");
}

/* ---- the lighting toggle ----
   A state button, so it shows BOTH options with the live one lit, rather than a
   bare word that could equally mean "you are here" or "click to go here". Same
   markup and behaviour as the light page's unit switch. */
const lightingBtn = $("#btn-lighting");

function syncLightingButton() {
  lightingBtn.setAttribute("aria-pressed", String(settings.lightMode === SD.LAMPS));
}

lightingBtn.addEventListener("click", () => {
  commit("lightMode", settings.lightMode === SD.LAMPS ? SD.AMBIENT : SD.LAMPS);
});

/* ---- the mobile view switch ----
   Both viewports are on screen together above 900px, so there is nothing to
   choose between and the switch stays hidden. Below it, one at a time. */
function showView(which) {
  stage.dataset.show = which;
  for (const b of document.querySelectorAll("[data-view]")) {
    b.setAttribute("aria-pressed", String(b.dataset.view === which));
  }
  /* A hidden canvas cannot be measured, so the view has to re-read its size on
     the way back in. */
  if (which === "scene" && view && !view.failed) view.resize();
}
for (const b of document.querySelectorAll("[data-view]")) {
  b.addEventListener("click", () => showView(b.dataset.view));
}

/* ---- sharing ----

   The hash is written on every edit and also read back, so the page has to tell
   its own writes from someone else's. A boolean "the next hashchange is mine"
   flag is the obvious way and it is wrong: writing the hash with replaceState
   does not always fire hashchange, so the flag survives to swallow the NEXT
   event -- which is a real one. Pasting a link into the address bar of a page
   that is already open then does nothing at all, because changing only the
   fragment does not reload the document.

   Comparing against what we last wrote has no such state to get stuck. */
let lastWritten = null;
function writeHash() {
  const h = `#${ST.toHash(settings)}`;
  lastWritten = h;
  history.replaceState(null, "", h);
}

$("#btn-share").addEventListener("click", async () => {
  writeHash();
  try {
    await navigator.clipboard.writeText(location.href);
    statusMsg.textContent = "Link copied.";
  } catch {
    statusMsg.textContent = "Copy the address bar to share this view.";
  }
  setTimeout(() => { statusMsg.textContent = ""; }, 2400);
});

$("#btn-fit").addEventListener("click", () => { if (view && !view.failed) view.frame(); });

$("#btn-reset").addEventListener("click", () => {
  Object.assign(settings, ST.defaults());
  buildPanel();
  rebuildDiagram();
  writeHash();
  requestRender(0);
});

/* Colours are read from the stylesheet, so the diagram has to be rebuilt when
   the theme changes. The render itself is physical and does not change. */
window.addEventListener("themechange", () => { if (view && !view.failed) view.setTheme(); });

/* ---- start ---- */

async function start() {
  ST.fromHash(location.hash, settings);

  /* A narrower render on a narrow viewport: one worker, and a phone has less of
     it. The picture converges progressively either way. */
  if (window.innerWidth < 700) settings.resW = 192;

  buildPanel();
  rebuildDiagram();     /* fills in the readouts before the first render lands */
  updateStatus();

  worker = startWorker();
  requestRender(0);

  view = await createView($("#scene"), {});
  if (view.failed) {
    sceneNote.textContent = "The scene view needs three.js, which could not be loaded. The render and every control still work.";
    console.warn("optics view3d:", view.error);
  } else {
    sceneNote.textContent = "";
  }
  rebuildDiagram();

  window.addEventListener("hashchange", () => {
    if (location.hash === lastWritten) return;   /* our own write, echoed back */
    /* An incoming link is a whole state, not a patch: start from the defaults
       so that fields the link omits go back to their defaults rather than
       keeping whatever this session happened to leave them at. Otherwise a link
       naming one field would inherit the aperture and the lighting of whatever
       was on screen, and the same link would show two different pictures to two
       people. */
    const next = ST.defaults();
    if (!ST.fromHash(location.hash, next)) return;
    Object.assign(settings, next);
    lastWritten = location.hash;
    buildPanel();
    renderDerived();
    rebuildDiagram();
    requestRender(0);
  });
}

/* ---- the assistant ----

   Everything it can do goes through commit(), which is the same path a typed
   number takes. So a command cannot reach a state the panel could not, and the
   panel's values stay the single source of truth for what is on screen. */
const assistantApi = {
  settings: () => ({ ...settings }),
  derived: () => derived,
  spp: () => passesSeen,

  /* The same verdict the scene view marks with, from the same traced spot, so
     the assistant and the diagram cannot disagree about which one is sharp --
     and neither can disagree with the render, which is where the spot comes
     from. */
  targets() {
    if (!lensForDiagram || !markers.length) return [];
    return markers.map((m) => {
      const height = Math.hypot(m.centre?.x ?? 0, m.centre?.y ?? 0);
      const spot = LENS.spotMm(lensForDiagram, m.depthM, height, 15);
      return {
        label: m.label,
        colour: m.colour,
        depthM: m.depthM,
        spotMm: spot,
        sharp: Number.isFinite(spot) && spot <= settings.cocLimitMm,
      };
    });
  },

  /* Returns true when the value actually moved -- the assistant says "already
     f/5" rather than claiming a change that did not happen. */
  set(id, value) {
    const before = settings[id];
    commit(id, value);
    return settings[id] !== before;
  },

  fit() { if (view && !view.failed) view.frame(); },
  share() { $("#btn-share").click(); },
  reset() { $("#btn-reset").click(); },
};

const assistantHost = $("#assistant");
if (assistantHost) {
  import("./assistant.js?v=4c85dc67")
    .then(({ mountAssistant }) => mountAssistant(assistantHost, assistantApi))
    .catch((err) => {
      console.warn("optics assistant:", err);
      const shell = assistantHost.closest(".assistant-shell") || assistantHost;
      shell.remove();
    });
}

start().catch((err) => {
  statusMsg.textContent = "Something went wrong starting the simulator.";
  statusMsg.classList.add("warn");
  console.error(err);
});
