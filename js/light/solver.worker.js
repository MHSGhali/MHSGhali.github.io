/* The solver, off the main thread.

   A module worker, and only ONE of them: GitHub Pages cannot send the
   COOP/COEP headers SharedArrayBuffer needs, so there is no thread pool to be
   had. The work is instead split into time-sliced chunks that yield often
   enough for a new request to pre-empt an old one, which is what keeps dragging
   a lamp responsive.

   Protocol
     in   { type: "solve", gen, sceneText, quality, depth, indirectPasses }
     out  { type: "geometry", gen, surfaces: [{pos, nor, idx}], nlights, weights }
     out  { type: "direct",   gen, direct: [Float64Array] }
     out  { type: "indirect", gen, pass, passes, indRad: [...], indLum: [...] }
     out  { type: "error",    gen, message }

   Every array is transferred, not copied. `gen` rises with each request; a
   result carrying a stale gen is ignored by the page and abandoned here. */

import { parseScene, buildScene } from "./scenefile.js?v=4c85dc67";
import * as F from "./field.js?v=4c85dc67";

let gen = 0;


const yieldToInbox = () => new Promise((r) => setTimeout(r, 0));

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type !== "solve") return;
  const myGen = ++gen;
  const stale = () => gen !== myGen;

  try {
    const desc = parseScene(msg.sceneText);
    const { scene, surfaces } = buildScene(desc);
    const nl = scene.lights.length;
    const q = F.QUALITY[msg.quality] || F.QUALITY.draft;

    /* An unbounded plane needs a finite patch; size it to the scene. */
    let extent = 1;
    for (const pi of surfaces) {
      const p = scene.prims[pi];
      extent = Math.max(extent, Math.abs(p.c.x), Math.abs(p.c.y), Math.abs(p.c.z));
    }

    /* The scene's `grid` directive is a measurement plane, not geometry: it is
       solved like any other surface but never drawn, and it is what the
       uniformity numbers are reported over. Statistics taken across every
       vertex in the scene would include wall backs that face away from every
       lamp, which drives U0 and Ud to zero and says nothing. */
    const build = surfaces.map((pi) => ({ primId: pi, hidden: false, prim: scene.prims[pi] }));
    if (desc.grid) build.push({ primId: -1, hidden: true, grid: desc.grid });
    const mesh = (b) => (b.grid ? F.tessGrid(b.grid, q.gridMax) : F.tessellate(b.prim, q, extent * 2));
    const meshes = build.map(mesh);
    const weights = F.lightWeights(scene);

    /* Narrowed to float32 for the page: a WebGL vertex buffer is float32
       regardless, and only the solver needs the double-precision originals
       (see the tessellation note in field.js). */
    const gpu = meshes.map((m) => ({
      pos: Float32Array.from(m.pos), nor: Float32Array.from(m.nor), idx: m.idx,
    }));
    postMessage(
      {
        type: "geometry", gen: myGen, nlights: nl,
        surfaces: gpu.map((m, i) => ({
          primId: build[i].primId, hidden: build[i].hidden,
          pos: m.pos, nor: m.nor, idx: m.idx,
        })),
        weights: { rad: weights.rad, lum: weights.lum },
      },
      gpu.flatMap((m) => [m.pos.buffer, m.nor.buffer, m.idx.buffer])
        .concat([weights.rad.buffer, weights.lum.buffer])
    );
    if (stale()) return;

    /* ---- direct, in chunks so a newer request can cut in ---- */
    const direct = meshes.map((m) => new Float64Array((m.pos.length / 3) * nl));
    let base = 0;
    for (let s = 0; s < meshes.length; s++) {
      const m = meshes[s];
      const nv = m.pos.length / 3;
      const CHUNK = 512;
      for (let v0 = 0; v0 < nv; v0 += CHUNK) {
        const v1 = Math.min(nv, v0 + CHUNK);
        const sub = {
          pos: m.pos.subarray(v0 * 3, v1 * 3),
          nor: m.nor.subarray(v0 * 3, v1 * 3),
        };
        F.solveDirect(scene, sub, direct[s].subarray(v0 * nl, v1 * nl), q.direct, base + v0);
        await yieldToInbox();
        if (stale()) return;
      }
      base += nv;
    }
    const directCopy = direct.map((a) => a.slice());
    postMessage({ type: "direct", gen: myGen, direct: directCopy },
                directCopy.map((a) => a.buffer));
    if (stale()) return;

    /* ---- indirect, one progressive pass at a time ---- */
    const passes = msg.indirectPasses | 0;
    if (passes <= 0 || msg.depth <= 0) return;
    const indRad = meshes.map((m) => new Float64Array((m.pos.length / 3) * nl));
    const indLum = meshes.map((m) => new Float64Array((m.pos.length / 3) * nl));
    const SAMPLES = 8;

    for (let pass = 0; pass < passes; pass++) {
      base = 0;
      for (let s = 0; s < meshes.length; s++) {
        const m = meshes[s];
        const nv = m.pos.length / 3;
        const CHUNK = 256;
        for (let v0 = 0; v0 < nv; v0 += CHUNK) {
          const v1 = Math.min(nv, v0 + CHUNK);
          const sub = {
            pos: m.pos.subarray(v0 * 3, v1 * 3),
            nor: m.nor.subarray(v0 * 3, v1 * 3),
          };
          F.solveIndirectPass(
            scene, sub,
            indRad[s].subarray(v0 * nl, v1 * nl),
            indLum[s].subarray(v0 * nl, v1 * nl),
            SAMPLES, msg.depth, pass, base + v0
          );
          await yieldToInbox();
          if (stale()) return;
        }
        base += nv;
      }
      /* Send the running MEAN, so the page can display a converging estimate
         rather than a sum that keeps growing. */
      const n = pass + 1;
      const rc = indRad.map((a) => { const b = a.slice(); for (let i = 0; i < b.length; i++) b[i] /= n; return b; });
      const lc = indLum.map((a) => { const b = a.slice(); for (let i = 0; i < b.length; i++) b[i] /= n; return b; });
      postMessage(
        { type: "indirect", gen: myGen, pass: n, passes, indRad: rc, indLum: lc },
        rc.map((a) => a.buffer).concat(lc.map((a) => a.buffer))
      );
      if (stale()) return;
    }
  } catch (err) {
    postMessage({ type: "error", gen: myGen, message: String(err && err.message || err) });
  }
};
