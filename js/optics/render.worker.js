/* The renderer, off the main thread.

   A module worker, and only ONE of them: GitHub Pages cannot send the COOP/COEP
   headers SharedArrayBuffer needs, so there is no thread pool to be had -- where
   the C fans out over every core with ls_parallel_for. The work is instead split
   into row chunks that yield often enough for a new request to pre-empt an old
   one, which is what keeps dragging the aperture responsive.

   Everything that decides what the picture LOOKS like lives in render.js, which
   knows nothing about workers and can therefore be rendered and checked by
   `node --test`. This file is only the postal service.

   Protocol
     in   { type: "render", gen, settings }
     in   { type: "expose", gen, exposure }   re-tonemap, no re-render
     out  { type: "built",  gen, derived, ... }
     out  { type: "pass",   gen, pass, spp, rgb }
     out  { type: "error",  gen, message }

   `rgb` is transferred, not copied. `gen` rises with each request; a result
   carrying a stale gen is ignored by the page and abandoned here. */

import * as FILM from "./film.js?v=1ebeecf9";
import { setup, renderRows, derivedOf } from "./render.js?v=1ebeecf9";
import { prescriptionName } from "./prescription.js?v=1ebeecf9";

let gen = 0;
/* Kept between messages so an exposure change can re-tonemap without tracing a
   single ray -- exposure is a view gain, and the film is in physical units. */
let state = null;

const yieldToInbox = () => new Promise((r) => setTimeout(r, 0));

const bytesFor = (film) => new Uint8ClampedArray(film.width * film.height * 4);

self.onmessage = async (e) => {
  const msg = e.data;

  /* Exposure is a VIEW GAIN. It does not restart a render, which is the whole
     reason the film is kept in physical units between messages. */
  if (msg.type === "expose") {
    if (!state || state.gen !== msg.gen) return;
    /* Recorded, not just used once. The render loop below tone-maps every
       frame it delivers, and if it kept using the exposure that arrived with
       the original request, the corrected frame would survive only until the
       next pass landed -- a quarter of a second -- and the control would look
       dead for the whole minute a render takes. */
    state.exposure = msg.exposure;
    const rgb = FILM.tonemap(state.film, state.exposure, bytesFor(state.film));
    postMessage(
      { type: "pass", gen: msg.gen, pass: state.pass, spp: FILM.samplesPerPixel(state.film), rgb },
      [rgb.buffer]
    );
    return;
  }

  if (msg.type !== "render") return;
  const myGen = ++gen;
  const stale = () => gen !== myGen;
  const s = msg.settings;

  try {
    const st = setup(s);
    const film = FILM.create(st.width, st.height);
    state = { gen: myGen, film, pass: 0, exposure: s.exposure };

    postMessage({
      type: "built", gen: myGen,
      derived: derivedOf(st.cam.lens, st.cam.sensorWMm, st.cam.sensorHMm, s.cocLimitMm),
      width: st.width, height: st.height,
      markers: st.markers,
      lamps: st.lamps.map((l) => ({
        kind: l.kind, centre: l.centre, sizeU: l.sizeU,
        sizeV: l.sizeV, radius: l.radius, name: l.name,
      })),
      lightMode: s.lightMode,
      lensName: prescriptionName(s.design),
    });
    if (stale()) return;

    /* Rows in chunks, so a newer request can cut in. 16 rows is short enough to
       stay responsive at 512 px wide and long enough that the yield itself is
       not the cost. */
    const CHUNK = 16;

    /* A frame costs a tone-map, a quarter-megabyte allocation, a transfer and a
       putImageData on the main thread. A pass takes about a tenth of a second,
       so posting one per pass means doing all of that ten times a second for
       the minute or so a full render takes -- which is enough to make the page
       itself feel heavy, and buys nothing: nobody can see a converging render
       improve at ten frames a second.

       So the film accumulates every pass and the picture is only DELIVERED
       every so often. The first pass goes out immediately, because the wait for
       something to appear is the one that is actually felt. */
    const MIN_FRAME_MS = 250;
    let lastPost = 0;

    for (let pass = 0; pass < s.passes; pass++) {
      for (let y0 = 0; y0 < st.height; y0 += CHUNK) {
        renderRows(st, film, s, pass, y0, Math.min(st.height, y0 + CHUNK));
        await yieldToInbox();
        if (stale()) return;
      }
      state.pass = pass + 1;

      const now = Date.now();
      const last = pass === s.passes - 1;
      if (pass === 0 || last || now - lastPost >= MIN_FRAME_MS) {
        lastPost = now;
        const rgb = FILM.tonemap(film, state.exposure, bytesFor(film));
        postMessage(
          { type: "pass", gen: myGen, pass: pass + 1, spp: FILM.samplesPerPixel(film), rgb },
          [rgb.buffer]
        );
        if (stale()) return;
      }
    }
  } catch (err) {
    postMessage({ type: "error", gen: myGen, message: String((err && err.message) || err) });
  }
};
