/* Descriptive statistics over a measurement set, from src/analysis.c.

   These are the numbers a lighting study actually reports: the spread of the
   distribution and how uniform it is. Unit-agnostic -- feed it lux or W/m^2 and
   the ratios come out the same. */

export function stats(values, n = values.length) {
  const s = {
    min: 0, max: 0, mean: 0, stddev: 0,
    michelson: 0, /* (max-min)/(max+min) */
    u0: 0,        /* min/mean, the CIE uniformity U0 */
    ud: 0,        /* min/max, the diversity ratio */
    count: n,
  };
  if (n <= 0) return s;

  s.min = s.max = values[0];
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = values[i];
    if (x < s.min) s.min = x;
    if (x > s.max) s.max = x;
    sum += x;
  }
  s.mean = sum / n;

  if (n > 1) {
    let acc = 0;
    for (let i = 0; i < n; i++) { const d = values[i] - s.mean; acc += d * d; }
    s.stddev = Math.sqrt(acc / (n - 1)); /* N-1 denominator, as in the C */
  }
  const denom = s.max + s.min;
  s.michelson = denom > 0 ? (s.max - s.min) / denom : 0;
  s.u0 = s.mean > 0 ? s.min / s.mean : 0;
  s.ud = s.max > 0 ? s.min / s.max : 0;
  return s;
}
