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

  /* Rebuilt to suit the mechanism in frame(): a fixed-size grid either swamps a
     small linkage or is swamped by a large one. */
  let grid = null;
  let gridColor = 0x2b2e33;
  function buildGrid(span) {
    if (grid) { scene.remove(grid); grid.geometry.dispose(); grid.material.dispose(); }
    /* A round pitch near a tenth of the span, so the squares read as a scale. */
    const rough = Math.max(span, 100) / 10;
    const pitch = Math.pow(10, Math.floor(Math.log10(rough))) *
                  [1, 2, 5, 10].find((k) => k * Math.pow(10, Math.floor(Math.log10(rough))) >= rough);
    const divisions = 24;
    grid = new THREE.GridHelper(pitch * divisions, divisions, gridColor, gridColor);
    grid.rotation.x = Math.PI / 2; /* the mechanism lies in the XY plane */
    grid.material.transparent = true;
    grid.material.opacity = 0.45;
    scene.add(grid);
  }

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
  let topologyKey = "";
  let framed = false;

  const group = new THREE.Group();
  /* The engine's y axis points down (screen convention); flipping it here
     rather than in the engine keeps the two views agreeing about which way is
     up without touching the ported maths. */
  group.scale.y = -1;
  scene.add(group);

  function setTheme(palette) {
    materials.rod.color.set(palette.text);
    materials.driven.color.set(palette.accent);
    materials.joint.color.set(palette.dim);
    materials.anchor.color.set(palette.accent);
    traceMaterial.color.set(palette.accent);
    gridColor = new THREE.Color(palette.line).getHex();
    if (grid) grid.material.color.setHex(gridColor);
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
    return parts.join("|");
  }

  function rebuild(m) {
    for (const r of rods) group.remove(r.mesh);
    for (const j of joints) group.remove(j.mesh);
    rods = [];
    joints = [];

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

    syncTraces(m);
    if (!framed) frame(m);
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
  /* Put the camera where the whole mechanism is visible, once per topology
     change rather than every frame -- otherwise the view would lurch about as
     the mechanism moves. */
  function frame(m) {
    const live = m.connectors.filter((c) => c.alive);
    if (!live.length) return;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const c of live) {
      x0 = Math.min(x0, c.pos.x); x1 = Math.max(x1, c.pos.x);
      y0 = Math.min(y0, c.pos.y); y1 = Math.max(y1, c.pos.y);
    }
    const cx = (x0 + x1) / 2, cy = -(y0 + y1) / 2;
    const span = Math.max(x1 - x0, y1 - y0, 50);

    rodRadius = span / 90;
    jointRadius = span / 60;
    buildGrid(span);
    grid.position.set(cx, cy, 0);

    /* Half the extent the camera must cover, allowing for the viewport being
       wider than it is tall (the vertical field of view is the binding one). */
    const half = Math.max(
      (x1 - x0) / 2 / Math.max(camera.aspect, 0.2),
      (y1 - y0) / 2,
      25
    ) * 1.25;
    const d = half / Math.tan((camera.fov * Math.PI) / 360);
    controls.target.set(cx, cy, 0);
    /* Mostly face-on, tipped just enough to read as three-dimensional. */
    camera.position.set(cx + d * 0.30, cy - d * 0.42, d * 0.86);
    camera.near = Math.max(d / 500, 0.01);
    camera.far = d * 20;
    camera.updateProjectionMatrix();
    controls.update();
    framed = true;
    /* The meshes were sized with the previous radius, so restate them now. */
    sizeMeshes(m);
  }

  function sizeMeshes(m) {
    for (const j of joints) {
      const r = m.connectors[j.id].isAnchor ? jointRadius * 1.4 : jointRadius;
      j.mesh.scale.set(r, r, r);
    }
  }

  function resize() {
    const rect = container.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    renderer.setSize(rect.width, rect.height, false);
    camera.aspect = rect.width / rect.height;
    camera.updateProjectionMatrix();
    dirty = true;
  }
  new ResizeObserver(resize).observe(container);
  resize();

  /* Render on demand: after a sync, while the camera is still settling, or
     while the user is dragging it. An idle 3D pane costs nothing. */
  controls.addEventListener("change", () => { dirty = true; });
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
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
