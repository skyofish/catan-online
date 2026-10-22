// 猛鬼宿舍：全部声音由 Web Audio 实时合成（无音频文件）。
// 配乐：低频持续音 + 风声 + 走调的八音盒（大厅/准备），对局中是不协和弦乐的涌动、随紧张度加快的心跳与偶发的吱呀、敲门、低语。
// 音效：弩箭、天雷、砸门、破门、建造、升级、猛鬼尖叫、升级钟声、鬼哭、出局、天亮。

const LS_KEY = 'dorm.audio';

function loadVol() {
  try {
    return { master: 0.8, music: 0.7, sfx: 0.9, ...JSON.parse(localStorage.getItem(LS_KEY) || '{}') };
  } catch {
    return { master: 0.8, music: 0.7, sfx: 0.9 };
  }
}

class HorrorAudio {
  constructor() {
    this.ctx = null;
    this.vol = loadVol();
    this.mood = 'off';
    this.tension = 0;
    this.last = {};
    this.timers = [];
    this.layers = [];
    this.reduced = false;
  }

  // 浏览器要求用户操作后才能出声：首次点击时调用
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.musicBus = ctx.createGain();
    this.sfxBus = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 4;
    this.sfxBus.connect(comp).connect(this.master);
    this.musicBus.connect(this.master);
    // 混响：用衰减噪声生成的脉冲响应，空旷的走廊感
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(3.2, 2.6);
    this.revSend = ctx.createGain();
    this.revSend.gain.value = 0.55;
    this.revSend.connect(this.reverb).connect(this.master);
    this.noiseBuf = this.makeNoise(2);
    this.applyVol();
    const m = this.mood;
    this.mood = 'off';
    this.setMood(m);
  }

  impulse(sec, decay) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * sec);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  makeNoise(sec) {
    const ctx = this.ctx;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * sec), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  setVolume(kind, v) {
    this.vol[kind] = Math.max(0, Math.min(1, v));
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(this.vol));
    } catch {}
    this.applyVol();
  }

  applyVol() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.vol.master, t, 0.05);
    this.musicBus.gain.setTargetAtTime(this.vol.music * 0.9, t, 0.05);
    this.sfxBus.gain.setTargetAtTime(this.vol.sfx, t, 0.05);
  }

  // ---------------- 基础积木 ----------------
  now() {
    return this.ctx.currentTime;
  }

  env(g, t, a, peak, d, sustain = 0.0001) {
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, sustain), t + a + d);
  }

  osc(type, freq, t, dur, { gain = 0.2, a = 0.005, out = this.sfxBus, detune = 0, rev = 0 } = {}) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.detune.value = detune;
    o.connect(g).connect(out);
    if (rev) {
      const s = ctx.createGain();
      s.gain.value = rev;
      g.connect(s).connect(this.revSend);
    }
    this.env(g, t, a, gain, dur);
    o.start(t);
    o.stop(t + a + dur + 0.05);
    return { o, g };
  }

  noise(t, dur, { gain = 0.2, a = 0.003, type = 'bandpass', freq = 1000, q = 1, out = this.sfxBus, rev = 0, sweepTo = null } = {}) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + a + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    src.connect(f).connect(g).connect(out);
    if (rev) {
      const s = ctx.createGain();
      s.gain.value = rev;
      g.connect(s).connect(this.revSend);
    }
    this.env(g, t, a, gain, dur);
    src.start(t, Math.random() * 1.5);
    src.stop(t + a + dur + 0.05);
    return { src, f, g };
  }

  // 女声般的尖叫：锯齿波 + 颤音 + 两个共振峰
  voice(t, dur, f0, f1, { gain = 0.25, vib = 7, depth = 0.04, formants = [900, 2300], jitter = 0, rev = 0.6, dist = 0 } = {}) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const lfo = ctx.createOscillator();
    const lg = ctx.createGain();
    lfo.frequency.value = vib;
    lg.gain.value = f0 * depth;
    lfo.connect(lg).connect(o.frequency);
    let src = o;
    if (jitter) {
      const j = ctx.createBufferSource();
      j.buffer = this.noiseBuf;
      j.loop = true;
      const jf = ctx.createBiquadFilter();
      jf.type = 'lowpass';
      jf.frequency.value = 40;
      const jg = ctx.createGain();
      jg.gain.value = jitter;
      j.connect(jf).connect(jg).connect(o.frequency);
      j.start(t);
      j.stop(t + dur + 0.1);
    }
    if (dist) {
      const ws = ctx.createWaveShaper();
      const curve = new Float32Array(256);
      for (let i = 0; i < 256; i++) {
        const x = (i / 128) - 1;
        curve[i] = Math.tanh(x * dist);
      }
      ws.curve = curve;
      o.connect(ws);
      src = ws;
    }
    const g = ctx.createGain();
    for (const ff of formants) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = ff;
      bp.Q.value = 5;
      src.connect(bp).connect(g);
    }
    g.connect(this.sfxBus);
    const s = ctx.createGain();
    s.gain.value = rev;
    g.connect(s).connect(this.revSend);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.15, dur * 0.2));
    g.gain.setValueAtTime(gain, t + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t);
    lfo.start(t);
    o.stop(t + dur + 0.05);
    lfo.stop(t + dur + 0.05);
  }

  thud(t, f = 90, gain = 0.5, dur = 0.3) {
    const { o } = this.osc('sine', f, t, dur, { gain, a: 0.004 });
    o.frequency.exponentialRampToValueAtTime(f * 0.4, t + dur);
  }

  bell(t, f, gain = 0.12, dur = 2.5, rev = 0.5) {
    for (const [m, gm] of [[1, 1], [2.76, 0.4], [5.4, 0.2], [0.5, 0.3]]) this.osc('sine', f * m, t, dur / (m > 1 ? m * 0.6 : 1), { gain: gain * gm, a: 0.003, rev });
  }

  // ---------------- 音效 ----------------
  // opts.near：0–1，离自己越远越小声
  play(name, opts = {}) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const t0 = this.now();
    // 同类音效限流，避免几十个弩同时开火时糊成一片
    const gap = { shot: 0.045, hitDoor: 0.08, hitBed: 0.12, thunder: 0.15, build: 0.06 }[name] || 0.02;
    if (this.last[name] && t0 - this.last[name] < gap) return;
    this.last[name] = t0;
    const k = opts.near === undefined ? 1 : 0.25 + 0.75 * opts.near;
    const t = t0 + 0.005;
    switch (name) {
      case 'click':
        this.osc('triangle', 1400, t, 0.04, { gain: 0.06 * k });
        break;
      case 'error':
        this.osc('square', 92, t, 0.16, { gain: 0.08 });
        this.osc('square', 97, t, 0.16, { gain: 0.06 });
        break;
      case 'shot': {
        this.noise(t, 0.06, { gain: 0.12 * k, type: 'bandpass', freq: 2600, q: 2 });
        const { o } = this.osc('triangle', 1100, t, 0.07, { gain: 0.07 * k });
        o.frequency.exponentialRampToValueAtTime(260, t + 0.07);
        break;
      }
      case 'thunder':
        this.noise(t, 0.04, { gain: 0.5 * k, type: 'highpass', freq: 3000, q: 0.5 });
        this.noise(t + 0.02, 1.4, { gain: 0.45 * k, type: 'lowpass', freq: 1800, sweepTo: 120, q: 0.7, rev: 0.6 });
        this.thud(t + 0.03, 70, 0.6 * k, 0.9);
        break;
      case 'hitDoor':
        this.thud(t, 120, 0.55 * k, 0.25);
        this.noise(t, 0.16, { gain: 0.3 * k, type: 'bandpass', freq: 380, q: 1.2, rev: 0.25 });
        if (Math.random() < 0.3) this.noise(t + 0.05, 0.08, { gain: 0.12 * k, type: 'highpass', freq: 2200 });
        break;
      case 'hitBed':
        this.thud(t, 80, 0.45 * k, 0.3);
        this.noise(t, 0.25, { gain: 0.18 * k, type: 'bandpass', freq: 600, q: 0.8 });
        this.osc('sawtooth', 160, t, 0.25, { gain: 0.04 * k });
        break;
      case 'doorBroken':
        this.noise(t, 1.3, { gain: 0.55 * k, type: 'lowpass', freq: 4000, sweepTo: 200, q: 0.5, rev: 0.8 });
        for (let i = 0; i < 4; i++) this.thud(t + i * 0.09, 140 - i * 20, 0.5 * k, 0.3);
        for (let i = 0; i < 6; i++) this.noise(t + 0.1 + Math.random() * 0.6, 0.05, { gain: 0.12 * k, type: 'highpass', freq: 2500 + Math.random() * 3000 });
        this.voice(t + 0.25, 0.9, 380, 700, { gain: 0.12 * k, formants: [800, 2100], rev: 0.8 });
        break;
      case 'build':
        this.osc('sine', 320, t, 0.06, { gain: 0.25 });
        this.noise(t, 0.03, { gain: 0.15, type: 'bandpass', freq: 1800, q: 3 });
        this.osc('sine', 260, t + 0.11, 0.06, { gain: 0.22 });
        this.noise(t + 0.11, 0.03, { gain: 0.13, type: 'bandpass', freq: 1500, q: 3 });
        break;
      case 'upgrade':
        [440, 523.25, 659.25].forEach((f, i) => this.bell(t + i * 0.08, f, 0.06, 1.2, 0.4));
        break;
      case 'sell':
        this.osc('triangle', 600, t, 0.08, { gain: 0.1 });
        this.osc('triangle', 400, t + 0.07, 0.12, { gain: 0.1 });
        break;
      case 'bed': {
        const { o } = this.osc('sawtooth', 140, t, 0.5, { gain: 0.05, a: 0.05 });
        o.frequency.linearRampToValueAtTime(190, t + 0.25);
        o.frequency.linearRampToValueAtTime(130, t + 0.5);
        [523.25, 659.25, 783.99].forEach((f, i) => this.bell(t + 0.1 + i * 0.07, f, 0.05, 1.4));
        break;
      }
      case 'door':
        this.thud(t, 180, 0.35, 0.15);
        this.noise(t, 0.08, { gain: 0.2, type: 'bandpass', freq: 900, q: 4 });
        this.osc('square', 1200, t + 0.1, 0.03, { gain: 0.05 });
        this.bell(t + 0.12, 392, 0.05, 1);
        break;
      case 'claim': {
        const { o } = this.osc('sawtooth', 120, t, 0.7, { gain: 0.06, a: 0.08 });
        o.frequency.linearRampToValueAtTime(175, t + 0.35);
        o.frequency.linearRampToValueAtTime(110, t + 0.7);
        this.noise(t, 0.6, { gain: 0.04, type: 'bandpass', freq: 500, q: 6 });
        break;
      }
      case 'tick':
        this.osc('square', 2400, t, 0.015, { gain: 0.05 });
        this.noise(t, 0.02, { gain: 0.08, type: 'highpass', freq: 5000 });
        break;
      case 'wake':
        this.thud(t, 50, 0.7, 1.5);
        this.voice(t + 0.1, 2.0, 520, 940, { gain: 0.3, vib: 6, depth: 0.05, formants: [950, 2400, 3300], rev: 1 });
        this.voice(t + 0.25, 1.8, 540, 300, { gain: 0.15, vib: 5.3, depth: 0.06, formants: [700, 1900], rev: 1 });
        this.noise(t, 2.4, { gain: 0.2, type: 'bandpass', freq: 300, sweepTo: 2000, q: 1, rev: 0.8 });
        break;
      case 'laugh':
        for (let i = 0; i < 5; i++) this.voice(t + i * 0.16, 0.13, 330 - i * 12, 300 - i * 12, { gain: 0.14 * k, vib: 0, depth: 0, formants: [750, 1700], rev: 0.9 });
        break;
      case 'hunt':
        this.voice(t, 1.2, 180, 120, { gain: 0.12 * k, vib: 4, depth: 0.08, formants: [500, 1400], rev: 1 });
        break;
      case 'level':
        this.noise(t, 0.9, { gain: 0.1, a: 0.8, type: 'bandpass', freq: 400, sweepTo: 1600, q: 2, rev: 0.6 });
        [55, 92.3, 147.2, 211.9, 330].forEach((f, i) => this.osc('sine', f, t + 0.85, 4.2 - i * 0.5, { gain: 0.22 / (i + 1), a: 0.004, rev: 0.9 }));
        break;
      case 'retreat':
        this.voice(t, 1.6, 320, 110, { gain: 0.16, vib: 5, depth: 0.07, formants: [600, 1500], rev: 1 });
        break;
      case 'scream':
        this.voice(t, 1.4, 1400, 1700, { gain: 0.22 * k, vib: 11, depth: 0.03, formants: [1800, 3200], jitter: 220, dist: 3, rev: 0.8 });
        this.noise(t, 1.2, { gain: 0.15 * k, type: 'highpass', freq: 3000, q: 0.7 });
        break;
      case 'reflect':
        this.osc('sine', 1800, t, 0.25, { gain: 0.06 * k, rev: 0.5 });
        this.osc('sine', 2400, t + 0.02, 0.2, { gain: 0.04 * k, rev: 0.5 });
        break;
      case 'kill':
        [65.4, 69.3, 92.5, 98].forEach((f) => this.osc('sawtooth', f, t, 2.5, { gain: 0.12, a: 0.02, rev: 0.8 }));
        this.voice(t + 0.05, 1.3, 800, 260, { gain: 0.22, vib: 9, depth: 0.04, formants: [1000, 2500], rev: 1 });
        this.thud(t, 45, 0.8, 1.2);
        break;
      case 'ghostHurt':
        this.voice(t, 0.5, 600, 320, { gain: 0.14, vib: 14, depth: 0.05, formants: [900, 2200], rev: 0.6 });
        break;
      case 'victory': {
        // 天亮：明亮的大和弦慢慢铺开，钟声
        [220, 277.18, 329.63, 440, 554.37].forEach((f, i) => this.osc('triangle', f, t + i * 0.12, 4, { gain: 0.06, a: 1.2, rev: 0.9 }));
        [880, 1108.73, 1318.51, 1760].forEach((f, i) => this.bell(t + 0.8 + i * 0.22, f, 0.05, 3));
        break;
      }
      case 'defeat':
        [55, 58.27, 82.41, 87.31].forEach((f) => this.osc('sawtooth', f, t, 5, { gain: 0.1, a: 1.5, rev: 1 }));
        this.bell(t + 0.5, 110, 0.15, 5, 1);
        break;
      case 'invite':
        this.bell(t, 659.25, 0.08, 1.5);
        this.bell(t + 0.15, 987.77, 0.08, 1.5);
        break;
      case 'creak': {
        const { o } = this.osc('sawtooth', 90 + Math.random() * 60, t, 1.2, { gain: 0.03 * k, a: 0.3, rev: 0.8 });
        o.frequency.linearRampToValueAtTime(140 + Math.random() * 80, t + 1.2);
        this.noise(t, 1.1, { gain: 0.03 * k, a: 0.2, type: 'bandpass', freq: 700, q: 8, rev: 0.8 });
        break;
      }
      case 'knock':
        for (let i = 0; i < 3; i++) {
          this.thud(t + i * 0.22, 160, 0.18 * k, 0.12);
          this.noise(t + i * 0.22, 0.05, { gain: 0.08 * k, type: 'bandpass', freq: 700, q: 2, rev: 1 });
        }
        break;
      case 'whisper':
        for (let i = 0; i < 6; i++) this.noise(t + i * 0.13 + Math.random() * 0.05, 0.1, { gain: 0.03 * k, a: 0.03, type: 'bandpass', freq: 1800 + Math.random() * 2500, q: 6, rev: 1 });
        break;
    }
  }

  // ---------------- 配乐 ----------------
  // mood：lobby（大厅）| prep（熄灯准备）| play（对局）| end | off
  setMood(mood) {
    if (mood === this.mood) return;
    this.mood = mood;
    if (!this.ctx) return;
    this.stopLayers();
    if (mood === 'off' || mood === 'end') return;
    this.startDrone(mood === 'play' ? 0.13 : 0.08);
    this.startWind(mood === 'play' ? 0.06 : 0.035);
    if (mood === 'lobby' || mood === 'prep') this.loop(() => this.musicBox(mood === 'prep'), 0);
    if (mood === 'play') {
      this.loop(() => this.strings(), 2000);
      this.loop(() => this.heartbeat(), 500);
    }
    this.loop(() => this.ambience(), 4000);
  }

  setTension(v) {
    this.tension = Math.max(0, Math.min(1, v));
    if (this.droneFilter) this.droneFilter.frequency.setTargetAtTime(160 + this.tension * 500, this.now(), 0.8);
  }

  loop(fn, delay) {
    const id = { stop: false };
    const run = () => {
      if (id.stop) return;
      const next = fn();
      if (next) id.t = setTimeout(run, next);
    };
    id.t = setTimeout(run, delay);
    this.timers.push(id);
  }

  stopLayers() {
    for (const id of this.timers) {
      id.stop = true;
      clearTimeout(id.t);
    }
    this.timers = [];
    const t = this.now();
    for (const l of this.layers) {
      try {
        l.g.gain.setTargetAtTime(0.0001, t, 0.6);
        for (const n of l.nodes) n.stop(t + 3);
      } catch {}
    }
    this.layers = [];
    this.droneFilter = null;
  }

  startDrone(gain) {
    const ctx = this.ctx;
    const t = this.now();
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 4);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 180;
    f.Q.value = 7;
    this.droneFilter = f;
    const nodes = [];
    for (const [type, fr, det] of [['sawtooth', 55, 0], ['sawtooth', 55, 13], ['sine', 27.5, 0], ['sawtooth', 82.4, -7]]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = fr;
      o.detune.value = det;
      o.connect(f);
      o.start(t);
      nodes.push(o);
    }
    const lfo = ctx.createOscillator();
    const lg = ctx.createGain();
    lfo.frequency.value = 0.05;
    lg.gain.value = 70;
    lfo.connect(lg).connect(f.frequency);
    lfo.start(t);
    nodes.push(lfo);
    f.connect(g).connect(this.musicBus);
    const s = ctx.createGain();
    s.gain.value = 0.3;
    g.connect(s).connect(this.revSend);
    this.layers.push({ g, nodes });
  }

  startWind(gain) {
    const ctx = this.ctx;
    const t = this.now();
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 420;
    f.Q.value = 0.9;
    const lfo = ctx.createOscillator();
    const lg = ctx.createGain();
    lfo.frequency.value = 0.07;
    lg.gain.value = 260;
    lfo.connect(lg).connect(f.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 5);
    src.connect(f).connect(g).connect(this.musicBus);
    src.start(t);
    lfo.start(t);
    this.layers.push({ g, nodes: [src, lfo] });
  }

  // 走调的八音盒：a 小调旋律，偶尔掉半音、拖慢
  musicBox(fast) {
    const mel = [
      [76, 1], [72, 1], [69, 1], [72, 1], [71, 1], [68, 1], [64, 2],
      [76, 1], [72, 1], [69, 1], [75, 1], [74, 1], [70, 1], [69, 2],
      [72, 1], [71, 1], [69, 1], [68, 1], [69, 1], [64, 1], [57, 3],
    ];
    const t0 = this.now() + 0.1;
    let t = t0;
    const beat = fast ? 0.36 : 0.5;
    const slow = Math.random() < 0.4;
    mel.forEach(([n, d], i) => {
      let midi = n;
      if (Math.random() < 0.06) midi -= 1; // 走音
      const f = 440 * Math.pow(2, (midi - 69) / 12) * (1 + (Math.random() - 0.5) * 0.008);
      this.osc('triangle', f, t, 1.4, { gain: 0.05, a: 0.002, out: this.musicBus, rev: 0.7 });
      this.osc('sine', f * 2, t, 0.6, { gain: 0.02, a: 0.002, out: this.musicBus, rev: 0.7 });
      if (i % 7 === 0) this.osc('sine', f / 4, t, 2.5, { gain: 0.04, a: 0.01, out: this.musicBus, rev: 0.6 });
      const stretch = slow && i > mel.length - 6 ? 1 + (i - mel.length + 6) * 0.25 : 1;
      t += d * beat * stretch;
    });
    return (t - t0) * 1000 + 2500 + Math.random() * 4000;
  }

  // 不协和弦乐的涌动，紧张度越高越密、越响
  strings() {
    const ctx = this.ctx;
    const t = this.now();
    const ten = this.tension;
    const roots = [110, 116.5, 98, 103.8];
    const root = roots[Math.floor(Math.random() * roots.length)];
    const ints = ten > 0.5 ? [0, 1, 6, 11] : [0, 1, 7];
    const dur = 5 + Math.random() * 3;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(400, t);
    f.frequency.linearRampToValueAtTime(900 + ten * 1800, t + dur * 0.6);
    f.frequency.linearRampToValueAtTime(300, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.025 + ten * 0.05, t + dur * 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    f.connect(g).connect(this.musicBus);
    const s = ctx.createGain();
    s.gain.value = 0.7;
    g.connect(s).connect(this.revSend);
    for (const iv of ints) {
      for (const det of [-9, 9]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = root * Math.pow(2, iv / 12) * (iv > 6 ? 2 : 1);
        o.detune.value = det;
        const vib = ctx.createOscillator();
        const vg = ctx.createGain();
        vib.frequency.value = 4.5 + Math.random();
        vg.gain.value = 4;
        vib.connect(vg).connect(o.detune);
        o.connect(f);
        o.start(t);
        vib.start(t);
        o.stop(t + dur + 0.1);
        vib.stop(t + dur + 0.1);
      }
    }
    // 极度紧张时加一声高音小提琴般的尖鸣
    if (ten > 0.75 && Math.random() < 0.6) this.voice(t + 1, 2.5, 1650, 1760, { gain: 0.03, vib: 6, depth: 0.01, formants: [1700, 3400], rev: 1 });
    return (dur * (1.1 - ten * 0.5) + Math.random() * 3) * 1000;
  }

  heartbeat() {
    const ten = this.tension;
    if (ten < 0.3) return 600;
    const t = this.now() + 0.02;
    const k = 0.25 + ten * 0.5;
    this.thud(t, 62, 0.5 * k, 0.16);
    this.thud(t + 0.17, 54, 0.4 * k, 0.2);
    return 1100 - ten * 650;
  }

  ambience() {
    const r = Math.random();
    const near = 0.15 + Math.random() * 0.3;
    if (r < 0.35) this.play('creak', { near });
    else if (r < 0.55) this.play('whisper', { near });
    else if (r < 0.7 && this.mood !== 'lobby') this.play('knock', { near: 0.1 });
    return 7000 + Math.random() * 12000;
  }
}

export const sound = new HorrorAudio();
