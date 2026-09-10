/* Surface scattering, from src/bsdf.c.

   CONVENTIONS (stated once, relied on everywhere):

     - All directions are in the LOCAL shading frame, +z along the normal, and
       point AWAY from the surface.
     - eval() returns f, the BRDF, in units of 1/sr. It does NOT include the
       cosine factor. The cosine belongs to the estimator, where it appears
       exactly twice: once in NEE, once in the path continuation.
     - pdf() is ALWAYS in solid-angle measure, 1/sr. Never projected solid angle.
     - `alpha` is the GGX width parameter, stored directly. The
       alpha = roughness^2 remapping is an artist convention and belongs in a
       scene parser, not in the physics. */

import { PI, INV_PI, clamp } from "./core.js?v=e7629c32";
import * as v from "./vec3.js?v=e7629c32";
import * as S from "./spectrum.js?v=e7629c32";

export const LAMBERT = "lambert";
export const CONDUCTOR = "conductor";

/* Fresnel reflectance of a dielectric interface, real IOR ratio eta. */
export function fresnelDielectric(cosTheta, eta) {
  cosTheta = clamp(cosTheta, -1, 1);
  if (cosTheta < 0) { eta = 1 / eta; cosTheta = -cosTheta; }
  const sin2t = (1 - cosTheta * cosTheta) / (eta * eta);
  if (sin2t >= 1) return 1; /* total internal reflection */
  const cosT = Math.sqrt(1 - sin2t);
  const rs = (cosTheta - eta * cosT) / (cosTheta + eta * cosT);
  const rp = (eta * cosTheta - cosT) / (eta * cosTheta + cosT);
  return 0.5 * (rs * rs + rp * rp);
}

/* Unpolarised Fresnel for an absorbing medium. The a^2+b^2 formulation, which
   stays numerically stable across the whole angle range. */
export function fresnelConductor(cosTheta, n, k) {
  cosTheta = clamp(cosTheta, 0, 1);
  const c2 = cosTheta * cosTheta;
  const s2 = 1 - c2;
  const n2 = n * n, k2 = k * k;

  const t0 = n2 - k2 - s2;
  const a2b2 = Math.sqrt(Math.max(0, t0 * t0 + 4 * n2 * k2));
  const t1 = a2b2 + c2;
  const a = Math.sqrt(Math.max(0, 0.5 * (a2b2 + t0)));
  const t2 = 2 * a * cosTheta;
  const rs = (t1 - t2) / (t1 + t2);

  const t3 = c2 * a2b2 + s2 * s2;
  const t4 = t2 * s2;
  const rp = (rs * (t3 - t4)) / (t3 + t4);

  return 0.5 * (rs + rp);
}

export function ggxD(cosThetaM, alpha) {
  if (cosThetaM <= 0) return 0;
  const a2 = alpha * alpha;
  const c2 = cosThetaM * cosThetaM;
  const t = c2 * (a2 - 1) + 1;
  return a2 / (PI * t * t);
}

function ggxLambda(w, alpha) {
  const c = Math.abs(w.z);
  if (c >= 1) return 0;
  const tan2 = (1 - c * c) / (c * c);
  return 0.5 * (-1 + Math.sqrt(1 + alpha * alpha * tan2));
}

export const ggxG1 = (w, alpha) => 1 / (1 + ggxLambda(w, alpha));

/* Height-correlated Smith: less energy loss than the separable form. */
export const ggxG2 = (wo, wi, alpha) =>
  1 / (1 + ggxLambda(wo, alpha) + ggxLambda(wi, alpha));

/* Sample the GGX distribution of VISIBLE normals (Heitz 2018). Sampling the
   visible normals rather than D itself removes the samples that would be
   masked, which is where most of the variance in a naive GGX sampler lives. */
function sampleGgxVndf(wo, alpha, u1, u2) {
  const vh = v.normalize(v.v3(alpha * wo.x, alpha * wo.y, wo.z));
  const l2 = vh.x * vh.x + vh.y * vh.y;
  const t1 = l2 > 0 ? v.scale(v.v3(-vh.y, vh.x, 0), 1 / Math.sqrt(l2)) : v.v3(1, 0, 0);
  const t2 = v.cross(vh, t1);

  const r = Math.sqrt(u1);
  const phi = 2 * PI * u2;
  const p1 = r * Math.cos(phi);
  let p2 = r * Math.sin(phi);
  const s = 0.5 * (1 + vh.z);
  p2 = (1 - s) * Math.sqrt(Math.max(0, 1 - p1 * p1)) + s * p2;

  const nh = v.add(
    v.add(v.scale(t1, p1), v.scale(t2, p2)),
    v.scale(vh, Math.sqrt(Math.max(0, 1 - p1 * p1 - p2 * p2)))
  );
  return v.normalize(v.v3(alpha * nh.x, alpha * nh.y, Math.max(1e-12, nh.z)));
}

export const isDelta = (b) => b.kind === CONDUCTOR && b.alpha <= 0;

function conductorFresnelSpectrum(b, cosTheta, out) {
  for (let i = 0; i < S.NBINS; i++) out[i] = fresnelConductor(cosTheta, b.eta[i], b.kappa[i]);
  return out;
}

/* f, in 1/sr, WITHOUT the cosine. */
export function evalBsdf(b, wo, wi, fOut) {
  fOut.fill(0);
  if (wo.z <= 0 || wi.z <= 0) return fOut; /* same hemisphere only */

  if (b.kind === LAMBERT) return S.scale(b.rho, INV_PI, fOut);
  if (b.alpha <= 0) return fOut; /* delta: no density */

  const m = v.normalize(v.add(wo, wi)); /* half vector */
  if (m.z <= 0) return fOut;
  const d = ggxD(m.z, b.alpha);
  const g2 = ggxG2(wo, wi, b.alpha);
  const denom = 4 * wo.z * wi.z;
  if (denom <= 0) return fOut;

  conductorFresnelSpectrum(b, v.dot(wi, m), fOut);
  return S.scale(fOut, (d * g2) / denom, fOut);
}

/* Solid-angle pdf of sampling wi given wo. Zero for delta lobes. */
export function pdfBsdf(b, wo, wi) {
  if (wo.z <= 0 || wi.z <= 0) return 0;
  if (b.kind === LAMBERT) return v.pdfHemisphereCosine(wi.z);
  if (b.alpha <= 0) return 0; /* delta */

  const m = v.normalize(v.add(wo, wi));
  if (m.z <= 0) return 0;
  /* pdf(wi) = D_visible(m) / (4 |wo . m|) */
  const dotOm = v.dot(wo, m);
  if (dotOm <= 0) return 0;
  const dv = (ggxG1(wo, b.alpha) * dotOm * ggxD(m.z, b.alpha)) / wo.z;
  return dv / (4 * dotOm);
}

/* Draw a direction. Returns null if the sample is degenerate. */
export function sampleBsdf(b, wo, u1, u2, fOut) {
  if (wo.z <= 0) return null;

  if (b.kind === LAMBERT) {
    const wi = v.sampleHemisphereCosine(u1, u2);
    const pdf = v.pdfHemisphereCosine(wi.z);
    if (pdf <= 0) return null;
    S.scale(b.rho, INV_PI, fOut);
    return { wi, pdf };
  }

  if (b.alpha <= 0) {
    /* Perfect mirror. f is a delta; return f such that f*cos/pdf gives the
       Fresnel term exactly, with pdf reported as 1 by convention. */
    const wi = v.v3(-wo.x, -wo.y, wo.z);
    conductorFresnelSpectrum(b, wi.z, fOut);
    S.scale(fOut, 1 / Math.max(1e-12, wi.z), fOut);
    return { wi, pdf: 1 };
  }

  const m = sampleGgxVndf(wo, b.alpha, u1, u2);
  const dotOm = v.dot(wo, m);
  if (dotOm <= 0) return null;
  const wi = v.sub(v.scale(m, 2 * dotOm), wo); /* reflect wo about m */
  if (wi.z <= 0) return null;

  const pdf = pdfBsdf(b, wo, wi);
  if (pdf <= 0) return null;
  evalBsdf(b, wo, wi, fOut);
  return { wi, pdf };
}

/* ---- spectral complex IOR presets (Rakic et al., abridged) ---- */

const METALS = {
  al: {
    lam: Float64Array.of(400, 450, 500, 550, 600, 650, 700, 750, 800),
    n: Float64Array.of(0.49, 0.618, 0.769, 0.958, 1.2, 1.47, 1.83, 2.4, 2.75),
    k: Float64Array.of(4.86, 5.47, 6.08, 6.69, 7.26, 7.79, 8.31, 8.62, 8.31),
  },
  cu: {
    lam: Float64Array.of(400, 450, 500, 550, 600, 650, 700, 750, 800),
    n: Float64Array.of(1.18, 1.18, 1.12, 0.826, 0.468, 0.243, 0.214, 0.223, 0.26),
    k: Float64Array.of(2.21, 2.21, 2.6, 2.6, 2.81, 3.31, 3.75, 4.14, 4.55),
  },
  au: {
    lam: Float64Array.of(400, 450, 500, 550, 600, 650, 700, 750, 800),
    n: Float64Array.of(1.658, 1.578, 0.849, 0.371, 0.242, 0.192, 0.166, 0.157, 0.153),
    k: Float64Array.of(1.956, 1.867, 1.871, 2.399, 2.966, 3.47, 3.929, 4.357, 4.759),
  },
};
export const METAL_NAMES = Object.keys(METALS);

export function metal(name) {
  const m = METALS[name] || METALS.al;
  return {
    eta: S.fromSamples(m.lam, m.n, m.lam.length),
    kappa: S.fromSamples(m.lam, m.k, m.lam.length),
  };
}

export function makeLambert(rho) {
  return { kind: LAMBERT, rho, eta: null, kappa: null, alpha: 0 };
}
export function makeConductor(name, alpha) {
  const { eta, kappa } = metal(name);
  return { kind: CONDUCTOR, rho: S.zero(), eta, kappa, alpha };
}
