/* The homepage background: a Strandbeest walking, in 3D, casting shadows.

   Three Jansen legs hang from one crankshaft, evenly spaced around the turn.
   Each leg is a separate mechanism run by the real solver, exactly as the
   linkage tool runs one; three of them cost well under a twentieth of a
   millisecond a frame, so there was no reason to bake it.

   Three is a deliberately open silhouette, not a walkable count: the leg's
   duty factor is about 20% (gait() measures it), so it takes six legs before
   some foot is always planted, and with three the creature is off the ground
   for roughly two fifths of the turn. Nothing here simulates weight -- the
   body is carried forwards at the stance rate regardless -- so the cost is
   only that the gait no longer reads as load-bearing, and what is bought is
   legs you can see through instead of a thicket of them.

   WHY THE CREATURE MOVES. During its stance a foot travels backwards relative
   to the body, so a body carried forwards at the same rate leaves the planted
   foot standing still on the ground -- which is what walking is. The rate
   comes from the leg itself (see gait() in jansen.js), not from a number
   chosen to look right. The camera travels with it and the ground is
   featureless, so the position is wrapped periodically; nothing on screen can
   tell, and it keeps the coordinates small however long the tab is left open.

   three.js is imported from a pinned URL rather than through an import map:
   the map on the tool pages exists only because OrbitControls and friends
   import the bare specifier "three" internally, and nothing here loads an
   addon. If the import fails -- offline, blocked CDN -- the page simply has no
   background, which is why this is a background and not the content.

   It stops when it is not being looked at: under prefers-reduced-motion, when
   the tab is hidden, and when it is scrolled out of view. */

const THREE_URL = "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js";

import * as M from "./linkage/mechanism.js?v=408e651f";
import * as S from "./linkage/solver.js?v=408e651f";
import { buildLeg, gait, legExtent } from "./walker/jansen.js?v=408e651f";
import { sweptBox, fitCamera } from "./walker/framing.js?v=408e651f";

const LEGS = 3;
const LEG_SPACING = 52;          /* along the crankshaft */
const CRANK_DEG_S = 46;          /* a slow walk: one stride every eight seconds */
const WRAP = 4000;               /* invisible: the ground carries no features */

/* Framing the WHOLE swept box was the honest reading of "keep it on screen",
   and it made the creature unreadable: legs 52 apart, fitted end to end,
   superimpose into a grey knot at the size that leaves. Nothing is lost by
   letting the far end of the crankshaft run past the edge -- the walking is in
   the near legs, and the shaft is a straight line either way -- so `fill` goes
   past 1 and the creature is framed on the legs instead of on its envelope.
   tests/framing.test.mjs pins how far past the edge that is allowed to go. */
const FRAMING = { fillX: 1.22, fillY: 0.88 };


const host = document.querySelector("[data-hero-walkers]");
/* A failure here costs the page nothing but the decoration, so it must never
   reach the visitor -- but swallowing it silently makes it invisible to
   whoever has to fix it, so it goes to the console. */
if (host) start(host).catch((err) => console.warn("hero walkers:", err));

async function start(host) {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  const THREE = await import(THREE_URL);

  const G = gait();
  const speedRad = (CRANK_DEG_S * Math.PI) / 180;
  const box = sweptBox(legExtent(), LEGS, LEG_SPACING);
  /* Depends only on the aspect ratio, so it is solved on resize, not per frame. */
  let framing = fitCamera(box, 1, FRAMING);

  /* ---- the creature: three legs on one crankshaft --------------------- */
  const legs = [];
  for (let n = 0; n < LEGS; n++) {
    const { mechanism, id } = buildLeg(CRANK_DEG_S, 1);
    /* Evenly spaced around the crank turn. accumulatedAngleRad is the motor's
       own state, so setting it here is exactly what a phase offset is. */
    mechanism.links[0].accumulatedAngleRad = (n / LEGS) * 2 * Math.PI;
    S.solveAtCurrentAngle(mechanism, S.defaultParams());
    legs.push({ mechanism, id, z: (n - (LEGS - 1) / 2) * LEG_SPACING });
  }
  const params = S.defaultParams();

  /* ---- scene --------------------------------------------------------- */
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 1, 3000);
  /* preserveDrawingBuffer, and it is not optional here. With the default
     (false) a WebGL drawing buffer's contents are UNDEFINED once it has been
     composited: render a single frame and the canvas shows it for one
     composite and then goes blank. That is invisible while an animation loop
     is repainting every frame, and fatal the moment the loop stops -- under
     prefers-reduced-motion, in a background tab, or when the hero scrolls out
     of view -- which is exactly the "appears for a split second, then
     vanishes" this had. A still background has to stay still on screen. */
  const renderer = new THREE.WebGLRenderer({
    antialias: true, alpha: true, preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.appendChild(renderer.domElement);

  const creature = new THREE.Group();
  scene.add(creature);

  /* Shared geometry, scaled per part per frame: the topology never changes, so
     allocating per frame would churn the GPU for nothing. */
  const rodGeom = new THREE.CylinderGeometry(1, 1, 1, 10);
  rodGeom.rotateX(Math.PI / 2);                    /* stand it along +Z */
  const jointGeom = new THREE.SphereGeometry(1, 12, 8);
  const ROD_R = 1.15, JOINT_R = 1.9;

  /* The floor fades out radially. A shadow can only darken something already
     drawn, so catching one needs a lit surface -- but a plain plane is a slab
     with a hard horizon across the hero, obvious in light mode where it sits
     over the text. An alpha map takes it from solid under the creature to
     nothing a leg-length away: the shadows land on something, and there is no
     edge anywhere to see. */
  function radialFade() {
    const size = 256;
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d");
    const grad = g.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
    grad.addColorStop(0.00, "#fff");
    grad.addColorStop(0.45, "#fff");
    grad.addColorStop(1.00, "#000");
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.NoColorSpace;
    return tex;
  }

  const mat = {
    rod: new THREE.MeshStandardMaterial({ metalness: 0.5, roughness: 0.45 }),
    crank: new THREE.MeshStandardMaterial({ metalness: 0.7, roughness: 0.3 }),
    joint: new THREE.MeshStandardMaterial({ metalness: 0.3, roughness: 0.6 }),
    ground: new THREE.MeshStandardMaterial({
      roughness: 1, metalness: 0, transparent: true, alphaMap: radialFade(),
      depthWrite: false,
    }),
  };

  /* One mesh per rod and per joint, for every leg. */
  const parts = [];
  for (const leg of legs) {
    for (let li = 0; li < leg.mechanism.links.length; li++) {
      const l = leg.mechanism.links[li];
      if (!l.alive) continue;
      for (let i = 0; i < l.connectorIds.length; i++) {
        for (let j = i + 1; j < l.connectorIds.length; j++) {
          const mesh = new THREE.Mesh(rodGeom, l.isDriven ? mat.crank : mat.rod);
          mesh.castShadow = true;
          creature.add(mesh);
          parts.push({ leg, a: l.connectorIds[i], b: l.connectorIds[j], mesh });
        }
      }
    }
    for (const cid of Object.values(leg.id)) {
      const mesh = new THREE.Mesh(jointGeom, mat.joint);
      mesh.scale.setScalar(JOINT_R);
      mesh.castShadow = true;
      mesh.position.z = leg.z;
      creature.add(mesh);
      leg.jointMeshes = leg.jointMeshes || [];
      leg.jointMeshes.push({ cid, mesh });
    }
  }

  /* The chassis: two beams down the length of the creature, through the crank
     centres and through the fixed pivots. Without them the legs read as
     separate machines rather than as one animal. */
  const spine = [];
  for (const key of ["O", "G"]) {
    const mesh = new THREE.Mesh(rodGeom, mat.rod);
    mesh.castShadow = true;
    creature.add(mesh);
    spine.push({ key, mesh });
  }

  /* ---- ground and light ---------------------------------------------- */
  /* Sized to the creature, not the world: the fade has to happen within the
     plane, so a huge one would put the fade off in the distance and bring the
     slab back. */
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(620, 620), mat.ground);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = G.footLow;
  ground.receiveShadow = true;
  scene.add(ground);

  const key = new THREE.DirectionalLight(0xffffff, 2.1);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  /* The shadow camera travels with the creature, so it only ever has to cover
     the creature itself and can stay tight enough for a crisp shadow. */
  const R = LEGS * LEG_SPACING * 0.75;
  Object.assign(key.shadow.camera, { left: -R, right: R, top: R, bottom: -R, near: 1, far: 900 });
  key.shadow.bias = -0.0012;
  key.shadow.normalBias = 0.6;
  scene.add(key, key.target);

  const fill = new THREE.DirectionalLight(0xffffff, 0.7);
  fill.position.set(-180, 90, -140);
  scene.add(fill);
  const ambient = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambient);

  /* ---- theme ---------------------------------------------------------- */
  /* Declared here rather than with the layout code below: applyTheme() runs
     during setup and marks the scene dirty, and a `let` further down would
     still be in its temporal dead zone by then. */
  let w = 0, h = 0, dirty = true, ready = false;

  /* How far the visitor has turned the view, in radians. Pitch is clamped
     short of the ground plane and of straight overhead, where the up vector
     degenerates and the view flips. */
  /* Not zero. At yaw 0 the camera looks straight down the crankshaft and the
     legs stack into one silhouette -- the creature reads as a knot of grey
     sticks rather than as something with legs, and no amount of zoom fixes it
     because the problem is the angle. Turning it three-quarters on fans the
     legs out along the shaft, which is the view a Strandbeest is recognisable
     from. The visitor can still drag it anywhere from here. */
  const orbit = { yaw: 0.72, pitch: 0.2 };
  const PITCH_LIMIT = 0.62;
  const AXIS_Y = new THREE.Vector3(0, 1, 0);
  const tmpQ1 = new THREE.Quaternion(), tmpQ2 = new THREE.Quaternion();
  const tmpV3 = new THREE.Vector3();
  const eyeRel = new THREE.Vector3(), atRel = new THREE.Vector3();

  function applyTheme() {
    const cs = getComputedStyle(document.documentElement);
    const pick = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
    const light = document.documentElement.getAttribute("data-theme") === "light";
    mat.rod.color.set(pick("--text-faint", "#858585"));
    mat.crank.color.set(pick("--text", "#e9e9e9"));
    mat.joint.color.set(pick("--text-dim", "#a1a1a1"));
    /* The ground is drawn, not transparent: a shadow can only darken what is
       already there, and on a near-black page there is nothing to darken. */
    /* The floor takes the PAGE's own background colour, not a raised surface
       colour: it is lit, so whatever colour it is gets multiplied up by the key
       light, and anything lighter than the page to begin with becomes a glare
       behind the creature rather than a floor under it. Starting from the page
       colour, the key lifts it just clear of the page and the shadow drops it
       just below -- which is all a shadow on a near-black page can be. */
    mat.ground.color.set(pick("--bg", light ? "#ffffff" : "#0a0a0a"));
    mat.ground.opacity = light ? 0.85 : 1;
    ambient.intensity = light ? 0.5 : 0.4;
    key.intensity = light ? 1.8 : 1.5;
    draw();
  }
  applyTheme();
  window.addEventListener("themechange", applyTheme);

  /* Re-solved whenever the shape of the viewport or the angle of the view
     changes -- both alter what the frustum has to hold.

     The default framing pushes the creature right of centre so that it walks
     beside the headline rather than under it. On a phone main.css takes it out
     from behind the text entirely and gives it a band of its own; there is
     nothing to dodge there, and a creature still leaning right only looks
     off-centre. Asking the stylesheet which layout it chose -- an absolute
     backdrop is positioned, a band in the flow is static -- means the two
     cannot disagree about where that breakpoint is. */
  function refit() {
    const inBand = getComputedStyle(host).position === "static";
    framing = fitCamera(box, camera.aspect, {
      ...FRAMING, yaw: orbit.yaw, pitch: orbit.pitch,
      ...(inBand ? { bias: 0 } : null),
    });
  }

  /* ---- painting -------------------------------------------------------
     Every repaint goes through here, including the ones that happen while the
     animation loop is NOT running. Resizing the renderer resizes the drawing
     buffer, which CLEARS it -- so a resize that only sets a dirty flag leaves
     a blank canvas until the next animated frame, and under
     prefers-reduced-motion, a hidden tab or a scrolled-away hero there is no
     next frame. That is a blank background, not a still one. */
  function draw() {
    if (!ready) return;
    place();
    renderer.render(scene, camera);
    dirty = false;
  }

  /* ---- layout --------------------------------------------------------- */
  function resize() {
    const rect = host.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    w = rect.width; h = rect.height;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    refit();
    draw();
  }
  new ResizeObserver(resize).observe(host);
  resize();

  /* ---- dragging to look round ------------------------------------------

     Pointer Events, so a mouse, a trackpad, a pen and a finger all arrive
     through one path. Capture on the canvas means a drag that wanders off it
     -- over the headline, out of the window -- keeps turning rather than
     sticking, and still ends cleanly.

     touch-action is pan-y (set in CSS): a vertical swipe still scrolls the
     page, because a background decoration must never take a phone's scroll
     away from it. That leaves horizontal drags to turn the creature, which is
     the axis worth having. */
  const canvas = renderer.domElement;
  let drag = null;

  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = "grabbing";
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    /* Scale by the viewport, so the same gesture turns the creature by the
       same amount on a laptop and on a large display. */
    orbit.yaw -= ((e.clientX - drag.x) / Math.max(w, 1)) * Math.PI * 1.1;
    orbit.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT,
      orbit.pitch - ((e.clientY - drag.y) / Math.max(h, 1)) * Math.PI * 0.7));
    drag.x = e.clientX;
    drag.y = e.clientY;
    refit();
    /* Repaint immediately: under reduced motion the loop is not running, and
       a drag that does not redraw is a dead control. */
    draw();
  });

  const endDrag = (e) => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    if (e) canvas.releasePointerCapture?.(e.pointerId);
    drag = null;
    canvas.style.cursor = "grab";
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.style.cursor = "grab";

  /* ---- run ------------------------------------------------------------

     The only thing that stops this loop is the visitor's reduced-motion
     setting. It used to also gate on an IntersectionObserver and on
     document.hidden, and both were mistakes:

       - The browser ALREADY suspends requestAnimationFrame in a hidden tab.
         Gating on document.hidden as well bought nothing and added a state
         the loop could get stuck in.
       - The observer was worse. Whenever it reported the hero as not
         intersecting the loop stopped, and if that report was wrong -- or
         arrived before layout settled -- nothing ever started it again. The
         hero is at the top of the page; the work it was avoiding is a 0.05 ms
         solve and one draw call batch.

     A loop with one condition cannot get stuck in a state I can't see. */
  reduce.addEventListener?.("change", () => tick());
  const running = () => !reduce.matches;

  let theta = 0;          /* crank angle, the one input the creature has */
  let raf = 0, last = 0;

  function place() {
    /* Walk: the body advances at the rate the stance foot sweeps backwards. */
    const bodyX = ((-G.advancePerRadian * theta) % WRAP + WRAP) % WRAP;
    creature.position.x = bodyX;

    const va = new THREE.Vector3(), vb = new THREE.Vector3(), dir = new THREE.Vector3();
    const up = new THREE.Vector3(0, 0, 1), quat = new THREE.Quaternion();
    for (const p of parts) {
      const a = p.leg.mechanism.connectors[p.a].pos;
      const b = p.leg.mechanism.connectors[p.b].pos;
      va.set(a.x, a.y, p.leg.z);
      vb.set(b.x, b.y, p.leg.z);
      dir.subVectors(vb, va);
      const len = dir.length();
      p.mesh.position.copy(va).add(vb).multiplyScalar(0.5);
      if (len > 1e-9) {
        quat.setFromUnitVectors(up, dir.divideScalar(len));
        p.mesh.quaternion.copy(quat);
      }
      p.mesh.scale.set(ROD_R, ROD_R, Math.max(len, 1e-6));
    }
    for (const leg of legs) {
      for (const jm of leg.jointMeshes) {
        const q = leg.mechanism.connectors[jm.cid].pos;
        jm.mesh.position.set(q.x, q.y, leg.z);
      }
    }
    const half = ((LEGS - 1) / 2) * LEG_SPACING + LEG_SPACING * 0.6;
    for (const s of spine) {
      const q = legs[0].mechanism.connectors[legs[0].id[s.key]].pos;
      s.mesh.position.set(q.x, q.y, 0);
      s.mesh.quaternion.identity();
      s.mesh.scale.set(ROD_R * 1.5, ROD_R * 1.5, half * 2);
    }

    /* Camera and key light travel with the creature. Where to put the camera
       is solved in framing.js against the creature's own swept size and the
       viewport's shape, so it stays framed whether the hero is short and wide
       or tall and narrow -- a fixed offset that parks it nicely in one clips
       it clean out of frame in the other.

       Dragging orbits that whole rig about the CREATURE, turning the eye and
       the point it aims at together. Turning only the eye would swing the
       creature across the frame and out of it; turning both leaves the
       composition exactly where framing.js put it -- same distance, same
       position on screen -- and changes only the side you are looking from. */
    const cx = bodyX + box.cx, cy = box.cy;
    const qYaw = tmpQ1.setFromAxisAngle(AXIS_Y, orbit.yaw);
    const right = tmpV3.set(1, 0, 0).applyQuaternion(qYaw);
    const spin = tmpQ2.setFromAxisAngle(right, orbit.pitch).multiply(qYaw);

    eyeRel.set(framing.eye.x - box.cx, framing.eye.y - cy, framing.eye.z).applyQuaternion(spin);
    atRel.set(framing.at.x - box.cx, framing.at.y - cy, framing.at.z).applyQuaternion(spin);
    camera.position.set(cx + eyeRel.x, cy + eyeRel.y, eyeRel.z);
    camera.lookAt(cx + atRel.x, cy + atRel.y, atRel.z);
    ground.position.x = bodyX;
    key.position.set(bodyX + 190, 320, 200);
    key.target.position.set(bodyX, G.footLow, 0);
    key.target.updateMatrixWorld();
    dirty = true;
  }

  function tick(now) {
    raf = 0;
    if (!running()) { last = 0; return; }
    /* Guard against a second chain: every entry point below calls tick(), and
       two live chains advance the mechanism twice per frame. */
    /* Clamp dt: a backgrounded tab hands back multi-second gaps, and one huge
       step would jump the solver clean off the branch it is tracking. */
    const dt = last ? Math.min((now - last) / 1000, 1 / 20) : 1 / 60;
    if (now) last = now;
    theta += speedRad * dt;
    for (const leg of legs) S.advance(leg.mechanism, dt, params);
    place();
    renderer.render(scene, camera);
    dirty = false;
    raf = requestAnimationFrame(tick);
  }

  ready = true;
  draw();
  /* A second paint after layout has settled: the first resize() can land
     before the hero has its final size, and ResizeObserver's first callback is
     what corrects it. */
  requestAnimationFrame(() => { resize(); draw(); });
  tick();
}
