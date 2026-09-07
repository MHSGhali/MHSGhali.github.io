/* 3D vector maths and the sampling warps used by the estimators, from
   include/lightsim/vec.h.

   Every warp documents the measure its PDF is expressed in. Confusing solid
   angle with projected solid angle is the classic way to get a renderer that
   looks right and integrates wrong. */

import { PI, TWO_PI, INV_PI } from "./core.js";

export const v3 = (x, y, z) => ({ x, y, z });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const mul = (a, b) => ({ x: a.x * b.x, y: a.y * b.y, z: a.z * b.z });
export const scale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const neg = (a) => ({ x: -a.x, y: -a.y, z: -a.z });
export const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const len2 = (a) => dot(a, a);
export const len = (a) => Math.sqrt(dot(a, a));
export const dist = (a, b) => len(sub(a, b));
export const lerp = (t, a, b) => add(a, scale(sub(b, a), t));

export function normalize(a) {
  const l = len(a);
  return l > 0 ? scale(a, 1 / l) : a;
}

/* Orthonormal basis around a unit normal (Duff et al., branchless, stable).
   The sign test reproduces C's copysign, which returns -1 for negative zero --
   `n.z >= 0` would not, and the two bases differ. */
export function basis(n) {
  const sign = n.z < 0 || (n.z === 0 && 1 / n.z < 0) ? -1 : 1;
  const a = -1 / (sign + n.z);
  const b = n.x * n.y * a;
  return {
    n,
    t: v3(1 + sign * n.x * n.x * a, sign * b, -sign * n.x),
    b: v3(b, sign + n.y * n.y * a, -n.y),
  };
}
export const basisToWorld = (o, v) =>
  add(add(scale(o.t, v.x), scale(o.b, v.y)), scale(o.n, v.z));
export const basisToLocal = (o, v) => v3(dot(v, o.t), dot(v, o.b), dot(v, o.n));

/* ---- sampling warps ---- */

/* Concentric (Shirley-Chiu) unit-disk map: low distortion, area-uniform. */
export function sampleDiskConcentric(u1, u2) {
  const ox = 2 * u1 - 1, oy = 2 * u2 - 1;
  if (ox === 0 && oy === 0) return { x: 0, y: 0 };
  let rad, theta;
  if (Math.abs(ox) > Math.abs(oy)) { rad = ox; theta = (PI / 4) * (oy / ox); }
  else { rad = oy; theta = PI / 2 - (PI / 4) * (ox / oy); }
  return { x: rad * Math.cos(theta), y: rad * Math.sin(theta) };
}

/* Cosine-weighted hemisphere about +z. PDF is cos(theta)/pi in SOLID ANGLE. */
export function sampleHemisphereCosine(u1, u2) {
  const d = sampleDiskConcentric(u1, u2);
  const z = Math.sqrt(Math.max(0, 1 - d.x * d.x - d.y * d.y));
  return v3(d.x, d.y, z);
}
export const pdfHemisphereCosine = (cosTheta) => (cosTheta > 0 ? cosTheta * INV_PI : 0);

/* Uniform on the unit sphere. PDF 1/(4 pi) in solid angle. */
export function sampleSphereUniform(u1, u2) {
  const z = 1 - 2 * u1;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  const phi = TWO_PI * u2;
  return v3(r * Math.cos(phi), r * Math.sin(phi), z);
}

/* Uniform inside a cone of half-angle acos(cosMax) about +z.
   PDF 1/(2 pi (1 - cosMax)) in solid angle. */
export function sampleConeUniform(u1, u2, cosMax) {
  const cosTheta = 1 - u1 + u1 * cosMax;
  const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
  const phi = TWO_PI * u2;
  return v3(sinTheta * Math.cos(phi), sinTheta * Math.sin(phi), cosTheta);
}
export const pdfConeUniform = (cosMax) => 1 / (TWO_PI * (1 - cosMax));

/* Solid angle of a cone of half-angle alpha: 2 pi (1 - cos alpha). The relation
   used to convert a source's angular span into steradians. */
export const coneSolidAngle = (halfAngleRad) => TWO_PI * (1 - Math.cos(halfAngleRad));

/* Convert a PDF from area measure on a light to solid angle measure at the
   shading point. THE single place this Jacobian is applied.
     pdf_omega = pdf_area * d^2 / |cos(theta_light)|
   Returns 0 when the light element is edge-on: the conversion is singular. */
export function pdfAreaToSolidAngle(pdfArea, dist2, cosThetaLight) {
  const c = Math.abs(cosThetaLight);
  if (c <= 1e-9) return 0;
  return (pdfArea * dist2) / c;
}
