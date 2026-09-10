/* Constraint solver, ported from the C tool's src/solver.c.

   Driven links are posed directly each frame (their frozen shape rotated
   around an anchored pivot); every other connector is solved with a
   Levenberg-Marquardt damped Gauss-Newton iteration over pairwise
   rest-distance residuals, warm-started from the previous frame. Warm-starting
   is what keeps the motion on a continuous branch, so there is no special case
   for four-bar branch ambiguity and the whole thing generalizes to open
   chains, multi-loop mechanisms, and ternary-or-larger links.

   Two kinds of residual share the one least-squares problem. A PAIR residual
   is a squared-distance between two connectors, in units of length^2. A RAIL
   residual holds a slider's pin on the line through two other connectors and
   is naturally linear, in units of length. Mixing them unscaled would be a
   mistake: the single Levenberg damping term is scaled by the largest diagonal
   of JtJ across the whole problem, so a residual an order of magnitude smaller
   in its natural units would simply be ignored. RAIL is therefore multiplied
   by a characteristic length of the mechanism, putting both in length^2. The
   rail's own endpoints get Jacobian entries too -- unlike a fixed guide axis
   the line may itself be moving, which is what makes it a pin running in a
   slot rather than a prismatic joint on ground.

   Two comments from the C are reproduced below because they explain choices
   that look arbitrary and are not: the global damping scale, and why
   convergence and binding are judged by different measures. */

import * as v from "./vec2.js?v=e7629c32";
import { pairIndex, liveSliders } from "./mechanism.js?v=e7629c32";
import { solve as linalgSolve } from "./linalg.js?v=e7629c32";

export function defaultParams() {
  return {
    maxIters: 30,
    tol: 1e-6,
    lambdaInit: 1e-3,
    dampingFloor: 1e-9,
    gravity: { x: 0, y: 0 },
    /* Deliberately tight: a solve that actually converges lands within ~1e-9
       of the rest length, so anything approaching a visible fraction of a unit
       means the solver is straining against geometry it cannot satisfy. */
    lengthTolAbs: 0.02,
    lengthTolRel: 0.0001,
  };
}

/* Largest rest distance anywhere in the mechanism -- the natural length scale
   for making the two residual kinds dimensionally comparable. */
function characteristicLength(m) {
  let best = 0;
  for (const l of m.links) {
    if (!l.alive) continue;
    const k = l.connectorIds.length;
    for (let i = 0; i < k; i++) {
      for (let j = i + 1; j < k; j++) {
        const d = l.restDist[pairIndex(i, j, k)];
        if (d > best) best = d;
      }
    }
  }
  return best > 1e-9 ? best : 1;
}

/* Call once when transitioning from editing to running: freezes every link's
   rest shape from current positions, and for driven links captures each
   connector's offset from the pivot at angle zero. */
export function freeze(m) {
  for (const c of m.connectors) c.prevPos = { x: c.pos.x, y: c.pos.y };

  for (const l of m.links) {
    if (!l.alive) continue;

    const k = l.connectorIds.length;
    for (let i = 0; i < k; i++) {
      for (let j = i + 1; j < k; j++) {
        l.restDist[pairIndex(i, j, k)] = v.dist(
          m.connectors[l.connectorIds[i]].pos,
          m.connectors[l.connectorIds[j]].pos
        );
      }
    }

    if (l.isDriven) {
      const pivotPos = m.connectors[l.pivotConnectorId].pos;
      l.frozenLocalOffset = l.connectorIds.map((cid) =>
        v.sub(m.connectors[cid].pos, pivotPos)
      );
      l.accumulatedAngleRad = 0;
    }
  }
}

function poseDrivenLinks(m) {
  for (const l of m.links) {
    if (!l.alive || !l.isDriven) continue;
    const pivotPos = m.connectors[l.pivotConnectorId].pos;
    for (let i = 0; i < l.connectorIds.length; i++) {
      const cid = l.connectorIds[i];
      if (cid === l.pivotConnectorId) continue; /* anchor, never moves */
      m.connectors[cid].pos = v.add(
        pivotPos,
        v.rotate(l.frozenLocalOffset[i], l.accumulatedAngleRad)
      );
    }
  }
}

/* Anchors and every connector belonging to a driven link are fixed: the
   former by definition, the latter because poseDrivenLinks has already put
   them exactly where they belong. */
function connectorIsFixed(m, cid) {
  if (m.connectors[cid].isAnchor) return true;
  for (const l of m.links) {
    if (!l.alive || !l.isDriven) continue;
    if (l.connectorIds.includes(cid)) return true;
  }
  return false;
}

/* One Gauss-Newton solve. `enforceVariableLinks` decides whether links whose
   length has been toggled variable are held at their rest length (treated
   exactly like rigid ones) or left entirely unconstrained. */
function solvePass(m, params, enforceVariableLinks) {
  const nconn = m.connectors.length;
  const freeIndex = new Int32Array(nconn).fill(-1);
  let numFree = 0;
  for (let c = 0; c < nconn; c++) {
    if (m.connectors[c].alive && !connectorIsFixed(m, c)) freeIndex[c] = numFree++;
  }
  if (numFree === 0) return true;

  /* Residual list: one entry per enforced pairwise distance that has at least
     one free endpoint. Driven links are exactly satisfied by construction. */
  const resCi = [], resCj = [], resRest = [];
  /* Parallel to the arrays above: -1 marks an ordinary PAIR residual, and any
     other value is the slider's rail-A connector, making the row a RAIL. */
  const resRailA = [], resRailB = [];
  for (const l of m.links) {
    if (!l.alive || l.isDriven) continue;
    if (!l.rigid && !enforceVariableLinks) continue;
    const k = l.connectorIds.length;
    for (let i = 0; i < k; i++) {
      for (let j = i + 1; j < k; j++) {
        const ci = l.connectorIds[i], cj = l.connectorIds[j];
        if (freeIndex[ci] < 0 && freeIndex[cj] < 0) continue; /* both fixed */
        resCi.push(ci); resCj.push(cj);
        resRest.push(l.restDist[pairIndex(i, j, k)]);
        resRailA.push(-1); resRailB.push(-1);
      }
    }
  }

  /* Sliders and pins-in-slots: the pin is held on the rail's line. */
  const railScale = characteristicLength(m);
  for (const sl of liveSliders(m)) {
    /* Nothing to solve if every point involved is already placed. */
    if (freeIndex[sl.pinConnectorId] < 0 &&
        freeIndex[sl.railAId] < 0 && freeIndex[sl.railBId] < 0) continue;
    resCi.push(sl.pinConnectorId); resCj.push(sl.pinConnectorId);
    resRest.push(0);
    resRailA.push(sl.railAId); resRailB.push(sl.railBId);
  }

  const nres = resCi.length;
  if (nres === 0) return true;

  const n = 2 * numFree;
  const x = new Float64Array(n);
  for (let c = 0; c < nconn; c++) {
    const fi = freeIndex[c];
    if (fi >= 0) { x[2 * fi] = m.connectors[c].pos.x; x[2 * fi + 1] = m.connectors[c].pos.y; }
  }

  const r = new Float64Array(nres);
  const rnew = new Float64Array(nres);
  const J = new Float64Array(nres * n);
  const JtJ = new Float64Array(n * n);
  const rhs = new Float64Array(n);
  const Mtmp = new Float64Array(n * n);
  const rhsTmp = new Float64Array(n);
  const delta = new Float64Array(n);
  const xnew = new Float64Array(n);

  const posX = (xv, cid) => (freeIndex[cid] >= 0 ? xv[2 * freeIndex[cid]] : m.connectors[cid].pos.x);
  const posY = (xv, cid) => (freeIndex[cid] >= 0 ? xv[2 * freeIndex[cid] + 1] : m.connectors[cid].pos.y);

  function evalResiduals(xv, rOut) {
    let cost = 0;
    for (let k = 0; k < nres; k++) {
      let rr;
      if (resRailA[k] >= 0) {
        /* Signed distance from the pin to the rail line, scaled into length^2. */
        const ax = posX(xv, resRailA[k]), ay = posY(xv, resRailA[k]);
        const ddx = posX(xv, resRailB[k]) - ax, ddy = posY(xv, resRailB[k]) - ay;
        const dlen = Math.hypot(ddx, ddy);
        if (dlen > 1e-12) {
          const qx = posX(xv, resCi[k]) - ax, qy = posY(xv, resCi[k]) - ay;
          rr = ((ddx * qy - ddy * qx) / dlen) * railScale;
        } else {
          rr = 0;
        }
      } else {
        const dx = posX(xv, resCi[k]) - posX(xv, resCj[k]);
        const dy = posY(xv, resCi[k]) - posY(xv, resCj[k]);
        rr = dx * dx + dy * dy - resRest[k] * resRest[k];
      }
      rOut[k] = rr;
      cost += rr * rr;
    }
    return cost;
  }

  function buildJacobian(xv) {
    J.fill(0);
    for (let k = 0; k < nres; k++) {
      if (resRailA[k] >= 0) {
        /* r = cross(d, q) / |d|, differentiated through the pin AND the rail's
           own endpoints, since the rail may belong to a moving link. */
        const pin = resCi[k], ra = resRailA[k], rb = resRailB[k];
        const ax = posX(xv, ra), ay = posY(xv, ra);
        const dx = posX(xv, rb) - ax, dy = posY(xv, rb) - ay;
        const dlen = Math.hypot(dx, dy);
        if (dlen < 1e-12) continue;
        const qx = posX(xv, pin) - ax, qy = posY(xv, pin) - ay;
        const f = dx * qy - dy * qx;          /* |d| * signed distance */
        const l3 = dlen * dlen * dlen;
        const sc = railScale;
        if (freeIndex[pin] >= 0) {
          J[k * n + 2 * freeIndex[pin]] += (-dy / dlen) * sc;
          J[k * n + 2 * freeIndex[pin] + 1] += (dx / dlen) * sc;
        }
        if (freeIndex[ra] >= 0) {
          J[k * n + 2 * freeIndex[ra]] += ((-qy + dy) / dlen + (f * dx) / l3) * sc;
          J[k * n + 2 * freeIndex[ra] + 1] += ((-dx + qx) / dlen + (f * dy) / l3) * sc;
        }
        if (freeIndex[rb] >= 0) {
          J[k * n + 2 * freeIndex[rb]] += (qy / dlen - (f * dx) / l3) * sc;
          J[k * n + 2 * freeIndex[rb] + 1] += (-qx / dlen - (f * dy) / l3) * sc;
        }
        continue;
      }
      const ci = resCi[k], cj = resCj[k];
      const dx = posX(xv, ci) - posX(xv, cj);
      const dy = posY(xv, ci) - posY(xv, cj);
      if (freeIndex[ci] >= 0) {
        J[k * n + 2 * freeIndex[ci]] += 2 * dx;
        J[k * n + 2 * freeIndex[ci] + 1] += 2 * dy;
      }
      if (freeIndex[cj] >= 0) {
        J[k * n + 2 * freeIndex[cj]] -= 2 * dx;
        J[k * n + 2 * freeIndex[cj] + 1] -= 2 * dy;
      }
    }
  }

  let cost = evalResiduals(x, r);
  let lambda = params.lambdaInit;
  let converged = cost <= params.tol * params.tol;

  for (let iter = 0; iter < params.maxIters && !converged; iter++) {
    buildJacobian(x);

    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        let s = 0;
        for (let k = 0; k < nres; k++) s += J[k * n + a] * J[k * n + b];
        JtJ[a * n + b] = s;
      }
      let s = 0;
      for (let k = 0; k < nres; k++) s += J[k * n + a] * r[k];
      rhs[a] = -s;
    }

    /* Damping is scaled to the whole problem (the largest diagonal of JtJ),
       not to each diagonal entry individually. Per-entry (Marquardt) scaling
       fails badly in a near-null direction: a pendulum hanging straight down
       has dx~0, so the x diagonal ~4dx^2 is nearly zero and lambda*4dx^2 damps
       it essentially not at all, letting Gauss-Newton propose an enormous
       sideways step (the direction that changes length only to second order).
       Every such step is rejected, the solve gives up, and the link silently
       stretches. Damping by the problem's overall magnitude restrains that
       direction. */
    let maxDiag = 0;
    for (let d = 0; d < n; d++) maxDiag = Math.max(maxDiag, JtJ[d * n + d]);
    if (maxDiag <= 0) maxDiag = 1;

    let improved = false;
    for (let sub = 0; sub < 12 && !improved; sub++) {
      Mtmp.set(JtJ);
      for (let d = 0; d < n; d++) Mtmp[d * n + d] += lambda * maxDiag + params.dampingFloor;
      rhsTmp.set(rhs);

      if (!linalgSolve(Mtmp, rhsTmp, n, delta)) { lambda *= 4; continue; }

      for (let d = 0; d < n; d++) xnew[d] = x[d] + delta[d];
      const costNew = evalResiduals(xnew, rnew);

      if (costNew < cost) {
        x.set(xnew);
        r.set(rnew);
        cost = costNew;
        lambda = Math.max(lambda / 4, 1e-12);
        improved = true;
        if (cost <= params.tol * params.tol) converged = true;
      } else {
        lambda *= 4;
        if (lambda > 1e12) improved = true; /* give up on this frame, but stop cleanly */
      }
    }
    if (!improved) break;
  }

  /* Connectors are left at the last iterate regardless of convergence, so a
     non-convergent frame degrades gracefully instead of freezing the run. */
  for (let c = 0; c < nconn; c++) {
    const fi = freeIndex[c];
    if (fi >= 0) m.connectors[c].pos = { x: x[2 * fi], y: x[2 * fi + 1] };
  }
  return converged;
}

function lengthViolation(m, absTol, relTol, includeVariable) {
  for (const l of m.links) {
    /* Driven links are posed rigidly by construction, so they can't bind. */
    if (!l.alive || l.isDriven) continue;
    if (!l.rigid && !includeVariable) continue;

    const k = l.connectorIds.length;
    for (let i = 0; i < k; i++) {
      for (let j = i + 1; j < k; j++) {
        const rest = l.restDist[pairIndex(i, j, k)];
        const actual = v.dist(
          m.connectors[l.connectorIds[i]].pos,
          m.connectors[l.connectorIds[j]].pos
        );
        if (Math.abs(actual - rest) > Math.max(absTol, relTol * rest)) return true;
      }
    }
  }

  /* A pin dragged off its rail is a genuine lock-up, exactly like a stretched
     link: the geometry leaves the mechanism nowhere legal to be. */
  for (const sl of liveSliders(m)) {
    const a = m.connectors[sl.railAId].pos, b = m.connectors[sl.railBId].pos;
    const d = v.sub(b, a);
    const len = v.len(d);
    if (len < 1e-9) continue;
    const off = Math.abs(v.cross(d, v.sub(m.connectors[sl.pinConnectorId].pos, a)) / len);
    if (off > Math.max(absTol, relTol * len)) return true;
  }
  return false;
}

/* Whether any fixed-length link is stretched or compressed beyond tolerance.
   Use THIS, not solveAtCurrentAngle's return value, to decide "the mechanism
   physically cannot be in this position": that flag compares an absolute
   least-squares cost against a fixed tolerance, and the residuals are in units
   of length SQUARED, so at real coordinate scales it reads "not converged"
   even for a perfectly good fit. This measure is scale-aware. */
export function hasLengthViolation(m, absTol, relTol) {
  return lengthViolation(m, absTol, relTol, false);
}

function hasVariableLink(m) {
  return m.links.some((l) => l.alive && !l.isDriven && !l.rigid);
}

export function solveAtCurrentAngle(m, params) {
  poseDrivenLinks(m);

  /* With no variable-length links there is nothing to decide. */
  if (!hasVariableLink(m)) return solvePass(m, params, false);

  /* Otherwise, first try to hold EVERY link at its rest length, variable ones
     included: a variable link should only give way when the geometry genuinely
     leaves it no choice, not merely because it is allowed to. If that
     succeeds, nothing needed to stretch and we keep it.

     Judge that by the lengths themselves rather than solvePass's convergence
     flag, for the reason given on hasLengthViolation. */
  const saved = m.connectors.map((c) => ({ x: c.pos.x, y: c.pos.y }));

  solvePass(m, params, true);
  if (!lengthViolation(m, params.lengthTolAbs, params.lengthTolRel, true)) return true;

  /* It didn't fit. Restore the frame's warm start and re-solve enforcing only
     the genuinely rigid links, letting the variable ones absorb whatever the
     rigid geometry demands of them. */
  for (let i = 0; i < m.connectors.length; i++) m.connectors[i].pos = saved[i];
  return solvePass(m, params, false);
}

const GRAVITY_VELOCITY_DAMPING = 0.98;

/* Advances every motor, optionally applies one Verlet gravity step to free
   connectors, then solves. Gravity is an external force on otherwise
   unconstrained degrees of freedom -- the Gauss-Newton solve below projects
   the integrated positions back onto the rigid-link constraint manifold -- not
   a separate physics engine. */
export function advance(m, dt, params) {
  for (const l of m.links) {
    if (!l.alive || !l.isDriven) continue;
    l.accumulatedAngleRad += l.motorSpeedDegS * (Math.PI / 180) * dt;
  }

  if (params.gravity.x !== 0 || params.gravity.y !== 0) {
    for (let i = 0; i < m.connectors.length; i++) {
      const c = m.connectors[i];
      if (!c.alive || connectorIsFixed(m, i)) continue;
      /* (pos - prevPos) is an implicit velocity estimate, so no separate
         velocity field is needed. */
      const velocity = v.sub(c.pos, c.prevPos);
      const newPos = v.add(
        v.add(c.pos, v.scale(velocity, GRAVITY_VELOCITY_DAMPING)),
        v.scale(params.gravity, dt * dt)
      );
      c.prevPos = c.pos;
      c.pos = newPos;
    }
  }

  return solveAtCurrentAngle(m, params);
}
