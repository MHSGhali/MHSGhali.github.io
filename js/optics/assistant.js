/* The assistant panel on the optics page. Same shape as the light one: it
   turns the chat's command grammar into this tool's actions, and puts the
   result into words a visitor would recognise from the panel beside it.

   Everything here goes through the page's own commit path, so a command and a
   typed number cannot reach different places -- which is the same reason
   settings.js has exactly one clamp. */

import { mountChat } from "../chat/ui.js?v=3da9737a";
import * as knowledge from "./knowledge.js?v=3da9737a";
import * as SD from "./scenedesc.js?v=3da9737a";
import * as P from "./prescription.js?v=3da9737a";

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : "∞");

/* One stop is a factor of root two in f-number, not two: the f-number is a
   ratio of lengths and the light goes as its square. */
const STOP = Math.SQRT2;

export function mountAssistant(host, api) {
  /* What the page said back the last time something was set, so `describe`
     can talk about the scene by name rather than as "this". */
  const sceneName = () => SD.PRESET_NAMES[api.settings().preset] || "the scene";

  /* A setting change, reported the way the panel reports it. Returns null when
     the value did not actually move, so the caller can say so instead of
     claiming a change that did not happen. */
  const put = (id, value) => api.set(id, value);

  const controller = {
    domain: "optics",

    /* Passed to the chat module, never imported by it -- see the note in
       js/linkage/assistant.js. */
    knowledge,

    snapshot() {
      const s = api.settings();
      return {
        scene: SD.PRESET_NAMES[s.preset],
        lighting: SD.MODE_NAMES[s.lightMode],
        ambientLux: s.ambientLux,
        ambientCctK: s.ambientCctK,
        design: P.NAMES[s.design],
        focalMm: s.focalMm, fno: s.fno, focusM: s.focusM,
        sensorWMm: s.sensorWMm, resW: s.resW,
        exposure: s.exposure, cocLimitMm: s.cocLimitMm,
        derived: api.derived(),
        spp: api.spp(),
        targets: api.targets(),
      };
    },

    stateBlock() { return knowledge.formatState(controller.snapshot()); },
    help() { return knowledge.CAPABILITY_TEXT; },

    apply(cmd) {
      const s = api.settings();

      switch (cmd.action) {
        case "preset": {
          if (!put("preset", cmd.id)) return `Already showing the ${cmd.name}.`;
          return "Loaded the depth rail: five identical targets at 1, 1.5, 2, 3 and 5 m. They all "
            + "subtend the same angle, so the only difference between them is focus.";
        }

        case "design": {
          if (!put("design", cmd.value)) return `Already on the ${P.NAMES[cmd.value].toLowerCase()}.`;
          const d = api.derived();
          const err = d ? ` Its chromatic error is ${r2(d.colourErrPct)} % of the focal length.` : "";
          if (cmd.value === P.SINGLET_100) {
            return `Mounted the uncorrected N-BK7 singlet.${err} It is supposed to fringe — that is `
              + "what it is here for.";
          }
          if (cmd.value === P.ACHROMAT_100) {
            return `Mounted the Fraunhofer achromat.${err} Two glasses with their powers split by `
              + "their Abbe numbers, so the blue and red foci coincide.";
          }
          return `Mounted the ideal lens.${err} Dispersionless and exactly 100 mm at every `
            + "wavelength, so anything you see now is not the glass.";
        }

        case "aperture": {
          const want = cmd.stops !== undefined
            ? s.fno * Math.pow(STOP, cmd.stops)
            : cmd.value;
          if (!put("fno", want)) return `Already at f/${r2(s.fno)}.`;
          const d = api.derived();
          /* The clamp is the interesting case and it must not pass silently:
             a design whose front element is too small cannot open that wide,
             and the lens reports the f-number it really passes. */
          if (d && Math.abs(d.fNumber - api.settings().fno) > 0.01) {
            return `That is wider than this design opens. Its front element gives f/${r2(d.fNumber)}, `
              + `with a ${r2(d.pupilMm)} mm entrance pupil, and that is what it is passing.`;
          }
          return `At f/${r2(api.settings().fno)}` + (d
            ? `, sharp on the axis from ${r2(d.nearM)} to ${r2(d.farM)} m.`
            : ".");
        }

        case "focal": {
          /* A relative step is a third of the way between the classic focal
             lengths, which is roughly how a zoom ring feels. */
          const want = cmd.stops !== undefined
            ? s.focalMm * Math.pow(1.5, cmd.stops)
            : cmd.value;
          if (!put("focalMm", want)) return `Already a ${r2(s.focalMm)} mm lens.`;
          const d = api.derived();
          return `Rescaled the design to ${r2(api.settings().focalMm)} mm`
            + (d ? `, which is ${r2(d.hfovDeg)}° across the frame.` : ".")
            + " Every length in the prescription scales together, so the f-number is unchanged.";
        }

        case "focus": {
          /* Infinity is a real answer to "focus where", but the control is a
             finite number: 1000 m is the far end and is past hyperfocal for
             every design here, so it IS infinity as far as the picture goes. */
          const want = cmd.stops !== undefined
            ? s.focusM * Math.pow(1.6, cmd.stops)
            : Number.isFinite(cmd.value) ? cmd.value : 1000;
          if (!put("focusM", want)) return `Already focused at ${r2(s.focusM)} m.`;
          const now = api.settings().focusM;
          if (Math.abs(now - want) > 1e-9) {
            return `That is outside what this lens can focus on, so it went to ${r2(now)} m — `
              + "the nearest it can do.";
          }
          const d = api.derived();
          const sharp = (api.targets() || []).filter((t) => t.sharp).map((t) => t.label);
          return `Focused at ${r2(now)} m.`
            + (d ? ` Sharp on the axis from ${r2(d.nearM)} to ${r2(d.farM)} m.` : "")
            + (sharp.length ? ` That puts ${sharp.join(" and ")} inside it.` : "");
        }

        case "sensor": {
          if (!put("sensorWMm", cmd.value)) return `The sensor is already ${r2(s.sensorWMm)} mm wide.`;
          const d = api.derived();
          const short = d && d.coversMm < d.coveredMm;
          return `Sensor is ${r2(api.settings().sensorWMm)} mm wide`
            + (d ? `, ${r2(d.hfovDeg)}° across.` : ".")
            + (short ? ` This design only covers ${r2(d.coversMm)} mm of the ${r2(d.coveredMm)} mm `
              + "that needs, so the corners are outside its image circle." : "");
        }

        case "exposure": {
          const want = cmd.factor !== undefined ? s.exposure * cmd.factor : cmd.value;
          if (!put("exposure", want)) return `The exposure is already ×${r2(s.exposure)}.`;
          return `Exposure ×${r2(api.settings().exposure)}. This is a viewing gain: it re-develops `
            + "the measurements already taken rather than tracing a single new ray.";
        }

        case "resolution":
          if (!put("resW", cmd.value)) return `Already rendering ${s.resW} px wide.`;
          return `Rendering ${api.settings().resW} px wide. Bigger is slower per pass, and the `
            + "picture refines progressively either way.";

        case "lighting": {
          if (!put("lightMode", cmd.value)) {
            return cmd.value === SD.AMBIENT ? "The sky is already lighting it." : "The lamps are already on.";
          }
          return cmd.value === SD.AMBIENT
            ? "Lit by a uniform sky now. Nothing casts a shadow and nothing has a terminator, which "
              + "is the honest place to judge focus — shadow contrast reads as sharpness. It is "
              + "about two stops brighter than the lamp, so bring the exposure down."
            : "Back to the placed key lamp, up and to the right. The shadows and the terminator "
              + "come back with it.";
        }

        case "ambientLux": {
          if (api.settings().lightMode !== SD.AMBIENT) {
            return {
              text: "The sky is not what is lighting the scene, so its brightness does nothing yet.",
              suggest: "switch to the sky",
            };
          }
          if (!put("ambientLux", cmd.value)) return `The sky is already ${r2(s.ambientLux)} lx.`;
          return `Sky at ${r2(api.settings().ambientLux)} lx — the illuminance on a surface facing `
            + "it, which is what a light meter aimed upward reads.";
        }

        case "skyColour": {
          if (api.settings().lightMode !== SD.AMBIENT) {
            return {
              text: "The sky is not lighting the scene, so its colour does nothing yet.",
              suggest: "switch to the sky",
            };
          }
          if (!put("ambientCctK", cmd.value)) return `The sky is already ${r2(s.ambientCctK)} K.`;
          return `Sky at ${r2(api.settings().ambientCctK)} K.`;
        }

        case "coc":
          if (!put("cocLimitMm", cmd.value)) return `The sharpness limit is already ${s.cocLimitMm} mm.`;
          return `Calling ${api.settings().cocLimitMm} mm sharp. That moves the depth-of-field `
            + "numbers and the slab in the scene view; it does not re-render anything.";

        case "fit":
          api.fit();
          return "Framed the scene view again.";

        case "reset":
          api.reset();
          return "Back to the shipped camera: the achromat at 100 mm, f/5, focused at 2 m.";

        case "share":
          api.share();
          return "Copied a link that carries the whole camera.";

        case "list":
          return controller.describe();

        default:
          return null;
      }
    },

    describe() {
      const s = api.settings();
      const d = api.derived();
      if (!d) return `Setting up the ${sceneName()}; the lens has not been built yet.`;

      const targets = api.targets() || [];
      const sharp = targets.filter((t) => t.sharp).map((t) => t.label);
      const spp = api.spp();

      /* The depth-of-field claim is on-axis and from defocus alone, and on this
         doublet that can be the opposite of what the render shows at the edge
         of the field. Saying so here costs one clause and stops the number
         being read as the whole truth. */
      const caveat = targets.length && sharp.length
        ? ` ${sharp.join(" and ")} ${sharp.length > 1 ? "are" : "is"} inside that, on the axis — off `
          + "axis this design's coma can still soften a target the numbers call sharp."
        : "";

      return `The ${sceneName()}, lit by ${SD.MODE_NAMES[s.lightMode].toLowerCase()}, through the `
        + `${P.NAMES[s.design].toLowerCase()} at ${r2(d.eflMm)} mm and f/${r2(d.fNumber)}, focused at `
        + `${r2(s.focusM)} m. Sharp on the axis from ${r2(d.nearM)} to ${r2(d.farM)} m.${caveat} `
        + (spp ? `The render is ${Math.round(spp)} samples a pixel in.` : "The render has not started.");
    },
  };

  return mountChat(host, { mode: "panel", controller });
}
