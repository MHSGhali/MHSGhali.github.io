/* The controller for the Ask page, where there is no simulator to drive.

   A request the panels would execute becomes a link here instead: the page
   knows what the visitor asked for, so it can hand over a URL that opens the
   right tool with the right thing already loaded, rather than telling them to
   go and find it. */

import { LINKAGE_PRESETS, LIGHT_PRESETS, OPTICS_PRESETS } from "./commands.js?v=3da9737a";

/* Resolved against this module's own URL rather than the document's, so the
   link is right wherever the controller is mounted from. A relative path here
   would be relative to whichever page happened to load it. */
const page = (file) => new URL(`../../pages/${file}`, import.meta.url).pathname;
const linkage = (id) => `${page("linkage.html")}#preset=${id}`;
const light = (id) => `${page("light.html")}#preset=${id}`;
const optics = (id) => `${page("optics.html")}#preset=${id}`;

export const linksController = {
  domain: "links",

  apply(cmd) {
    if (cmd.action === "preset") {
      /* The grammar was matched against the linkage vocabulary here, so a light
         scene arrives only when its name is unambiguous. Check both lists. */
      const inLight = LIGHT_PRESETS.find((p) => p.id === cmd.id);
      const inLinkage = LINKAGE_PRESETS.find((p) => p.id === cmd.id);
      const inOptics = OPTICS_PRESETS.find((p) => p.id === cmd.id);
      if (inLinkage) {
        return `[Open the linkage simulator with the ${inLinkage.name}](${linkage(cmd.id)}) `
          + "and I will come with you: the panel there can run it, change the motor speed and "
          + "read the mechanism back to you.";
      }
      if (inLight) {
        return `[Open the light simulator with ${inLight.name}](${light(cmd.id)}) `
          + "and the panel there can switch units, turn interreflection off and read the "
          + "illuminance back to you.";
      }
      if (inOptics) {
        return `[Open the optics simulator with the ${inOptics.name}](${optics(cmd.id)}) `
          + "and the panel there can change the lens, the aperture and the focus, and tell you "
          + "what came out sharp.";
      }
    }
    /* Any other control word on this page: there is nothing here to control. */
    return "There is no simulator on this page to drive. "
      + `[Open the linkage simulator](${linkage("four-bar")}), `
      + `[the light simulator](${light("workcell")}) or `
      + `[the optics simulator](${optics("rail")}) and ask me again there, where the same panel `
      + "can actually press the buttons.";
  },

  describe() {
    return "This page is just the chat. "
      + `[The linkage simulator](${linkage("four-bar")}), `
      + `[the light simulator](${light("workcell")}) and `
      + `[the optics simulator](${optics("rail")}) are where there is something to look at, and `
      + "I can drive any of them from the panel on those pages.";
  },
};
