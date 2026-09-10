/* The camera and its subjects, seen from outside. From viewer/scene3d.c.

   WHAT THIS VIEW IS FOR
     The image view shows what came out. It does not show WHERE ANYTHING IS.
     This one does: the camera, the cone it sees, the plane it is focused on,
     the near and far limits of acceptable sharpness, and the objects, at their
     true distances.

     That is the picture that makes a depth-of-field setting legible. "f/5 at
     2 m" is a pair of numbers; a focus plane sitting on the third sphere with
     the depth-of-field slab reaching neither of its neighbours is an
     explanation.

   THE INVARIANT THIS MODULE OWNS
     Every distance drawn comes from the same source the renderer uses -- the
     scene description for the objects, the lens's own solver for the focus and
     depth-of-field planes. Nothing here re-derives a position from a formula of
     its own, because a diagram that disagrees with the render is worse than no
     diagram.

   FREE OF THREE.JS
     It produces line segments and labels in world space, and nothing else.
     view3d.js turns them into geometry. So the diagram can be checked
     headlessly, which matters -- a sign error in a view is invisible until you
     already believe the picture.

   COORDINATES
     Y-up, camera at the origin looking down -z, matching scenedesc.js. */

import { TWO_PI } from "../light/core.js?v=901aad0b";
import * as v from "../light/vec3.js?v=901aad0b";
import * as LENS from "./lens.js?v=901aad0b";
import { AMBIENT } from "./scenedesc.js?v=901aad0b";

/* What a segment is FOR, which is what decides how it is drawn. */
export const GRID = "grid";         /* the ground, and its distance rings   */
export const AXIS = "axis";         /* the optical axis                     */
export const CAMERA = "camera";     /* the body and the barrel              */
export const FRUSTUM = "frustum";   /* what the sensor can see              */
export const FOCUS = "focus";       /* the plane in focus                   */
export const DOF = "dof";           /* the near and far limits of sharpness */
export const OBJECT = "object";     /* a subject, at its true distance      */
export const SUBJECT = "subject";   /* one inside the depth of field        */
export const LIGHT = "light";       /* a lamp                               */
export const SKY = "sky";           /* the ambient dome, when that is the light */
export const KINDS = [GRID, AXIS, CAMERA, FRUSTUM, FOCUS, DOF, OBJECT, SUBJECT, LIGHT, SKY];

const seg = (s, a, b, k) => { s.segs.push({ a, b, kind: k }); };
const label = (s, at, k, text) => { s.labels.push({ at, kind: k, text }); };

/* A circle of `n` chords about `c`, spanned by two perpendicular axes. Three of
   these make a readable wireframe sphere; a solid one would hide the objects
   behind it, which is the opposite of what this view is for. */
function ring(s, c, u, w, r, n, k) {
  let prev = v.add(c, v.scale(u, r));
  for (let i = 1; i <= n; i++) {
    const t = (TWO_PI * i) / n;
    const p = v.add(c, v.add(v.scale(u, r * Math.cos(t)), v.scale(w, r * Math.sin(t))));
    seg(s, prev, p, k);
    prev = p;
  }
}

function sphereWire(s, c, r, k) {
  ring(s, c, v.v3(1, 0, 0), v.v3(0, 0, 1), r, 20, k);   /* horizontal */
  ring(s, c, v.v3(1, 0, 0), v.v3(0, 1, 0), r, 20, k);
  ring(s, c, v.v3(0, 1, 0), v.v3(0, 0, 1), r, 20, k);
}

/* A rectangle perpendicular to the view axis at distance d, sized to what the
   sensor sees there -- so a plane's WIDTH is the field of view, drawn to scale
   rather than annotated. */
function planeAt(s, d, halfW, halfH, k) {
  const a = v.v3(-halfW, -halfH, -d), b = v.v3(halfW, -halfH, -d);
  const c = v.v3(halfW, halfH, -d), e = v.v3(-halfW, halfH, -d);
  seg(s, a, b, k); seg(s, b, c, k); seg(s, c, e, k); seg(s, e, a, k);
}

/* Build the segment list from the DESCRIPTION, not from the built scene, so the
   diagram responds to a control before a render has finished. `lens` may be
   null before one exists. */
export function build(d, lens, sensorWMm, sensorHMm, cocLimitMm) {
  const s = { segs: [], labels: [], nearM: 0, farM: 0, hyperfocalM: 0 };

  /* How far out to draw. Governed by the furthest thing that matters, so the
     view frames itself instead of needing a zoom every time the scene or the
     focus changes. */
  let reach = 8.0;
  for (const o of d.objects) if (-o.centre.z > reach) reach = -o.centre.z;
  if (reach > 14.0) reach = 14.0;

  /* ---- the ground, ruled every metre ----
     Kept narrow. A wide floor is mostly empty and pulls the eye away from the
     thing being explained. */
  const ground = -0.75;
  const halfw = 1.6;
  const gridReach = reach > 8.0 ? 8.0 : reach;
  for (let x = -halfw; x <= halfw + 0.001; x += 0.8) {
    seg(s, v.v3(x, ground, 0.4), v.v3(x, ground, -gridReach), GRID);
  }
  for (let z = 0; z <= gridReach + 0.001; z += 1.0) {
    seg(s, v.v3(-halfw, ground, -z), v.v3(halfw, ground, -z), GRID);
    if (z > 0.5 && z % 2 < 0.01) {
      label(s, v.v3(-halfw - 0.12, ground, -z), GRID, `${z.toFixed(0)}M`);
    }
  }

  seg(s, v.v3(0, 0, 0), v.v3(0, 0, -reach), AXIS);

  /* ---- the camera ---- */
  const bw = 0.09, bh = 0.065, bd = 0.10;
  const box = [
    [v.v3(-bw, -bh, bd), v.v3(bw, -bh, bd)], [v.v3(bw, -bh, bd), v.v3(bw, bh, bd)],
    [v.v3(bw, bh, bd), v.v3(-bw, bh, bd)], [v.v3(-bw, bh, bd), v.v3(-bw, -bh, bd)],
    [v.v3(-bw, -bh, 0), v.v3(bw, -bh, 0)], [v.v3(bw, -bh, 0), v.v3(bw, bh, 0)],
    [v.v3(bw, bh, 0), v.v3(-bw, bh, 0)], [v.v3(-bw, bh, 0), v.v3(-bw, -bh, 0)],
    [v.v3(-bw, -bh, bd), v.v3(-bw, -bh, 0)], [v.v3(bw, -bh, bd), v.v3(bw, -bh, 0)],
    [v.v3(bw, bh, bd), v.v3(bw, bh, 0)], [v.v3(-bw, bh, bd), v.v3(-bw, bh, 0)],
  ];
  for (const [a, b] of box) seg(s, a, b, CAMERA);
  label(s, v.v3(0, bh + 0.16, 0), CAMERA, "CAMERA");

  const barrelR = lens ? lens.epSemiApMm * 0.001 + 0.012 : 0.03;
  let barrelL = lens ? (lens.totalTrackMm + lens.eflMm) * 0.001 * 0.35 : 0.06;
  if (barrelL < 0.03) barrelL = 0.03;
  ring(s, v.v3(0, 0, 0), v.v3(1, 0, 0), v.v3(0, 1, 0), barrelR, 16, CAMERA);
  ring(s, v.v3(0, 0, -barrelL), v.v3(1, 0, 0), v.v3(0, 1, 0), barrelR, 16, CAMERA);
  for (let i = 0; i < 4; i++) {
    const t = (TWO_PI * i) / 4;
    const o = v.v3(barrelR * Math.cos(t), barrelR * Math.sin(t), 0);
    seg(s, o, v.v3(o.x, o.y, -barrelL), CAMERA);
  }

  if (!lens) return s;

  /* ---- what the sensor can see ---- */
  const tanH = (sensorWMm * 0.5) / lens.eflMm;
  const tanV = (sensorHMm * 0.5) / lens.eflMm;
  planeAt(s, reach, reach * tanH, reach * tanV, FRUSTUM);
  for (let i = 0; i < 4; i++) {
    const sx = i === 0 || i === 3 ? -1 : 1;
    const sy = i < 2 ? -1 : 1;
    seg(s, v.v3(0, 0, 0), v.v3(sx * reach * tanH, sy * reach * tanV, -reach), FRUSTUM);
  }

  /* ---- focus, and the slab either side of it that counts as sharp ---- */
  const f = lens.focusDistanceM;
  if (Number.isFinite(f) && f > 0 && f <= reach) {
    planeAt(s, f, f * tanH, f * tanV, FOCUS);
    label(s, v.v3(f * tanH * 1.08, f * tanV * 0.9, -f), FOCUS, `FOCUS ${f.toFixed(2)}M`);
  }

  const dofRes = LENS.dof(lens, cocLimitMm);
  let nr = 0, fr = 0;
  if (dofRes) {
    nr = dofRes.near; fr = dofRes.far;
    s.nearM = nr; s.farM = fr;
    s.hyperfocalM = LENS.hyperfocalM(lens, cocLimitMm);

    /* The three planes crowd together whenever the depth of field is shallow,
       so their labels are staggered vertically -- stacked on one line they
       overprint exactly when the numbers matter most. */
    if (nr > 0.02 && nr <= reach) {
      planeAt(s, nr, nr * tanH, nr * tanV, DOF);
      label(s, v.v3(-nr * tanH * 1.08, -nr * tanV * 0.9, -nr), DOF, `NEAR ${nr.toFixed(2)}M`);
    }
    if (Number.isFinite(fr) && fr <= reach) {
      planeAt(s, fr, fr * tanH, fr * tanV, DOF);
      label(s, v.v3(-fr * tanH * 1.08, fr * tanV * 0.9, -fr), DOF, `FAR ${fr.toFixed(2)}M`);
    }
    if (nr > 0.02 && Number.isFinite(fr) && fr <= reach) {
      for (let i = 0; i < 4; i++) {
        const sx = i === 0 || i === 3 ? -1 : 1;
        const sy = i < 2 ? -1 : 1;
        seg(s, v.v3(sx * nr * tanH, sy * nr * tanV, -nr),
               v.v3(sx * fr * tanH, sy * fr * tanV, -fr), DOF);
      }
    }
  }

  /* ---- the subjects, at the distances the description says ---- */
  for (const o of d.objects) {
    if (o.kind === "plane") continue;
    /* Marked means INSIDE THE DEPTH OF FIELD: between the near and far limits
       the same dof() draws its slab at. Every subject in the slab is marked, on
       axis or not -- the slab and the marks are then one statement rather than
       two, and a subject sitting visibly inside the drawn planes can never come
       out unmarked.

       This is defocus only, which is what depth of field has always meant. It
       is NOT the whole of how sharp a subject looks: off axis an uncorrected
       doublet adds coma and astigmatism that no depth-of-field formula knows
       about, so a marked subject near the frame edge can still be soft in the
       render.

       The C's panel reports lens.spotMm for the SELECTED subject, which is the
       honest answer for one. This page has no selection, so it has no such row
       and the rendered image is the only place the discrepancy shows -- which
       it does, plainly, and a test pins it. Do not read this mark as a promise
       about the corners. */
    const dist = -o.centre.z;
    const sharp = !!dofRes && dist >= nr && dist <= fr;
    sphereWire(s, o.centre, o.radius, sharp ? SUBJECT : OBJECT);
    /* A dropped line to the ground: a sphere floating in a perspective view has
       no readable depth on its own. */
    seg(s, o.centre, v.v3(o.centre.x, ground, o.centre.z), GRID);
    label(s, v.v3(o.centre.x, o.centre.y + o.radius + 0.14, o.centre.z),
          sharp ? SUBJECT : OBJECT, o.name);
  }

  /* ---- the lamps ---- */
  for (const l of d.lights) {
    /* Under AMBIENT the lamps emit nothing, so they are drawn as ordinary
       objects rather than as sources. Still drawn: losing them off the screen
       would make switching modes feel like deleting them. */
    const off = d.lightMode === AMBIENT;
    const k = off ? OBJECT : LIGHT;

    if (l.kind === "rect") {
      const u = l.sizeU * 0.5, w = l.sizeV * 0.5;
      const a = v.v3(l.centre.x - u, l.centre.y, l.centre.z - w);
      const b = v.v3(l.centre.x + u, l.centre.y, l.centre.z - w);
      const c = v.v3(l.centre.x + u, l.centre.y, l.centre.z + w);
      const e = v.v3(l.centre.x - u, l.centre.y, l.centre.z + w);
      seg(s, a, b, k); seg(s, b, c, k); seg(s, c, e, k); seg(s, e, a, k);
      /* An X across it, so a rect lamp seen edge-on is still visible. */
      seg(s, a, c, k); seg(s, b, e, k);
    } else {
      ring(s, l.centre, v.v3(1, 0, 0), v.v3(0, 0, 1), l.radius, 14, k);
      ring(s, l.centre, v.v3(1, 0, 0), v.v3(0, 1, 0), l.radius, 14, k);
    }
    /* Rays leaving it, so a lamp reads as a source rather than as an object.
       Length is fixed rather than scaled by flux: a 20000 lm lamp would
       otherwise fill the view. */
    for (let r = 0; r < 6; r++) {
      const t = (TWO_PI * r) / 6;
      const dir = v.v3(Math.cos(t) * 0.7, -0.7, Math.sin(t) * 0.7);
      const r0 = l.kind === "rect" ? 0 : l.radius;
      seg(s, v.add(l.centre, v.scale(dir, r0)), v.add(l.centre, v.scale(dir, r0 + 0.16)), k);
    }
    seg(s, l.centre, v.v3(l.centre.x, ground, l.centre.z), GRID);
    label(s, v.v3(l.centre.x, l.centre.y + 0.20, l.centre.z), k,
          off ? `${l.name} OFF` : `${l.name} ${l.fluxLm.toFixed(0)}LM`);
  }

  /* ---- the dome ----

     Drawn as strokes coming INWARD from every direction, not as a surface. A
     uniform sky is infinitely far away, so any drawn radius is a lie about a
     distance -- and a wireframe hemisphere at a plausible radius reads as a
     wall around the set, which is the one thing it is not. The strokes say the
     only true thing there is to say: light arrives from everywhere, from no
     particular place.

     Two faint latitude rings, and no meridians. The meridians were the lines
     that ran off the edge of the canvas and turned the diagram into a cage. */
  if (d.lightMode === AMBIENT) {
    const c = v.v3(0, ground + 0.7, -gridReach * 0.42);
    const R = 2.9;

    for (let i = 0; i < 2; i++) {
      const el = 0.30 + 0.55 * i;
      ring(s, v.v3(c.x, c.y + R * Math.sin(el), c.z), v.v3(1, 0, 0), v.v3(0, 0, 1),
           R * Math.cos(el), 32, SKY);
    }
    /* Arriving light. Elevations stepped by a coprime stride so the strokes do
       not line up into a band at one height. */
    for (let i = 0; i < 16; i++) {
      const t = (TWO_PI * i) / 16;
      const el = 0.12 + 0.30 * ((i * 7) % 5);
      const dir = v.v3(Math.cos(el) * Math.cos(t), Math.sin(el), Math.cos(el) * Math.sin(t));
      const p0 = v.add(c, v.scale(dir, R));
      const p1 = v.add(c, v.scale(dir, R - 0.42));
      seg(s, p0, p1, SKY);
      /* A head on the inward end, so it reads as arriving rather than as
         leaving. */
      const side = v.normalize(v.cross(dir, v.v3(0, 1, 0)));
      seg(s, p1, v.add(v.add(p1, v.scale(dir, 0.16)), v.scale(side, 0.07)), SKY);
      seg(s, p1, v.add(v.add(p1, v.scale(dir, 0.16)), v.scale(side, -0.07)), SKY);
    }
    /* On the lower ring rather than over the pole: the pole is off the top of
       the canvas at the default framing, and a label you have to orbit to find
       is not a label. */
    label(s, v.v3(c.x + R * Math.cos(0.30) * 0.72, c.y + R * Math.sin(0.30),
                  c.z + R * Math.cos(0.30) * 0.72), SKY,
          `SKY ${d.ambientLux.toFixed(0)} LX`);
  }

  return s;
}
