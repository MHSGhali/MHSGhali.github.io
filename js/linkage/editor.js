/* The 2D canvas editor: interaction, selection, undo, and drawing.

   This replaces the desktop tool's SDL front end (src/main.c, src/render.c,
   src/ui.c) rather than porting it. The engine underneath is the same, but the
   input model is not: everything here goes through pointer events so it works
   with a mouse, a trackpad, or a finger, and every keyboard shortcut from the
   desktop app is also a toolbar button because a phone has no keyboard. */

import * as M from "./mechanism.js?v=1ebeecf9";
import * as S from "./solver.js?v=1ebeecf9";
import * as v from "./vec2.js?v=1ebeecf9";

const CONNECTOR_HIT_RADIUS = 12;   /* screen px */
const LINK_EDGE_HIT_DIST = 7;
const DRAG_THRESHOLD = 4;
const DEFAULT_MOTOR_SPEED_DEG_S = 90;
const MOTOR_SPEED_STEP_DEG_S = 10;
const DEFAULT_GRAVITY = 400;       /* world units/s^2; qualitative, not calibrated */
const ZOOM_MIN = 0.08, ZOOM_MAX = 8, ZOOM_STEP = 1.1;
const UNDO_MAX = 50;
/* A fixed simulation step, subdivided if the frame took longer. Stepping by
   the real frame time would make the motion depend on the display's refresh
   rate, and one long frame (a background tab, a slow repaint) would jump the
   solver clean off the branch it was tracking. */
const SIM_STEP = 1 / 240;
const MAX_STEPS_PER_FRAME = 40;

export function createEditor(canvas, { onChange } = {}) {
  const ctx = canvas.getContext("2d");

  let mechanism = M.create();
  let gravity = false;
  let running = false;
  /* Bound: the simulation hit a position the mechanism cannot physically
     assume and stopped stepping. It stays "running" so the design is not
     silently replaced by the jammed pose -- press Stop to come back to it. */
  let bound = false;
  let bindMessage = "";
  const params = S.defaultParams();

  let cam = { x: 0, y: 0, z: 1 };
  let undoStack = [];
  let preRunSnapshot = null;

  let palette = readPalette();
  let w = 0, h = 0, dpr = 1;

  const notify = () => onChange && onChange();

  /* ---------------------------------------------------------------- view */

  function readPalette() {
    const cs = getComputedStyle(document.documentElement);
    const get = (n, f) => cs.getPropertyValue(n).trim() || f;
    return {
      accent: get("--accent", "#ffffff"),
      line: get("--surface-line", "#2c2c2c"),
      text: get("--text", "#e9e9e9"),
      dim: get("--text-dim", "#a1a1a1"),
      faint: get("--text-faint", "#858585"),
      elev: get("--bg-elev", "#141414"),
      bg: get("--bg", "#0a0a0a"),
    };
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = rect.width;
    h = rect.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    /* What fits depends on the canvas size, so refit while the framing is
       still ours -- a resized window should not crop the mechanism. */
    if (autoFramed) fitView();
    else draw();
  }

  /* True while the camera is still the one Fit chose. Any manual pan or zoom
     hands the framing to the visitor, and keepInView() then leaves it alone --
     otherwise panning in to watch one joint during a run would be yanked back
     the moment the trace grew. */
  let autoFramed = true;
  const releaseFraming = () => { autoFramed = false; };

  const toScreen = (p) => ({ x: (p.x - cam.x) * cam.z + w / 2, y: (p.y - cam.y) * cam.z + h / 2 });
  const toWorld = (p) => ({ x: (p.x - w / 2) / cam.z + cam.x, y: (p.y - h / 2) / cam.z + cam.y });

  function pointerPos(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  /* Frames the mechanism AND its traces. Called when a preset or shared link
     loads, so a mechanism designed at any scale arrives visible. */
  const FIT_PAD = 120;   /* world units of breathing room around the extent */
  const FIT_SLACK = 1.2; /* extra room a widening refit leaves for more trace */

  function fitView() {
    autoFramed = true;
    const b = M.bounds(mechanism);
    if (!b) { cam = { x: 0, y: 0, z: 1 }; draw(); return; }
    cam.x = (b.x0 + b.x1) / 2;
    cam.y = (b.y0 + b.y1) / 2;
    const spanX = Math.max(b.x1 - b.x0 + FIT_PAD, 1);
    const spanY = Math.max(b.y1 - b.y0 + FIT_PAD, 1);
    cam.z = w && h ? clamp(Math.min(w / spanX, h / spanY), ZOOM_MIN, ZOOM_MAX) : 1;
    draw();
  }

  /* A trace only exists once the mechanism has run, and it keeps growing, so
     the fit computed when the preset loaded goes stale the moment the coupler
     swings wide. Widen to suit, and only ever outwards: zooming back in as the
     curve closes would leave the view pumping in and out every revolution. */
  function keepInView() {
    if (!autoFramed) return;
    const b = M.bounds(mechanism);
    if (!b || !w || !h) return;
    const halfW = w / (2 * cam.z), halfH = h / (2 * cam.z);
    const margin = FIT_PAD / 2;
    if (b.x0 >= cam.x - halfW + margin && b.x1 <= cam.x + halfW - margin &&
        b.y0 >= cam.y - halfH + margin && b.y1 <= cam.y + halfH - margin) return;
    /* Zoom out FIT_SLACK further than the curve currently needs. Refitting it
       exactly would re-trigger on the next millimetre of trace and the view
       would creep shut over hundreds of frames; with headroom it steps out a
       handful of times per revolution and then holds still. */
    const z = Math.min(w / Math.max((b.x1 - b.x0) * FIT_SLACK + FIT_PAD, 1),
                       h / Math.max((b.y1 - b.y0) * FIT_SLACK + FIT_PAD, 1));
    if (z >= cam.z) return;   /* already wide enough; only the centre drifted */
    cam.x = (b.x0 + b.x1) / 2;
    cam.y = (b.y0 + b.y1) / 2;
    cam.z = clamp(z, ZOOM_MIN, ZOOM_MAX);
  }

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  /* ---------------------------------------------------------------- undo */

  /* A bounded stack of full clones taken BEFORE each edit, exactly as the
     desktop tool does it. Mechanisms here are small enough that snapshotting
     is cheaper to get right than an inverse operation per edit. */
  function pushUndo() {
    undoStack.push(M.clone(mechanism));
    if (undoStack.length > UNDO_MAX) undoStack.shift();
  }

  function undo() {
    if (running || !undoStack.length) return;
    mechanism = undoStack.pop();
    bindMessage = "";
    draw();
    notify();
  }

  /* -------------------------------------------------------------- queries */

  const selectedConnectors = () =>
    mechanism.connectors.reduce((acc, c, i) => (c.alive && c.selected ? acc.concat(i) : acc), []);

  const selectedLink = () => mechanism.links.findIndex((l) => l.alive && l.selected);

  function linkCanDrive(lid) {
    const l = mechanism.links[lid];
    if (!l || !l.alive) return false;
    if (l.isDriven) return true;
    return l.connectorIds.filter((cid) => mechanism.connectors[cid].isAnchor).length === 1;
  }

  function state() {
    const sel = selectedConnectors();
    const lid = selectedLink();
    const l = lid >= 0 ? mechanism.links[lid] : null;
    return {
      running,
      gravity,
      bindMessage,
      selectedCount: sel.length,
      selectedLink: lid,
      linkDriven: !!(l && l.isDriven),
      linkRigid: !l || l.rigid,
      linkCanDrive: lid >= 0 && linkCanDrive(lid),
      allTraced: sel.length > 0 && sel.every((cid) => mechanism.connectors[cid].traced),
      /* Whether there is anything for "Clear traces" to erase. Traced joints
         with an empty path do not count -- the button would do nothing. */
      anyTraced: mechanism.connectors.some((c) => c.alive && c.traced && c.path.length > 1),
      allAnchored: sel.length > 0 && sel.every((cid) => mechanism.connectors[cid].isAnchor),
      selectedSlider: mechanism.sliders.findIndex((sl) => sl.alive && sl.selected),
      hasSelection: sel.length > 0 || lid >= 0 ||
                    mechanism.sliders.some((sl) => sl.alive && sl.selected),
      canUndo: undoStack.length > 0 && !running,
      jointCount: mechanism.connectors.filter((c) => c.alive).length,
      linkCount: mechanism.links.filter((l2) => l2.alive).length,
      sliderCount: M.liveSliders(mechanism).length,
      motorSpeed: l && l.isDriven ? l.motorSpeedDegS : null,
      hasMotor: M.hasDrivenLink(mechanism),
    };
  }

  /* --------------------------------------------------------------- edits */

  function clearSelection() {
    for (const c of mechanism.connectors) c.selected = false;
    for (const l of mechanism.links) l.selected = false;
    for (const sl of mechanism.sliders) sl.selected = false;
    selectionOrder = [];
  }

  /* Selection ORDER, not just membership. A slider has to know which of the
     three chosen joints is the pin and which two are its rail, and nothing
     else in the editor cares which order you clicked in. Reconciled after each
     change rather than maintained at every selection site: click-by-click that
     preserves the true order, and a box-select falls back to joint order,
     which is as good an answer as any for a rectangle. */
  let selectionOrder = [];
  function noteSelection() {
    selectionOrder = selectionOrder.filter(
      (id) => mechanism.connectors[id] && mechanism.connectors[id].alive &&
              mechanism.connectors[id].selected
    );
    for (let i = 0; i < mechanism.connectors.length; i++) {
      const c = mechanism.connectors[i];
      if (c.alive && c.selected && !selectionOrder.includes(i)) selectionOrder.push(i);
    }
    return selectionOrder;
  }

  function linkSelected() {
    const sel = selectedConnectors();
    if (running || sel.length < 2) return;
    pushUndo();
    M.addLink(mechanism, sel);
    clearSelection();
    draw();
    notify();
  }

  /* Three joints, in the order they were picked: the first becomes a pin held
     on the line through the other two. Rails on anchors give a prismatic joint
     sliding on ground; rails on a moving link give a pin in that link's slot. */
  function slideSelected() {
    const sel = noteSelection();
    if (running) return;
    if (sel.length !== 3) {
      bindMessage = "A slider needs exactly three joints: click the pin first, then the two that define its rail.";
      notify();
      return;
    }
    pushUndo();
    if (M.addSlider(mechanism, sel[0], sel[1], sel[2]) < 0) {
      undoStack.pop();
      bindMessage = "Those three joints cannot form a slider.";
    } else {
      bindMessage = "";
      clearSelection();
    }
    draw();
    notify();
  }

  function toggleAnchor() {
    const sel = selectedConnectors();
    if (running || !sel.length) return;
    pushUndo();
    /* One toggle for the whole selection, decided by whether they are all
       anchored already -- so a mixed selection becomes uniformly anchored
       rather than each joint flipping to the opposite of its neighbour. */
    const target = !sel.every((cid) => mechanism.connectors[cid].isAnchor);
    for (const cid of sel) M.setAnchor(mechanism, cid, target);
    draw();
    notify();
  }

  function toggleMotor() {
    const lid = selectedLink();
    if (running || lid < 0) return;
    pushUndo();
    if (!M.toggleDriven(mechanism, lid, DEFAULT_MOTOR_SPEED_DEG_S)) {
      undoStack.pop();
      bindMessage = "A motor needs exactly one anchored joint on the link to pivot around.";
    } else {
      bindMessage = "";
    }
    draw();
    notify();
  }

  function nudgeMotorSpeed(delta) {
    const lid = selectedLink();
    if (lid < 0 || !mechanism.links[lid].isDriven) return;
    mechanism.links[lid].motorSpeedDegS += delta * MOTOR_SPEED_STEP_DEG_S;
    draw();
    notify();
  }

  /* ------------------------------------------------- the assistant's hands

     The pointer handlers own selection and placement for a person with a
     mouse. These give the panel the same two moves without one: name a joint
     by the number the panel reads back, and put a joint down at a coordinate.
     Everything else the assistant does is an existing toolbar action, which
     already works on whatever is selected. */

  function listJoints() {
    const out = [];
    mechanism.connectors.forEach((c, id) => {
      if (!c.alive) return;
      out.push({ id, n: out.length + 1, x: c.pos.x, y: c.pos.y,
                 isAnchor: c.isAnchor, traced: c.traced, selected: c.selected });
    });
    return out;
  }

  function listLinks() {
    const out = [];
    mechanism.links.forEach((l, id) => {
      if (!l.alive) return;
      out.push({ id, n: out.length + 1, joints: l.connectorIds.slice(),
                 rigid: l.rigid, isDriven: l.isDriven, speed: l.motorSpeedDegS });
    });
    return out;
  }

  /* `ns` are the numbers listJoints() hands out, not raw indices: the panel
     says "joint 3" and the visitor says "joint 3" back. */
  function selectJoints(ns, add = false) {
    if (running) return 0;
    const live = listJoints();
    if (!add) clearSelection();
    let n = 0;
    for (const want of ns) {
      const j = live.find((c) => c.n === want);
      if (!j) continue;
      mechanism.connectors[j.id].selected = true;
      n++;
    }
    noteSelection();
    draw();
    notify();
    return n;
  }

  function selectLink(want) {
    if (running) return false;
    const l = listLinks().find((x) => x.n === want);
    clearSelection();
    if (!l) { draw(); notify(); return false; }
    mechanism.links[l.id].selected = true;
    draw();
    notify();
    return true;
  }

  /* A predicate rather than a list, for "select the anchors" and friends. */
  function selectWhere(pred, add = false) {
    if (running) return 0;
    const live = listJoints();
    if (!add) clearSelection();
    let n = 0;
    for (const j of live) {
      if (!pred(j)) continue;
      mechanism.connectors[j.id].selected = true;
      n++;
    }
    noteSelection();
    draw();
    notify();
    return n;
  }

  function addJointAt(x, y, add = false) {
    if (running) return null;
    pushUndo();
    if (!add) clearSelection();
    const id = M.addConnector(mechanism, { x, y });
    mechanism.connectors[id].selected = true;
    noteSelection();
    fitView();
    draw();
    notify();
    return listJoints().find((j) => j.id === id)?.n ?? null;
  }

  /* The +/- buttons and the keys act on the SELECTED link, which is the desktop
     tool's rule and right while you are editing. The assistant has no selection
     to work with, and run() clears the selection anyway, so it drives whatever
     motor the mechanism actually has and reports the new speed. */
  function driveMotor(delta) {
    const lid = mechanism.links.findIndex((l) => l.alive && l.isDriven);
    if (lid < 0) return null;
    mechanism.links[lid].motorSpeedDegS += delta * MOTOR_SPEED_STEP_DEG_S;
    draw();
    notify();
    return mechanism.links[lid].motorSpeedDegS;
  }

  /* Trace every joint at once. Trace (T) works on a selection because a person
     picks the point they care about; asked in words, "trace the paths" means
     all of them. */
  function traceAll(on) {
    if (running) return 0;
    let n = 0;
    for (let cid = 0; cid < mechanism.connectors.length; cid++) {
      if (!mechanism.connectors[cid].alive) continue;
      if (!n) pushUndo();          /* once, and before the first change */
      M.setTraced(mechanism, cid, on);
      n++;
    }
    if (n) { draw(); notify(); }
    return n;
  }

  function toggleVariable() {
    const lid = selectedLink();
    if (running || lid < 0 || mechanism.links[lid].isDriven) return;
    pushUndo();
    M.setRigid(mechanism, lid, !mechanism.links[lid].rigid);
    draw();
    notify();
  }

  function toggleTrace() {
    const sel = selectedConnectors();
    if (running || !sel.length) return;
    pushUndo();
    const target = !sel.every((cid) => mechanism.connectors[cid].traced);
    for (const cid of sel) M.setTraced(mechanism, cid, target);
    draw();
    notify();
  }

  function deleteSelection() {
    const sel = selectedConnectors();
    const lid = selectedLink();
    const sid = mechanism.sliders.findIndex((sl) => sl.alive && sl.selected);
    if (running || (!sel.length && lid < 0 && sid < 0)) return;
    pushUndo();
    for (const cid of sel) M.deleteConnector(mechanism, cid);
    if (lid >= 0) M.deleteLink(mechanism, lid);
    if (sid >= 0) M.deleteSlider(mechanism, sid);
    clearSelection();
    draw();
    notify();
  }

  function toggleGravity() {
    gravity = !gravity;
    applyGravity();
    notify();
  }

  /* A mechanism with no motor has nothing to make it move, so it runs under
     gravity whether or not gravity was asked for -- matching the desktop tool.
     Once it IS asked for, that choice applies either way. */
  function applyGravity() {
    const on = gravity || (running && !M.hasDrivenLink(mechanism));
    params.gravity = on ? { x: 0, y: DEFAULT_GRAVITY } : { x: 0, y: 0 };
  }

  function clearTraces() {
    M.clearTraces(mechanism);
    draw();
  }

  /* What Esc does, as something the toolbar can call: clearSelection() alone
     only mutates the model, and every caller has to repaint and re-report. */
  function deselectAll() {
    clearSelection();
    draw();
    notify();
  }

  /* ------------------------------------------------------------ run/stop */

  function toggleRun() {
    running ? stop() : run();
  }

  function run() {
    if (running) return;
    /* Keep the pre-run layout so Stop returns to the design rather than
       leaving it wherever the simulation happened to end. */
    preRunSnapshot = M.clone(mechanism);
    clearSelection();
    S.freeze(mechanism);
    M.clearTraces(mechanism);
    applyGravity();
    running = true;
    bound = false;
    bindMessage = "";
    lastFrame = 0;
    notify();
    loop();
  }

  function stop() {
    if (!running) return;
    running = false;
    bound = false;
    bindMessage = "";
    if (preRunSnapshot) {
      mechanism = preRunSnapshot;
      preRunSnapshot = null;
    }
    applyGravity();
    draw();
    notify();
  }

  let raf = 0;
  let lastFrame = 0;
  function loop(now) {
    raf = 0;
    if (!running || bound) return;
    const elapsed = lastFrame ? (now - lastFrame) / 1000 : SIM_STEP;
    if (now) lastFrame = now;
    const steps = clamp(Math.round(elapsed / SIM_STEP), 1, MAX_STEPS_PER_FRAME);

    for (let i = 0; i < steps; i++) {
      /* Keep what to come back to if this step turns out to be impossible. */
      const priorPos = mechanism.connectors.map((c) => ({ x: c.pos.x, y: c.pos.y }));
      const priorAngle = mechanism.links.map((l) => l.accumulatedAngleRad);

      S.advance(mechanism, SIM_STEP, params);

      if (S.hasLengthViolation(mechanism, params.lengthTolAbs, params.lengthTolRel)) {
        /* A fixed-length link would have to change length to get here, so the
           mechanism physically cannot assume this position. Roll the step back
           -- leaving every link at exactly its rest length -- and stop there,
           rather than showing a stretched bar. The desktop tool does the same.

           Note it stays "running": stopping properly is what restores the
           design, and re-freezing this jammed pose would adopt it as the new
           one, destroying the mechanism the visitor drew. */
        for (let k = 0; k < mechanism.connectors.length; k++) {
          mechanism.connectors[k].pos = priorPos[k];
          mechanism.connectors[k].prevPos = { ...priorPos[k] };
        }
        for (let k = 0; k < mechanism.links.length; k++) {
          mechanism.links[k].accumulatedAngleRad = priorAngle[k];
        }
        bound = true;
        bindMessage = "Bound up: a fixed-length link would have to change length to go further. Press Stop to come back to your design, or make a link variable with V.";
        draw();
        notify();
        return;
      }
      M.traceStep(mechanism);
    }
    keepInView();
    draw();
    notify();
    raf = requestAnimationFrame(loop);
  }

  /* -------------------------------------------------------- interaction */

  let drag = null;
  const pointers = new Map();
  let pinch = null;

  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, pointerPos(e));

    if (pointers.size === 2) {
      /* Two fingers: pinch to zoom and pan, and cancel whatever the first
         finger had started doing. */
      drag = null;
      const [p1, p2] = [...pointers.values()];
      pinch = { dist: Math.hypot(p1.x - p2.x, p1.y - p2.y), z: cam.z,
                mid: toWorld({ x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }) };
      draw();
      return;
    }
    if (pointers.size > 2) return;

    const screen = pointerPos(e);
    const world = toWorld(screen);

    /* Middle button or space-drag pans, at any time -- including while the
       simulation runs, when nothing else here is allowed to touch the model. */
    if (e.button === 1 || spaceHeld) {
      drag = { kind: "pan", from: screen, cam: { ...cam } };
      return;
    }
    if (running) return;

    const cid = M.pickConnector(mechanism, world, CONNECTOR_HIT_RADIUS / cam.z);
    if (cid >= 0) {
      if (e.shiftKey) {
        mechanism.connectors[cid].selected = !mechanism.connectors[cid].selected;
      } else if (!mechanism.connectors[cid].selected) {
        clearSelection();
        mechanism.connectors[cid].selected = true;
      }
      noteSelection();
      drag = { kind: "move", from: world, moved: false, start: snapshotPositions() };
      draw();
      notify();
      return;
    }

    /* Rails are picked after joints but before link edges: a rail usually runs
       along ground where nothing else competes for the click, and a pin sitting
       on it should still win. */
    const sid = M.pickSlider(mechanism, world, LINK_EDGE_HIT_DIST / cam.z);
    if (sid >= 0) {
      clearSelection();
      mechanism.sliders[sid].selected = true;
      drag = { kind: "none" };
      draw();
      notify();
      return;
    }

    const lid = M.pickLinkEdge(mechanism, world, LINK_EDGE_HIT_DIST / cam.z);
    if (lid >= 0) {
      clearSelection();
      mechanism.links[lid].selected = true;
      drag = { kind: "none" };
      draw();
      notify();
      return;
    }

    drag = { kind: "maybe-box", from: screen, world, shift: e.shiftKey };
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, pointerPos(e));

    if (pinch && pointers.size === 2) {
      const [p1, p2] = [...pointers.values()];
      const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      releaseFraming();
      if (pinch.dist > 0) cam.z = clamp((pinch.z * dist) / pinch.dist, ZOOM_MIN, ZOOM_MAX);
      const midScreen = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      /* Keep the world point that was under the midpoint pinned to it. */
      cam.x = pinch.mid.x - (midScreen.x - w / 2) / cam.z;
      cam.y = pinch.mid.y - (midScreen.y - h / 2) / cam.z;
      draw();
      return;
    }
    if (!drag) return;

    const screen = pointerPos(e);

    if (drag.kind === "pan") {
      releaseFraming();
      cam.x = drag.cam.x - (screen.x - drag.from.x) / cam.z;
      cam.y = drag.cam.y - (screen.y - drag.from.y) / cam.z;
      draw();
      return;
    }

    if (drag.kind === "maybe-box") {
      if (Math.hypot(screen.x - drag.from.x, screen.y - drag.from.y) < DRAG_THRESHOLD) return;
      drag = { kind: "box", from: drag.from, to: screen, shift: drag.shift };
    }
    if (drag.kind === "box") {
      drag.to = screen;
      draw();
      return;
    }

    if (drag.kind === "move") {
      const world = toWorld(screen);
      const d = v.sub(world, drag.from);
      if (!drag.moved) {
        if (Math.hypot(d.x * cam.z, d.y * cam.z) < DRAG_THRESHOLD) return;
        /* Snapshot only once movement is real, so a plain click that happens
           to wobble a pixel doesn't fill the undo stack. */
        pushUndo();
        drag.moved = true;
      }
      /* Move from the positions captured at pointer-down, not incrementally:
         accumulating deltas would drift as the pointer is dragged around. */
      for (let i = 0; i < mechanism.connectors.length; i++) {
        const c = mechanism.connectors[i];
        if (c.alive && c.selected) c.pos = v.add(drag.start[i], d);
      }
      draw();
      notify();
    }
  });

  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!drag) return;

    if (drag.kind === "box") {
      const a = toWorld(drag.from), b = toWorld(drag.to);
      const [x0, x1] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
      const [y0, y1] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
      if (!drag.shift) clearSelection();
      for (const c of mechanism.connectors) {
        if (!c.alive) continue;
        if (c.pos.x >= x0 && c.pos.x <= x1 && c.pos.y >= y0 && c.pos.y <= y1) c.selected = true;
      }
      noteSelection();
      notify();
    } else if (drag.kind === "maybe-box" && !running) {
      /* A click on empty space places a joint there and selects it. Holding
         shift adds it to the selection instead of replacing it, so a chain of
         joints can be clicked out and turned into one body with L without
         having to go back and box-select them. */
      pushUndo();
      if (!drag.shift) clearSelection();
      const id = M.addConnector(mechanism, drag.world);
      mechanism.connectors[id].selected = true;
      noteSelection();
      notify();
    }

    drag = null;
    draw();
  }
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const screen = pointerPos(e);
    releaseFraming();
    const before = toWorld(screen);
    cam.z = clamp(cam.z * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP), ZOOM_MIN, ZOOM_MAX);
    const after = toWorld(screen);
    /* Keep the point under the cursor fixed while the scale changes. */
    cam.x += before.x - after.x;
    cam.y += before.y - after.y;
    draw();
  }, { passive: false });

  function snapshotPositions() {
    return mechanism.connectors.map((c) => ({ x: c.pos.x, y: c.pos.y }));
  }

  /* ------------------------------------------------------------ keyboard */

  let spaceHeld = false;
  const KEYS = {
    l: linkSelected, a: toggleAnchor, m: toggleMotor, v: toggleVariable,
    t: toggleTrace, g: toggleGravity, r: toggleRun, c: clearTraces,
    s: slideSelected,
  };

  function onKeyDown(e) {
    /* Never swallow a key someone is typing into a field. */
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;

    if (e.code === "Space") { spaceHeld = true; return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    const k = e.key.toLowerCase();
    if (k === "escape") { clearSelection(); draw(); notify(); return; }
    if (k === "delete" || k === "backspace") { e.preventDefault(); deleteSelection(); return; }
    if (k === "+" || k === "=") { nudgeMotorSpeed(1); return; }
    if (k === "-" || k === "_") { nudgeMotorSpeed(-1); return; }
    if (KEYS[k]) { e.preventDefault(); KEYS[k](); }
  }
  function onKeyUp(e) { if (e.code === "Space") spaceHeld = false; }
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  /* -------------------------------------------------------------- drawing */

  function draw() {
    if (!w) return;
    ctx.clearRect(0, 0, w, h);
    drawGrid();

    /* traces first, so the mechanism sits on top of its own path */
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = palette.accent;
    ctx.globalAlpha = 0.55;
    for (const c of mechanism.connectors) {
      if (!c.alive || !c.traced || c.path.length < 2) continue;
      ctx.beginPath();
      const p0 = toScreen(c.path[0]);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < c.path.length; i++) {
        const q = toScreen(c.path[i]);
        ctx.lineTo(q.x, q.y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    /* ternary-and-larger links get a faint fill, so a plate reads as a body
       rather than as a triangle of independent bars */
    for (const l of mechanism.links) {
      if (!l.alive || l.connectorIds.length < 3) continue;
      ctx.fillStyle = l.selected ? palette.accent : palette.text;
      ctx.globalAlpha = l.selected ? 0.14 : 0.07;
      ctx.beginPath();
      l.connectorIds.forEach((cid, i) => {
        const q = toScreen(mechanism.connectors[cid].pos);
        i === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y);
      });
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    /* Rails, under the links: a slider's rail is guideway, not structure, so
       it is drawn as a thin double line -- the draughting convention for a
       slideway -- rather than as another bar. Extended a little past its two
       joints because the constraint is on the whole LINE, so the pin really
       can travel beyond them. */
    for (const sl of M.liveSliders(mechanism)) {
      const a = mechanism.connectors[sl.railAId].pos;
      const b = mechanism.connectors[sl.railBId].pos;
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) continue;
      const ux = dx / len, uy = dy / len;
      const over = 0.08 * len;
      const q1 = toScreen({ x: a.x - ux * over, y: a.y - uy * over });
      const q2 = toScreen({ x: b.x + ux * over, y: b.y + uy * over });
      /* Offset perpendicular by a fixed number of SCREEN pixels, so the pair
         reads as a slideway at any zoom instead of closing up when you zoom out. */
      const nx = -uy * 3, ny = ux * 3;
      ctx.strokeStyle = sl.selected ? palette.accent : palette.faint;
      ctx.lineWidth = sl.selected ? 2 : 1.25;
      for (const sgn of [1, -1]) {
        ctx.beginPath();
        ctx.moveTo(q1.x + nx * sgn, q1.y + ny * sgn);
        ctx.lineTo(q2.x + nx * sgn, q2.y + ny * sgn);
        ctx.stroke();
      }
    }

    ctx.lineCap = "round";
    for (const l of mechanism.links) {
      if (!l.alive) continue;
      /* Monochrome: selected and driven links take the top of the value
         scale; everything else sits a step below so they stand out. */
      ctx.strokeStyle = l.selected || l.isDriven ? palette.accent : palette.dim;
      ctx.lineWidth = l.selected ? 4 : l.isDriven ? 3.5 : 2.5;
      /* A variable-length link is drawn dashed: it is the one kind of link
         whose length you cannot trust by looking at it. */
      ctx.setLineDash(l.rigid || l.isDriven ? [] : [7, 5]);
      for (let i = 0; i < l.connectorIds.length; i++) {
        for (let j = i + 1; j < l.connectorIds.length; j++) {
          const q1 = toScreen(mechanism.connectors[l.connectorIds[i]].pos);
          const q2 = toScreen(mechanism.connectors[l.connectorIds[j]].pos);
          ctx.beginPath();
          ctx.moveTo(q1.x, q1.y);
          ctx.lineTo(q2.x, q2.y);
          ctx.stroke();
        }
      }
      ctx.setLineDash([]);
    }

    drawLengths();
    drawJoints();

    if (drag && drag.kind === "box") {
      ctx.strokeStyle = palette.accent;
      ctx.fillStyle = palette.accent;
      ctx.globalAlpha = 0.09;
      ctx.fillRect(drag.from.x, drag.from.y, drag.to.x - drag.from.x, drag.to.y - drag.from.y);
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(drag.from.x, drag.from.y, drag.to.x - drag.from.x, drag.to.y - drag.from.y);
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
  }

  function drawGrid() {
    /* A grid pitch that stays between 24 and 240 screen px whatever the zoom,
       so it reads as scale rather than as noise. */
    let pitch = 50;
    while (pitch * cam.z < 24) pitch *= 5;
    while (pitch * cam.z > 240) pitch /= 5;
    const step = pitch * cam.z;
    const originX = w / 2 - cam.x * cam.z;
    const originY = h / 2 - cam.y * cam.z;

    ctx.strokeStyle = palette.line;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = originX % step; x < w; x += step) {
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, h);
    }
    for (let y = originY % step; y < h; y += step) {
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(w, Math.round(y) + 0.5);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function drawLengths() {
    /* Every link's current length, alongside it. The desktop tool draws these
       with a hand-built seven-segment display to avoid a font dependency;
       canvas has fillText, so this just uses it. */
    if (cam.z < 0.12) return;
    ctx.font = "500 11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const l of mechanism.links) {
      if (!l.alive) continue;
      for (let i = 0; i < l.connectorIds.length; i++) {
        for (let j = i + 1; j < l.connectorIds.length; j++) {
          const a = mechanism.connectors[l.connectorIds[i]].pos;
          const b = mechanism.connectors[l.connectorIds[j]].pos;
          const len = v.dist(a, b);
          const s1 = toScreen(a), s2 = toScreen(b);
          if (Math.hypot(s2.x - s1.x, s2.y - s1.y) < 42) continue;
          const mid = { x: (s1.x + s2.x) / 2, y: (s1.y + s2.y) / 2 };
          let ang = Math.atan2(s2.y - s1.y, s2.x - s1.x);
          /* Keep the numeral upright rather than letting it read upside down
             on links pointing leftward. */
          if (ang > Math.PI / 2 || ang < -Math.PI / 2) ang += Math.PI;
          ctx.save();
          ctx.translate(mid.x, mid.y);
          ctx.rotate(ang);
          ctx.fillStyle = palette.faint;
          ctx.fillText(len.toFixed(0), 0, -10);
          ctx.restore();
        }
      }
    }
  }

  function drawJoints() {
    for (const c of mechanism.connectors) {
      if (!c.alive) continue;
      const s = toScreen(c.pos);

      if (c.isAnchor) {
        /* The conventional grounded-pivot triangle with hatching below. */
        ctx.fillStyle = c.selected ? palette.accent : palette.faint;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(s.x - 10, s.y + 15);
        ctx.lineTo(s.x + 10, s.y + 15);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = c.selected ? palette.accent : palette.faint;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(s.x - 13, s.y + 15.5);
        ctx.lineTo(s.x + 13, s.y + 15.5);
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(s.x, s.y, c.selected ? 6.5 : 5, 0, Math.PI * 2);
      ctx.fillStyle = c.traced ? palette.accent : palette.elev;
      ctx.fill();
      ctx.lineWidth = c.selected ? 3 : 2;
      ctx.strokeStyle = c.selected ? palette.accent : c.traced ? palette.accent : palette.text;
      ctx.stroke();
    }
  }

  /* ----------------------------------------------------------------- api */

  window.addEventListener("themechange", () => { palette = readPalette(); draw(); });
  new ResizeObserver(resize).observe(canvas);
  resize();

  return {
    get mechanism() { return mechanism; },
    get running() { return running; },
    get gravity() { return gravity; },
    load(next, useGravity) {
      if (running) stop();
      mechanism = next;
      gravity = !!useGravity;
      undoStack = [];
      bound = false;
      bindMessage = "";
      applyGravity();
      fitView();
      notify();
    },
    state, draw, fitView, undo, clearSelection: deselectAll,
    linkSelected, slideSelected, toggleAnchor, toggleMotor, toggleVariable, toggleTrace,
    deleteSelection, toggleGravity, toggleRun, clearTraces, nudgeMotorSpeed,
    driveMotor, traceAll,
    listJoints, listLinks, selectJoints, selectLink, selectWhere, addJointAt,
    params,
    destroy() {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      if (raf) cancelAnimationFrame(raf);
    },
  };
}
