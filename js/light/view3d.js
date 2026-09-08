/* The 3D viewport: scene geometry carrying its illuminance field as vertex
   colour, lamps drawn as their own shapes, and a gizmo for moving whatever is
   selected.

   three.js is resolved through the import map in pages/light.html, where the
   version is pinned. It has to be an import map rather than plain CDN URLs
   because OrbitControls and TransformControls import the bare specifier
   "three" internally, and a bare specifier will not resolve without one. */

const THREE_URL = "three";
const ORBIT_URL = "three/addons/controls/OrbitControls.js";
const GIZMO_URL = "three/addons/controls/TransformControls.js";

import { createViewControl } from "../viewcontrol.js?v=071da3f3";

export async function createView(container, opts = {}) {
  let THREE, OrbitControls, TransformControls;
  try {
    const [t, o, g] = await Promise.all([
      import(THREE_URL), import(ORBIT_URL), import(GIZMO_URL),
    ]);
    THREE = t;
    OrbitControls = o.OrbitControls;
    TransformControls = g.TransformControls;
  } catch (err) {
    return { failed: true, error: err };
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.001, 100);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  const orbit = controls;
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.08;

  /* The scene is Z-up, as the scene files are; three.js defaults to Y-up. */
  camera.up.set(0, 0, 1);

  const gizmo = new TransformControls(camera, renderer.domElement);
  gizmo.addEventListener("dragging-changed", (e) => { orbit.enabled = !e.value; });
  gizmo.addEventListener("objectChange", () => opts.onGizmoMove && opts.onGizmoMove());
  const gizmoHelper = gizmo.getHelper ? gizmo.getHelper() : gizmo;
  scene.add(gizmoHelper);

  /* Field surfaces are unlit: their colour IS the measurement, and shading them
     again would mix a fake light into a real one. */
  const fieldGroup = new THREE.Group();
  const lampGroup = new THREE.Group();
  const wireGroup = new THREE.Group();
  scene.add(fieldGroup, lampGroup, wireGroup);

  let surfaces = [];
  let lampMeshes = [];
  let dirty = true;
  let wheel = null;
  const raycaster = new THREE.Raycaster();

  function clearGroup(g) {
    for (const c of [...g.children]) {
      g.remove(c);
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
    }
  }

  /* ---- geometry ---- */

  function setSurfaces(list) {
    clearGroup(fieldGroup);
    clearGroup(wireGroup);
    surfaces = list.map((s) => {
      /* A hidden surface (the measurement grid) still occupies its slot so the
         page's per-surface arrays stay index-aligned, but gets no mesh. */
      if (s.hidden) return { mesh: null, colors: null, nverts: s.pos.length / 3, primId: s.primId };
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(s.pos, 3));
      geom.setAttribute("normal", new THREE.BufferAttribute(s.nor, 3));
      const nverts = s.pos.length / 3;
      const colors = new Float32Array(nverts * 3).fill(0.15);
      geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      geom.setIndex(new THREE.BufferAttribute(s.idx, 1));
      /* FrontSide, not DoubleSide: a wall's outward face carries no light and
         drawing it just hides the lit interior behind a black shell. Culling it
         lets the camera see into an enclosure from any angle. */
      const mat = new THREE.MeshBasicMaterial({
        vertexColors: true, side: THREE.FrontSide,
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.userData.primId = s.primId;
      fieldGroup.add(mesh);
      return { mesh, colors, nverts, primId: s.primId };
    });
    dirty = true;
  }

  /* Repaint from a scalar per vertex, through the shared viridis scale. */
  function setField(surfaceIndex, values, lo, hi, ramp) {
    const s = surfaces[surfaceIndex];
    if (!s || !s.mesh) return;
    const span = hi > lo ? hi - lo : 1;
    for (let i = 0; i < s.nverts; i++) {
      const c = ramp((values[i] - lo) / span);
      s.colors[i * 3] = c.r;
      s.colors[i * 3 + 1] = c.g;
      s.colors[i * 3 + 2] = c.b;
    }
    s.mesh.geometry.attributes.color.needsUpdate = true;
    dirty = true;
  }

  /* Lamps are drawn as emissive-looking shapes so they read as sources, not as
     another surface carrying a field. */
  function setLamps(lights) {
    clearGroup(lampGroup);
    lampMeshes = lights.map((l, i) => {
      let geom;
      if (l.kind === "rect") geom = new THREE.PlaneGeometry(1, 1);
      else if (l.kind === "disk") geom = new THREE.CircleGeometry(1, 40);
      else if (l.kind === "sphere") geom = new THREE.SphereGeometry(1, 24, 16);
      else geom = new THREE.SphereGeometry(1, 16, 12);
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
      const m = new THREE.Mesh(geom, mat);
      m.userData.lightIndex = i;
      lampGroup.add(m);
      return m;
    });
    dirty = true;
  }

  /* Place a lamp mesh from its description. Rect and disk are oriented by
     their normal; point and spot get a small marker. */
  function placeLamp(i, l) {
    const m = lampMeshes[i];
    if (!m) return;
    m.position.set(l.p ? l.p.x : 0, l.p ? l.p.y : 0, l.p ? l.p.z : 0);
    if (l.kind === "rect") {
      const ex = l.ex, ey = l.ey;
      const nx = new THREE.Vector3(ex.x, ex.y, ex.z);
      const ny = new THREE.Vector3(ey.x, ey.y, ey.z);
      m.scale.set(nx.length() * 2, ny.length() * 2, 1);
      const nz = new THREE.Vector3().crossVectors(nx, ny).normalize();
      const basis = new THREE.Matrix4().makeBasis(
        nx.clone().normalize(), ny.clone().normalize(), nz
      );
      m.quaternion.setFromRotationMatrix(basis);
    } else if (l.kind === "disk") {
      m.scale.setScalar(l.r || 0.05);
      m.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 0, 1), new THREE.Vector3(l.n.x, l.n.y, l.n.z).normalize()
      );
    } else if (l.kind === "sphere") {
      m.scale.setScalar(l.r || 0.03);
    } else {
      m.scale.setScalar(0.012);
    }
    dirty = true;
  }

  /* ---- selection and picking ---- */

  function pick(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects([...lampGroup.children, ...fieldGroup.children], false);
    if (!hits.length) return null;
    const h = hits[0];
    return {
      lightIndex: h.object.userData.lightIndex,
      primId: h.object.userData.primId,
      point: { x: h.point.x, y: h.point.y, z: h.point.z },
      faceIndex: h.face ? h.face.a : -1,
      surfaceIndex: fieldGroup.children.indexOf(h.object),
      distance: h.distance,
    };
  }

  function attachGizmo(object, mode = "translate") {
    if (!object) { gizmo.detach(); dirty = true; return; }
    gizmo.setMode(mode);
    gizmo.attach(object);
    dirty = true;
  }
  const lampObject = (i) => lampMeshes[i] || null;

  /* ---- framing ---- */

  function frame(bounds) {
    const cx = (bounds.min.x + bounds.max.x) / 2;
    const cy = (bounds.min.y + bounds.max.y) / 2;
    const cz = (bounds.min.z + bounds.max.z) / 2;
    const span = Math.max(
      bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y,
      bounds.max.z - bounds.min.z, 0.1
    );
    orbit.target.set(cx, cy, cz);
    const d = span * 1.9;
    camera.position.set(cx + d * 0.75, cy - d * 0.95, cz + d * 0.6);
    camera.near = d / 200;
    camera.far = d * 30;
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

  /* ---- orbit / zoom, driven by the corner wheel ----
     Done on the camera directly rather than through OrbitControls' internals:
     the offset from the target is converted to spherical, adjusted, and rebuilt.
     Polar is clamped just short of the poles, where the up vector degenerates
     and the view flips. */
  function orbitBy(dAzimuth, dPolar) {
    const off = camera.position.clone().sub(controls.target);
    const radius = off.length();
    if (radius <= 0) return;
    const up = camera.up;
    /* Spherical about the camera's own up axis, so this works for a Z-up scene
       as well as three.js's default Y-up. */
    const zAxis = up.clone().normalize();
    const xAxis = new THREE.Vector3(1, 0, 0);
    if (Math.abs(xAxis.dot(zAxis)) > 0.9) xAxis.set(0, 1, 0);
    const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
    xAxis.crossVectors(yAxis, zAxis).normalize();

    const z = off.dot(zAxis);
    let polar = Math.acos(Math.min(1, Math.max(-1, z / radius)));
    let azimuth = Math.atan2(off.dot(yAxis), off.dot(xAxis));

    azimuth += dAzimuth;
    polar = Math.min(Math.PI - 0.05, Math.max(0.05, polar + dPolar));

    const s = Math.sin(polar);
    off.copy(xAxis).multiplyScalar(Math.cos(azimuth) * s * radius)
      .addScaledVector(yAxis, Math.sin(azimuth) * s * radius)
      .addScaledVector(zAxis, Math.cos(polar) * radius);
    camera.position.copy(controls.target).add(off);
    camera.lookAt(controls.target);
    controls.update();
    dirty = true;
    syncHeading();
  }

  function zoomBy(scale) {
    const off = camera.position.clone().sub(controls.target);
    const next = Math.min(Math.max(off.length() * scale, camera.near * 4), camera.far * 0.5);
    camera.position.copy(controls.target).add(off.setLength(next));
    controls.update();
    dirty = true;
  }

  /* Keep the needle pointing where the camera actually is. */
  function syncHeading() {
    if (!wheel) return;
    const off = camera.position.clone().sub(controls.target);
    const up = camera.up.clone().normalize();
    const xAxis = new THREE.Vector3(1, 0, 0);
    if (Math.abs(xAxis.dot(up)) > 0.9) xAxis.set(0, 1, 0);
    const yAxis = new THREE.Vector3().crossVectors(up, xAxis).normalize();
    xAxis.crossVectors(yAxis, up).normalize();
    wheel.setHeading(Math.atan2(off.dot(yAxis), off.dot(xAxis)));
  }

  wheel = createViewControl(container.parentElement || container, {
    label: "Rotate and zoom the view",
    onSpin: (d) => orbitBy(d, 0),
    onTilt: (d) => orbitBy(0, d),
    onZoom: (s2) => zoomBy(s2),
    onReset: () => opts.onFit && opts.onFit(),
  });

  new ResizeObserver(resize).observe(container);
  resize();

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
    setSurfaces, setField, setLamps, placeLamp, pick, attachGizmo, lampObject,
    frame, resize, orbitBy, zoomBy,
    markDirty() { dirty = true; },
    domElement: renderer.domElement,
    dispose() { alive = false; wheel && wheel.destroy(); orbit.dispose(); renderer.dispose(); renderer.domElement.remove(); },
  };
}
