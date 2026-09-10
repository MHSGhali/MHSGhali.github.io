/* Primitive and light aggregation plus visibility queries, from src/scene.c.
   Linear scan, as in the C. */

import { primIntersect, primOccludes, offsetOrigin, makeHit } from "./geom.js?v=3da9737a";

export function createScene() {
  return { prims: [], mats: [], lights: [] };
}

const tmpHit = makeHit();

/* Nearest hit. Returns false if the ray escapes. */
export function intersect(sc, ray, hit) {
  const r = { o: ray.o, d: ray.d, tmin: ray.tmin, tmax: ray.tmax };
  let found = false;
  for (let i = 0; i < sc.prims.length; i++) {
    if (primIntersect(sc.prims[i], i, r, tmpHit)) {
      r.tmax = tmpHit.t; /* shrink so later prims must beat it */
      hit.t = tmpHit.t; hit.p = tmpHit.p; hit.ng = tmpHit.ng;
      hit.primId = tmpHit.primId; hit.matId = tmpHit.matId;
      hit.lightId = tmpHit.lightId; hit.backface = tmpHit.backface;
      found = true;
    }
  }
  return found;
}

/* Is the segment from `p` (offset off the surface along `ng`) toward `wi`, of
   length `dist`, blocked? `dist` may be Infinity for directional lights. The
   segment is shortened slightly at the far end so a light's own geometry does
   not shadow it. */
export function occluded(sc, p, ng, wi, dist) {
  const r = {
    o: offsetOrigin(p, ng, wi),
    d: wi,
    tmin: 0,
    tmax: dist === Infinity ? Infinity : dist * (1 - 1e-6),
  };
  for (let i = 0; i < sc.prims.length; i++) {
    if (primOccludes(sc.prims[i], r)) return true;
  }
  return false;
}
