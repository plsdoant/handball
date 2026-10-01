export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const RAD2DEG = 180 / Math.PI;

export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Frame-rate independent exponential approach factor. */
export const approach = (rate, dt) => 1 - Math.exp(-rate * dt);

/**
 * Convex hull (Andrew's monotone chain) over indices into xs/ys.
 * Returns an array of indices in hull order.
 */
export function convexHull(idx, xs, ys) {
  const pts = idx.slice().sort((a, b) => xs[a] - xs[b] || ys[a] - ys[b]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (xs[a] - xs[o]) * (ys[b] - ys[o]) - (ys[a] - ys[o]) * (xs[b] - xs[o]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}
