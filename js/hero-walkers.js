/* The homepage background: a Strandbeest walking, in 3D, casting shadows.

   It walks because it is held up. Five pins on one crankshaft, each carrying a
   mirrored PAIR of Jansen legs -- one reaching forwards, one back -- and a body
   with mass and rotational inertia that falls under gravity and is carried by
   whichever feet are touching the ground. Every leg is a separate mechanism run
   by the real solver, exactly as the linkage tool runs one.

   That is measured at about a millisecond a frame for the ten of them, and it
   is the one real cost here: the contact solve beside it is 0.013 ms, so this
   is very nearly all solver. It buys the thing the page is actually claiming --
   the background is the engine, not a recording of it -- and a millisecond of a
   sixteen millisecond frame is a price worth paying for that. Do not go looking
   for it in the iteration count: the solve converges on its own in five or six
   passes, well short of maxIters, and cutting it to four is worth 0.04 ms and
   costs three digits of the accuracy jansen.js claims.

   WHAT THIS USED TO BE, AND WHY IT CHANGED. Three legs all facing one way, and
   the whole creature slid forwards at `advancePerRadian` radians of crank -- the
   rate a planted foot sweeps backwards, so a planted foot stayed planted. The
   number was right and the creature was still skating: nothing was ever held up
   by anything. With a duty factor near 20% three legs leave it with no foot
   down at all for two fifths of every turn, which does not matter when nothing
   has weight and is fatal the moment something does.

   The leg layout, the body and the contact model are all in walker/, which
   imports no three.js and is therefore the part that can be driven by a test:
   creature.js says what the creature is and body.js carries it. This file
   draws it. tests/walker-physics.test.mjs is where "does it actually walk?"
   is answered in numbers.

   WHERE THE SPEED COMES FROM NOW. Nowhere. It is an output. The feet push, the
   body accelerates until the pushing balances, and what comes out has to agree
   with `advancePerRadian` -- which is no longer the thing that moves the
   creature but the prediction the physics has to reproduce. The slack in that
   agreement is real: Jansen's stance speed varies about a quarter either side
   of its mean, so planted feet genuinely fight each other and the loser scuffs.

   The camera travels with it and the ground is featureless, so the position is
   wrapped periodically; nothing on screen can tell, and it keeps the
   coordinates small however long the tab is left open. The wrap is anchored on
   the CAMERA and the creature placed relative to it, so the two can never wrap
   a frame apart and throw the creature across the screen.

   three.js is imported from a pinned URL rather than through an import map:
   the map on the tool pages exists only because OrbitControls and friends
   import the bare specifier "three" internally, and nothing here loads an
   addon. If the import fails -- offline, blocked CDN -- the page simply has no
   background, which is why this is a background and not the content.

   It stops when it is not being looked at: under prefers-reduced-motion, and
   when the tab is hidden (which the browser does for us). */

const THREE_URL = "https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js";

import { pairExtent } from "./walker/jansen.js?v=3d923acb";
import { sweptBox, fitCamera } from "./walker/framing.js?v=3d923acb";
import * as RNG from "./light/rng.js?v=3d923acb";
import { LAYOUT, PLANES, FRAMING, BUILD, buildCreature, advance, members }
  from "./walker/creature.js?v=3d923acb";

const { LEG_SPACING } = LAYOUT;
const WRAP = 4000;               /* invisible: the ground carries no features */


const host = document.querySelector("[data-hero-walkers]");
/* A failure here costs the page nothing but the decoration, so it must never
   reach the visitor -- but swallowing it silently makes it invisible to
   whoever has to fix it, so it goes to the console. */
if (host) start(host).catch((err) => console.warn("hero walkers:", err));

async function start(host) {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  const THREE = await import(THREE_URL);

  const extent = pairExtent();
  const box = sweptBox(extent, PLANES, LEG_SPACING);
  /* Depends only on the aspect ratio, so it is solved on resize, not per frame. */
  let framing = fitCamera(box, 1, FRAMING);

  /* ---- the creature ---------------------------------------------------
     Ten legs, one crankshaft and a body with weight, all of it built and run by
     walker/creature.js, which imports no three.js and is therefore the part a
     test can drive. Everything below this line is drawing. */
  const creatureState = buildCreature();
  const { legs, physics, body } = creatureState;
  /* The height the camera is aimed at. Fixed, not the live body height: a
     camera that rode the bob would cancel it out and the creature would look
     rigid again. */
  const rideY = creatureState.rideY;

  /* ---- scene --------------------------------------------------------- */
  const scene = new THREE.Scene();
  /* Depth fog, and it is doing the same job the ground's radial fade does.
     Five leg planes strung along the crankshaft superimpose into one silhouette
     from any angle worth looking from -- that is not a framing failure, it is
     what a Strandbeest looks like, and no spacing fixes it because the legs are
     215 wide and the planes can only ever be tens apart. What CAN be fixed is
     that all five arrive at the eye with equal weight, so the near ones have
     nothing to stand out against. Fading the far ones into the page colour puts
     the tangle behind the creature instead of on top of it.

     The range is set from the camera distance in refit(), not written down: the
     camera backs off and closes in as the window changes shape, and a fixed
     near and far would swallow the whole creature in one layout and do nothing
     in another. */
  scene.fog = new THREE.Fog(0x000000, 1, 3000);
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
  /* Bar thicknesses live in creature.js, not here: they decide whether two
     members foul, so the test has to see the same numbers the renderer does. */

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
    frame: new THREE.MeshStandardMaterial({ metalness: 0.6, roughness: 0.35 }),
    stone: new THREE.MeshStandardMaterial({ metalness: 0.05, roughness: 0.95 }),
    ground: new THREE.MeshStandardMaterial({
      roughness: 1, metalness: 0, transparent: true, alphaMap: radialFade(),
      depthWrite: false,
    }),
  };

  /* One mesh per member, built straight off creature.js's own description of
     the machine. The renderer does not decide what the creature is made of:
     members() says, and the clearance test measures the same list, so what is
     drawn and what is checked for fouling cannot drift apart. */
  const memberMeshes = [];
  for (const mem of members(creatureState)) {
    const material = mem.kind === "crank" ? mat.crank
                   : mem.kind === "rod" ? mat.rod
                   : mat.frame;
    const mesh = new THREE.Mesh(rodGeom, material);
    mesh.castShadow = true;
    creature.add(mesh);
    memberMeshes.push(mesh);
  }

  /* Pins, one per joint per leg -- but not at O or J1.

     Those two are the crankshaft's, not the leg's, and the crankshaft draws
     them itself: J1 is the crank pin, already there as a pin between its webs,
     and O is the main axis, which at a leg station is a GAP. A bead at O hangs
     in the middle of the throw attached to nothing, which is exactly what it
     looks like. */
  const CRANK_JOINTS = new Set(["O", "J1"]);
  for (const leg of legs) {
    leg.jointMeshes = [];
    for (const [key, cid] of Object.entries(leg.id)) {
      if (CRANK_JOINTS.has(key)) continue;
      const mesh = new THREE.Mesh(jointGeom, mat.joint);
      mesh.scale.setScalar(BUILD.jointR);
      mesh.castShadow = true;
      mesh.position.z = leg.z;
      creature.add(mesh);
      leg.jointMeshes.push({ cid, mesh });
    }
  }

  /* ---- ground and light ---------------------------------------------- */
  /* Sized to the creature, not the world: the fade has to happen within the
     plane, so a huge one would put the fade off in the distance and bring the
     slab back. */
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(760, 760), mat.ground);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = physics.groundY;
  ground.receiveShadow = true;
  scene.add(ground);

  const key = new THREE.DirectionalLight(0xffffff, 2.1);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  /* The shadow camera travels with the creature, so it only ever has to cover
     the creature itself and can stay tight enough for a crisp shadow. It is
     sized on whichever of the creature's two spans is larger -- the legs reach
     further across the walking plane than the shaft does along it. */
  const R = Math.max(extent.x1 - extent.x0, (PLANES - 1) * LEG_SPACING) * 0.75;
  Object.assign(key.shadow.camera, { left: -R, right: R, top: R, bottom: -R, near: 1, far: 900 });
  key.shadow.bias = -0.0012;
  key.shadow.normalBias = 0.6;
  scene.add(key, key.target);

  const fill = new THREE.DirectionalLight(0xffffff, 0.7);
  fill.position.set(-180, 90, -140);
  scene.add(fill);
  const ambient = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambient);

  /* ---- scenery ---------------------------------------------------------

     The camera travels with the creature and the ground carries no features, so
     without this the creature walks on the spot: every pixel that could tell
     you it is moving is either moving with it or featureless. A scatter of
     stones on the ground is the cheapest thing that fixes it.

     Endless, from a fixed pool. Each stone carries an unwrapped world x, and
     any that falls more than half a period behind the camera is moved a whole
     period ahead -- a treadmill, so sixty stones make a field of any length.
     The field therefore repeats every FIELD units, which nothing on screen can
     tell because the repeat is four times wider than the view.

     They are laid down BESIDE the creature's track rather than under it: the
     creature would otherwise walk through them, and a leg passing through a
     stone undoes the point of the clearance work. A real beach would have them
     underfoot; a background that has to stay legible would rather not.

     Sizes and distances are drawn from the product of two uniforms rather than
     one, which piles most of them up small and near and leaves a few large ones
     scattered out into the distance. A flat distribution gives an even gravel
     that reads as texture; this reads as ground.

     Deterministic, from the light engine's PCG32 rather than Math.random, so
     the scatter is the same on every load and the same for every visitor. */
  const STONES = 170;
  const FIELD = 1400;            /* the repeat period, in creature units */
  const LANE = (PLANES / 2) * LEG_SPACING + 40;   /* clear of the legs */
  const stoneGeom = new THREE.IcosahedronGeometry(1, 0);
  const stones = [];
  {
    const rng = RNG.seed(0x9e3779b97f4a7c15n, 1n);
    for (let i = 0; i < STONES; i++) {
      const mesh = new THREE.Mesh(stoneGeom, mat.stone);
      /* Flattened and turned at random: an icosahedron scaled unevenly reads as
         a rock, where the bare solid reads as a die. */
      const size = 2.5 + RNG.f(rng) * RNG.f(rng) * 11;
      mesh.scale.set(size * (0.7 + RNG.f(rng) * 0.8), size * (0.4 + RNG.f(rng) * 0.5),
                     size * (0.7 + RNG.f(rng) * 0.8));
      mesh.rotation.set(RNG.f(rng) * 3.14, RNG.f(rng) * 3.14, RNG.f(rng) * 3.14);
      mesh.position.y = physics.groundY + mesh.scale.y * 0.35;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const side = RNG.f(rng) < 0.5 ? -1 : 1;
      stones.push({ mesh, wx: RNG.f(rng) * FIELD, z: side * (LANE + RNG.f(rng) * RNG.f(rng) * 520) });
      mesh.position.z = stones[i].z;
      scene.add(mesh);
    }
  }

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
    /* The frame reads as the heaviest thing on the creature, because it is the
       thing being carried. */
    mat.frame.color.set(pick("--text-dim", "#a1a1a1"));
    /* The ground is drawn, not transparent: a shadow can only darken what is
       already there, and on a near-black page there is nothing to darken. */
    /* The floor takes the PAGE's own background colour, not a raised surface
       colour: it is lit, so whatever colour it is gets multiplied up by the key
       light, and anything lighter than the page to begin with becomes a glare
       behind the creature rather than a floor under it. Starting from the page
       colour, the key lifts it just clear of the page and the shadow drops it
       just below -- which is all a shadow on a near-black page can be. */
    /* Set between the floor and the rods: the stones have to be visible against
       the ground without ever competing with the creature for attention. */
    mat.stone.color.set(pick("--surface-line", light ? "#d8d8d8" : "#242424"));
    mat.ground.color.set(pick("--bg", light ? "#ffffff" : "#0a0a0a"));
    /* The same colour the floor takes, and for the same reason: fog that is not
       the page's own colour reads as haze rather than as distance. */
    scene.fog.color.set(pick("--bg", light ? "#ffffff" : "#0a0a0a"));
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
         hero is at the top of the page; the work it was avoiding is about a
         millisecond of solve and one draw call batch.

     A loop with one condition cannot get stuck in a state I can't see. */
  reduce.addEventListener?.("change", () => tick());
  const running = () => !reduce.matches;

  let raf = 0, last = 0;
  /* The camera lags the body through a first-order filter. The body's x is an
     output of a contact solve now, so it carries the ripple of feet landing and
     breaking away; a camera rigidly bolted to it would hand that ripple to
     every pixel on screen instead of to the creature. A quarter-second constant
     is long enough to swallow the ripple and far shorter than a stride. */
  const CAM_LAG = 0.25;
  let camX = body.x;

  /* The furthest any part of the creature can be from its own centre, however
     the visitor has turned it: the half-diagonal of the swept box. The fog is
     scaled by this so the fade always spans the creature rather than a fixed
     number of units. */
  const DEPTH = Math.hypot(box.halfW, ((PLANES - 1) / 2) * LEG_SPACING);

  function place() {
    /* Wrap the CAMERA and hang the creature off it. Wrapping each separately
       would, once every few minutes, leave them a frame apart across the
       boundary and throw the creature clean across the screen. */
    const anchor = ((camX % WRAP) + WRAP) % WRAP;
    const bodyX = anchor + (body.x - camX);

    creature.position.set(bodyX, body.y, 0);
    creature.rotation.z = body.pitch;

    /* Roll the stone field past the camera. Positions are kept unwrapped and
       rendered relative to the same anchor the creature uses, so the field and
       the creature can never drift apart across a wrap. */
    for (const st of stones) {
      let d = st.wx - camX;
      if (d > FIELD / 2) { st.wx -= FIELD; d -= FIELD; }
      else if (d < -FIELD / 2) { st.wx += FIELD; d += FIELD; }
      st.mesh.position.x = anchor + d;
    }

    const va = new THREE.Vector3(), vb = new THREE.Vector3(), dir = new THREE.Vector3();
    const up = new THREE.Vector3(0, 0, 1), quat = new THREE.Quaternion();
    const beam = (mesh, a, b, r) => {
      dir.subVectors(b, a);
      const len = dir.length();
      mesh.position.copy(a).add(b).multiplyScalar(0.5);
      if (len > 1e-9) {
        quat.setFromUnitVectors(up, dir.divideScalar(len));
        mesh.quaternion.copy(quat);
      }
      mesh.scale.set(r, r, Math.max(len, 1e-6));
    };

    const mem = members(creatureState);
    for (let i = 0; i < mem.length; i++) {
      va.set(mem[i].a.x, mem[i].a.y, mem[i].a.z);
      vb.set(mem[i].b.x, mem[i].b.y, mem[i].b.z);
      beam(memberMeshes[i], va, vb, mem[i].r);
    }
    for (const leg of legs) {
      for (const jm of leg.jointMeshes) {
        const q = leg.mechanism.connectors[jm.cid].pos;
        jm.mesh.position.set(q.x, q.y, leg.z);
      }
    }

    /* Camera and key light travel with the creature. Where to put the camera
       is solved in framing.js against the creature's own swept size and the
       viewport's shape, so it stays framed whether the hero is short and wide
       or tall and narrow -- a fixed offset that parks it nicely in one clips
       it clean out of frame in the other.

       It is aimed at the creature's NOMINAL height, not its live one. The bob
       and the pitch are the whole point of giving it weight, and a camera that
       tracked them would subtract them straight back out.

       Dragging orbits that whole rig about the CREATURE, turning the eye and
       the point it aims at together. Turning only the eye would swing the
       creature across the frame and out of it; turning both leaves the
       composition exactly where framing.js put it -- same distance, same
       position on screen -- and changes only the side you are looking from. */
    const cx = anchor + box.cx, cy = rideY + box.cy;
    const qYaw = tmpQ1.setFromAxisAngle(AXIS_Y, orbit.yaw);
    const right = tmpV3.set(1, 0, 0).applyQuaternion(qYaw);
    const spin = tmpQ2.setFromAxisAngle(right, orbit.pitch).multiply(qYaw);

    eyeRel.set(framing.eye.x - box.cx, framing.eye.y - box.cy, framing.eye.z).applyQuaternion(spin);
    atRel.set(framing.at.x - box.cx, framing.at.y - box.cy, framing.at.z).applyQuaternion(spin);
    camera.position.set(cx + eyeRel.x, cy + eyeRel.y, eyeRel.z);
    camera.lookAt(cx + atRel.x, cy + atRel.y, atRel.z);

    /* Fog range from where the camera ACTUALLY is, every frame, rather than
       from the distance framing.js solved for. Those two are not the same
       number -- the solved distance is the depth component, while the eye also
       stands off sideways and above -- and dragging the view changes the gap
       between them. Setting the fade from the solved value at refit time made
       the creature sink into the background as it was turned, and at some
       angles vanish outright. The eye's real distance to the creature cannot
       disagree with itself. */
    const eyeDist = Math.hypot(camera.position.x - cx, camera.position.y - cy, camera.position.z);
    scene.fog.near = Math.max(1, eyeDist - DEPTH * 0.2);
    scene.fog.far = eyeDist + DEPTH * 2.2;
    ground.position.x = anchor;
    key.position.set(anchor + 190, 320, 200);
    key.target.position.set(anchor, physics.groundY, 0);
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

    advance(creatureState, dt);

    camX += (body.x - camX) * (1 - Math.exp(-dt / CAM_LAG));

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
