/* Dense linear solve by Gaussian elimination with partial pivoting, ported
   from the C tool's src/linalg.c.

   A is row-major n*n and b is length n; BOTH ARE OVERWRITTEN. The result
   lands in x. Returns false when the matrix is singular to within 1e-14 on
   the pivot, which the solver treats as "raise the damping and retry" rather
   than as an error. */
export function solve(A, b, n, x) {
  for (let col = 0; col < n; col++) {
    let piv = col;
    let best = Math.abs(A[col * n + col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(A[r * n + col]);
      if (v > best) { best = v; piv = r; }
    }
    if (best < 1e-14) return false;

    if (piv !== col) {
      for (let k = 0; k < n; k++) {
        const t = A[col * n + k];
        A[col * n + k] = A[piv * n + k];
        A[piv * n + k] = t;
      }
      const t = b[col];
      b[col] = b[piv];
      b[piv] = t;
    }

    const diag = A[col * n + col];
    for (let r = col + 1; r < n; r++) {
      const factor = A[r * n + col] / diag;
      if (factor === 0) continue;
      for (let k = col; k < n; k++) A[r * n + k] -= factor * A[col * n + k];
      b[r] -= factor * b[col];
    }
  }

  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let k = i + 1; k < n; k++) s -= A[i * n + k] * x[k];
    x[i] = s / A[i * n + i];
  }
  return true;
}
