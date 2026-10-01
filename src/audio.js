// Synthesized sound effects (no audio files): metallic clinks from inharmonic partials,
// soft taps for body hits, a whoosh for spawning and a breath noise that follows blowing.

import { clamp } from './util.js';

export class Sfx {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.active = 0;
  }

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 5;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.7;
    this.master.connect(comp).connect(ctx.destination);

    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    // Continuous breath bed, gain driven by how hard you're blowing.
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1100;
    bp.Q.value = 0.6;
    this.breath = ctx.createGain();
    this.breath.gain.value = 0;
    src.connect(bp).connect(this.breath).connect(this.master);
    src.start();
  }

  setMuted(m) {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.7, this.ctx.currentTime, 0.03);
  }

  get ready() {
    return this.ctx && this.ctx.state === 'running' && !this.muted;
  }

  setBreath(level) {
    if (!this.ctx) return;
    this.breath.gain.setTargetAtTime(level * 0.16, this.ctx.currentTime, 0.06);
  }

  voice(pan, dur) {
    if (this.active > 16) return null;
    const ctx = this.ctx;
    const out = ctx.createGain();
    const p = ctx.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1) * 0.8;
    out.connect(p).connect(this.master);
    this.active++;
    setTimeout(() => { this.active--; p.disconnect(); }, dur * 1000 + 50);
    return out;
  }

  /** Steel-on-steel: bright inharmonic ring (free-bar mode ratios). */
  clink(intensity, pan, pitch = 1) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const out = this.voice(pan, 0.7);
    if (!out) return;
    const base = (2100 + Math.random() * 400) * pitch;
    const partials = [[1, 1, 0.55], [2.756, 0.5, 0.32], [5.404, 0.28, 0.18], [8.933, 0.14, 0.1]];
    const amp = 0.06 + 0.32 * intensity * intensity;
    for (const [ratio, a, dur] of partials) {
      const f = base * ratio;
      if (f > 15000) continue;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(amp * a, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur * (0.6 + intensity * 0.6));
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + 0.7);
    }
    this.click(out, t, amp * 0.6, 4000);
  }

  /** Ball against the screen edge: duller, lower knock. */
  knock(intensity, pan) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const out = this.voice(pan, 0.35);
    if (!out) return;
    const amp = 0.05 + 0.3 * intensity * intensity;
    const base = 520 + Math.random() * 80;
    for (const [ratio, a, dur] of [[1, 1, 0.22], [2.3, 0.45, 0.12], [4.1, 0.2, 0.06]]) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = base * ratio;
      g.gain.setValueAtTime(amp * a, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + 0.3);
    }
    this.click(out, t, amp * 0.7, 1800);
  }

  /** Ball against skin: a soft, muted pat. */
  tap(intensity, pan) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const out = this.voice(pan, 0.2);
    if (!out) return;
    const amp = 0.08 + 0.4 * intensity;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(220, t);
    o.frequency.exponentialRampToValueAtTime(90, t + 0.08);
    g.gain.setValueAtTime(amp * 0.6, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.15);
    this.click(out, t, amp * 0.5, 900, 'lowpass');
  }

  whoosh(intensity = 1) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const out = this.voice(0, 0.6);
    if (!out) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(500, t);
    bp.frequency.exponentialRampToValueAtTime(2600, t + 0.35);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35 * intensity, t + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    src.connect(bp).connect(g).connect(out);
    src.start(t, Math.random() * 0.4);
    src.stop(t + 0.55);

    // A soft "pop" as the ball leaves the lips.
    const o = ctx.createOscillator();
    const og = ctx.createGain();
    o.frequency.setValueAtTime(380, t + 0.02);
    o.frequency.exponentialRampToValueAtTime(900, t + 0.09);
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.18, t + 0.03);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    o.connect(og).connect(out);
    o.start(t);
    o.stop(t + 0.2);
  }

  click(out, t, amp, freq, type = 'highpass') {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(amp, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.012);
    src.connect(f).connect(g).connect(out);
    src.start(t, Math.random() * 0.5);
    src.stop(t + 0.03);
  }
}
