/* 2D vector helpers. A direct transliteration of the C tool's src/vec2.h, kept
   as free functions over plain {x, y} objects so the ported mechanism and
   solver code reads like the original. */

export const vec2 = (x, y) => ({ x, y });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a, s) => ({ x: a.x * s, y: a.y * s });
export const dot = (a, b) => a.x * b.x + a.y * b.y;
export const len = (a) => Math.hypot(a.x, a.y);
export const dist2 = (a, b) => { const dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; };
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const perp = (a) => ({ x: -a.y, y: a.x });
export const cross = (a, b) => a.x * b.y - a.y * b.x;
export const fromAngle = (t) => ({ x: Math.cos(t), y: Math.sin(t) });

export function rotate(v, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}
