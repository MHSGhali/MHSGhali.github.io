/* The creature's body: one rigid body, held up by whichever feet are touching
   the ground.

   WHAT THIS REPLACES. The homepage background used to slide the whole creature
   forwards at `advancePerRadian` radians of crank, a number measured off the
   foot path. That is the right number -- it is what a planted foot demands --
   but scripting it means nothing is ever actually held up, and the creature
   skated through the two fifths of every turn when three legs left it with no
   foot down at all. Here the number becomes a PREDICTION instead: the body
   falls under gravity, the feet push it, and the speed that comes out has to
   agree with the one the kinematics asked for. tests/walker-physics.test.mjs
   checks that it does.

   THE MODEL. Three degrees of freedom in the sagittal plane -- surge, heave and
   pitch -- and that is deliberate. The legs are planar linkages standing in
   planes strung along the crankshaft, and every foot of every leg lies in the
   same line of travel, so roll and yaw are not under-damped, they are
   under-DETERMINED: nothing in the geometry decides them. Simulating them would
   mean inventing a lateral stiffness that is not in the creature. So the body
   carries (x, y, pitch) and the crankshaft holds it upright, exactly as a real
   Strandbeest's width does.

   The rods themselves stay massless and kinematic, run by the linkage solver
   off the crank as they always were. What that buys is the thing worth having
   -- a body that has to be carried -- at a cost that is a few dozen lines of
   arithmetic rather than a constraint-dynamics engine.

   CONTACT. Penalty contact, which is to say the ground is a very stiff spring
   rather than an inequality constraint. Each foot below the ground gets a
   normal force proportional to how far it has sunk, damped, and a tangential
   force from a spring anchored where the foot first touched down. That
   tangential spring is the whole trick: while it holds, the foot is stuck to
   the ground and the leg's backward sweep pushes the body forwards, which is
   what walking is. When it exceeds Coulomb's limit the anchor is dragged
   forwards and the foot scuffs. Jansen's stance speed genuinely varies about a
   quarter either side of its mean, so planted feet DO fight each other, and
   this is how that argument gets settled: the losing foot slips, a little,
   exactly as it would on sand. */

/* Units. One unit is about a centimetre: the leg hangs its foot 90 below the
   crank centre, so the creature stands about knee high. Gravity is therefore
   the real thing at this scale, not a number chosen to look right.

   Mass is 1 and every constant below is per unit mass, which is why they look
   large. Only their ratios matter to the motion. */
export function defaultPhysics() {
  return {
    gravity: 981,
    groundY: 0,

    /* Normal contact. `kn` is set by how far a foot may sink: at rest with
       about four feet down each carries mg/4, so a penetration of 0.4 of a unit
       -- a twentieth of a rod's thickness, invisible -- wants kn near 800.
       `cn` is then ~critical against the resulting natural frequency,
       omega = sqrt(kn * feet / m) ~ 57 rad/s, so the creature settles rather
       than bounces. */
    kn: 800,
    cn: 30,

    /* Tangential. Same stiffness, so a foot has to move about a third of a unit
       before it breaks away -- far enough to be a stick, short enough that a
       fight between two planted feet resolves within one frame. */
    kt: 800,
    ct: 30,
    mu: 0.9,

    /* The contact spring is the stiffest thing here and it sets the step.
       omega*h ~ 0.1 at 1/600 s, which is comfortably inside stability for
       semi-implicit Euler with room for the ripple when several feet land at
       once. A frame is clamped to 1/20 s upstream, so this is at most 34
       substeps of arithmetic over ten feet. */
    substep: 1 / 600,
  };
}

/* The body. `feet` is how many contact points it has, which fixes the length of
   the friction-anchor table; the anchors have to persist ACROSS frames, because
   an anchor is the memory of where a foot touched down. */
export function createBody(opts = {}) {
  const feet = opts.feet ?? 0;
  return {
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    pitch: opts.pitch ?? 0,
    vx: opts.vx ?? 0,
    vy: opts.vy ?? 0,
    omega: opts.omega ?? 0,
    mass: opts.mass ?? 1,
    /* m * k^2 with a radius of gyration of about 70: the creature's mass is
       spread over its legs, which span roughly 215 by 105, and sqrt of a
       twelfth of the sum of those squares is 69. Written out rather than
       hardcoded so it follows the creature if the leg count or spacing moves. */
    inertia: opts.inertia ?? gyration(opts.span ?? 215, opts.height ?? 105) * (opts.mass ?? 1),
    anchors: Array.from({ length: feet }, () => ({ x: 0, active: false })),
    /* Counts how often the guard in step() has had to re-seat the creature.
       It should stay at zero; a test asserts that it does. */
    reseats: 0,
  };
}

export function gyration(span, height) {
  return (span * span + height * height) / 12;
}

/* Where the body sits with its lowest foot just touching. Used to seat the
   creature at startup: dropping it from an arbitrary height would make the
   still frame under prefers-reduced-motion a creature caught mid-fall. */
export function restHeight(feetLocal, groundY = 0) {
  let low = Infinity;
  for (const f of feetLocal) if (f.y < low) low = f.y;
  return Number.isFinite(low) ? groundY - low : groundY;
}

/* Advance the body by `dt`, with the feet moving from `feetPrev` to `feetNow`
   in BODY coordinates over that interval.

   Taking the two poses rather than positions and velocities is what lets the
   linkages be solved once per frame while the contacts run at their own much
   shorter step: the foot path is a smooth curve traced at 0.8 rad/s, so a
   straight line across one frame of it is far below the size of a contact
   penetration. Ten solver calls a frame instead of ten per substep. */
export function step(body, dt, feetPrev, feetNow, P) {
  if (!(dt > 0)) return body;
  const n = Math.max(1, Math.ceil(dt / P.substep));
  const h = dt / n;
  const m = body.mass;

  /* One velocity for the whole frame: the difference quotient of the two poses.
     Consistent with the lerp below by construction. */
  const nf = feetNow.length;
  const vel = new Array(nf);
  for (let i = 0; i < nf; i++) {
    vel[i] = { x: (feetNow[i].x - feetPrev[i].x) / dt, y: (feetNow[i].y - feetPrev[i].y) / dt };
  }

  for (let s = 1; s <= n; s++) {
    const a = s / n;
    const c = Math.cos(body.pitch), sn = Math.sin(body.pitch);
    let Fx = 0, Fy = -P.gravity * m, T = 0;

    for (let i = 0; i < nf; i++) {
      const fx = feetPrev[i].x + (feetNow[i].x - feetPrev[i].x) * a;
      const fy = feetPrev[i].y + (feetNow[i].y - feetPrev[i].y) * a;
      const anchor = body.anchors[i];

      /* Where the foot is, and how fast that material point is moving. The
         third term is the propulsion and the only reason any of this walks:
         the foot's prescribed motion relative to the body. */
      const rx = c * fx - sn * fy;
      const ry = sn * fx + c * fy;
      const py = body.y + ry;

      const delta = P.groundY - py;
      if (delta <= 0) { anchor.active = false; continue; }

      const px = body.x + rx;
      const vlx = c * vel[i].x - sn * vel[i].y;
      const vly = sn * vel[i].x + c * vel[i].y;
      const vx = body.vx - body.omega * ry + vlx;
      const vy = body.vy + body.omega * rx + vly;

      /* Clamped at zero: ground pushes, it never pulls a rising foot back. */
      const N = P.kn * delta - P.cn * vy;
      if (N <= 0) { anchor.active = false; continue; }

      if (!anchor.active) { anchor.active = true; anchor.x = px; }
      let Ft = -P.kt * (px - anchor.x) - P.ct * vx;
      const lim = P.mu * N;
      if (Math.abs(Ft) > lim) {
        /* Break away. Re-anchor so the spring sits exactly at the limit rather
           than snapping back: otherwise a slipping foot chatters between stuck
           and sliding at the substep rate. */
        Ft = Ft < 0 ? -lim : lim;
        anchor.x = px + Ft / P.kt;
      }

      Fx += Ft;
      Fy += N;
      T += rx * N - ry * Ft;
    }

    body.vx += (Fx / m) * h;
    body.vy += (Fy / m) * h;
    body.omega += (T / body.inertia) * h;
    body.x += body.vx * h;
    body.y += body.vy * h;
    body.pitch += body.omega * h;
  }

  return guard(body, feetNow, P);
}

/* Numerical hygiene, not gait correction. The creature is kept upright by
   having ten legs and never fewer than two feet down, not by anything here.
   But a background that goes NaN stops painting and stays stopped, and the one
   thing this decoration must never do is become a visible wreck, so a state
   that has left the realm of the possible is re-seated rather than rendered.
   The physics test asserts `reseats` stays zero over many turns; if it ever
   starts firing, that is a bug to find, not a fix that is working. */
function guard(body, feetLocal, P) {
  const sane =
    Number.isFinite(body.x) && Number.isFinite(body.y) && Number.isFinite(body.pitch) &&
    Number.isFinite(body.vx) && Number.isFinite(body.vy) && Number.isFinite(body.omega) &&
    Math.abs(body.pitch) < 1.2 &&
    body.y > P.groundY - 400 && body.y < P.groundY + 800;
  if (sane) return body;

  body.reseats++;
  body.y = restHeight(feetLocal, P.groundY);
  body.pitch = 0;
  body.vx = 0; body.vy = 0; body.omega = 0;
  if (!Number.isFinite(body.x)) body.x = 0;
  for (const a of body.anchors) a.active = false;
  return body;
}
