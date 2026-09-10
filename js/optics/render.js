/* The render core: settings in, pixels out.

   Deliberately free of `self`, postMessage and any other worker vocabulary, so
   `node --test` can render a frame and check it. render.worker.js is the thin
   message shim around this; everything that could be wrong about a picture is
   in here, where a test can reach it.

   DETERMINISM
     Row y of pass p produces the same numbers however the work is chunked. The
     RNG is seeded from the PIXEL and the PASS, never from a chunk index or a
     running counter -- exactly as os_render.c seeds from the work-item index
     rather than a thread id. Seeding per chunk would make every render depend
     on how the scheduler happened to slice it, so a bug would reproduce only
     sometimes and a regression test could not exist at all. */

import * as SD from "./scenedesc.js?v=008be1e5";
import * as CAM from "./camera.js?v=008be1e5";
import * as LENS from "./lens.js?v=008be1e5";
import * as FILM from "./film.js?v=008be1e5";
import * as T from "./trace.js?v=008be1e5";
import * as G from "./glass.js?v=008be1e5";
import * as R from "../light/rng.js?v=008be1e5";
import { PI } from "../light/core.js?v=008be1e5";

/* The same seed constant the light engine's grid uses. */
const SEED = 0x2545f4914f6cdd1dn;

export function resH(resW) {
  /* 3:2, the aspect of the 36 x 24 mm format the sensor width names. Derived
     rather than stored so the render grid and the sensor cannot disagree. */
  const h = Math.round((resW * 2) / 3);
  return h < 2 ? 2 : h;
}

/* Everything the panel reports but does not set, from the LENS rather than from
   a built camera.

   Taking the lens directly is what lets the page compute these synchronously,
   the instant a control moves, instead of waiting for the worker to build a
   camera and send them back. That wait was long enough to be wrong about:
   the assistant read the previous render's numbers and told a visitor who had
   just stopped down to f/16 that f/16 was wider than the design opens. */
export function derivedOf(L, sensorWMm, sensorHMm, cocLimitMm) {
  const diag = Math.sqrt(sensorWMm ** 2 + sensorHMm ** 2);
  const d = LENS.dof(L, cocLimitMm) || { near: 0, far: Infinity };
  return {
    name: L.name,
    eflMm: L.eflMm,
    hfovDeg: (2 * Math.atan2(sensorWMm * 0.5, L.eflMm) * 180) / PI,
    pupilMm: 2 * L.epSemiApMm,
    /* The f-stop / T-stop gap: real transmitted light, not geometry. */
    tstop: L.fNumber / Math.sqrt(LENS.transmittance(L, G.LINE_D)),
    fNumber: L.fNumber,
    bfdMm: L.bfdMm,
    filmZMm: L.filmZMm,
    /* Longitudinal chromatic aberration as a number: swap the singlet for the
       achromat and watch it fall by a factor of twenty. */
    colourErrPct: (100 * (LENS.eflAt(L, G.LINE_F) - LENS.eflAt(L, G.LINE_C))) / L.eflMm,
    blurAt6mMm: LENS.cocMm(L, 6),
    coversMm: L.imageCircleMm,
    coveredMm: diag,
    nearM: d.near,
    farM: d.far,
    hyperfocalM: LENS.hyperfocalM(L, cocLimitMm),
    focusM: L.focusDistanceM,
  };
}

/* Build the camera and the scene a settings object describes. Exported so the
   tests can render a frame without a worker. */
export function setup(s) {
  const w = s.resW | 0;
  const h = resH(w);

  const cam = CAM.build(s.design, s.focalMm, s.fno, s.sensorWMm, w, h);
  cam.lens.blades = s.blades >= 3 ? s.blades | 0 : 0;
  cam.lens.bladeCurvature = s.curvature;
  cam.lens.bladeRotRad = (s.rotDeg * PI) / 180;
  /* The iris shape changes the clip, so the f-number must be re-derived through
     it before the pupil is cached against it. */
  LENS.setFnumber(cam.lens, s.fno);
  if (!LENS.focus(cam.lens, s.focusM)) {
    throw new Error(`cannot focus at ${s.focusM} m: that is inside the front focal point`);
  }
  CAM.refresh(cam);

  const desc = SD.preset(s.preset);
  desc.lightMode = s.lightMode;
  desc.ambientLux = s.ambientLux;
  desc.ambientCctK = s.ambientCctK;
  const built = SD.build(desc);

  /* No refresh after lookAt: the pupil cache depends on the lens and the
     sensor, and a pose is neither. */
  CAM.lookAt(cam, desc.camEye, desc.camTarget, { x: 0, y: 1, z: 0 });

  return { cam, ...built, desc, width: w, height: h };
}

/* One pass over a band of rows. Exported so a test can prove that chunking the
   rows differently produces identical pixels. */
export function renderRows(st, film, s, pass, y0, y1) {
  const { cam, scene, env } = st;
  const W = film.width;
  const spp = s.spp | 0;
  const depth = s.depth | 0;
  const cs = CAM.makeSample();

  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < W; x++) {
      /* Seeded from the PIXEL and the PASS, never from the chunk. */
      const rng = R.seed(SEED, (y * W + x) * 977 + pass + 1);

      for (let i = 0; i < spp; i++) {
        /* The sample index spans passes, so the wavelength stratification keeps
           filling in as a render refines rather than repeating the same few
           wavelengths every pass. */
        const sampleIndex = pass * spp + i;

        let value = 0;
        let bin = 0;
        if (CAM.sample(cam, x, y, sampleIndex, rng, cs)) {
          const L = T.radiance(scene, env, { o: cs.o, d: cs.d }, cs.lambdaNm, rng, depth);
          /* Deposit into the ONE bin this path sampled, weighted by the
             reciprocal of the probability of having sampled it. Over many
             samples each bin receives an unbiased estimate of the radiance at
             its own wavelength. */
          value = cs.weight * L;
          bin = cs.bin;
        }
        /* A vignetted sample still lands here, contributing zero. Skipping it
           instead would renormalise the vignetting away and make the corners
           exactly as bright as the centre. */
        FILM.add(film, x, y, bin, value);
      }
    }
  }
}
