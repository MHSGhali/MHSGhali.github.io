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

import { TWO_PI } from "../light/core.js?v=58764426";
import * as v from "../light/vec3.js?v=58764426";
import * as LENS from "./lens.js?v=58764426";
import { AMBIENT } from "./scenedesc.js?v=58764426";

/* What a segment is FOR, which is what decides how it is drawn. */
export const GRID = "grid";         /* the ground, and its distance rings   */
export const AXIS = "axis";         /* the optical axis                     */
export const CAMERA = "camera";     /* the body and the barrel              */
export const FRUSTUM = "frustum";   /* what the sensor can see              */
export const FOCUS = "focus";       /* the plane in focus                   */
export const DOF = "dof";           /* the near and far limits of sharpness */
export const OBJECT = "object";     /* a subject, at its true distance      */
export const SUBJECT = "subject";   /* one the camera actually resolves     */
export const BEST = "best";         /* the sharpest thing in frame, whether  */
                                    /* or not it met the criterion           */
export const LIGHT = "light";       /* a lamp                               */
export const SKY = "sky";           /* the ambient dome, when that is the light */
export const KINDS = [GRID, AXIS, CAMERA, FRUSTUM, FOCUS, DOF, OBJECT, SUBJECT, BEST, LIGHT, SKY];

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

  /* Solved before anything is drawn, because the depth of field is one of the
     things that decides HOW FAR OUT to draw. */
  const dofRes = lens ? LENS.dof(lens, cocLimitMm) : null;

  /* How far out to draw. Governed by the furthest thing that matters, so the
     view frames itself instead of needing a zoom every time the scene or the
     focus changes.

     The depth of field counts as one of those things. It used to not, and the
     far limit simply vanished whenever it fell past the objects: at 100 mm and
     f/5 focused at 5 m the range is 3.36 m to 9.77 m, and with the axis stopping
     at 8 m the diagram drew AXIS NEAR and nothing else -- which reads as a range
     that stops there rather than one that runs off the end of the picture.

     Past LIMIT the far end is not drawn to scale, because making room for it
     would squeeze the camera and the targets into a few pixels to accommodate a
     single line. It gets an arrow and its real value instead. */
  const LIMIT = 14.0;
  let reach = 8.0;
  for (const o of d.objects) if (-o.centre.z > reach) reach = -o.centre.z;
  if (dofRes) {
    for (const end of [dofRes.near, dofRes.far]) {
      if (Number.isFinite(end) && end > reach) reach = end * 1.06;
    }
  }
  if (reach > LIMIT) reach = LIMIT;

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
    /* "FILM SET FOR", not "FOCUS": this plane is where the film is placed, and
       a bare "FOCUS 1.00M" reads as a claim that the thing at 1 m is the sharp
       one. Off axis it frequently is not. */
    /* Top RIGHT. The depth-of-field box puts its two labels on the left-hand
       corners, so the three cannot collide however shallow the range gets. */
    label(s, v.v3(f * tanH * 1.10, f * tanV * 1.28, -f), FOCUS, `FILM SET FOR ${f.toFixed(2)}M`);
  }

  let nr = 0, fr = 0;
  if (dofRes) {
    nr = dofRes.near; fr = dofRes.far;
    s.nearM = nr; s.farM = fr;
    s.hyperfocalM = LENS.hyperfocalM(lens, cocLimitMm);

    /* THE BOX, restored from viewer/scene3d.c -- the near and far cross-sections
       of the frustum, joined at the corners.

       It was replaced with ticks on the axis for a while, because a box says
       "everything in this volume is sharp" and the number behind it is paraxial,
       ON AXIS and from defocus alone. That objection was really an objection to
       the SCENE: the targets were strung across the frame, so most of them sat
       far off axis where an uncorrected doublet's coma decides the answer and
       the box was pointing at the wrong ball. They now sit on a ring at one
       small field radius, well inside the box's walls, and the box points at the
       right one. The per-target SPOT is still the authority on what the camera
       resolves -- that is what the highlight and the label follow -- and this is
       the textbook figure drawn to scale beside it.

       AN OPEN END MEANS IT KEEPS GOING. The face is drawn only where the limit
       is; past the hyperfocal distance there is no far face, because there is no
       far limit. A closed box that stopped at the edge of the picture would be
       claiming an end the calculation never gave. */
    const face = (dist) => planeAt(s, dist, dist * tanH, dist * tanV, DOF);
    const corners = (dist) => [
      v.v3(-dist * tanH, -dist * tanV, -dist), v.v3(dist * tanH, -dist * tanV, -dist),
      v.v3(dist * tanH, dist * tanV, -dist), v.v3(-dist * tanH, dist * tanV, -dist),
    ];
    const walls = (fromD, toD) => {
      const a = corners(fromD), b = corners(toD);
      for (let i = 0; i < 4; i++) seg(s, a[i], b[i], DOF);
    };
    /* An open arrowhead on the axis, for the case where NONE of the range is in
       the picture and there is no box to draw at all. */
    const arrow = (dist) => {
      const r = dist * tanV * 0.10;
      for (const [ax, ay] of [[-0.6, 0], [0.6, 0], [0, -0.6], [0, 0.6]]) {
        seg(s, v.v3(ax * r, ay * r, -dist + r * 0.9), v.v3(0, 0, -dist), DOF);
      }
      return r;
    };

    const m = (x) => `${x.toFixed(x < 100 ? 2 : 0)}M`;
    const nearAtLens = nr <= 0.02;
    const nearIn = !nearAtLens && nr <= reach;
    const farIn = Number.isFinite(fr) && fr <= reach;
    const anyIn = nearAtLens || nearIn;

    if (nearIn) {
      face(nr);
      /* Labels on the box's own corners rather than on the axis. On the axis
         they landed in the middle of the targets, and at a shallow depth of
         field NEAR, FAR, the focus plane and two target labels all overprinted
         within a centimetre of each other. Opposite corners, so the two cannot
         collide with each other however close the limits get. */
      label(s, v.v3(-nr * tanH * 1.10, -nr * tanV * 1.28, -nr), DOF, `NEAR ${m(nr)}`);
    }
    if (anyIn && farIn) {
      face(fr);
      label(s, v.v3(-fr * tanH * 1.10, fr * tanV * 1.28, -fr), DOF, `FAR ${m(fr)}`);
    }
    if (anyIn && !farIn) {
      /* No far face: the range runs past the edge of the picture, or past the
         hyperfocal distance, where it does not end at all. */
      label(s, v.v3(-reach * tanH * 1.10, reach * tanV * 1.28, -reach), DOF,
        `FAR ${Number.isFinite(fr) ? m(fr) : "INFINITY"}`);
    }
    if (anyIn) walls(nearAtLens ? 0.02 : nr, farIn ? fr : reach);
    else if (nr > reach) {
      /* The whole range is past the end of the axis -- focus far enough out and
         it is. Nothing on screen is within it, so nothing on screen may be drawn
         as though it were: an arrow out of the picture, and both numbers in
         words. */
      const r = arrow(reach);
      label(s, v.v3(0, r + reach * tanV * 0.12, -reach), DOF,
        `AXIS SHARP ${m(nr)} TO ${Number.isFinite(fr) ? m(fr) : "INFINITY"}`);
    }
  }

  /* ---- the subjects, at the distances the description says ----

     Spots are measured for ALL of them first, because the most useful single
     thing this view can say is which one the camera resolves best, and that
     cannot be known one object at a time. */
  const spots = new Map();
  let bestObj = null;
  for (const o of d.objects) {
    if (o.kind === "plane") continue;
    const sp = LENS.spotMm(lens, -o.centre.z, Math.hypot(o.centre.x, o.centre.y), 15);
    spots.set(o, sp);
    if (Number.isFinite(sp) && (!bestObj || sp < spots.get(bestObj))) bestObj = o;
  }

  for (const o of d.objects) {
    if (o.kind === "plane") continue;
    /* Marked means THE TRACED SPOT IS INSIDE THE SHARPNESS LIMIT -- the real
       one, through the real glass, at this subject's real field position.

       NOT "inside the depth-of-field slab", which is what this used to be and
       which made the diagram disagree with the picture beside it. Depth of
       field is a paraxial, ON-AXIS statement from defocus alone, and off axis
       an uncorrected doublet's coma and astigmatism can dwarf defocus entirely.
       At 25 mm with the achromat scaled down, focused at 1 m, the 1 m target
       sits 8 degrees off axis: the slab calls its defocus exactly zero while
       the trace puts its spot at 0.114 mm -- the WORST of the five -- and the
       2 m target, which is the only one on the axis, comes out sharpest at
       0.052 mm. The render showed that plainly and the diagram contradicted it.

       So the slab is still drawn, because it is a real quantity and the number
       every depth-of-field table gives; its labels now say AXIS. What is marked
       is what the camera actually resolves. Where the two disagree you can see
       both, which is the whole point of having a diagram beside a render. */
    const dist = -o.centre.z;
    const spot = spots.get(o);
    const sharp = Number.isFinite(spot) && spot <= cocLimitMm;
    /* THE SHARPEST THING IN FRAME IS ALWAYS MARKED, whether or not it met the
       criterion. "Nothing qualifies" leaves the view with no highlight at all,
       and the strongest visual left is then the focus plane -- which sits at
       the distance the FILM is set for and says nothing about what the lens
       resolves there. A visitor reads that plane as the answer.

       It is not the answer. At 25 mm focused at 1 m the plane lands on the 1 m
       target while the camera resolves the 2 m one twice as well, and with the
       sharpness limit set tight enough that neither qualifies, the diagram was
       pointing at the wrong ball with nothing on screen to contradict it. */
    const best = o === bestObj;
    sphereWire(s, o.centre, o.radius, sharp ? SUBJECT : best ? BEST : OBJECT);
    /* A dropped line to the ground: a sphere floating in a perspective view has
       no readable depth on its own. */
    seg(s, o.centre, v.v3(o.centre.x, ground, o.centre.z), GRID);
    /* The spot goes IN THE LABEL, not just into the highlight colour. A binary
       mark has one bad case and this scene lands on it: the shipped achromat
       leaves 0.032 mm of spherical aberration wide open, a hair over the
       0.030 mm the sharpness criterion asks for, so at the default settings
       nothing qualifies and nothing would be marked -- while the picture beside
       it obviously has one target sharper than the rest. A number is never
       wrong in that way: 0.03 against 0.38 says which one the camera is
       resolving even when neither has met the standard. */
    const size = Number.isFinite(spot)
      ? `${o.name} ${spot < 0.1 ? spot.toFixed(3) : spot.toFixed(2)}MM${best ? " SHARPEST" : ""}`
      : o.name;
    /* PUSHED OUT ALONG THE RING, not stacked above the target.

       Every label used to sit directly over its own sphere, which was fine
       while the targets were strung across the frame and read left to right.
       On a ring they are five points around one small circle, so five labels
       hung above them landed in a heap in the middle of the picture -- with the
       focus plane's label and the depth-of-field limits in the same heap.

       Each one now moves radially outward from the axis, in its own target's
       direction, by an amount that grows with distance so the fan opens up
       rather than converging toward the vanishing point. The five clock
       positions then carry the five labels apart from each other, and all of
       them away from the axis where the focus plane lives. */
    const out = Math.hypot(o.centre.x, o.centre.y);
    const push = o.radius + 0.10 + 0.085 * dist;
    const at = out > 1e-6
      ? v.v3(o.centre.x * (1 + push / out), o.centre.y * (1 + push / out), o.centre.z)
      : v.v3(o.centre.x, o.centre.y + push, o.centre.z);
    label(s, at, sharp ? SUBJECT : best ? BEST : OBJECT, size);
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
