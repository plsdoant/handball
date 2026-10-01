// Turns raw landmarker output into smoothed screen-space skeletons, gesture state
// (head tilt + blowing) and the kinematic colliders the physics engine collides with.

import { clamp, smoothstep, approach, convexHull, RAD2DEG } from './util.js';
import { CAPSULE, POLYGON } from './physics.js';

export const HAND_BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [5, 6], [6, 7], [7, 8],
  [9, 10], [10, 11], [11, 12],
  [13, 14], [14, 15], [15, 16],
  [17, 18], [18, 19], [19, 20],
];
export const PALM_EDGES = [[0, 5], [5, 9], [9, 13], [13, 17], [17, 0]];
const PALM = [0, 1, 5, 9, 13, 17];
export const ARMS = [
  { side: 'L', s: 11, e: 13, w: 15 },
  { side: 'R', s: 12, e: 14, w: 16 },
];

const LOST_MS = 150;
const BLENDS = ['mouthPucker', 'mouthFunnel', 'jawOpen', 'cheekPuff'];

/** A set of landmarks: raw normalized input, smoothed screen positions and velocities. */
class Points {
  constructor(n) {
    this.n = n;
    this.nx = new Float32Array(n); // raw normalized (camera image, unmirrored)
    this.ny = new Float32Array(n);
    this.nz = new Float32Array(n);
    this.vis = new Float32Array(n).fill(1);
    this.tx = new Float32Array(n); // target in stage px
    this.ty = new Float32Array(n);
    this.x = new Float32Array(n); // smoothed stage px
    this.y = new Float32Array(n);
    this.vx = new Float32Array(n); // px / s
    this.vy = new Float32Array(n);
  }

  setRaw(lms) {
    for (let i = 0; i < this.n; i++) {
      const l = lms[i];
      this.nx[i] = l.x;
      this.ny[i] = l.y;
      this.nz[i] = l.z;
      this.vis[i] = l.visibility ?? 1;
    }
  }

  retarget(map) {
    for (let i = 0; i < this.n; i++) {
      this.tx[i] = map.ox + (1 - this.nx[i]) * map.dw; // mirrored (selfie view)
      this.ty[i] = map.oy + this.ny[i] * map.dh;
    }
  }

  snap() {
    this.x.set(this.tx);
    this.y.set(this.ty);
    this.vx.fill(0);
    this.vy.fill(0);
  }

  smooth(dt, rate, maxV) {
    const a = approach(rate, dt);
    for (let i = 0; i < this.n; i++) {
      const px = this.x[i], py = this.y[i];
      this.x[i] = px + (this.tx[i] - px) * a;
      this.y[i] = py + (this.ty[i] - py) * a;
      this.vx[i] = clamp((this.x[i] - px) / dt, -maxV, maxV);
      this.vy[i] = clamp((this.y[i] - py) / dt, -maxV, maxV);
    }
  }
}

class Track {
  constructor(n, rate) {
    this.pts = new Points(n);
    this.rate = rate;
    this.present = false;
    this.fresh = true;
    this.lastSeen = -1e9;
    this.alpha = 0;
  }
}

function capsule(id, group, r, ax, ay, avx, avy, bx, by, bvx, bvy) {
  return { type: CAPSULE, id, group, r, ax, ay, avx, avy, bx, by, bvx, bvy };
}

function capsuleFrom(id, group, P, a, b, r) {
  return capsule(id, group, r, P.x[a], P.y[a], P.vx[a], P.vy[a], P.x[b], P.y[b], P.vx[b], P.vy[b]);
}

function polygonFrom(id, group, P, idx, r) {
  const hull = convexHull(idx, P.x, P.y);
  const n = hull.length;
  const xs = new Float32Array(n), ys = new Float32Array(n);
  const vxs = new Float32Array(n), vys = new Float32Array(n);
  let cx = 0, cy = 0, cvx = 0, cvy = 0;
  for (let i = 0; i < n; i++) {
    const j = hull[i];
    cx += P.x[j]; cy += P.y[j];
    cvx += P.vx[j]; cvy += P.vy[j];
  }
  cx /= n; cy /= n; cvx /= n; cvy /= n;
  for (let i = 0; i < n; i++) {
    const j = hull[i];
    xs[i] = P.x[j];
    ys[i] = P.y[j];
    vxs[i] = P.vx[j];
    vys[i] = P.vy[j];
  }
  return { type: POLYGON, id, group, r, n, xs, ys, vxs, vys, cx, cy, cvx, cvy };
}

/** Head orientation from face landmarks. Returns pitch (deg, + = looking up) and forward vector (image space, y down). */
function headPoseFromLandmarks(lm, vw, vh) {
  const ux = (lm[10].x - lm[152].x) * vw, uy = (lm[10].y - lm[152].y) * vh, uz = (lm[10].z - lm[152].z) * vw;
  const rx = (lm[263].x - lm[33].x) * vw, ry = (lm[263].y - lm[33].y) * vh, rz = (lm[263].z - lm[33].z) * vw;
  let fx = ry * uz - rz * uy, fy = rz * ux - rx * uz, fz = rx * uy - ry * ux;
  const len = Math.hypot(fx, fy, fz) || 1;
  fx /= len; fy /= len; fz /= len;
  if (fz > 0) { fx = -fx; fy = -fy; fz = -fz; } // forward points toward the camera (smaller z)
  return { pitch: Math.asin(clamp(-fy, -1, 1)) * RAD2DEG, fx, fy, fz };
}

export class Body {
  constructor() {
    this.face = new Track(478, 30);
    this.pose = new Track(33, 22);
    this.hands = [new Track(21, 34), new Track(21, 34)];
    this.blend = Object.fromEntries(BLENDS.map((k) => [k, 0]));
    this.head = {
      pitchRaw: 0, pitchLm: 0, pitch: 0, baseline: null, calibT: 0, fx: 0, fy: -1,
      mSign: 1, mMean: 0, lMean: 0, cov: 0, n: 0,
    };
    this.gesture = { tilt: 0, blow: 0, tiltOn: false, blowOn: false, ready: false };
    this.mouth = { x: 0, y: 0, w: 0 };
    this.blowDir = { x: 0, y: -1 };
    this.colliders = [];
    this.hits = new Map();
    this.settings = { tiltDeg: 10, blowThreshold: 0.5 };
    this.map = null;
    this.remap = false;
  }

  recalibrate() {
    this.head.baseline = null;
  }

  /** Feed one frame of landmarker results (any of face/hands/pose may be undefined when skipped). */
  ingest(res, now, vw, vh) {
    if (res.face) {
      const lms = res.face.faceLandmarks?.[0];
      const F = this.face;
      if (lms) {
        F.pts.setRaw(lms);
        if (!F.present) F.fresh = true;
        F.present = true;
        F.lastSeen = now;
        const cats = res.face.faceBlendshapes?.[0]?.categories;
        if (cats) for (const c of cats) if (c.categoryName in this.blend) this.blend[c.categoryName] = c.score;
        const lp = headPoseFromLandmarks(lms, vw, vh);
        this.head.pitchLm = lp.pitch;
        this.head.fx = lp.fx;
        this.head.fy = lp.fy;
        // The transformation matrix (column-major, camera space y-up) gives a better-scaled pitch:
        // the face's forward axis is its third column, so forward.y = data[9].
        const m = res.face.facialTransformationMatrixes?.[0]?.data;
        this.head.pitchRaw = m && m.length === 16
          ? this.checkedMatrixPitch(Math.asin(clamp(m[9], -1, 1)) * RAD2DEG, lp.pitch)
          : lp.pitch;
      } else if (now - F.lastSeen > LOST_MS) {
        F.present = false;
      }
    }

    if (res.hands) this.matchHands(res.hands.landmarks || [], now);

    if (res.pose) {
      const lms = res.pose.landmarks?.[0];
      const P = this.pose;
      if (lms) {
        P.pts.setRaw(lms);
        if (!P.present) P.fresh = true;
        P.present = true;
        P.lastSeen = now;
      } else if (now - P.lastSeen > LOST_MS) {
        P.present = false;
      }
    }
  }

  /**
   * The landmark-derived pitch has a reliable sign but a compressed scale; the matrix pitch has
   * the right scale. Track their covariance and flip the matrix sign if they ever disagree, so
   * "tilt up" can't end up inverted by a convention mismatch.
   */
  checkedMatrixPitch(mp, lp) {
    const hd = this.head;
    if (hd.n++ === 0) { hd.mMean = mp; hd.lMean = lp; }
    hd.mMean += (mp - hd.mMean) * 0.05;
    hd.lMean += (lp - hd.lMean) * 0.05;
    hd.cov = hd.cov * 0.995 + (mp - hd.mMean) * (lp - hd.lMean);
    const sign = hd.n < 30 ? hd.mSign : hd.cov < -150 ? -1 : hd.cov > 150 ? 1 : hd.mSign;
    if (sign !== hd.mSign) {
      hd.mSign = sign;
      hd.baseline = null;
    }
    return mp * hd.mSign;
  }

  /** Keep hand identities stable across frames by matching detections to the nearest previous hand. */
  matchHands(dets, now) {
    const slots = this.hands;
    const perms = dets.length === 0 ? [[]] : dets.length === 1 ? [[0], [1]] : [[0, 1], [1, 0]];
    const dist = (d, s) => Math.hypot(d[0].x - s.pts.nx[0], d[0].y - s.pts.ny[0]);
    let best = perms[0], bestCost = Infinity;
    for (const perm of perms) {
      let cost = 0;
      for (let i = 0; i < dets.length; i++) {
        const s = slots[perm[i]];
        cost += s.present ? dist(dets[i], s) : 0.25;
      }
      if (cost < bestCost) { bestCost = cost; best = perm; }
    }
    const used = [false, false];
    for (let i = 0; i < dets.length; i++) {
      const s = slots[best[i]];
      used[best[i]] = true;
      const jump = s.present ? dist(dets[i], s) : 1;
      s.pts.setRaw(dets[i]);
      if (!s.present || jump > 0.3) s.fresh = true;
      s.present = true;
      s.lastSeen = now;
    }
    for (let i = 0; i < slots.length; i++) {
      if (!used[i] && slots[i].present && now - slots[i].lastSeen > LOST_MS) slots[i].present = false;
    }
  }

  setMap(map) {
    if (this.map && (map.dw !== this.map.dw || map.dh !== this.map.dh || map.ox !== this.map.ox)) this.remap = true;
    this.map = map;
  }

  update(dt, H) {
    const maxV = H * 7;
    for (const t of [this.face, this.pose, this.hands[0], this.hands[1]]) {
      if (!t.present) {
        t.alpha = Math.max(0, t.alpha - dt * 5);
        t.pts.vx.fill(0);
        t.pts.vy.fill(0);
        continue;
      }
      t.alpha = Math.min(1, t.alpha + dt * 5);
      t.pts.retarget(this.map);
      if (t.fresh || this.remap) { t.pts.snap(); t.fresh = false; }
      else t.pts.smooth(dt, t.rate, maxV);
    }
    this.remap = false;
    this.updateGesture(dt);
    this.buildColliders(H);
  }

  updateGesture(dt) {
    const g = this.gesture, hd = this.head, F = this.face;
    if (!F.present) {
      g.blow += (0 - g.blow) * approach(10, dt);
      g.tilt += (0 - g.tilt) * approach(10, dt);
      g.tiltOn = g.blowOn = g.ready = false;
      return;
    }

    hd.pitch += (hd.pitchRaw - hd.pitch) * approach(14, dt);
    if (hd.baseline === null) { hd.baseline = hd.pitch; hd.calibT = 0; }
    hd.calibT += dt;
    const tilt = hd.pitch - hd.baseline;
    // Calibrate quickly at first, then drift very slowly toward the resting pose (never while tilting).
    const rate = hd.calibT < 1.2 ? 4 : tilt < this.settings.tiltDeg * 0.4 ? 0.12 : 0;
    hd.baseline += (hd.pitch - hd.baseline) * approach(rate, dt);
    g.tilt = tilt;

    const b = this.blend;
    const shape = Math.max(b.mouthPucker, b.mouthFunnel * 0.95);
    const jawPenalty = 1 - smoothstep(0.3, 0.6, b.jawOpen);
    const raw = clamp(clamp((shape - 0.15) / 0.55, 0, 1) * jawPenalty + b.cheekPuff * 0.4, 0, 1);
    g.blow += (raw - g.blow) * approach(16, dt);

    const th = this.settings.blowThreshold, td = this.settings.tiltDeg;
    g.blowOn = g.blowOn ? g.blow > th * 0.7 : g.blow > th;
    g.tiltOn = g.tiltOn ? tilt > td * 0.65 : tilt > td;
    g.ready = g.blowOn && g.tiltOn;

    const P = F.pts;
    this.mouth.x = (P.x[13] + P.x[14]) / 2;
    this.mouth.y = (P.y[13] + P.y[14]) / 2;
    this.mouth.w = Math.hypot(P.x[61] - P.x[291], P.y[61] - P.y[291]);

    // Blow direction: the face's forward axis projected onto the (mirrored) screen, biased upward.
    let dx = -hd.fx, dy = hd.fy;
    const mag = Math.hypot(dx, dy);
    if (mag < 0.12) { dx = 0; dy = -1; } else { dx /= mag; dy /= mag; }
    dx = dx * 0.75; dy = dy * 0.75 - 0.35;
    const m2 = Math.hypot(dx, dy) || 1;
    const k = approach(10, dt);
    this.blowDir.x += (dx / m2 - this.blowDir.x) * k;
    this.blowDir.y += (dy / m2 - this.blowDir.y) * k;
    const m3 = Math.hypot(this.blowDir.x, this.blowDir.y) || 1;
    this.blowDir.x /= m3;
    this.blowDir.y /= m3;
  }

  buildColliders(H) {
    const out = this.colliders;
    out.length = 0;
    const map = this.map;

    for (let h = 0; h < 2; h++) {
      const s = this.hands[h];
      if (!s.present) continue;
      const P = s.pts;
      const dz = (P.nz[9] - P.nz[0]) * map.dw;
      s.scale = Math.hypot(P.x[9] - P.x[0], P.y[9] - P.y[0], dz);
      const rf = clamp(s.scale * 0.085, 5, 32);
      for (const [a, b] of HAND_BONES) {
        out.push(capsuleFrom(`h${h}:${a}-${b}`, 'hand', P, a, b, b <= 4 ? rf * 1.15 : rf));
      }
      out.push(polygonFrom(`h${h}:palm`, 'hand', P, PALM, rf * 0.7));
    }

    const pose = this.pose;
    if (pose.present) {
      const P = pose.pts, vis = P.vis;
      const sw = Math.hypot(P.x[11] - P.x[12], P.y[11] - P.y[12]);
      const rad = (k) => clamp(sw * k, 8, H * 0.09);
      if (vis[11] > 0.5 && vis[12] > 0.5 && sw > 30) out.push(capsuleFrom('shoulders', 'arm', P, 11, 12, rad(0.1)));
      for (const arm of ARMS) {
        if (vis[arm.s] < 0.5 || vis[arm.e] < 0.5) continue;
        out.push(capsuleFrom(`arm${arm.side}:upper`, 'arm', P, arm.s, arm.e, rad(0.12)));
        if (vis[arm.w] < 0.5) continue;
        // Join the forearm to the tracked hand's wrist when one is nearby, so arm and hand line up.
        let wx = P.x[arm.w], wy = P.y[arm.w], wvx = P.vx[arm.w], wvy = P.vy[arm.w];
        let bestD = Math.max(sw * 0.6, 40);
        for (const hand of this.hands) {
          if (!hand.present) continue;
          const d = Math.hypot(hand.pts.x[0] - P.x[arm.w], hand.pts.y[0] - P.y[arm.w]);
          if (d < bestD) {
            bestD = d;
            wx = hand.pts.x[0]; wy = hand.pts.y[0]; wvx = hand.pts.vx[0]; wvy = hand.pts.vy[0];
          }
        }
        out.push(capsule(`arm${arm.side}:fore`, 'arm', rad(0.09),
          P.x[arm.e], P.y[arm.e], P.vx[arm.e], P.vy[arm.e], wx, wy, wvx, wvy));
      }
    }
  }
}
