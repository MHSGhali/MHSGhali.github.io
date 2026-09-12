/* The live 3D view: one cylinder per link edge and one sphere per joint,
   rebuilt in step with the 2D simulation.

   This is deliberately the same construction the Blender exporter writes --
   rods as unit-depth cylinders scaled along their local Z, joints as markers,
   1 world unit = 1 mm -- so what you orbit here is what you get after
   exporting, rather than a separate prettier interpretation of it.

   three.js is imported dynamically so the homepage, which uses the same engine
   for its hero but needs no 3D, never pays for it. If the import fails (an
   offline visitor, a blocked CDN) the page keeps working with the 2D editor
   alone and says so. */

/* Resolved through the import map in pages/linkage.html, which is where the
   version is pinned. It has to be an import map rather than plain CDN URLs
   because OrbitControls imports the bare specifier "three" internally, and a
   bare specifier is unresolvable without one. */
const THREE_URL = "three";
const CONTROLS_URL = "three/addons/controls/OrbitControls.js";

import { bounds as mechanismBounds, liveSliders } from "./mechanism.js?v=58764426";
import { createViewControl } from "../viewcontrol.js?v=58764426";

export async function createView3D(container, getMechanism) {
  let THREE, OrbitControls;
  try {
    const [three, controlsMod] = await Promise.all([
      import(THREE_URL),
      import(CONTROLS_URL),
    ]);
    THREE = three;
    OrbitControls = controlsMod.OrbitControls;
  } catch (err) {
    return {
      failed: true, error: err,
      sync() {}, resize() {}, setTheme() {}, resetView() {}, dispose() {},
    };
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 8000);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  const key = new THREE.DirectionalLight(0xffffff, 2.1);
  key.position.set(1, 2, 3);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.7);
  fill.position.set(-2, -1, 1);
  scene.add(fill);
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));

  /* Shared geometry: one unit cylinder along Z, scaled per rod per frame, and
     one unit sphere. Allocating per rod per frame would churn the GPU for no
     reason -- the topology only changes when the mechanism does. */
  const rodGeom = new THREE.CylinderGeometry(1, 1, 1, 16);
  rodGeom.rotateX(Math.PI / 2); /* stand it up along +Z, as the exporter does */
  const jointGeom = new THREE.SphereGeometry(1, 20, 14);

  const materials = {
    rod: new THREE.MeshStandardMaterial({ metalness: 0.65, roughness: 0.35 }),
    driven: new THREE.MeshStandardMaterial({ metalness: 0.7, roughness: 0.25 }),
    joint: new THREE.MeshStandardMaterial({ metalness: 0.3, roughness: 0.55 }),
    anchor: new THREE.MeshStandardMaterial({ metalness: 0.4, roughness: 0.4 }),
    rail: new THREE.MeshStandardMaterial({ metalness: 0.5, roughness: 0.6 }),
  };

  const traceMaterial = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.8 });

  /* The exporter writes a fixed ROD_RADIUS_MM = 3.0 that you edit before
     building real geometry around the skeleton. Here the radius is scaled to
     the mechanism instead, so a 40 mm linkage and a 4 m one are both legible;
     the shapes and motion are identical either way. */
  let rodRadius = 3;
  let jointRadius = 4.5;

  let rods = [];
  let joints = [];
  let traceLines = [];
  let rails = [];
  let topologyKey = "";
  let framed = false;
  /* The camera distance the current framing was computed for, so keepInView()
     can tell a grown trace from an orbit or a zoom. */
  let framedDistance = 0;
  /* True while the camera distance is still the one Fit chose. Orbiting keeps
     it -- rotation does not change what fits -- but any dolly or wheel zoom
     hands the framing to the visitor and keepInView() then leaves it alone. */
  let autoFramed = true;

  const group = new THREE.Group();
  /* The engine's y axis points down (screen convention); flipping it here
     rather than in the engine keeps the two views agreeing about which way is
     up without touching the ported maths. */
  group.scale.y = -1;
  scene.add(group);

  function setTheme(palette) {
    materials.rod.color.set(palette.dim);
    materials.driven.color.set(palette.accent);
    materials.joint.color.set(palette.dim);
    materials.anchor.color.set(palette.accent);
    materials.rail.color.set(palette.dim);
    traceMaterial.color.set(palette.accent);
    dirty = true;
  }

  /* Rebuild meshes only when the set of joints and rods actually changes --
     which is an edit, not a simulation frame. */
  function topology(m) {
    const parts = [];
    for (let i = 0; i < m.connectors.length; i++) {
      if (m.connectors[i].alive) parts.push(`c${i}${m.connectors[i].isAnchor ? "a" : ""}`);
    }
    for (let li = 0; li < m.links.length; li++) {
      const l = m.links[li];
      if (l.alive) parts.push(`l${li}:${l.connectorIds.join(",")}${l.isDriven ? "d" : ""}`);
    }
    for (const sl of liveSliders(m)) {
      parts.push(`s${sl.pinConnectorId}:${sl.railAId},${sl.railBId}`);
    }
    return parts.join("|");
  }

  function rebuild(m) {
    for (const r of rods) group.remove(r.mesh);
    for (const j of joints) group.remove(j.mesh);
    for (const r of rails) group.remove(r.mesh);
    rods = [];
    joints = [];
    rails = [];

    /* A rail is guideway, not structure: drawn as a thin bar in the dim
       material so it reads as something the mechanism slides ON rather than
       another link it is built from. */
    for (const sl of liveSliders(m)) {
      const mesh = new THREE.Mesh(rodGeom, materials.rail);
      group.add(mesh);
      rails.push({ a: sl.railAId, b: sl.railBId, mesh });
    }

    for (let i = 0; i < m.connectors.length; i++) {
      const c = m.connectors[i];
      if (!c.alive) continue;
      const mesh = new THREE.Mesh(jointGeom, c.isAnchor ? materials.anchor : materials.joint);
      const r = c.isAnchor ? jointRadius * 1.4 : jointRadius;
      mesh.scale.set(r, r, r);
      group.add(mesh);
      joints.push({ id: i, mesh });
    }

    for (let li = 0; li < m.links.length; li++) {
      const l = m.links[li];
      if (!l.alive) continue;
      for (let i = 0; i < l.connectorIds.length; i++) {
        for (let j = i + 1; j < l.connectorIds.length; j++) {
          const mesh = new THREE.Mesh(rodGeom, l.isDriven ? materials.driven : materials.rod);
          group.add(mesh);
          rods.push({ a: l.connectorIds[i], b: l.connectorIds[j], mesh });
        }
      }
    }
  }

  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const up = new THREE.Vector3(0, 0, 1);
  const quat = new THREE.Quaternion();

  let dirty = true;
  let wheel = null;

  function sync() {
    const m = getMechanism();
    const key2 = topology(m);
    if (key2 !== topologyKey) {
      topologyKey = key2;
      rebuild(m);
      framed = false;
    }

    for (const j of joints) {
      const p = m.connectors[j.id].pos;
      j.mesh.position.set(p.x, p.y, 0);
    }

    for (const r of rods) {
      const a = m.connectors[r.a].pos, b = m.connectors[r.b].pos;
      vA.set(a.x, a.y, 0);
      vB.set(b.x, b.y, 0);
      dir.subVectors(vB, vA);
      const len = dir.length();
      r.mesh.position.copy(vA).add(vB).multiplyScalar(0.5);
      if (len > 1e-9) {
        quat.setFromUnitVectors(up, dir.divideScalar(len));
        r.mesh.quaternion.copy(quat);
      }
      /* Scale along local Z is what lets a variable-length link animate its
         length correctly, exactly as in the exported Blender rig. */
      r.mesh.scale.set(rodRadius, rodRadius, Math.max(len, 1e-6));
    }

    /* Rails are posed like rods but thinner, and run a little past their two
       joints because the constraint is on the whole line, not the segment. */
    for (const r of rails) {
      const a = m.connectors[r.a].pos, b = m.connectors[r.b].pos;
      vA.set(a.x, a.y, 0);
      vB.set(b.x, b.y, 0);
      dir.subVectors(vB, vA);
      const len = dir.length();
      r.mesh.position.copy(vA).add(vB).multiplyScalar(0.5);
      if (len > 1e-9) {
        quat.setFromUnitVectors(up, dir.divideScalar(len));
        r.mesh.quaternion.copy(quat);
      }
      r.mesh.scale.set(rodRadius * 0.45, rodRadius * 0.45, Math.max(len * 1.16, 1e-6));
    }

    syncTraces(m);
    if (!framed) frame(m);
    else keepInView(m);
    dirty = true;
  }

  function syncTraces(m) {
    for (const line of traceLines) {
      group.remove(line);
      line.geometry.dispose();
    }
    traceLines = [];
    for (const c of m.connectors) {
      if (!c.alive || !c.traced || c.path.length < 2) continue;
      const pts = new Float32Array(c.path.length * 3);
      for (let i = 0; i < c.path.length; i++) {
        pts[i * 3] = c.path[i].x;
        pts[i * 3 + 1] = c.path[i].y;
        pts[i * 3 + 2] = 0;
      }
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(pts, 3));
      const line = new THREE.Line(geom, traceMaterial);
      traceLines.push(line);
      group.add(line);
    }
  }
  /* The camera distance that fits `b`, and the point it should look at. The
     mechanism is drawn with y negated (see group.scale.y), so the target's y
     is negated to match. */
  const FIT_SLACK = 1.2;  /* extra room a widening refit leaves for more trace */

  function fitFor(b) {
    /* Half the extent the camera must cover, allowing for the viewport being
       wider than it is tall (the vertical field of view is the binding one). */
    const half = Math.max(
      (b.x1 - b.x0) / 2 / Math.max(camera.aspect, 0.2),
      (b.y1 - b.y0) / 2,
      25
    ) * 1.25;
    return {
      cx: (b.x0 + b.x1) / 2,
      cy: -(b.y0 + b.y1) / 2,
      d: half / Math.tan((camera.fov * Math.PI) / 360),
    };
  }

  /* Put the camera where the whole mechanism AND its traces are visible, once
     per topology change rather than every frame -- otherwise the view would
     lurch about as the mechanism moves. */
  function frame(m) {
    const b = mechanismBounds(m);
    if (!b) return;
    const { cx, cy, d } = fitFor(b);

    rodRadius = Math.max(b.x1 - b.x0, b.y1 - b.y0, 50) / 90;
    jointRadius = rodRadius * 1.5;

    controls.target.set(cx, cy, 0);
    /* Mostly face-on, tipped just enough to read as three-dimensional. */
    camera.position.set(cx + d * 0.30, cy - d * 0.42, d * 0.86);
    camera.near = Math.max(d / 500, 0.01);
    camera.far = d * 20;
    camera.updateProjectionMatrix();
    framedDistance = d;
    autoFramed = true;
    controls.update();
    framed = true;
    syncHeading();
    /* The meshes were sized with the previous radius, so restate them now. */
    sizeMeshes(m);
  }

  /* A trace only exists once the mechanism has run, and it keeps growing, so
     the fit chosen at topology time goes stale as soon as the coupler swings
     wide. Pull the camera back to suit -- along whatever direction it is
     already pointing, so this never undoes an orbit the visitor set up -- and
     only ever outwards, or the view would pump in and out every revolution. */
  function keepInView(m) {
    if (!autoFramed) return;
    const b = mechanismBounds(m);
    if (!b) return;
    const { cx, cy, d } = fitFor(b);
    if (d <= framedDistance) return;
    const dir = camera.position.clone().sub(controls.target);
    if (dir.lengthSq() < 1e-12) return;
    /* Pull back FIT_SLACK further than the curve currently needs, so the next
       millimetre of trace does not re-trigger this and leave the camera
       creeping backwards for a whole revolution. */
    const next = d * FIT_SLACK;
    controls.target.set(cx, cy, 0);
    camera.position.copy(controls.target).add(dir.setLength(next));
    camera.near = Math.max(next / 500, 0.01);
    camera.far = next * 20;
    camera.updateProjectionMatrix();
    framedDistance = next;
    controls.update();
    syncHeading();
  }

  function sizeMeshes(m) {
    for (const j of joints) {
      const r = m.connectors[j.id].isAnchor ? jointRadius * 1.4 : jointRadius;
      j.mesh.scale.set(r, r, r);
    }
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
    autoFramed = false;
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

  function resize() {
    const rect = container.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    renderer.setSize(rect.width, rect.height, false);
    camera.aspect = rect.width / rect.height;
    camera.updateProjectionMatrix();
    /* What fits depends on the aspect ratio, so a pane that has just been laid
       out -- or a window the visitor resized -- needs the fit recomputed.
       Without this the first frame is computed against the placeholder aspect
       and the mechanism arrives cropped. */
    if (framed && autoFramed) frame(getMechanism());
    dirty = true;
  }
  wheel = createViewControl(container.parentElement || container, {
    label: "Rotate and zoom the view",
    onSpin: (d) => orbitBy(d, 0),
    onTilt: (d) => orbitBy(0, d),
    onZoom: (s2) => zoomBy(s2),
    onReset: () => { framed = false; sync(); },
  });

  new ResizeObserver(resize).observe(container);
  resize();

  /* Render on demand: after a sync, while the camera is still settling, or
     while the user is dragging it. An idle 3D pane costs nothing. */
  controls.addEventListener("change", () => {
    /* Rotation preserves the distance to the target, a dolly does not -- so a
       distance that no longer matches the framed one means the visitor zoomed. */
    const dist = camera.position.distanceTo(controls.target);
    if (framedDistance > 0 && Math.abs(dist - framedDistance) > framedDistance * 0.01) {
      autoFramed = false;
    }
    dirty = true;
    syncHeading();
  });
  let alive = true;
  (function renderLoop() {
    if (!alive) return;
    requestAnimationFrame(renderLoop);
    const moved = controls.update();
    if (dirty || moved) {
      renderer.render(scene, camera);
      dirty = false;
    }
  })();

  return {
    failed: false,
    sync, resize, setTheme,
    resetView() { framed = false; sync(); },
    dispose() {
      alive = false;
      wheel && wheel.destroy();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
