/* PCG32, from include/lightsim/rng.h.

   Ported exactly rather than swapped for a convenient JS generator, so a run
   here can be compared against the C stream for stream. That matters: when a
   Monte Carlo result disagrees with the reference, the first question is always
   "is this a bug or just a different random sequence?", and keeping the same
   generator removes the question.

   JS has no 64-bit integers outside BigInt, which is far too slow for the inner
   loop, so the 64-bit state is carried as two 32-bit halves and multiplied the
   long way. All arithmetic is kept in uint32 via >>> 0. */

const MUL_LO = 0x4c957f2d; /* 6364136223846793005 = 0x5851f42d4c957f2d */
const MUL_HI = 0x5851f42d;

/* Split a seed or stream into two uint32 halves. Accepts a BigInt so 64-bit
   constants survive: the C seeds its grid from 0x2545F4914F6CDD1D, which is
   larger than 2^53 and cannot be held exactly by a JS number. Seeding happens
   once per point, so the BigInt path costs nothing in the inner loop. */
function split64(x) {
  if (typeof x === "bigint") {
    return { hi: Number((x >> 32n) & 0xffffffffn) >>> 0, lo: Number(x & 0xffffffffn) >>> 0 };
  }
  return { hi: Math.floor(x / 0x100000000) >>> 0, lo: x >>> 0 };
}

export function seed(seedVal, stream) {
  const sd = split64(seedVal);
  const st = split64(stream);
  /* inc = (stream << 1) | 1, as 64 bits */
  const r = {
    stateHi: 0, stateLo: 0,
    incHi: ((st.hi << 1) | (st.lo >>> 31)) >>> 0,
    incLo: ((st.lo << 1) | 1) >>> 0,
  };
  u32(r);
  /* state += seed, 64-bit */
  const lo = (r.stateLo + sd.lo) >>> 0;
  const carry = lo < r.stateLo ? 1 : 0;
  r.stateLo = lo;
  r.stateHi = (r.stateHi + sd.hi + carry) >>> 0;
  u32(r);
  return r;
}

export function u32(r) {
  const oldLo = r.stateLo, oldHi = r.stateHi;

  /* state = old * 6364136223846793005 + inc, in 64 bits. */
  const a0 = oldLo & 0xffff, a1 = oldLo >>> 16;
  const b0 = MUL_LO & 0xffff, b1 = MUL_LO >>> 16;
  const p00 = a0 * b0;
  const p01 = a0 * b1;
  const p10 = a1 * b0;
  const p11 = a1 * b1;
  const mid = (p01 + p10 + (p00 >>> 16)) >>> 0;
  let lo = (((mid & 0xffff) << 16) >>> 0) + (p00 & 0xffff);
  lo = lo >>> 0;
  /* high 32 bits: carries out of the low product, plus the cross terms */
  const carryMid = Math.floor((p01 + p10 + (p00 >>> 16)) / 0x100000000);
  let hi = (p11 + (mid >>> 16) + carryMid * 0x10000) >>> 0;
  hi = (hi + Math.imul(oldLo, MUL_HI) + Math.imul(oldHi, MUL_LO)) >>> 0;

  const nLo = (lo + r.incLo) >>> 0;
  const carry = nLo < lo ? 1 : 0;
  r.stateLo = nLo;
  r.stateHi = (hi + r.incHi + carry) >>> 0;

  /* xorshifted = (uint32)(((old >> 18) ^ old) >> 27) */
  const sh18Lo = ((oldLo >>> 18) | (oldHi << 14)) >>> 0;
  const sh18Hi = oldHi >>> 18;
  const xLo = (sh18Lo ^ oldLo) >>> 0;
  const xHi = (sh18Hi ^ oldHi) >>> 0;
  const xorshifted = ((xLo >>> 27) | (xHi << 5)) >>> 0;

  const rot = oldHi >>> 27; /* (old >> 59) */
  return ((xorshifted >>> rot) | (xorshifted << ((32 - rot) & 31))) >>> 0;
}

/* Uniform in [0,1). The 2^-32 scaling never returns exactly 1.0. */
export function f(r) {
  return u32(r) * 2.3283064365386963e-10;
}
