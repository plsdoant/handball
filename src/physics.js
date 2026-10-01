// 2D rigid-body physics for small steel balls against kinematic body colliders.
//
// - Balls are solid spheres (I = 2/5 m r²) with linear + angular velocity, so friction
//   at contacts produces spin and balls roll realistically along surfaces.
// - Body colliders (capsules for bones, convex polygons for palms) are kinematic:
//   they carry per-vertex velocities and are interpolated across sub-steps, so a fast
//   swipe of the hand transfers momentum instead of tunnelling through the ball.
// - Fixed 240 Hz sub-stepping keeps contacts stable at any display refresh rate.

import { clamp, approach } from './util.js';

export const CAPSULE = 0;
export const POLYGON = 1;

const SUBSTEP = 1 / 240;
const DYING_TIME = 0.35;
const GROW_TIME = 0.16;

// Restitution is relative to the global "bounciness" setting; mu is the friction coefficient.
const MATERIAL = {
  wall: { e: 1.0, mu: 0.45 },
  hand: { e: 0.8, mu: 0.6 },
  arm: { e: 0.75, mu: 0.5 },
  mouse: { e: 1.0, mu: 0.3 },
};

export class Ball {
  constructor(id, x, y, vx, vy, r) {
    this.id = id;
    this.x = x; this.y = y;
    this.vx = vx; this.vy = vy;
    this.r = r; // target radius
    this.cr = r * 0.4; // current collision radius (grows on spawn)
    this.w = 0; // angular velocity (rad/s, + = clockwise on screen)
    this.age = 0;
    this.dying = 0;
    this.ignoreGroup = null; // collider group to pass through until the ball is clear of it
    this.lastEvent = -1;
  }

  get alpha() {
    return this.dying > 0 ? clamp(1 - this.dying / DYING_TIME, 0, 1) : 1;
  }

  get drawRadius() {
    const d = this.dying > 0 ? 1 - 0.6 * (this.dying / DYING_TIME) ** 2 : 1;
    return this.cr * d;
  }
}

export class World {
  constructor() {
    this.balls = [];
    this.w = 1;
    this.h = 1;
    this.time = 0;
    this.nextId = 1;
    this.events = [];
    this.wind = null; // { x, y, dx, dy, strength }
    this.params = { gravity: 1.6, bounce: 0.72, maxBalls: 12, ballSize: 1, wind: true };
  }

  get radius() {
    return Math.max(9, Math.min(this.w, this.h) * 0.03 * this.params.ballSize);
  }

  setBounds(w, h) {
    this.w = w;
    this.h = h;
    for (const b of this.balls) {
      b.x = clamp(b.x, b.cr, w - b.cr);
      b.y = clamp(b.y, b.cr, h - b.cr);
    }
  }

  spawn(x, y, vx, vy, opts = {}) {
    const b = new Ball(this.nextId++, x, y, vx, vy, this.radius);
    b.ignoreGroup = opts.ignoreGroup ?? null;
    b.w = opts.spin ?? (Math.random() - 0.5) * 6;
    this.balls.push(b);
    const alive = this.balls.filter((o) => !o.dying);
    for (let i = 0; i < alive.length - this.params.maxBalls; i++) alive[i].dying = 1e-6;
    return b;
  }

  clear() {
    for (const b of this.balls) if (!b.dying) b.dying = 1e-6;
  }

  get count() {
    let n = 0;
    for (const b of this.balls) if (!b.dying) n++;
    return n;
  }

  step(dt, colliders) {
    this.events.length = 0;
    const target = this.radius;
    for (const b of this.balls) {
      b.age += dt;
      if (b.dying) b.dying += dt;
      b.r += (target - b.r) * approach(6, dt);
      const g = Math.min(1, b.age / GROW_TIME);
      b.cr = b.r * (0.4 + 0.6 * (1 - (1 - g) ** 3));
    }
    this.balls = this.balls.filter((b) => b.dying < DYING_TIME);

    const n = clamp(Math.ceil(dt / SUBSTEP - 1e-6), 1, 16);
    const h = dt / n;
    for (let i = 1; i <= n; i++) {
      this.time += h;
      this.substep(h, colliders, dt - i * h);
    }
  }

  substep(h, colliders, back) {
    const H = this.h;
    const gravity = this.params.gravity * H;
    const vmax = 6 * H;
    const drag = Math.exp(-0.06 * h);
    const spinDrag = Math.exp(-0.3 * h);
    const wind = this.params.wind ? this.wind : null;

    for (const b of this.balls) {
      b.vy += gravity * h;
      if (wind) this.applyWind(b, wind, h);
      b.vx *= drag;
      b.vy *= drag;
      b.w *= spinDrag;
      const sp = Math.hypot(b.vx, b.vy);
      if (sp > vmax) { b.vx *= vmax / sp; b.vy *= vmax / sp; }
      b.x += b.vx * h;
      b.y += b.vy * h;

      let groupSeen = false, overlapping = false;
      for (const c of colliders) {
        if (c.group === b.ignoreGroup) {
          groupSeen = true;
          if (this.overlaps(b, c, back)) overlapping = true;
          continue;
        }
        if (c.type === CAPSULE) this.collideCapsule(b, c, back);
        else this.collidePolygon(b, c, back, false);
      }
      if (b.ignoreGroup && ((groupSeen && !overlapping) || b.age > 2.5)) b.ignoreGroup = null;

      this.collideWalls(b, h);
    }

    const balls = this.balls;
    for (let i = 0; i < balls.length; i++) {
      for (let j = i + 1; j < balls.length; j++) this.collideBalls(balls[i], balls[j]);
    }
  }

  applyWind(b, wd, h) {
    const range = this.h * 0.65;
    const qx = b.x - wd.x, qy = b.y - wd.y;
    const s = qx * wd.dx + qy * wd.dy;
    if (s <= 0 || s > range) return;
    const px = qx - s * wd.dx, py = qy - s * wd.dy;
    const half = this.h * 0.04 + s * 0.4;
    const p = Math.hypot(px, py);
    if (p > half) return;
    const f = wd.strength * this.h * 3.4 * (1 - s / range) * (1 - (p / half) ** 2);
    b.vx += wd.dx * f * h;
    b.vy += wd.dy * f * h;
  }

  overlaps(b, c, back) {
    if (c.type !== CAPSULE) return this.collidePolygon(b, c, back, true);
    const ax = c.ax - c.avx * back, ay = c.ay - c.avy * back;
    const abx = c.bx - c.bvx * back - ax, aby = c.by - c.bvy * back - ay;
    const L2 = abx * abx + aby * aby;
    const t = L2 > 1e-6 ? clamp(((b.x - ax) * abx + (b.y - ay) * aby) / L2, 0, 1) : 0;
    const R = b.cr + c.r;
    return (b.x - ax - abx * t) ** 2 + (b.y - ay - aby * t) ** 2 < R * R;
  }

  collideCapsule(b, c, back) {
    const ax = c.ax - c.avx * back, ay = c.ay - c.avy * back;
    const bx = c.bx - c.bvx * back, by = c.by - c.bvy * back;
    const abx = bx - ax, aby = by - ay;
    const L2 = abx * abx + aby * aby;
    const t = L2 > 1e-6 ? clamp(((b.x - ax) * abx + (b.y - ay) * aby) / L2, 0, 1) : 0;
    const px = ax + abx * t, py = ay + aby * t;
    const dx = b.x - px, dy = b.y - py;
    const R = b.cr + c.r;
    const d2 = dx * dx + dy * dy;
    if (d2 >= R * R) return;
    const cvx = c.avx + (c.bvx - c.avx) * t;
    const cvy = c.avy + (c.bvy - c.avy) * t;
    const d = Math.sqrt(d2);
    let nx, ny;
    if (d > 1e-4) {
      nx = dx / d; ny = dy / d;
    } else {
      const L = Math.sqrt(L2);
      if (L > 1e-4) {
        nx = -aby / L; ny = abx / L;
        if (nx * cvx + ny * cvy < 0) { nx = -nx; ny = -ny; }
      } else { nx = 0; ny = -1; }
    }
    this.resolve(b, nx, ny, R - d, cvx, cvy, MATERIAL[c.group], c, 'body');
  }

  /** Circle vs. rounded convex polygon. With testOnly, returns whether they overlap. */
  collidePolygon(b, c, back, testOnly) {
    const { n, xs, ys, vxs, vys } = c;
    if (n < 3) return false;
    const ccx = c.cx - c.cvx * back, ccy = c.cy - c.cvy * back;
    let inside = true;
    let bestSd = -Infinity, bestI = 0, bestT = 0, bnx = 0, bny = -1;
    let minD2 = Infinity, mpx = 0, mpy = 0, minI = 0, minT = 0;
    for (let i = 0; i < n; i++) {
      const j = i + 1 === n ? 0 : i + 1;
      const x0 = xs[i] - vxs[i] * back, y0 = ys[i] - vys[i] * back;
      const x1 = xs[j] - vxs[j] * back, y1 = ys[j] - vys[j] * back;
      const ex = x1 - x0, ey = y1 - y0;
      const L2 = ex * ex + ey * ey;
      if (L2 < 1e-6) continue;
      const L = Math.sqrt(L2);
      let nx = ey / L, ny = -ex / L;
      if ((x0 - ccx) * nx + (y0 - ccy) * ny < 0) { nx = -nx; ny = -ny; }
      const sd = (b.x - x0) * nx + (b.y - y0) * ny;
      if (sd > 0) inside = false;
      const t = clamp(((b.x - x0) * ex + (b.y - y0) * ey) / L2, 0, 1);
      const px = x0 + ex * t, py = y0 + ey * t;
      const d2 = (b.x - px) ** 2 + (b.y - py) ** 2;
      if (d2 < minD2) { minD2 = d2; mpx = px; mpy = py; minI = i; minT = t; }
      if (sd > bestSd) { bestSd = sd; bestI = i; bestT = t; bnx = nx; bny = ny; }
    }
    const R = b.cr + c.r;
    if (!inside && minD2 >= R * R) return false;
    if (testOnly) return true;

    let nx, ny, pen, ei, et;
    if (inside) {
      nx = bnx; ny = bny; pen = R - bestSd; ei = bestI; et = bestT;
    } else {
      const d = Math.sqrt(minD2);
      if (d < 1e-6) return false;
      nx = (b.x - mpx) / d; ny = (b.y - mpy) / d; pen = R - d; ei = minI; et = minT;
    }
    const ej = ei + 1 === n ? 0 : ei + 1;
    const cvx = vxs[ei] + (vxs[ej] - vxs[ei]) * et;
    const cvy = vys[ei] + (vys[ej] - vys[ei]) * et;
    this.resolve(b, nx, ny, pen, cvx, cvy, MATERIAL[c.group], c, 'body');
    return true;
  }

  collideWalls(b, h) {
    const r = b.cr;
    const wall = MATERIAL.wall;
    if (b.y > this.h - r) {
      this.resolve(b, 0, -1, b.y - (this.h - r), 0, 0, wall, null, 'wall');
      // Rolling resistance on the floor so balls eventually come to rest.
      const rr = Math.exp(-0.3 * h);
      b.vx *= rr;
      b.w *= rr;
    }
    if (b.y < r) this.resolve(b, 0, 1, r - b.y, 0, 0, wall, null, 'wall');
    if (b.x < r) this.resolve(b, 1, 0, r - b.x, 0, 0, wall, null, 'wall');
    if (b.x > this.w - r) this.resolve(b, -1, 0, b.x - (this.w - r), 0, 0, wall, null, 'wall');
  }

  /** Contact against an infinitely heavy (kinematic) surface moving at (cvx, cvy). */
  resolve(b, nx, ny, pen, cvx, cvy, mat, collider, kind) {
    b.x += nx * pen;
    b.y += ny * pen;
    const rvx = b.vx - cvx, rvy = b.vy - cvy;
    const vn = rvx * nx + rvy * ny;
    if (vn >= 0) return;
    const resting = this.h * 0.04;
    const e = -vn < resting ? 0 : Math.min(0.97, this.params.bounce * mat.e);
    const jn = -(1 + e) * vn;
    b.vx += jn * nx;
    b.vy += jn * ny;

    // Coulomb friction at the contact point, including the ball's spin (solid sphere).
    const tx = -ny, ty = nx;
    const vt = rvx * tx + rvy * ty - b.w * b.cr;
    const jt = clamp(-vt / 3.5, -mat.mu * jn, mat.mu * jn);
    b.vx += jt * tx;
    b.vy += jt * ty;
    b.w -= (2.5 * jt) / b.cr;

    if (-vn > this.h * 0.05) this.emit(b, kind, -vn, b.x - nx * b.cr, b.y - ny * b.cr, collider);
  }

  collideBalls(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const R = a.cr + b.cr;
    const d2 = dx * dx + dy * dy;
    if (d2 >= R * R) return;
    const d = Math.sqrt(d2);
    const nx = d > 1e-6 ? dx / d : 0, ny = d > 1e-6 ? dy / d : -1;
    const pen = (R - d) * 0.5;
    a.x -= nx * pen; a.y -= ny * pen;
    b.x += nx * pen; b.y += ny * pen;
    const rvx = b.vx - a.vx, rvy = b.vy - a.vy;
    const vn = rvx * nx + rvy * ny;
    if (vn >= 0) return;
    const e = -vn < this.h * 0.04 ? 0 : Math.min(0.95, this.params.bounce * 1.2);
    const j = (-(1 + e) * vn) / 2;
    a.vx -= j * nx; a.vy -= j * ny;
    b.vx += j * nx; b.vy += j * ny;

    // Steel on steel: low friction, but enough to trade a little spin.
    const tx = -ny, ty = nx;
    const vt = rvx * tx + rvy * ty - a.w * a.cr - b.w * b.cr;
    const mu = 0.15;
    const jt = clamp(-vt / 7, -mu * j, mu * j);
    a.vx -= jt * tx; a.vy -= jt * ty;
    b.vx += jt * tx; b.vy += jt * ty;
    a.w -= (2.5 * jt) / a.cr;
    b.w -= (2.5 * jt) / b.cr;

    if (-vn > this.h * 0.05) this.emit(a, 'ball', -vn, a.x + nx * a.cr, a.y + ny * a.cr, null);
  }

  emit(b, kind, speed, x, y, collider) {
    if (this.time - b.lastEvent < 0.05) return;
    b.lastEvent = this.time;
    this.events.push({ kind, speed, x, y, id: collider?.id, group: collider?.group ?? kind, ball: b });
  }
}
