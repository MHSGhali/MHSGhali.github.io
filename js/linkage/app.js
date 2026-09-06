/* Page controller for the linkage tool: wires the toolbar, the status line,
   the 3D view, the Blender export and the share link to the editor. */

import { createEditor } from "./editor.js?v=0bbdca31";
import { createView3D } from "./view3d.js?v=0bbdca31";
import { PRESETS, buildPreset } from "./presets.js?v=0bbdca31";
import { exportBlenderScript } from "./blender.js?v=0bbdca31";
import { encode, decode } from "./serialize.js?v=0bbdca31";

const $ = (sel) => document.querySelector(sel);

const editorCanvas = $("#editor");
const presetSelect = $("#preset");
const statusMsg = $("#status-msg");
const statusCounts = $("#status-counts");
const view3dHost = $("#view3d");
const view3dNote = $("#view3d-note");

const buttons = {
  link: $("#btn-link"), anchor: $("#btn-anchor"), motor: $("#btn-motor"),
  variable: $("#btn-variable"), trace: $("#btn-trace"), del: $("#btn-delete"),
  undo: $("#btn-undo"), gravity: $("#btn-gravity"), run: $("#btn-run"),
  fit: $("#btn-fit"), download: $("#btn-download"), share: $("#btn-share"),
};

let view3d = null;
/* The last thing the page said to the visitor: a preset's blurb, or the result
   of an export or a copied link. Declared up here because refresh() reads it,
   and the first refresh happens while the opening preset loads below. */
let transient = "";

const editor = createEditor(editorCanvas, { onChange: refresh });

/* Fill the preset menu from the list itself, so adding one there is the only
   edit needed to offer it here. */
for (const p of PRESETS) {
  const opt = document.createElement("option");
  opt.value = p.id;
  opt.textContent = p.name;
  presetSelect.appendChild(opt);
}

/* --- what to open on ------------------------------------------------- */

function loadFromHash() {
  const hash = location.hash.replace(/^#/, "");
  if (!hash) return false;
  const shared = decode(hash);
  if (!shared) return false;
  editor.load(shared.mechanism, shared.gravity);
  presetSelect.value = "";
  say("Loaded a shared mechanism from this link.");
  return true;
}

function loadPreset(id) {
  const { mechanism, gravity, preset } = buildPreset(id);
  editor.load(mechanism, gravity);
  presetSelect.value = preset.id;
  say(preset.blurb);
  /* Drop a stale share link: what is on screen is no longer what it encodes. */
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
}

if (!loadFromHash()) loadPreset(PRESETS[0].id);
window.addEventListener("hashchange", loadFromHash);

presetSelect.addEventListener("change", () => loadPreset(presetSelect.value));

/* --- toolbar --------------------------------------------------------- */

buttons.link.addEventListener("click", () => editor.linkSelected());
buttons.anchor.addEventListener("click", () => editor.toggleAnchor());
buttons.motor.addEventListener("click", () => editor.toggleMotor());
buttons.variable.addEventListener("click", () => editor.toggleVariable());
buttons.trace.addEventListener("click", () => editor.toggleTrace());
buttons.del.addEventListener("click", () => editor.deleteSelection());
buttons.undo.addEventListener("click", () => editor.undo());
buttons.gravity.addEventListener("click", () => editor.toggleGravity());
buttons.run.addEventListener("click", () => editor.toggleRun());
buttons.fit.addEventListener("click", () => {
  editor.fitView();
  if (view3d && !view3d.failed) view3d.resetView();
});

/* --- export and share ------------------------------------------------- */

buttons.download.addEventListener("click", () => {
  const script = exportBlenderScript(editor.mechanism, editor.params);
  const url = URL.createObjectURL(new Blob([script], { type: "text/x-python" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "linkage_export.py";
  a.click();
  /* Revoke on the next turn: revoking synchronously can beat the download. */
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  say("Downloaded linkage_export.py — run it in Blender's Scripting tab, then press Space.");
});

buttons.share.addEventListener("click", async () => {
  const url = location.origin + location.pathname + "#" + encode(editor.mechanism, editor.gravity);
  history.replaceState(null, "", url);
  try {
    await navigator.clipboard.writeText(url);
    say("Link copied. It carries the whole mechanism, so anyone who opens it gets exactly this.");
  } catch {
    /* Clipboard access needs a secure context and a permission; the URL bar
       now holds the link either way, so say that instead of failing. */
    say("This page's address now holds the mechanism — copy it from the address bar.");
  }
});

/* --- status ----------------------------------------------------------- */

function say(text) {
  transient = text;
  refresh();
}

function refresh() {
  const s = editor.state();

  const set = (btn, { disabled, pressed } = {}) => {
    if (disabled !== undefined) btn.disabled = disabled;
    if (pressed !== undefined) btn.setAttribute("aria-pressed", String(pressed));
  };

  /* Editing is disabled while the simulation runs, matching the desktop
     tool: the model it is stepping must not change underneath it. */
  set(buttons.link, { disabled: s.running || s.selectedCount < 2 });
  set(buttons.anchor, { disabled: s.running || s.selectedCount === 0, pressed: s.allAnchored });
  set(buttons.motor, { disabled: s.running || !s.linkCanDrive, pressed: s.linkDriven });
  set(buttons.variable, { disabled: s.running || s.selectedLink < 0 || s.linkDriven, pressed: s.selectedLink >= 0 && !s.linkRigid });
  set(buttons.trace, { disabled: s.running || s.selectedCount === 0, pressed: s.allTraced });
  set(buttons.del, { disabled: s.running || !s.hasSelection });
  set(buttons.undo, { disabled: !s.canUndo });
  set(buttons.gravity, { pressed: s.gravity });
  set(buttons.share, { disabled: s.running });

  buttons.run.textContent = s.running ? "Stop" : "Run";
  buttons.run.setAttribute("aria-pressed", String(s.running));
  editorCanvas.parentElement.classList.toggle("is-running", s.running);

  const plural = (n, word) => `<b>${n}</b> ${word}${n === 1 ? "" : "s"}`;
  statusCounts.innerHTML =
    `${plural(s.jointCount, "joint")} &nbsp;${plural(s.linkCount, "link")}` +
    (s.motorSpeed !== null ? ` &nbsp;motor <b>${s.motorSpeed.toFixed(0)}&deg;/s</b>` : "") +
    (!s.hasMotor ? " &nbsp;no motor: runs under gravity" : "");

  const message = s.bindMessage || transient;
  statusMsg.textContent = message;
  statusMsg.classList.toggle("warn", !!s.bindMessage);

  if (view3d && !view3d.failed) view3d.sync();
}

/* A preset's blurb, or the note left by an export, describes the mechanism as
   it was. Touching the canvas means the visitor is making their own, so retire
   it rather than leaving stale text under a mechanism it no longer describes. */
editorCanvas.addEventListener("pointerdown", () => {
  if (transient) { transient = ""; refresh(); }
}, { capture: true });

/* --- 3D --------------------------------------------------------------- */

function palette() {
  const cs = getComputedStyle(document.documentElement);
  const get = (n, f) => cs.getPropertyValue(n).trim() || f;
  return {
    accent: get("--accent", "#ffffff"),
    line: get("--surface-line", "#2c2c2c"),
    text: get("--text", "#e9e9e9"),
    dim: get("--text-dim", "#a1a1a1"),
  };
}

createView3D(view3dHost, () => editor.mechanism).then((v) => {
  view3d = v;
  if (v.failed) {
    view3dNote.textContent = "The 3D view needs three.js, which could not be loaded. Everything else still works.";
    return;
  }
  v.setTheme(palette());
  v.sync();
  view3dNote.hidden = true;
  window.addEventListener("themechange", () => v.setTheme(palette()));
});

refresh();
