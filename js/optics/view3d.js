/* The scene viewport: the diagram from scene3d.js, drawn with three.js.

   All the geometry decisions live in scene3d.js, which is free of three.js and
   therefore testable. This file only turns segments into buffers, picks their
   colours out of the stylesheet, and drives an orbit camera. If a distance is
   wrong, it is wrong there, not here.

   three.js is resolved through the import map in pages/optics.html, where the
   version is pinned. It has to be an import map rather than a plain CDN URL
   because OrbitControls imports the bare specifier "three" internally, and a
   bare specifier will not resolve without one. */

const THREE_URL = "three";
const ORBIT_URL = "three/addons/controls/OrbitControls.js";

import { createViewControl } from "../viewcontrol.js?v=e7629c32";
import * as S3 from "./scene3d.js?v=e7629c32";

/* How each kind of segment is drawn. Colour comes from a CSS custom property so
   the diagram follows the page's theme; `w` is the opacity, which is what
   carries the hierarchy in a monochrome design -- the ground is barely there,
   the focus plane is the brightest thing on screen. */
const STYLE = {
  [S3.GRID]:    { token: "--surface-line", opacity: 0.85 },
  [S3.AXIS]:    { token: "--text-faint",   opacity: 0.55 },
  [S3.CAMERA]:  { token: "--text",         opacity: 0.85 },
  [S3.FRUSTUM]: { token: "--text-faint",   opacity: 0.40 },
  [S3.FOCUS]:   { token: "--accent",       opacity: 1.00 },
  [S3.DOF]:     { token: "--text-dim",     opacity: 0.70 },
  [S3.OBJECT]:  { token: "--text-faint",   opacity: 0.60 },
  [S3.SUBJECT]: { token: "--accent",       opacity: 0.95 },
  [S3.LIGHT]:   { token: "--text",         opacity: 0.80 },
  [S3.SKY]:     { token: "--text-dim",     opacity: 0.60 },
};

const cssVar = (name, fallback) => {
  const val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return val || fallback;
};

export async function createView(container, opts = {}) {
  let THREE, OrbitControls;
  try {
    const [t, o] = await Promise.all([import(THREE_URL), import(ORBIT_URL)]);
    THREE = t;
    OrbitControls = o.OrbitControls;
  } catch (err) {
    /* A CDN failure must not blank the page: every method is a no-op and the
       caller shows a note. Same contract as js/light/view3d.js. */
    return {
      failed: true, error: err,
      setDiagram() {}, resize() {}, setTheme() {}, frame() {}, dispose() {},
    };
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 400);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  container.appendChild(renderer.domElement);

  /* The optics scene is Y-up with the camera looking down -z, which is also
     three.js's default -- unlike the light page, which is Z-up. */
  camera.up.set(0, 1, 0);

  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.08;

  const lineGroup = new THREE.Group();
  const labelGroup = new THREE.Group();
  scene.add(lineGroup, labelGroup);

  let dirty = true;
  let wheel = null;
  let diagram = null;

  function clearGroup(g) {
    for (const c of [...g.children]) {
      g.remove(c);
      if (c.geometry) c.geometry.dispose();
      if (c.material) {
        if (c.material.map) c.material.map.dispose();
        c.material.dispose();
      }
    }
  }

  /* ---- labels ----
     Canvas-textured sprites. A sprite always faces the camera, which is what a
     distance annotation has to do -- text that rotates with the scene is
     unreadable from three quarters of the orbit. */
  function makeLabel(text, colour, opacity) {
    const pad = 6, font = 22;
    const c = document.createElement("canvas");
    const ctx = c.getContext("2d");
    ctx.font = `500 ${font}px ui-monospace, monospace`;
    const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
    c.width = w; c.height = font + pad * 2;
    const ctx2 = c.getContext("2d");
    ctx2.font = `500 ${font}px ui-monospace, monospace`;
    ctx2.fillStyle = colour;
    ctx2.textBaseline = "middle";
    ctx2.fillText(text, pad, c.height / 2);

    const tex = new THREE.CanvasTexture(c);
    tex.minFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    /* Scaled in world units so a label keeps its size relative to the scene;
       0.0026 puts a five-character label at about 14 cm wide, which reads at
       the default framing without swamping a 6 cm sphere. */
    const s = 0.0026;
    sprite.scale.set(c.width * s, c.height * s, 1);
    sprite.renderOrder = 10;
    return sprite;
  }

  /* Rebuild every line and label from a diagram. Segments are batched into ONE
     LineSegments per kind -- five hundred individual Line objects would be five
     hundred draw calls for a picture that is mostly a ground plane. */
  function setDiagram(d) {
    diagram = d;
    clearGroup(lineGroup);
    clearGroup(labelGroup);
    if (!d) { dirty = true; return; }

    const byKind = new Map();
    for (const g of d.segs) {
      let arr = byKind.get(g.kind);
      if (!arr) { arr = []; byKind.set(g.kind, arr); }
      arr.push(g.a.x, g.a.y, g.a.z, g.b.x, g.b.y, g.b.z);
    }

    for (const [kind, coords] of byKind) {
      const st = STYLE[kind] || STYLE[S3.OBJECT];
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(coords), 3));
      const mat = new THREE.LineBasicMaterial({
        color: new THREE.Color(cssVar(st.token, "#888")),
        transparent: true,
        opacity: st.opacity,
      });
      lineGroup.add(new THREE.LineSegments(geom, mat));
    }

    for (const l of d.labels) {
      const st = STYLE[l.kind] || STYLE[S3.OBJECT];
      const sprite = makeLabel(l.text, cssVar(st.token, "#888"), Math.min(1, st.opacity + 0.15));
      sprite.position.set(l.at.x, l.at.y, l.at.z);
      labelGroup.add(sprite);
    }
    dirty = true;
  }

  /* The C's own default framing, and its reasoning: a three-quarter view from
     the right and slightly above, framed on the near half of the rail. Looking
     straight down the axis hides exactly what this view is for -- how far apart
     things are -- and looking straight across it hides the frustum. The target
     is lifted so a key light overhead stays in shot; a framing that cut it off
     would make the lighting control feel like it acted on nothing. */
  function frame() {
    const target = new THREE.Vector3(0.30, 0.30, -2.1);
    const dist = 7.0, az = 1.02, el = 0.26;
    orbit.target.copy(target);
    camera.position.set(
      target.x + dist * Math.cos(el) * Math.sin(az),
      target.y + dist * Math.sin(el),
      target.z + dist * Math.cos(el) * Math.cos(az)
    );
    camera.near = 0.02;
    camera.far = 200;
    camera.updateProjectionMatrix();
    orbit.update();
    dirty = true;
    syncHeading();
  }

  function resize() {
    const r = container.getBoundingClientRect();
    if (!r.width || !r.height) return;
    renderer.setSize(r.width, r.height, false);
    camera.aspect = r.width / r.height;
    camera.updateProjectionMatrix();
    dirty = true;
  }

  /* Colours are read from the stylesheet, so a theme change has to rebuild
     them. The geometry is unchanged, so this re-runs setDiagram on what is
     already there. */
  function setTheme() { setDiagram(diagram); }

  /* ---- orbit / zoom, driven by the corner wheel ----
     On the camera directly rather than through OrbitControls' internals: the
     offset from the target is converted to spherical, adjusted, and rebuilt.
     Polar is clamped just short of the poles, where the up vector degenerates
     and the view flips. */
  function orbitBy(dAzimuth, dPolar) {
    const off = camera.position.clone().sub(orbit.target);
    const radius = off.length();
    if (radius <= 0) return;
    let polar = Math.acos(Math.min(1, Math.max(-1, off.y / radius)));
    let azimuth = Math.atan2(off.x, off.z);
    azimuth += dAzimuth;
    polar = Math.min(Math.PI - 0.05, Math.max(0.05, polar + dPolar));
    const s = Math.sin(polar);
    off.set(Math.sin(azimuth) * s * radius, Math.cos(polar) * radius, Math.cos(azimuth) * s * radius);
    camera.position.copy(orbit.target).add(off);
    camera.lookAt(orbit.target);
    orbit.update();
    dirty = true;
    syncHeading();
  }

  function zoomBy(scale) {
    const off = camera.position.clone().sub(orbit.target);
    const next = Math.min(Math.max(off.length() * scale, camera.near * 4), camera.far * 0.5);
    camera.position.copy(orbit.target).add(off.setLength(next));
    orbit.update();
    dirty = true;
  }

  /* Keep the needle pointing where the camera actually is. */
  function syncHeading() {
    if (!wheel) return;
    const off = camera.position.clone().sub(orbit.target);
    wheel.setHeading(Math.atan2(off.x, off.z));
  }

  wheel = createViewControl(container.parentElement || container, {
    label: "Rotate and zoom the scene view",
    onSpin: (d) => orbitBy(d, 0),
    onTilt: (d) => orbitBy(0, d),
    onZoom: (s) => zoomBy(s),
    onReset: () => frame(),
  });

  new ResizeObserver(resize).observe(container);
  resize();
  frame();

  orbit.addEventListener("change", () => { dirty = true; syncHeading(); });

  let alive = true;
  (function loop() {
    if (!alive) return;
    requestAnimationFrame(loop);
    const moved = orbit.update();
    if (dirty || moved) { renderer.render(scene, camera); dirty = false; }
  })();

  return {
    failed: false,
    setDiagram, frame, resize, setTheme, orbitBy, zoomBy,
    markDirty() { dirty = true; },
    domElement: renderer.domElement,
    dispose() {
      alive = false;
      wheel && wheel.destroy();
      orbit.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
