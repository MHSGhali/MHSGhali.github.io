/* The assistant panel on the light page. Same shape as the linkage one: it
   turns the chat's command grammar into this tool's actions, and puts the
   result into words a visitor would recognise from the status line. */

import { mountChat } from "../chat/ui.js?v=4c85dc67";
import * as knowledge from "./knowledge.js?v=4c85dc67";

const round = (x) => Math.round(x * 1000) / 1000;
const at = (p) => `(${round(p.x)}, ${round(p.y)}, ${round(p.z)})`;

/* The viewport shows lamps and surfaces but numbers none of them, so whenever a
   number would be useful the panel reads the scene out; those numbers are what
   select() takes back. */
function inventory(api) {
  const s = api.scene();
  const lamps = s.lights.map((l) => `${l.n}: ${l.kind} at ${at(l.p)}, ${l.flux} ${l.unit}`
    + (l.spd && (l.spd.kind === "daylight" || l.spd.kind === "blackbody") ? `, ${l.spd.a} K` : ""));
  const parts = s.prims.map((p) => `${p.n}: ${p.kind} at ${at(p.c)}`
    + (p.albedo !== undefined ? `, albedo ${p.albedo}` : ""));
  return `Lamps: ${lamps.length ? lamps.join("; ") : "none"}. `
    + `Surfaces: ${parts.length ? parts.join("; ") : "none"}.`;
}

export function mountAssistant(host, api) {
  let lastName = null;

  const controller = {
    domain: "light",

    /* Passed to the chat module, never imported by it. See the note in
       js/linkage/assistant.js. */
    knowledge,

    snapshot() {
      const sc = api.scene();
      const stats = api.stats();
      return {
        scene: lastName,
        photometric: api.units(),
        indirect: api.indirect(),
        quality: api.quality(),
        selection: sc.selection,
        lamps: sc.lights.map((l) => ({
          n: l.n, kind: l.kind, flux: l.flux, unit: l.unit, p: l.p,
          totalDeg: l.totalDeg,
          kelvin: l.spd && (l.spd.kind === "daylight" || l.spd.kind === "blackbody") ? l.spd.a : null,
        })),
        surfaces: sc.prims.map((p) => ({ n: p.n, kind: p.kind, c: p.c, albedo: p.albedo })),
        stats,
      };
    },

    stateBlock() { return knowledge.formatState(controller.snapshot()); },
    help() { return knowledge.CAPABILITY_TEXT; },

    apply(cmd) {
      switch (cmd.action) {
        case "preset": {
          const preset = api.loadPreset(cmd.id);
          if (!preset) return null;
          lastName = preset.name;
          return `Loaded “${preset.name}”. ${preset.blurb} Solving now.`;
        }

        case "units": {
          const photometric = cmd.value === "lux";
          if (api.units() === photometric) {
            return `Already showing ${photometric ? "lux" : "W·m⁻²"}.`;
          }
          api.setUnits(photometric);
          /* Worth saying every time: this is the thing the engine is FOR. */
          return photometric
            ? "Showing illuminance in lux. No re-solve: both units are dot products against the "
              + "same stored spectrum."
            : "Showing irradiance in W·m⁻², re-projected from the same measurement "
              + "rather than scaled.";
        }

        case "indirect": {
          const want = cmd.value === null ? !api.indirect() : cmd.value;
          if (want === api.indirect()) return `Interreflection is already ${want ? "on" : "off"}.`;
          api.setIndirect(want);
          return want
            ? "Interreflection on. The bounce passes accumulate, so the numbers climb for a second."
            : "Direct light only. Anything lit purely by a bounce goes dark.";
        }

        case "quality": {
          const fine = cmd.value === "fine";
          if (api.quality() === cmd.value) return `Already on ${cmd.value} quality.`;
          api.setQuality(cmd.value);
          return fine ? "Fine quality: more samples, a slower solve." : "Back to draft quality.";
        }

        case "addLight":
          api.addLight(cmd.kind);
          return `Added a ${cmd.kind === "rect" ? "rectangular panel" : cmd.kind} lamp at the top of `
            + "the scene, selected so you can set its position and flux in the panel.";

        case "addPrim":
          api.addPrim(cmd.kind);
          return `Added a ${cmd.kind === "sphere" ? "sphere" : "quad"}, selected for editing.`;

        case "fit":
          api.fit();
          return "Framed the whole scene.";

        /* --- picking something, then changing it --------------------- */

        case "pick": {
          const got = api.select(cmd.kind, cmd.n);
          if (!got) return `There is no ${cmd.kind === "light" ? "lamp" : "surface"} ${cmd.n}. ` + inventory(api);
          /* Say what THIS object takes, not what objects take in general: a
             surface has no flux and a lamp has no albedo. */
          return cmd.kind === "light"
            ? `Selected lamp ${cmd.n}, the ${got.kind}. I can set its flux ("600 lumens"), its `
              + `colour temperature ("2700 K"), where it is ("move it to 0.1 0 0.45")`
              + (got.kind === "spot" ? ', and its cone ("set the cone to 25 degrees").' : ".")
            : `Selected surface ${cmd.n}, the ${got.kind}. I can set where it is `
              + `("move it to 0 0 0.1"), its material's albedo ("set the albedo to 0.8")`
              + (got.kind === "sphere" ? ', and its radius ("set the radius to 0.08").' : ".");
        }

        case "edit": {
          const said = api.edit(cmd.patch);
          if (!said) {
            if (api.scene().selection) {
              return "That is not something this object has. A lamp takes a flux, a colour "
                + "temperature and a position; a surface takes a position, a size and an albedo.";
            }
            return {
              text: "Nothing is selected, so there is nothing to change. " + inventory(api),
              suggest: api.scene().lights.length ? "select lamp 1" : null,
            };
          }
          return `Set it to ${said.join(", ")}. Re-solving.`;
        }

        case "remove": {
          const gone = api.remove();
          if (gone) {
            return `Deleted ${gone}. The scene re-solves without it; reload the preset to get it back.`;
          }
          return {
            text: "Nothing is selected, so there is nothing to delete.",
            suggest: api.scene().lights.length ? "select lamp 1" : null,
          };
        }

        case "download":
          api.download();
          return "Downloaded scene.scene. The C CLI reads the same file: ./lightsim grid scene.scene";

        case "share":
          api.share();
          return "Copied a link that carries the whole scene.";

        case "list":
          return inventory(api);

        default:
          return null;
      }
    },

    describe() {
      const s = api.stats();
      const where = lastName ? `“${lastName}”` : "the scene on screen";
      if (!s) return `Nothing has been measured yet in ${where}.`;
      const unit = api.units() ? "lx" : "W·m⁻²";
      /* One unlit point drives both uniformity ratios to zero, so a bare 0.000
         reads as a broken solve. The page says why under the stats line; so
         does this. */
      const why = s.dark
        ? ` ${s.dark} of the ${s.points} grid points get no light at all, which is what puts `
          + "the uniformity at zero."
        : "";
      return `Across the grid in ${where} the solver reads ${s.min} min, ${s.mean} mean and `
        + `${s.max} max ${unit}, with uniformity U₀ of ${s.u0}.${why} `
        + `${api.indirect() ? "Interreflection is on" : "Direct light only"}, `
        + `${api.quality()} quality`
        + (s.settled ? "." : ", and the bounce passes are still landing, so these will move.");
    },
  };

  return mountChat(host, { mode: "panel", controller });
}
