/* A navigation wheel for the corner of a 3D viewport: drag the ring to spin,
   the arrows to tilt, and +/- to zoom.

   It exists because dragging in the viewport itself is not always available.
   On the light page the gizmo swallows a drag that starts on a lamp, and on a
   touchscreen a one-finger drag is easy to start on the wrong thing. A control
   that is always in the same place, and always does the same thing, is also
   simply easier to find than a convention.

   The widget is pure DOM and knows nothing about three.js. It reports what the
   user did -- spin by this many radians, zoom by this factor -- and the view
   decides what that means to its camera. It sits as a SIBLING of the canvas,
   not a child, so its pointer events never reach OrbitControls. */

const SVGNS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs) => {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
};

const ZOOM_STEP = 1.25;
const TILT_STEP = Math.PI / 18; /* 10 degrees */

export function createViewControl(host, { onSpin, onTilt, onZoom, onReset, label } = {}) {
  const root = document.createElement("div");
  root.className = "viewctl";
  if (label) root.setAttribute("aria-label", label);

  /* ---- the ring: spin only ----
     The tilt arrows used to live inside the ring, where they sat on top of the
     needle whenever the camera faced north. Spin gets the dial to itself and
     everything else is a button underneath. */
  const R = 30, C = 36;
  const svg = svgEl("svg", { viewBox: "0 0 72 72", class: "viewctl-dial" });
  svg.appendChild(svgEl("circle", { cx: C, cy: C, r: R, class: "vc-ring" }));

  /* Ticks every 30 degrees, longer at the cardinals, so a partial turn reads as
     an amount rather than just "it moved". */
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const long = i % 3 === 0;
    const r0 = R - (long ? 8 : 5);
    svg.appendChild(svgEl("line", {
      x1: C + Math.sin(a) * r0, y1: C - Math.cos(a) * r0,
      x2: C + Math.sin(a) * (R - 1.5), y2: C - Math.cos(a) * (R - 1.5),
      class: long ? "vc-tick vc-tick-long" : "vc-tick",
    }));
  }

  /* The needle rides on the ring and carries a stem to the centre, so the
     heading is readable at a glance at this size. */
  const needle = svgEl("g", { class: "vc-needle" });
  needle.appendChild(svgEl("line", { x1: C, y1: C, x2: C, y2: C - R + 8, class: "vc-stem" }));
  needle.appendChild(svgEl("polygon", {
    points: `${C},${C - R - 1} ${C - 5.5},${C - R + 9} ${C + 5.5},${C - R + 9}`,
  }));
  needle.appendChild(svgEl("circle", { cx: C, cy: C, r: 2.4 }));
  svg.appendChild(needle);
  root.appendChild(svg);

  /* ---- buttons ---- */
  const mkRow = () => {
    const r = document.createElement("div");
    r.className = "viewctl-row";
    root.appendChild(r);
    return r;
  };
  const mk = (row, label, title, fn, isSvg) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "vc-btn";
    b.title = title;
    b.setAttribute("aria-label", title);
    if (isSvg) {
      const i = svgEl("svg", { viewBox: "0 0 16 16", class: "vc-icon" });
      i.appendChild(svgEl("path", { d: label, class: "vc-icon-path" }));
      b.appendChild(i);
    } else b.textContent = label;
    b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    row.appendChild(b);
    return b;
  };

  const tiltRow = mkRow();
  mk(tiltRow, "▲", "Tilt up", () => onTilt && onTilt(-TILT_STEP));
  mk(tiltRow, "▼", "Tilt down", () => onTilt && onTilt(TILT_STEP));

  const zoomRow = mkRow();
  mk(zoomRow, "−", "Zoom out", () => onZoom && onZoom(ZOOM_STEP));
  /* A drawn frame rather than a glyph: the house character is missing from
     plenty of monospace faces and renders as a box. */
  mk(zoomRow, "M2 5V2h3M14 5V2h-3M2 11v3h3M14 11v3h-3", "Fit the view",
     () => onReset && onReset(), true);
  mk(zoomRow, "+", "Zoom in", () => onZoom && onZoom(1 / ZOOM_STEP));

  /* ---- ring drag: the angle you travel around it IS the spin ---- */
  let dragging = false;
  let lastAngle = 0;
  const angleAt = (e) => {
    const r = svg.getBoundingClientRect();
    return Math.atan2(e.clientX - (r.left + r.width / 2), -(e.clientY - (r.top + r.height / 2)));
  };
  svg.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    e.preventDefault();
    dragging = true;
    lastAngle = angleAt(e);
    svg.setPointerCapture(e.pointerId);
    root.classList.add("is-dragging");
  });
  svg.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    e.stopPropagation();
    const a = angleAt(e);
    let d = a - lastAngle;
    /* Unwrap across the -pi/+pi seam, or a drag past due north jumps a turn. */
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    lastAngle = a;
    onSpin && onSpin(d);
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    root.classList.remove("is-dragging");
    try { svg.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
  };
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", endDrag);

  /* Scrolling over the widget zooms, which is what a wheel over a wheel should
     do -- and stops the page scrolling out from under the pointer. */
  root.addEventListener("wheel", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onZoom && onZoom(e.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
  }, { passive: false });

  host.appendChild(root);

  return {
    /* Point the needle where the camera is actually looking. */
    setHeading(rad) { needle.setAttribute("transform", `rotate(${(rad * 180) / Math.PI} ${C} ${C})`); },
    destroy() { root.remove(); },
    element: root,
  };
}
