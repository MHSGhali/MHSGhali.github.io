/* The assistant panel on the linkage page: what the chat's command grammar
   means in terms of this editor, and how to say what happened.

   The wording lives here rather than in js/chat/ because it is this tool's
   vocabulary. The chat module knows there is a controller; it does not know
   what a coupler is. */

import { mountChat } from "../chat/ui.js?v=1ebeecf9";
import * as knowledge from "./knowledge.js?v=1ebeecf9";
import { buildBars, SIZES } from "./generate.js?v=1ebeecf9";

const deg = (v) => `${v.toFixed(0)}°/s`;

/* The tool's preset names are titles ("Four-bar crank-rocker"), and dropped
   into the middle of a sentence a title reads wrong. Lowercasing the first
   letter fixes that for most of them and breaks the ones that are named after
   somebody: "the hoeken straight-line" and "the scotch yoke". Nothing about the
   spelling distinguishes "Four-bar" from "Hoeken", so the names are listed. */
const PROPER = /^(Hoeken|Scotch|Whitworth|Jansen|Grashof|Geneva)\b/;
const midSentence = (name) =>
  PROPER.test(name) ? name : name.charAt(0).toLowerCase() + name.slice(1);

/* The canvas draws joints, it does not number them. So whenever a number would
   be useful -- to select one, or to say which one moved -- the panel reads the
   list out, and those numbers are what selectJoints() takes back. */
function jointList(editor) {
  const live = editor.listJoints();
  if (!live.length) return "There are no joints yet. Say “place a joint at 0, 0” to start one.";
  const parts = live.slice(0, 12).map((j) => {
    const tags = [j.isAnchor && "anchored", j.traced && "traced", j.selected && "selected"]
      .filter(Boolean).join(", ");
    return `${j.n} at (${Math.round(j.x)}, ${Math.round(j.y)})${tags ? " " + tags : ""}`;
  });
  return `Joints: ${parts.join("; ")}${live.length > 12 ? `; and ${live.length - 12} more` : ""}.`;
}

/* After a selection, say what it is now good FOR. The toolbar greys out the
   buttons that cannot act; in words the equivalent is telling you which of them
   would work. */
function whatSelectionAllows(editor) {
  const s = editor.state();
  const can = [];
  if (s.selectedCount >= 2) can.push("“link them” makes a rigid bar");
  if (s.selectedCount === 3) can.push("“make a slider” rails the first on the other two");
  if (s.selectedCount) can.push("“anchor it” grounds them", "“trace them” draws their paths");
  return can.length ? can.join("; ") + "." : "";
}

/* The command that would make a motor possible on this link, worked out from
   the mechanism rather than guessed: a motor needs exactly one anchored joint
   on its own link, so either there are none and one must be anchored, or there
   are too many and one must be freed. Anchoring is a toggle, so the wording has
   to match the direction it will actually move in. */
function motorRemedy(editor, linkId) {
  const link = editor.listLinks().find((l) => l.id === linkId);
  if (!link) return null;
  const joints = editor.listJoints().filter((j) => link.joints.includes(j.id));
  const anchored = joints.filter((j) => j.isAnchor);
  if (!anchored.length && joints.length) return `anchor joint ${joints[0].n}`;
  if (anchored.length > 1) return `unanchor joint ${anchored[anchored.length - 1].n}`;
  return null;
}

export function mountAssistant(host, api) {
  const { editor } = api;
  let lastName = null;          /* what was loaded, for describe() */

  const controller = {
    domain: "linkage",

    /* Handed to the chat module rather than imported by it: js/chat/ knows
       there is a controller, and must not know what a coupler is. It is also
       what keeps the Ask page from loading both tools' documents. */
    knowledge,

    /* What is on the screen, as data. stateBlock() and describe() are both
       formatters over this, so the two can never disagree about the mechanism
       they are describing. */
    snapshot() {
      const s = editor.state();
      const joints = editor.listJoints();
      return {
        preset: lastName,
        running: s.running,
        gravity: s.gravity,
        sliders: s.sliderCount,
        bind: s.bindMessage || "",
        joints: joints.map((j) => ({
          n: j.n, x: j.x, y: j.y, anchor: j.isAnchor, traced: j.traced, selected: j.selected,
        })),
        links: editor.listLinks().map((l) => ({
          n: l.n, rigid: l.rigid, driven: l.isDriven, speed: l.speed,
          joints: l.joints.map((id) => (joints.find((j) => j.id === id) || {}).n).filter(Boolean),
        })),
        /* state().selectedLink is a raw index into mechanism.links, which keeps
           tombstones; every other number in this block comes from listLinks(),
           which counts only living ones. Adding one to the raw index printed a
           number the model would then quote and selectLink could not resolve. */
        selection: {
          link: s.selectedLink >= 0
            ? (editor.listLinks().find((l) => l.id === s.selectedLink) || {}).n ?? null
            : null,
        },
      };
    },

    stateBlock() { return knowledge.formatState(controller.snapshot()); },
    help() { return knowledge.CAPABILITY_TEXT; },

    apply(cmd) {
      switch (cmd.action) {
        case "preset": {
          const preset = api.loadPreset(cmd.id);
          lastName = preset.name;
          /* `because` is set when the mechanism was asked for by what it DOES
             rather than by name, so say which one answers that and why. Every
             preset already traces the point that shows its motion, so running
             it draws the answer. */
          if (cmd.because) {
            return {
              text: `The ${midSentence(preset.name)} does that: ${cmd.because}. It is loaded, `
                + "and the point that shows it is already traced, so running it will draw the path.",
              suggest: "run it",
            };
          }
          return `Loaded the ${midSentence(preset.name)}. ${preset.blurb}`;
        }

        case "run":
          if (editor.running) return "It is already running.";
          editor.toggleRun();
          /* toggleRun can refuse: a mechanism that will not bind stays put and
             says why in the status line, so do not claim it started. */
          return editor.running
            ? "Running. Press Stop, or say stop, whenever you like."
            : "It would not start. The status line under the canvas says why.";

        case "pause":
          if (!editor.running) return "It is not running.";
          editor.toggleRun();
          return "Stopped, and back to the layout it started from.";

        case "speed": {
          const v = editor.driveMotor(cmd.delta);
          if (v === null) {
            return {
              text: "There is no motor on this one, so there is no speed to change. "
                + "The double pendulum runs under gravity alone.",
              suggest: editor.listLinks().length === 1 ? "put a motor on it" : null,
            };
          }
          return `Motor ${cmd.delta > 0 ? "up" : "down"} to ${deg(v)}.`;
        }

        case "gravity": {
          const want = cmd.value === null ? !editor.gravity : cmd.value;
          if (want === editor.gravity) return `Gravity is already ${want ? "on" : "off"}.`;
          editor.toggleGravity();
          return want
            ? "Gravity on. Anything not held by a motor or an anchor now falls."
            : "Gravity off.";
        }

        case "trace": {
          if (editor.running) return "Stop it first: traces are set on the design, not on the run.";
          const n = editor.traceAll(true);
          return n
            ? `Tracing all ${n} joints. Run it and each one draws its path.`
            : "There are no joints to trace yet.";
        }

        case "clearTraces":
          editor.clearTraces();
          return "Traces cleared.";

        case "view":
          api.showView(cmd.value);
          return cmd.value === "3d"
            ? "Showing the 3D view. Drag to orbit, scroll to zoom."
            : "Back to the design view.";

        case "fit":
          api.fit();
          return "Fitted the view to the mechanism.";

        /* --- building ------------------------------------------------ */

        case "addJoint": {
          if (editor.running) {
            return { text: "The mechanism cannot change while it runs.", suggest: "stop" };
          }
          /* No coordinate given: put it clear of everything already there, so
             a joint asked for blind never lands on top of another one. */
          let { x, y } = cmd;
          if (x === null) {
            const live = editor.listJoints();
            x = live.length ? Math.max(...live.map((j) => j.x)) + 60 : 0;
            y = live.length ? live[live.length - 1].y : 0;
          }
          const n = editor.addJointAt(x, y, cmd.add);
          return n === null
            ? "I could not place that joint."
            : `Placed joint ${n} at (${Math.round(x)}, ${Math.round(y)}), and selected it. `
              + "Select another and say “link them” to make a bar.";
        }

        case "select": {
          if (editor.running) {
            return { text: "Selection is part of the design, and it is running.", suggest: "stop" };
          }
          let n = 0;
          if (cmd.which === "all") n = editor.selectWhere(() => true);
          else if (cmd.which === "anchors") n = editor.selectWhere((j) => j.isAnchor);
          else if (cmd.which === "traced") n = editor.selectWhere((j) => j.traced);
          else if (cmd.which === "ids") n = editor.selectJoints(cmd.ids);
          else if (cmd.which === "last") {
            const live = editor.listJoints();
            n = editor.selectJoints(live.slice(-cmd.count).map((j) => j.n));
          }
          if (!n) return "Nothing matched, so the selection is unchanged. " + jointList(editor);
          return `Selected ${n} joint${n === 1 ? "" : "s"}. ` + whatSelectionAllows(editor);
        }

        case "selectLink": {
          if (editor.running) {
            return { text: "Selection is part of the design, and it is running.", suggest: "stop" };
          }
          return editor.selectLink(cmd.n)
            ? `Selected link ${cmd.n}. Motor drives it if one of its joints is anchored; `
              + "variable lets it change length."
            : `There is no link ${cmd.n}. ` + jointList(editor);
        }

        case "deselect":
          editor.clearSelection();
          return "Selection cleared.";

        case "generate": {
          if (editor.running) {
            return { text: "The mechanism cannot change while it runs.", suggest: "stop" };
          }
          const built = buildBars(cmd.bars, { motorLink: cmd.motorLink });
          if (!built) {
            return `I can generate a ${SIZES.join(", a ")} bar linkage. An odd number of bars has `
              + "no closed chain with one degree of freedom, so there is nothing to build for it. "
              + "You can still place the joints yourself and link them however you like.";
          }
          editor.load(built.mechanism, false);
          lastName = `${cmd.bars}-bar linkage`;
          /* "a 8-bar" reads wrong, and this string is in front of the visitor
             every time they ask for one. */
          const an = built.bars === 8 ? "an" : "a";
          api.loadedCustom(`Generated ${an} ${cmd.bars}-bar linkage. Press Run to watch it.`);
          return {
            text: `Built ${an} ${built.bars}-bar linkage: ${built.joints} joints and ${built.links} `
              + `links, anchored at joint${built.anchors.length > 1 ? "s" : ""} `
              + `${built.anchors.join(", ")}, with the motor on link ${built.motorLink} at 90 deg/s. `
              + (built.note ? built.note + " " : "")
              + `Links ${built.drivable.join(", ")} each have one anchored joint, so any of them `
              + "could take the motor instead.",
            suggest: "run it",
          };
        }

        case "reset":
          if (editor.running) return "Stop it first.";
          api.blank();
          lastName = null;
          return "Empty canvas. Say “place a joint at 0, 0” and build from there; two joints and "
            + "“link them” make a bar, and a bar with one anchored end can take a motor.";

        case "link": {
          const before = editor.state().linkCount;
          editor.linkSelected();
          const after = editor.state().linkCount;
          if (after === before) {
            const enough = editor.listJoints().length >= 2;
            return {
              text: "That needs at least two joints selected. " + jointList(editor),
              suggest: enough ? "select all" : null,
            };
          }
          return "Linked them into one rigid body. Its joints now hold their distances.";
        }

        case "slide": {
          const before = editor.state().sliderCount;
          editor.slideSelected();
          return editor.state().sliderCount > before
            ? "Made a slider: the first joint you selected now runs on the line through the other two."
            : "A slider needs exactly three joints selected, in order: the pin first, then the two "
              + "that make its rail.";
        }

        case "anchor": {
          const s = editor.state();
          if (s.running) return "Stop it first.";
          /* A LINK cannot be anchored: anchoring is a property of a joint. So
             "select link 1, anchor it" has exactly one sensible reading, which
             is to ground the end that link turns about. Guessing here is safe
             because the alternative is not an ambiguity, it is a no-op. */
          if (!s.selectedCount && s.selectedLink >= 0) {
            const chosen = editor.listLinks().find((l) => l.id === s.selectedLink);
            const end = chosen && editor.listJoints().find((j) => j.id === chosen.joints[0]);
            if (end) editor.selectJoints([end.n]);
          }
          /* "Link them, then anchor it" is how anyone would say it, and after a
             link the selection is empty because linkSelected() clears it. With
             exactly one bar on the canvas there is no ambiguity about what "it"
             is either. */
          if (!editor.state().selectedCount && editor.listLinks().length === 1) {
            const only = editor.listLinks()[0];
            const first = editor.listJoints().find((j) => j.id === only.joints[0]);
            if (first) editor.selectJoints([first.n]);
          }
          if (!editor.state().selectedCount) return "Select a joint first. " + jointList(editor);
          const which = editor.listJoints().filter((j) => j.selected).map((j) => j.n);
          editor.toggleAnchor();
          return editor.state().allAnchored
            ? `Anchored joint${which.length === 1 ? " " + which[0] : "s " + which.join(" and ")}, `
              + "now fixed to the ground."
            : "Unanchored. Those joints are free again.";
        }

        case "motor": {
          let s = editor.state();
          if (s.running) return "Stop it first.";
          /* Same reading as anchor: one bar means "it" is that bar. */
          if (s.selectedLink < 0 && editor.listLinks().length === 1) {
            editor.selectLink(1);
            s = editor.state();
          }
          if (s.selectedLink < 0) {
            /* "Load the four-bar and put a motor on it" asks for something the
               starter already has. Saying "select a link first" there is
               technically true and completely unhelpful. */
            const driven = editor.mechanism.links.find((l) => l.alive && l.isDriven);
            if (driven) return `It already has a motor, running at ${deg(driven.motorSpeedDegS)}. `
              + "Say faster or slower to change it, or run it.";
            return editor.listLinks().length
              ? { text: "Select a link first, then I can drive it.", suggest: "select link 1" }
              : "There is no link to drive yet. Two joints and “link them” make one.";
          }
          if (!s.linkCanDrive && !s.linkDriven) {
            const fix = motorRemedy(editor, s.selectedLink);
            const both = fix && fix.startsWith("unanchor");
            return {
              text: both
                ? "Both ends of that link are anchored, and a motor needs exactly one anchored "
                  + "joint to turn about. Free one end and it will go on."
                : "A motor needs the link to have exactly one anchored joint to turn about. "
                  + "Anchor one of its ends first.",
              suggest: fix,
            };
          }
          editor.toggleMotor();
          return editor.state().linkDriven
            ? "Motor on that link. Say faster or slower to set its speed, then run it."
            : "Motor removed from that link.";
        }

        case "variable": {
          let s = editor.state();
          if (s.selectedLink < 0 && editor.listLinks().length === 1) {
            editor.selectLink(1);
            s = editor.state();
          }
          if (s.selectedLink < 0) return "Select a link first, then I can make it variable.";
          if (s.linkDriven) return "That link is driven by a motor, so it has to stay rigid.";
          editor.toggleVariable();
          return editor.state().linkRigid
            ? "Back to rigid: that link holds its length."
            : "Variable: that link may now change length as far as the rest of the geometry forces it to.";
        }

        case "delete": {
          const s = editor.state();
          if (s.running) return "Stop it first.";
          if (!s.hasSelection) return "Nothing is selected, so there is nothing to delete.";
          editor.deleteSelection();
          return "Deleted. Undo puts it back.";
        }

        /* --- taking it away ------------------------------------------ */

        /* Both of these go through the toolbar button, which is disabled while
           the mechanism runs, and the share handler says what it did only after
           awaiting the clipboard. So the status line cannot be read back
           straight away: doing that reported whatever the tool last said, which
           after loading a preset was the preset's blurb, as though the export
           had succeeded. */
        case "export": {
          if (editor.running) {
            return { text: "Exports are disabled while it runs.", suggest: "stop" };
          }
          const what = cmd.what === "blender" ? "download" : "print";
          if (what === "print" && editor.state().linkCount === 0) {
            return "There is nothing to print yet: a printable part needs at least one link.";
          }
          api.click(what);
          return cmd.what === "blender"
            ? "Downloading linkage_export.py. Run it in Blender's Scripting tab, then press Space."
            : "Downloading linkage_parts.zip. The manifest inside says how the parts stack, and "
              + "names any that were left out.";
        }

        case "share":
          if (editor.running) {
            return { text: "The share link is disabled while it runs.", suggest: "stop" };
          }
          api.click("share");
          return "Copied a link that carries the whole mechanism, so anyone who opens it gets "
            + "exactly this.";

        case "list":
          return jointList(editor);

        case "undo":
          if (editor.running) return "Stop it first; undo works on the design.";
          editor.undo();
          return "Undone.";

        default:
          return null;
      }
    },

    describe() {
      const s = editor.state();
      const bits = [];
      bits.push(lastName ? `The ${midSentence(lastName)}` : "The mechanism on screen");
      bits.push(`has ${s.jointCount} joint${s.jointCount === 1 ? "" : "s"} and `
        + `${s.linkCount} link${s.linkCount === 1 ? "" : "s"}`
        + (s.sliderCount ? `, plus ${s.sliderCount} slider${s.sliderCount === 1 ? "" : "s"}` : "")
        + ".");
      /* state().motorSpeed is the SELECTED link's, which is null while the
         thing is running because run() clears the selection. Read the driven
         link itself, so "what am I looking at" answers with a number in the
         one situation where the number is most interesting. */
      const driven = editor.mechanism.links.find((l) => l.alive && l.isDriven);
      if (driven) bits.push(`Its motor is set to ${deg(driven.motorSpeedDegS)}.`);
      else bits.push("It has no motor, so it moves under gravity or not at all.");
      bits.push(s.running ? "It is running now." : "It is stopped.");
      if (s.gravity) bits.push("Gravity is on.");
      return bits.join(" ");
    },
  };

  return mountChat(host, { mode: "panel", controller });
}
