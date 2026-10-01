import { Tracker } from './tracking.js';
import { Body } from './body.js';
import { World, CAPSULE } from './physics.js';
import { BallRenderer } from './renderer.js';
import { Overlay } from './overlay.js';
import { Sfx } from './audio.js';
import { clamp, smoothstep, approach } from './util.js';

const $ = (s) => document.querySelector(s);
const el = {
  video: $('#video'),
  under: $('#under'),
  balls: $('#balls'),
  fx: $('#fx'),
  intro: $('#intro'),
  start: $('#btn-start'),
  hint: $('#hint'),
  debug: $('#debug'),
  settings: $('#settings'),
  btnSkeleton: $('#btn-skeleton'),
  btnSound: $('#btn-sound'),
  btnClear: $('#btn-clear'),
  btnSettings: $('#btn-settings'),
  btnFull: $('#btn-full'),
  btnRecal: $('#btn-recal'),
  btnReset: $('#btn-reset'),
};

// ---------- Settings (persisted per browser) ----------

const DEFAULTS = {
  gravity: 1.6, bounce: 0.72, ballSize: 1, maxBalls: 12, wind: true,
  tiltDeg: 10, blowThreshold: 0.5, skeleton: true, muted: false,
};
const STORE_KEY = 'handball.settings.v1';

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}
function saveSettings() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch { /* storage unavailable */ }
}

const settings = loadSettings();

// ---------- Core objects ----------

const tracker = new Tracker();
const body = new Body();
const world = new World();
const sfx = new Sfx();
const overlay = new Overlay(el.under, el.fx);
let renderer;
try {
  renderer = new BallRenderer(el.balls);
} catch (err) {
  console.error(err);
}

const state = {
  mode: 'intro', // intro | camera
  debug: false,
  W: 1, H: 1, dpr: 1,
  map: { ox: 0, oy: 0, dw: 1, dh: 1 },
  readySince: 0,
  wasReady: false,
  lastSpawn: -10,
  spawned: 0,
  firstSpawnAt: 0,
  fps: 60,
  last: performance.now() / 1000,
  hudT: 0,
  mouse: { x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0, r: 26, active: false, fade: 0, lastMove: -10, inside: false },
};

function applySettings() {
  Object.assign(world.params, {
    gravity: settings.gravity, bounce: settings.bounce, ballSize: settings.ballSize,
    maxBalls: settings.maxBalls, wind: settings.wind,
  });
  body.settings.tiltDeg = settings.tiltDeg;
  body.settings.blowThreshold = settings.blowThreshold;
  el.btnSkeleton.setAttribute('aria-pressed', String(settings.skeleton));
  el.btnSound.setAttribute('aria-pressed', String(!settings.muted));
  sfx.setMuted(settings.muted);
  for (const input of el.settings.querySelectorAll('[data-setting]')) {
    const k = input.dataset.setting;
    if (input.type === 'checkbox') input.checked = !!settings[k];
    else input.value = settings[k];
  }
  for (const out of el.settings.querySelectorAll('output')) {
    const k = out.dataset.for, v = settings[k];
    out.textContent = k === 'tiltDeg' ? `${v}°` : k === 'maxBalls' ? String(v) : Number(v).toFixed(2);
  }
}

// ---------- Layout ----------

function computeMap() {
  const vw = el.video.videoWidth || 16, vh = el.video.videoHeight || 9;
  const s = Math.max(state.W / vw, state.H / vh);
  const dw = vw * s, dh = vh * s;
  state.map = { ox: (state.W - dw) / 2, oy: (state.H - dh) / 2, dw, dh };
  body.setMap(state.map);
}

function resize() {
  state.W = window.innerWidth;
  state.H = window.innerHeight;
  state.dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer?.resize(state.W, state.H, state.dpr);
  overlay.resize(state.W, state.H, state.dpr);
  world.setBounds(state.W, state.H);
  computeMap();
}
window.addEventListener('resize', resize);
el.video.addEventListener('loadedmetadata', computeMap);

// ---------- Spawning ----------

function spawnFromMouth(now) {
  const m = body.mouth, d = body.blowDir, H = state.H;
  const r = world.radius;
  const speed = H * (1.05 + 0.4 * body.gesture.blow);
  world.spawn(m.x + d.x * r * 0.5, m.y + d.y * r * 0.5, d.x * speed, d.y * speed);
  sfx.whoosh(0.9);
  state.lastSpawn = now;
  if (!state.spawned++) state.firstSpawnAt = now;
}

function spawnManual(x, y, now) {
  if (x === undefined) {
    if (body.face.present) return spawnFromMouth(now);
    x = state.W * (0.3 + Math.random() * 0.4);
    y = state.H * 0.12;
  }
  world.spawn(x, y, (Math.random() - 0.5) * state.H * 0.4, -state.H * 0.2, { ignoreGroup: 'mouse' });
  sfx.whoosh(0.6);
  if (!state.spawned++) state.firstSpawnAt = now;
}

function handleGesture(now) {
  const g = body.gesture, F = body.face;
  world.wind = F.present && g.blow > 0.3
    ? { x: body.mouth.x, y: body.mouth.y, dx: body.blowDir.x, dy: body.blowDir.y, strength: smoothstep(0.3, 0.85, g.blow) }
    : null;
  sfx.setBreath(F.present ? smoothstep(0.22, 0.85, g.blow) : 0);

  if (g.ready) {
    if (!state.wasReady) state.readySince = now;
    if (now - state.readySince > 0.08 && now - state.lastSpawn > 0.7) spawnFromMouth(now);
  }
  state.wasReady = g.ready;
}

function handleEvents(now) {
  const H = state.H;
  for (const ev of world.events) {
    const intensity = clamp(ev.speed / (H * 2.2), 0, 1);
    const pan = (ev.x / state.W) * 2 - 1;
    if (ev.kind === 'ball') sfx.clink(intensity, pan, 1);
    else if (ev.kind === 'wall') sfx.knock(intensity, pan);
    else if (ev.group === 'mouse') sfx.clink(intensity * 0.7, pan, 0.6);
    else sfx.tap(intensity, pan);
    if (ev.id) body.hits.set(ev.id, now);
  }
}

function mouseCollider(dt) {
  const m = state.mouse;
  const recent = performance.now() / 1000 - m.lastMove < 2.5;
  const wasActive = m.active;
  m.active = m.inside && recent;
  m.fade += ((m.active ? 1 : 0) - m.fade) * approach(10, dt);
  m.r = Math.max(18, state.H * 0.03);
  // Velocity from per-frame displacement, matching how body colliders are interpolated.
  const maxV = state.H * 7;
  m.vx = wasActive ? clamp((m.x - m.px) / dt, -maxV, maxV) : 0;
  m.vy = wasActive ? clamp((m.y - m.py) / dt, -maxV, maxV) : 0;
  m.px = m.x;
  m.py = m.y;
  if (!m.active) return null;
  return { type: CAPSULE, id: 'mouse', group: 'mouse', r: m.r, ax: m.x, ay: m.y, bx: m.x, by: m.y, avx: m.vx, avy: m.vy, bvx: m.vx, bvy: m.vy };
}

// ---------- HUD ----------

function setHint(text) {
  if (el.hint.textContent !== text) el.hint.textContent = text;
}

function updateHud(now) {
  const g = body.gesture;
  if (state.mode === 'camera') {
    const afterFirst = state.spawned > 0 ? now - state.firstSpawnAt : -1;
    if (!tracker.ready) setHint('Loading tracking…');
    else if (!body.face.present) setHint('Step into frame');
    else if (afterFirst >= 0 && afterFirst < 4) setHint('Bat it with your hands and arms');
    else if (afterFirst >= 4) setHint('');
    else if (g.tiltOn && !g.blowOn) setHint('Now blow — purse your lips');
    else if (g.blowOn && !g.tiltOn) setHint('Tilt your head back a little more');
    else setHint('Tilt your head back and blow');
  } else {
    setHint('');
  }

  if (state.debug && now - state.hudT > 0.15) {
    state.hudT = now;
    const hd = body.head, b = body.blend, t = tracker.timings;
    el.debug.textContent = [
      `fps        ${state.fps.toFixed(0)}`,
      `detect ms  hands ${t.hands.toFixed(1)}  face ${t.face.toFixed(1)}  pose ${t.pose.toFixed(1)}`,
      `pitch      ${hd.pitch.toFixed(1)}°  (landmarks ${hd.pitchLm.toFixed(1)}°)`,
      `baseline   ${hd.baseline === null ? '—' : hd.baseline.toFixed(1) + '°'}`,
      `tilt       ${g.tilt.toFixed(1)}° ${g.tiltOn ? '✓' : ''}`,
      `pucker     ${b.mouthPucker.toFixed(2)}  funnel ${b.mouthFunnel.toFixed(2)}`,
      `jawOpen    ${b.jawOpen.toFixed(2)}  cheekPuff ${b.cheekPuff.toFixed(2)}`,
      `blow       ${g.blow.toFixed(2)} ${g.blowOn ? '✓' : ''}`,
      `balls      ${world.count}   colliders ${body.colliders.length}`,
    ].join('\n');
  }
}

// ---------- Main loop ----------

function frame(tms) {
  const now = tms / 1000;
  const rawDt = now - state.last;
  const dt = clamp(rawDt, 1 / 240, 1 / 30);
  state.last = now;
  if (rawDt > 0) state.fps += (1 / rawDt - state.fps) * 0.05;

  const video = el.video;
  if (state.mode === 'camera' && video.readyState >= 2) {
    const res = tracker.detect(video);
    if (res) body.ingest(res, performance.now(), video.videoWidth, video.videoHeight);
  }

  body.update(dt, state.H);
  if (state.mode === 'camera') handleGesture(now);

  const colliders = body.colliders;
  const mc = state.mode !== 'intro' ? mouseCollider(dt) : null;
  if (mc) colliders.push(mc);

  world.step(dt, colliders);
  handleEvents(now);

  const drawOpts = {
    skeleton: settings.skeleton && state.mode === 'camera',
    debug: state.debug,
    faceConnections: tracker.connections,
    mouse: state.mode !== 'intro' ? state.mouse : null,
  };
  overlay.drawUnder(world, body, drawOpts, now);
  renderer?.render(world.balls);
  overlay.drawFx(world, body, drawOpts);
  updateHud(now);

  requestAnimationFrame(frame);
}

// ---------- Startup ----------

const START_LABEL = 'Start camera';
let trackerFailed = false;

function setButton(text, disabled = false) {
  el.start.textContent = text;
  el.start.disabled = disabled;
}

const trackerReady = tracker.init();
trackerReady.catch((err) => {
  console.error(err);
  trackerFailed = true;
  setButton('Tracking failed to load — reload');
});

function enterCamera() {
  state.mode = 'camera';
  document.body.classList.add('camera');
  el.intro.classList.add('hidden');
  document.activeElement?.blur();
  state.spawned = 0;
}

el.start.addEventListener('click', async () => {
  if (trackerFailed) return location.reload();
  sfx.unlock();
  setButton('Starting…', true);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    el.video.srcObject = stream;
    await el.video.play();
    computeMap();
    if (!tracker.ready) {
      setButton('Loading…', true);
      await trackerReady;
    }
    enterCamera();
  } catch (err) {
    console.error(err);
    if (trackerFailed) return;
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    setButton(denied ? 'Camera blocked — try again' : err?.name === 'NotFoundError' ? 'No camera found — try again' : `${START_LABEL} — try again`);
  }
});

// ---------- Controls ----------

function toggleSkeleton() { settings.skeleton = !settings.skeleton; applySettings(); saveSettings(); }
function toggleSound() { sfx.unlock(); settings.muted = !settings.muted; applySettings(); saveSettings(); }
function toggleSettings(force) {
  const open = force ?? el.settings.hidden;
  el.settings.hidden = !open;
  el.btnSettings.setAttribute('aria-expanded', String(open));
}
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
}

el.btnSkeleton.addEventListener('click', toggleSkeleton);
el.btnSound.addEventListener('click', toggleSound);
el.btnClear.addEventListener('click', () => world.clear());
el.btnSettings.addEventListener('click', () => toggleSettings());
el.btnFull.addEventListener('click', toggleFullscreen);
el.btnRecal.addEventListener('click', () => body.recalibrate());
el.btnReset.addEventListener('click', () => {
  Object.assign(settings, DEFAULTS, { skeleton: settings.skeleton, muted: settings.muted });
  applySettings();
  saveSettings();
});

el.settings.addEventListener('input', (e) => {
  const k = e.target.dataset.setting;
  if (!k) return;
  settings[k] = e.target.type === 'checkbox' ? e.target.checked : Number(e.target.value);
  applySettings();
  saveSettings();
});

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' && e.key !== 'Escape') return;
  if (state.mode === 'intro' || e.metaKey || e.ctrlKey || e.altKey) return;
  // Keep Space from re-clicking whichever HUD button was pressed last.
  if (document.activeElement?.tagName === 'BUTTON') document.activeElement.blur();
  const now = performance.now() / 1000;
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); spawnManual(undefined, undefined, now); }
  else if (k === 'c') world.clear();
  else if (k === 's') toggleSkeleton();
  else if (k === 'm') toggleSound();
  else if (k === 'f') toggleFullscreen();
  else if (k === 'd') { state.debug = !state.debug; el.debug.hidden = !state.debug; }
  else if (k === 'h') document.body.classList.toggle('ui-hidden');
  else if (k === 'escape') toggleSettings(false);
});

// Mouse / touch acts as an extra paddle; click to drop a ball.
el.fx.addEventListener('pointermove', (e) => {
  const m = state.mouse;
  m.x = e.clientX;
  m.y = e.clientY;
  m.inside = true;
  m.lastMove = performance.now() / 1000;
});
el.fx.addEventListener('pointerleave', () => { state.mouse.inside = false; });
el.fx.addEventListener('pointerdown', (e) => {
  if (state.mode === 'intro') return;
  sfx.unlock();
  toggleSettings(false);
  spawnManual(e.clientX, e.clientY, performance.now() / 1000);
});

// ---------- Go ----------

applySettings();
resize();
requestAnimationFrame(frame);
