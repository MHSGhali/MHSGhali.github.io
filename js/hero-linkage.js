/* The homepage hero: a four-bar crank-rocker running on the same engine the
   linkage tool uses, tracing its coupler curve.

   This is the real solver, not a canned animation -- which is the point, and
   also why it costs one small file instead of a hand-authored SVG that would
   have to be kept in step with the tool.

   It stops when it isn't being looked at: under prefers-reduced-motion, when
   the tab is hidden, and when the canvas is scrolled out of view. */

import * as M from "./linkage/mechanism.js?v=554aaff8";
import * as S from "./linkage/solver.js?v=554aaff8";
import * as v from "./linkage/vec2.js?v=554aaff8";

const canvas = document.querySelector("[data-hero-linkage]");
if (canvas) start(canvas);

function start(canvas) {
  const ctx = canvas.getContext("2d");
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");

  /* Grashof crank-rocker (ground 400, crank 100, coupler 350, rocker 300), so
     the crank turns all the way round instead of binding at a limit. The
     coupler point sits off the A-B line, which is what gives the trace its
     shape rather than a plain arc. */
  const m = M.create();
  const o2 = M.addConnector(m, { x: -200, y: 60 }, true);
  const o4 = M.addConnector(m, { x: 200, y: 60 }, true);
  const a = M.addConnector(m, { x: -100, y: 60 });
  const b = M.addConnector(m, circleIntersect({ x: -100, y: 60 }, 350, { x: 200, y: 60 }, 300));
  const p = M.addConnector(m, couplerPoint(m.connectors[a].pos, m.connectors[b].pos));
  M.addLink(m, [o2, a]);
  M.addLink(m, [a, b, p]);
  M.addLink(m, [b, o4]);
  M.toggleDriven(m, 0, 52);
  M.setTraced(m, p, true);

  S.freeze(m);
  const params = S.defaultParams();

  /* Frame the view from the mechanism's actual swept extent, measured once on
     a throwaway copy. Hardcoding a viewbox means re-deriving it by hand every
     time the design changes; this follows it. */
  const view = sweptExtent(m, params);

  /* One full revolution's worth of trace, then it starts overwriting: the
     curve is closed, so a longer tail would just redraw the same line. */
  const TRACE_LIMIT = Math.ceil((360 / 52) * 60);

  let dpr = 1, w = 0, h = 0;
  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = rect.width;
    h = rect.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    /* Assigning canvas.width wipes the bitmap, so a resize must repaint or the
       drawing vanishes until the next simulation frame -- and when the
       animation is paused (reduced motion, hidden tab) there isn't one. */
    draw();
  }
  /* Read the palette from CSS so the drawing follows the theme toggle. Set up
     before the first resize(), which paints. */
  let palette = readPalette();
  function readPalette() {
    const cs = getComputedStyle(document.documentElement);
    return {
      accent: cs.getPropertyValue("--accent").trim() || "#e0a03c",
      line: cs.getPropertyValue("--surface-line").trim() || "#2b2e33",
      text: cs.getPropertyValue("--text").trim() || "#e4e2de",
      faint: cs.getPropertyValue("--text-faint").trim() || "#6b675f",
      elev: cs.getPropertyValue("--bg-elev").trim() || "#191b1f",
    };
  }
  window.addEventListener("themechange", () => { palette = readPalette(); draw(); });

  resize();
  new ResizeObserver(resize).observe(canvas);

  /* --- when to run ---------------------------------------------------- */
  let onScreen = true;
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(
      ([e]) => { onScreen = e.isIntersecting; if (onScreen) tick(); },
      { threshold: 0 }
    ).observe(canvas);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });
  reduce.addEventListener?.("change", () => { tick(); draw(); });

  const running = () => onScreen && !document.hidden && !reduce.matches;

  let raf = 0;
  let last = 0;
  function tick(now) {
    raf = 0;
    if (!running()) { last = 0; return; }
    /* Clamp dt: a backgrounded tab can hand back a multi-second gap, and one
       huge step would jump the solver clean off its branch. */
    const dt = last ? Math.min((now - last) / 1000, 1 / 20) : 1 / 60;
    if (now) last = now;
    S.advance(m, dt, params);
    M.traceStep(m);
    const path = m.connectors[p].path;
    if (path.length > TRACE_LIMIT) path.splice(0, path.length - TRACE_LIMIT);
    draw();
    raf = requestAnimationFrame(tick);
  }

  /* --- drawing --------------------------------------------------------- */
  function draw() {
    if (!w) return;
    /* Scale and centre come from the swept extent, so joints never drift out
       of frame and the view never jitters as they move. */
    const scale = Math.min(w / view.w, h / view.h);
    const X = (pt) => w / 2 + (pt.x - view.cx) * scale;
    const Y = (pt) => h / 2 + (pt.y - view.cy) * scale;

    ctx.clearRect(0, 0, w, h);

    /* ground line */
    ctx.strokeStyle = palette.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, Y({ y: 60 }) + 0.5);
    ctx.lineTo(w, Y({ y: 60 }) + 0.5);
    ctx.stroke();

    /* the traced coupler curve */
    const path = m.connectors[p].path;
    if (path.length > 1) {
      ctx.strokeStyle = palette.accent;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(X(path[0]), Y(path[0]));
      for (let i = 1; i < path.length; i++) ctx.lineTo(X(path[i]), Y(path[i]));
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    /* links: the coupler is a plate, so fill its triangle faintly */
    const coupler = m.links[1];
    ctx.fillStyle = palette.accent;
    ctx.globalAlpha = 0.08;
    ctx.beginPath();
    coupler.connectorIds.forEach((cid, i) => {
      const q = m.connectors[cid].pos;
      i === 0 ? ctx.moveTo(X(q), Y(q)) : ctx.lineTo(X(q), Y(q));
    });
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.lineCap = "round";
    for (const l of m.links) {
      if (!l.alive) continue;
      ctx.strokeStyle = l.isDriven ? palette.accent : palette.text;
      ctx.lineWidth = l.isDriven ? 3 : 2.5;
      for (let i = 0; i < l.connectorIds.length; i++) {
        for (let j = i + 1; j < l.connectorIds.length; j++) {
          const q1 = m.connectors[l.connectorIds[i]].pos;
          const q2 = m.connectors[l.connectorIds[j]].pos;
          ctx.beginPath();
          ctx.moveTo(X(q1), Y(q1));
          ctx.lineTo(X(q2), Y(q2));
          ctx.stroke();
        }
      }
    }

    /* joints: anchors are grounded triangles, everything else a pin */
    for (const c of m.connectors) {
      if (!c.alive) continue;
      const x = X(c.pos), y = Y(c.pos);
      if (c.isAnchor) {
        ctx.fillStyle = palette.faint;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - 9, y + 14);
        ctx.lineTo(x + 9, y + 14);
        ctx.closePath();
        ctx.fill();
      }
      ctx.fillStyle = c.traced ? palette.accent : palette.elev;
      ctx.strokeStyle = c.traced ? palette.accent : palette.text;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, c.traced ? 5 : 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  draw();
  tick();
}

/* --- geometry helpers, so the design above reads as lengths ------------- */

function circleIntersect(a, ra, b, rb) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  const t = (ra * ra - rb * rb + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, ra * ra - t * t));
  return { x: a.x + (t * dx) / d - (h * dy) / d, y: a.y + (t * dy) / d + (h * dx) / d };
}

/* Runs one revolution on a clone and returns the box every joint stayed
   inside, padded a little. The clone means this never disturbs the live
   mechanism's state or its warm start. */
function sweptExtent(m, params) {
  const sim = M.clone(m);
  S.freeze(sim);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < 60 * 8; i++) {
    S.advance(sim, 1 / 60, params);
    for (const c of sim.connectors) {
      if (!c.alive) continue;
      x0 = Math.min(x0, c.pos.x); x1 = Math.max(x1, c.pos.x);
      y0 = Math.min(y0, c.pos.y); y1 = Math.max(y1, c.pos.y);
    }
  }
  const pad = 40;
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
}

/* A point rigidly attached to the coupler, off the A-B line. */
function couplerPoint(a, b) {
  const mid = v.scale(v.add(a, b), 0.5);
  const n = v.perp(v.scale(v.sub(b, a), 1 / v.dist(a, b)));
  return v.add(mid, v.scale(n, -150));
}
