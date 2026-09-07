/* Rays, intersections and analytic primitives, from src/geom.c.

   A linear scan over primitives, as in the C: a BVH is deliberately absent
   until the transport physics is validated, because an energy-conservation
   failure with no acceleration structure present can only be a BSDF, PDF or
   estimator bug. These scenes are a handful of primitives, so it stays fast. */

import { PI } from "./core.js?v=19c91c08";
import * as v from "./vec3.js?v=19c91c08";

export const SPHERE = "sphere";
export const PLANE = "plane";   /* infinite plane through c with normal n */
export const DISK = "disk";     /* radius r, in the plane through c with normal n */
export const QUAD = "quad";     /* parallelogram: c +/- ex +/- ey (half-edges) */

/* Surface area; 0 for an infinite plane. */
export function primArea(p) {
  switch (p.kind) {
    case SPHERE: return 4 * PI * p.r * p.r;
    case DISK:   return PI * p.r * p.r;
    case QUAD:   return 4 * v.len(v.cross(p.ex, p.ey));
    case PLANE:  return 0;
  }
  return 0;
}

function hitSphere(p, ray, out) {
  const oc = v.sub(ray.o, p.c);
  const b = v.dot(oc, ray.d);
  const c = v.dot(oc, oc) - p.r * p.r;
  const disc = b * b - c;
  if (disc < 0) return false;
  const sq = Math.sqrt(disc);
  let t = -b - sq;
  if (t <= ray.tmin || t >= ray.tmax) {
    t = -b + sq;
    if (t <= ray.tmin || t >= ray.tmax) return false;
  }
  out.t = t;
  out.n = v.scale(v.sub(v.add(ray.o, v.scale(ray.d, t)), p.c), 1 / p.r);
  return true;
}

function hitPlaneT(p, ray, out) {
  const denom = v.dot(ray.d, p.n);
  if (Math.abs(denom) < 1e-12) return false; /* parallel */
  const t = v.dot(v.sub(p.c, ray.o), p.n) / denom;
  if (t <= ray.tmin || t >= ray.tmax) return false;
  out.t = t;
  return true;
}

function hitDisk(p, ray, out) {
  if (!hitPlaneT(p, ray, out)) return false;
  const q = v.sub(v.add(ray.o, v.scale(ray.d, out.t)), p.c);
  if (v.len2(q) > p.r * p.r) return false;
  return true;
}

function hitQuad(p, ray, out) {
  if (!hitPlaneT(p, ray, out)) return false;
  const q = v.sub(v.add(ray.o, v.scale(ray.d, out.t)), p.c);
  /* Project onto the half-edge vectors; |coord| <= 1 is inside. */
  const ex2 = v.len2(p.ex), ey2 = v.len2(p.ey);
  if (ex2 <= 0 || ey2 <= 0) return false;
  const a = v.dot(q, p.ex) / ex2;
  const b = v.dot(q, p.ey) / ey2;
  if (Math.abs(a) > 1 || Math.abs(b) > 1) return false;
  return true;
}

const scratch = { t: 0, n: null };

/* Nearest intersection in (ray.tmin, ray.tmax). Fills `hit`, returns true on a
   hit, and does not modify the ray. */
export function primIntersect(p, primId, ray, hit) {
  scratch.n = p.n;
  switch (p.kind) {
    case SPHERE: if (!hitSphere(p, ray, scratch)) return false; break;
    case PLANE:  if (!hitPlaneT(p, ray, scratch)) return false; break;
    case DISK:   if (!hitDisk(p, ray, scratch))   return false; break;
    case QUAD:   if (!hitQuad(p, ray, scratch))   return false; break;
    default: return false;
  }
  hit.t = scratch.t;
  hit.p = v.add(ray.o, v.scale(ray.d, scratch.t));
  /* The GEOMETRIC normal, in raw winding order. NEVER flipped by the
     intersector: flipping it silently is a whole family of energy-leak bugs.
     `backface` records the orientation instead. */
  hit.ng = scratch.n;
  hit.primId = primId;
  hit.matId = p.matId;
  hit.lightId = p.lightId;
  hit.backface = v.dot(ray.d, scratch.n) > 0;
  return true;
}

/* Any-hit test for shadow rays: returns on the first hit, ignores ordering. */
export function primOccludes(p, ray) {
  scratch.n = p.n;
  switch (p.kind) {
    case SPHERE: return hitSphere(p, ray, scratch);
    case PLANE:  return hitPlaneT(p, ray, scratch);
    case DISK:   return hitDisk(p, ray, scratch);
    case QUAD:   return hitQuad(p, ray, scratch);
  }
  return false;
}

/* Offset a ray origin off a surface to avoid self-intersection. Along the
   GEOMETRIC normal, scaled by the point magnitude, so it holds up from
   millimetre to kilometre scene scales. */
export function offsetOrigin(p, ng, dir) {
  const s = v.dot(ng, dir) < 0 ? -1 : 1;
  const mag = Math.max(1, Math.max(Math.abs(p.x), Math.max(Math.abs(p.y), Math.abs(p.z))));
  return v.add(p, v.scale(ng, s * 1e-9 * mag));
}

export const makeHit = () => ({
  t: 0, p: null, ng: null, primId: -1, matId: -1, lightId: -1, backface: false,
});
