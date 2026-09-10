/* Entry point for the Ask page. The chat is the whole page here, so there is
   nothing to wire but the mount: everything else lives in ui.js, which the two
   simulator panels mount the same way. */

import { mountChat } from "./ui.js?v=6aaa6367";
import { linksController } from "./links.js?v=6aaa6367";

mountChat(document.getElementById("assistant"), {
  mode: "page",
  controller: linksController,
});
