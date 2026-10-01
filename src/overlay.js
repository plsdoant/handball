// 2D canvas layers. "under" sits between the video and the balls (shadows, body
// volumes, skeleton); "fx" sits on top (mouse paddle, debug).

import { CAPSULE } from './physics.js';
import { HAND_BONES, PALM_EDGES, ARMS } from './body.js';

const ACCENT = '#9be3ff';
const ACCENT_RGB = '155,227,255';
const FLASH_TIME = 0.35;
const FINGERTIPS = [4, 8, 12, 16, 20];

function setupCanvas(canvas, w, h, dpr) {
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function traceCollider(ctx, c) {
  if (c.type === CAPSULE) {
    ctx.moveTo(c.ax, c.ay);
    ctx.lineTo(c.bx + 0.01, c.by);
  } else {
    ctx.moveTo(c.xs[0], c.ys[0]);
    for (let i = 1; i < c.n; i++) ctx.lineTo(c.xs[i], c.ys[i]);
    ctx.closePath();
  }
}

/** Fill a collider's full collision volume (capsules: round-capped thick line; polygons: rounded hull). */
function fillCollider(ctx, c) {
  ctx.beginPath();
  traceCollider(ctx, c);
  ctx.lineWidth = c.r * 2;
  ctx.stroke();
  if (c.type !== CAPSULE) ctx.fill();
}

export class Overlay {
  constructor(under, fx) {
    this.underCanvas = under;
    this.fxCanvas = fx;
    this.vol = document.createElement('canvas');
    this.w = 1;
    this.h = 1;
  }

  resize(w, h, dpr) {
    this.w = w;
    this.h = h;
    this.u = setupCanvas(this.underCanvas, w, h, dpr);
    this.f = setupCanvas(this.fxCanvas, w, h, dpr);
    this.v = setupCanvas(this.vol, w, h, Math.min(dpr, 1.5));
  }

  drawUnder(world, body, opts, now) {
    const ctx = this.u;
    ctx.clearRect(0, 0, this.w, this.h);
    this.drawShadows(ctx, world);
    if (!opts.skeleton) return;
    this.drawVolumes(ctx, body, now);
    this.drawFace(ctx, body, opts);
    this.drawArms(ctx, body);
    this.drawHands(ctx, body);
  }

  drawShadows(ctx, world) {
    for (const b of world.balls) {
      const r = b.drawRadius;
      const x = b.x + r * 0.22, y = b.y + r * 0.5;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r * 1.35);
      g.addColorStop(0, `rgba(0,0,0,${0.42 * b.alpha})`);
      g.addColorStop(0.55, `rgba(0,0,0,${0.18 * b.alpha})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(x, y, r * 1.35, r * 1.15, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawVolumes(ctx, body, now) {
    const cols = body.colliders.filter((c) => c.group !== 'mouse');
    if (!cols.length) return;

    // Draw the union of all volumes opaque, then composite once, so overlaps don't stack.
    const v = this.v;
    v.clearRect(0, 0, this.w, this.h);
    v.fillStyle = v.strokeStyle = '#fff';
    v.lineCap = v.lineJoin = 'round';
    for (const c of cols) fillCollider(v, c);
    ctx.save();
    ctx.globalAlpha = 0.1;
    ctx.drawImage(this.vol, 0, 0, this.w, this.h);
    ctx.restore();

    // Flash the bones that were just hit.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = ctx.lineJoin = 'round';
    for (const c of cols) {
      const t = body.hits.get(c.id);
      if (t === undefined) continue;
      const k = (now - t) / FLASH_TIME;
      if (k >= 1) continue;
      const a = (1 - k) ** 2;
      ctx.fillStyle = ctx.strokeStyle = `rgba(${ACCENT_RGB},${0.4 * a})`;
      ctx.shadowColor = `rgba(${ACCENT_RGB},${a})`;
      ctx.shadowBlur = 18;
      fillCollider(ctx, c);
    }
    ctx.restore();
  }

  drawHands(ctx, body) {
    ctx.save();
    ctx.lineCap = 'round';
    for (const hand of body.hands) {
      if (hand.alpha <= 0) continue;
      const P = hand.pts;
      ctx.globalAlpha = hand.alpha;
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (const [a, b] of HAND_BONES) { ctx.moveTo(P.x[a], P.y[a]); ctx.lineTo(P.x[b], P.y[b]); }
      for (const [a, b] of PALM_EDGES) { ctx.moveTo(P.x[a], P.y[a]); ctx.lineTo(P.x[b], P.y[b]); }
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      for (let i = 0; i < 21; i++) {
        const r = FINGERTIPS.includes(i) ? 3.2 : 2.2;
        ctx.moveTo(P.x[i] + r, P.y[i]);
        ctx.arc(P.x[i], P.y[i], r, 0, Math.PI * 2);
      }
      ctx.fill();
    }
    ctx.restore();
  }

  drawArms(ctx, body) {
    const pose = body.pose;
    if (pose.alpha <= 0) return;
    const P = pose.pts, vis = P.vis;
    ctx.save();
    ctx.globalAlpha = pose.alpha;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const seg = (a, b) => {
      if (vis[a] > 0.5 && vis[b] > 0.5) { ctx.moveTo(P.x[a], P.y[a]); ctx.lineTo(P.x[b], P.y[b]); }
    };
    seg(11, 12);
    for (const arm of ARMS) { seg(arm.s, arm.e); seg(arm.e, arm.w); }
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    for (const i of [11, 12, 13, 14, 15, 16]) {
      if (vis[i] < 0.5) continue;
      ctx.moveTo(P.x[i] + 4, P.y[i]);
      ctx.arc(P.x[i], P.y[i], 4, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.restore();
  }

  drawFace(ctx, body, opts) {
    const face = body.face;
    const conns = opts.faceConnections;
    if (face.alpha <= 0 || !conns) return;
    const P = face.pts;
    const path = (list) => {
      ctx.beginPath();
      for (const { start, end } of list) { ctx.moveTo(P.x[start], P.y[start]); ctx.lineTo(P.x[end], P.y[end]); }
      ctx.stroke();
    };
    ctx.save();
    ctx.globalAlpha = face.alpha;
    ctx.lineCap = 'round';
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = 'rgba(255,255,255,0.32)';
    path(conns.faceOval);
    path(conns.leftEye);
    path(conns.rightEye);
    path(conns.leftBrow);
    path(conns.rightBrow);

    // Lips light up as you blow.
    const blow = body.gesture.blow;
    ctx.strokeStyle = `rgba(${ACCENT_RGB},${0.35 + 0.65 * blow})`;
    ctx.lineWidth = 1.4 + blow * 1.4;
    ctx.shadowColor = ACCENT;
    ctx.shadowBlur = 14 * blow;
    path(conns.lips);
    ctx.restore();
  }

  drawFx(world, body, opts) {
    const ctx = this.f;
    ctx.clearRect(0, 0, this.w, this.h);

    const m = opts.mouse;
    if (m && m.active) {
      ctx.save();
      ctx.globalAlpha = m.fade;
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    if (opts.debug) this.drawDebug(ctx, world, body);
  }

  drawDebug(ctx, world, body) {
    ctx.save();
    ctx.lineWidth = 1;
    for (const c of body.colliders) {
      ctx.strokeStyle = 'rgba(255,90,120,0.9)';
      if (c.type === CAPSULE) {
        const dx = c.bx - c.ax, dy = c.by - c.ay;
        const L = Math.hypot(dx, dy) || 1;
        const nx = (-dy / L) * c.r, ny = (dx / L) * c.r;
        const ang = Math.atan2(dy, dx);
        ctx.beginPath();
        ctx.moveTo(c.ax + nx, c.ay + ny);
        ctx.lineTo(c.bx + nx, c.by + ny);
        ctx.arc(c.bx, c.by, c.r, ang + Math.PI / 2, ang - Math.PI / 2, true);
        ctx.lineTo(c.ax - nx, c.ay - ny);
        ctx.arc(c.ax, c.ay, c.r, ang - Math.PI / 2, ang + Math.PI / 2, true);
        ctx.stroke();
      } else {
        ctx.beginPath();
        traceCollider(ctx, c);
        ctx.stroke();
      }
    }
    ctx.strokeStyle = 'rgba(120,255,170,0.9)';
    for (const b of world.balls) {
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x + b.vx * 0.08, b.y + b.vy * 0.08);
      ctx.stroke();
      if (b.ignoreGroup) {
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.cr + 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    if (body.face.present) {
      const m = body.mouth, d = body.blowDir;
      ctx.strokeStyle = 'rgba(155,227,255,0.9)';
      ctx.beginPath();
      ctx.moveTo(m.x, m.y);
      ctx.lineTo(m.x + d.x * 80, m.y + d.y * 80);
      ctx.stroke();
    }
    ctx.restore();
  }
}
