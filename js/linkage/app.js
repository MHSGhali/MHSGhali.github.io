/* Page controller for the linkage tool: wires the toolbar, the status line,
   the 3D view, the Blender export and the share link to the editor. */

import { createEditor } from "./editor.js?v=955473fe";
import { createView3D } from "./view3d.js?v=955473fe";
import { PRESETS, buildPreset } from "./presets.js?v=955473fe";
import { exportBlenderScript } from "./blender.js?v=955473fe";
import { exportPrintableParts } from "./print3d.js?v=955473fe";
import { makeZip } from "./zip.js?v=955473fe";
import { encode, decode } from "./serialize.js?v=955473fe";

const $ = (sel) => document.querySelector(sel);

const editorCanvas = $("#editor");
const presetSelect = $("#preset");
const statusMsg = $("#status-msg");
const statusCounts = $("#status-counts");
const view3dHost = $("#view3d");
const view3dNote = $("#view3d-note");

const buttons = {
  link: $("#btn-link"), slide: $("#btn-slide"), anchor: $("#btn-anchor"), motor: $("#btn-motor"),
  variable: $("#btn-variable"), trace: $("#btn-trace"), del: $("#btn-delete"),
  undo: $("#btn-undo"), gravity: $("#btn-gravity"), run: $("#btn-run"),
  fit: $("#btn-fit"), download: $("#btn-download"), share: $("#btn-share"),
  print: $("#btn-print"), deselect: $("#btn-deselect"), clear: $("#btn-clear"),
  slower: $("#btn-slower"), faster: $("#btn-faster"),
};
const editorNote = $("#editor-note");

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

presetSelect.addEventListener("change", () => {
  loadPreset(presetSelect.value);
  /* Hand the keyboard back. A <select> keeps focus after you choose from it,
     and the editor deliberately ignores keys aimed at a form control -- so
     every shortcut silently does nothing until you happen to click elsewhere,
     which reads as "the hotkeys are broken". */
  presetSelect.blur();
});

/* --- toolbar --------------------------------------------------------- */

buttons.link.addEventListener("click", () => editor.linkSelected());
buttons.slide.addEventListener("click", () => editor.slideSelected());
buttons.anchor.addEventListener("click", () => editor.toggleAnchor());
buttons.motor.addEventListener("click", () => editor.toggleMotor());
buttons.variable.addEventListener("click", () => editor.toggleVariable());
buttons.trace.addEventListener("click", () => editor.toggleTrace());
buttons.del.addEventListener("click", () => editor.deleteSelection());
buttons.undo.addEventListener("click", () => editor.undo());
buttons.gravity.addEventListener("click", () => editor.toggleGravity());
/* Esc, C and +/- were bound to keys only, so on a touchscreen -- which has no
   keys -- three documented controls were unreachable, motor speed among them
   and it is the only pacing control the tool has. */
buttons.deselect.addEventListener("click", () => editor.clearSelection());
buttons.clear.addEventListener("click", () => editor.clearTraces());
buttons.slower.addEventListener("click", () => editor.nudgeMotorSpeed(-1));
buttons.faster.addEventListener("click", () => editor.nudgeMotorSpeed(1));
buttons.run.addEventListener("click", () => editor.toggleRun());
buttons.fit.addEventListener("click", () => {
  editor.fitView();
  if (view3d && !view3d.failed) view3d.resetView();
});

/* --- which viewport holds the screen on a phone -----------------------
   Only one is visible under 900px. A hidden canvas cannot be measured, so both
   the editor and the 3D view have to be told to re-measure when they are the
   one shown -- otherwise the newly revealed view keeps whatever size it had
   when it was last laid out, which for a view hidden since load is none. */
const stage = $("#stage");
const viewButtons = { design: $("#btn-view-design"), "3d": $("#btn-view-3d") };
function showView(which) {
  stage.dataset.show = which;
  for (const [name, btn] of Object.entries(viewButtons)) {
    btn.setAttribute("aria-pressed", String(name === which));
  }
  if (which === "3d" && view3d && !view3d.failed) view3d.resize();
  else editor.draw();
}
viewButtons.design.addEventListener("click", () => showView("design"));
viewButtons["3d"].addEventListener("click", () => showView("3d"));

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

buttons.print.addEventListener("click", () => {
  /* A folder of parts, which a browser cannot hand over as a folder -- so the
     same names arrive inside one archive. */
  const parts = exportPrintableParts(editor.mechanism);
  if (!parts.written) {
    say("Nothing to print: draw a mechanism with at least one link first.", true);
    return;
  }
  const zip = makeZip([{ name: "MANIFEST.txt", bytes: parts.manifest }, ...parts.files]);
  const url = URL.createObjectURL(new Blob([zip], { type: "application/zip" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "linkage_parts.zip";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  say(`Downloaded linkage_parts.zip — ${parts.report}`, parts.warnings > 0);
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
  set(buttons.slide, { disabled: s.running || s.selectedCount !== 3 });
  set(buttons.anchor, { disabled: s.running || s.selectedCount === 0, pressed: s.allAnchored });
  set(buttons.motor, { disabled: s.running || !s.linkCanDrive, pressed: s.linkDriven });
  set(buttons.variable, { disabled: s.running || s.selectedLink < 0 || s.linkDriven, pressed: s.selectedLink >= 0 && !s.linkRigid });
  set(buttons.trace, { disabled: s.running || s.selectedCount === 0, pressed: s.allTraced });
  set(buttons.del, { disabled: s.running || !s.hasSelection });
  set(buttons.undo, { disabled: !s.canUndo });
  set(buttons.gravity, { pressed: s.gravity });
  set(buttons.deselect, { disabled: !s.hasSelection });
  set(buttons.clear, { disabled: !s.anyTraced });
  /* nudgeMotorSpeed acts on the SELECTED link, so these are live only when the
     driven link is the one selected -- same rule the +/- keys have always had,
     now visible instead of silent. */
  set(buttons.slower, { disabled: s.motorSpeed === null });
  set(buttons.faster, { disabled: s.motorSpeed === null });
  set(buttons.share, { disabled: s.running });
  set(buttons.print, { disabled: s.running || s.linkCount === 0 });

  /* Only the word, never the button's contents: the <kbd>R</kbd> beside it is
     markup, and textContent on the button would delete it. */
  buttons.run.querySelector("[data-run-label]").textContent = s.running ? "Stop" : "Run";
  buttons.run.setAttribute("aria-pressed", String(s.running));
  editorCanvas.parentElement.classList.toggle("is-running", s.running);

  const plural = (n, word) => `<b>${n}</b> ${word}${n === 1 ? "" : "s"}`;
  statusCounts.innerHTML =
    `${plural(s.jointCount, "joint")} &nbsp;${plural(s.linkCount, "link")}` +
    (s.sliderCount ? ` &nbsp;${plural(s.sliderCount, "slider")}` : "") +
    (s.motorSpeed !== null ? ` &nbsp;motor <b>${s.motorSpeed.toFixed(0)}&deg;/s</b>` : "") +
    (!s.hasMotor ? " &nbsp;no motor: runs under gravity" : "");

  const message = s.bindMessage || transient;
  statusMsg.textContent = message;
  statusMsg.classList.toggle("warn", !!s.bindMessage);

  editorNote.textContent = nextStep(s);

  if (view3d && !view3d.failed) view3d.sync();
}

/* What to do next, said in the Design viewport.

   Every build button disables itself until it has something to act on, which is
   right but means the toolbar arrives almost entirely greyed out -- to a first
   visitor that reads as broken software, and the explanation is in a panel that
   is both collapsed and below the fold. This is the same precondition each
   button already carries in its `title`, surfaced where the visitor is looking.

   It lives here rather than in the editor because it is copy, and the editor is
   the engine's half of this page. Returning "" hides it: there is nothing
   useful to say while the mechanism is running, and the status line owns the
   bind message anyway. */
function nextStep(s) {
  if (s.running) return "";
  if (s.selectedLink >= 0) {
    if (s.linkCanDrive) return "Motor (M) drives this link. Variable (V) lets it change length.";
    if (s.linkDriven) return "+ and - change this motor's speed. Run (R) starts it.";
    return "Variable (V) lets this link change length. Motor (M) needs one grounded joint.";
  }
  switch (s.selectedCount) {
    case 0:
      return s.jointCount === 0
        ? "Click anywhere to place a joint."
        : "Click a joint or a bar to select it · click empty space to place a joint";
    case 1:
      return "Anchor (A) grounds it · Trace (T) draws its path · shift-click another to link";
    case 2:
      return "Link (L) joins these two into a rigid bar.";
    case 3:
      return "Link (L) makes a rigid plate · Slide (S) rails the first on the other two";
    default:
      return "Link (L) joins all " + s.selectedCount + " into one rigid plate.";
  }
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
