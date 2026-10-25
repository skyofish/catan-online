// 青野牧歌：全部声音由 Web Audio 实时合成（无音频文件）。
// 配乐：三拍子的钢琴圆舞曲 + 柔和的弦乐铺底，白天明亮、夜里稀疏安静；环境声：风、鸟鸣、夏夜的虫鸣、雨声。
const LS_KEY = 'farm.audio';
function loadVol() {
  try {
    return { master: 0.8, music: 0.55, sfx: 0.9, ...JSON.parse(localStorage.getItem(LS_KEY) || '{}') };
  } catch {
    return { master: 0.8, music: 0.55, sfx: 0.9 };
  }
}
const midi = (n) => 440 * 2 ** ((n - 69) / 12);

// F 大调：和弦进行（根音 MIDI，和弦音相对根音的半音）
const PROG_DAY = [
  [53, [0, 4, 7]], [50, [0, 3, 7]], [46, [0, 4, 7]], [48, [0, 4, 7]],
  [53, [0, 4, 7]], [45, [0, 3, 7]], [46, [0, 4, 7, 11]], [48, [0, 4, 7, 10]],
];
const PROG_NIGHT = [[50, [0, 3, 7]], [46, [0, 4, 7, 11]], [53, [0, 4, 7]], [48, [0, 5, 7]]];
const SCALE = [0, 2, 4, 5, 7, 9, 11]; // F 大调音阶（相对 F）

class FarmAudio {
  constructor() {
    this.ctx = null;
    this.vol = loadVol();
    this.mode = 'off';
    this.last = {};
    this.env = { night: 0, weather: 'sun', season: 'spring', nearWater: 0 };
  }

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
    this.ambBus = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 3;
    this.sfxBus.connect(comp).connect(this.master);
    this.musicBus.connect(this.master);
    this.ambBus.connect(this.master);
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(2.6, 3);
    this.revSend = ctx.createGain();
    this.revSend.gain.value = 0.4;
    this.revSend.connect(this.reverb).connect(this.master);
    this.noise = this.makeNoise(3);
    this.applyVol();
    this.startAmbience();
    if (this.mode !== 'off') this.startMusic();
  }

  impulse(sec, decay) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * sec);
    const b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** decay;
    }
    return b;
  }

  makeNoise(sec) {
    const ctx = this.ctx;
    const b = ctx.createBuffer(1, ctx.sampleRate * sec, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  setVol(k, v) {
    this.vol[k] = v;
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(this.vol));
    } catch {}
    this.applyVol();
  }

  applyVol() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.vol.master, t, 0.05);
    this.musicBus.gain.setTargetAtTime(this.vol.music * 0.5, t, 0.2);
    this.sfxBus.gain.setTargetAtTime(this.vol.sfx * 0.8, t, 0.05);
    this.ambBus.gain.setTargetAtTime(this.vol.sfx * 0.5, t, 0.2);
  }

  setMode(m) {
    if (m === this.mode) return;
    this.mode = m;
    if (!this.ctx) return;
    if (m === 'off') this.stopMusic();
    else this.startMusic();
  }

  setEnv(e) {
    Object.assign(this.env, e);
  }

  // ======================= 乐器 =======================
  piano(freq, t, dur = 1.6, vel = 0.25, bus = this.musicBus, rev = 0.5) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel, t + 0.008);
    g.gain.exponentialRampToValueAtTime(vel * 0.35, t + 0.25);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(Math.min(9000, freq * 7), t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(400, freq * 2), t + dur * 0.6);
    for (const [mul, a, type] of [[1, 1, 'triangle'], [2, 0.32, 'sine'], [3, 0.12, 'sine'], [4.01, 0.05, 'sine']]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq * mul;
      const og = ctx.createGain();
      og.gain.value = a;
      o.connect(og).connect(lp);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
    lp.connect(g);
    g.connect(bus);
    const s = ctx.createGain();
    s.gain.value = rev;
    g.connect(s).connect(this.revSend);
  }

  pad(freqs, t, dur, vel = 0.05) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel, t + dur * 0.35);
    g.gain.linearRampToValueAtTime(0, t + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1400;
    lp.Q.value = 0.3;
    for (const f of freqs) {
      for (const det of [-6, 6]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.detune.value = det;
        o.connect(lp);
        o.start(t);
        o.stop(t + dur + 0.05);
      }
    }
    lp.connect(g).connect(this.musicBus);
    const s = ctx.createGain();
    s.gain.value = 0.6;
    g.connect(s).connect(this.revSend);
  }

  // ======================= 配乐（三拍子圆舞曲） =======================
  startMusic() {
    if (this.musicTimer || !this.ctx) return;
    this.bar = 0;
    this.nextBar = this.ctx.currentTime + 0.3;
    this.mel = 72;
    this.musicTimer = setInterval(() => this.scheduleMusic(), 200);
  }

  stopMusic() {
    clearInterval(this.musicTimer);
    this.musicTimer = null;
  }

  scheduleMusic() {
    const ctx = this.ctx;
    const night = this.env.night > 0.5;
    const rainy = this.env.weather !== 'sun';
    const bpm = night ? 62 : rainy ? 70 : 84;
    const beat = 60 / bpm;
    while (this.nextBar < ctx.currentTime + 1.2) {
      const t = this.nextBar;
      const prog = night ? PROG_NIGHT : PROG_DAY;
      const [root, chord] = prog[this.bar % prog.length];
      const phrase = Math.floor(this.bar / prog.length);
      // 左手：低音 + 两拍和弦（夜里只弹低音）
      this.piano(midi(root - 12), t, beat * 3.2, night ? 0.14 : 0.18, this.musicBus, 0.6);
      if (!night) {
        const ch = chord.slice(0, 3).map((c) => midi(root + c));
        for (const b of [1, 2]) for (const f of ch) this.piano(f, t + beat * b, beat * 1.1, 0.055);
      }
      // 弦乐铺底：每两小节一次
      if (this.bar % 2 === 0 && (!rainy || night)) this.pad(chord.slice(0, 3).map((c) => midi(root + c + 12)), t, beat * 6, night ? 0.035 : 0.028);
      // 右手旋律：围绕和弦音的级进，偶尔留白
      const rest = night ? 0.45 : phrase % 4 === 3 ? 0.6 : 0.18;
      const rhythm = night ? [[0, 3]] : Math.random() < 0.5 ? [[0, 2], [2, 1]] : [[0, 1], [1, 1], [2, 1]];
      for (const [pos, len] of rhythm) {
        if (Math.random() < rest) continue;
        const pc = ((this.mel - 53) % 12 + 12) % 12;
        const deg = SCALE.indexOf(pc);
        let step = [-2, -1, -1, 1, 1, 2, 0][Math.floor(Math.random() * 7)];
        if (this.mel > 81) step = -Math.abs(step) || -1;
        if (this.mel < 67) step = Math.abs(step) || 1;
        let d = (deg < 0 ? 0 : deg) + step;
        let oct = Math.floor((this.mel - 53) / 12);
        while (d < 0) {
          d += 7;
          oct--;
        }
        while (d > 6) {
          d -= 7;
          oct++;
        }
        let note = 53 + oct * 12 + SCALE[d];
        // 强拍落在和弦音上
        if (pos === 0) {
          const tones = chord.map((c) => root + c + 24).flatMap((n) => [n - 12, n, n + 12]);
          note = tones.reduce((a, b) => (Math.abs(b - note) < Math.abs(a - note) ? b : a), tones[0]);
        }
        this.mel = note;
        this.piano(midi(note), t + pos * beat, beat * len * 1.8 + 0.4, night ? 0.13 : 0.16);
      }
      this.nextBar += beat * 3;
      this.bar++;
    }
  }

  // ======================= 环境声 =======================
  startAmbience() {
    const ctx = this.ctx;
    // 风：带通滤波的噪声，慢慢起伏
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 500;
    bp.Q.value = 0.6;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0.05;
    src.connect(bp).connect(this.windGain).connect(this.ambBus);
    src.start();
    this.windBp = bp;
    // 雨：高通噪声
    const rs = ctx.createBufferSource();
    rs.buffer = this.noise;
    rs.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1200;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    rs.connect(hp).connect(this.rainGain).connect(this.ambBus);
    rs.start();
    this.ambTimer = setInterval(() => this.ambTick(), 250);
  }

  ambTick() {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const e = this.env;
    const wind = 0.035 + 0.03 * Math.sin(t * 0.3) + (e.weather === 'rain' ? 0.04 : 0);
    this.windGain.gain.setTargetAtTime(wind, t, 0.8);
    this.windBp.frequency.setTargetAtTime(380 + 260 * (Math.sin(t * 0.21) + 1), t, 1);
    this.rainGain.gain.setTargetAtTime(e.weather === 'rain' ? 0.22 : 0, t, 1.2);
    if (this.mode === 'off') return;
    // 白天晴天：鸟鸣
    if (e.night < 0.3 && e.weather === 'sun' && e.season !== 'winter' && Math.random() < 0.08) this.bird(t);
    // 夏秋夜：虫鸣
    if (e.night > 0.6 && (e.season === 'summer' || e.season === 'autumn') && Math.random() < 0.35) this.cricket(t);
  }

  bird(t) {
    const ctx = this.ctx;
    const n = 2 + Math.floor(Math.random() * 4);
    const base = 2200 + Math.random() * 1600;
    for (let i = 0; i < n; i++) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      const g = ctx.createGain();
      const s = t + i * (0.09 + Math.random() * 0.05);
      o.frequency.setValueAtTime(base, s);
      o.frequency.exponentialRampToValueAtTime(base * (1.3 + Math.random() * 0.4), s + 0.05);
      o.frequency.exponentialRampToValueAtTime(base * 0.9, s + 0.09);
      g.gain.setValueAtTime(0, s);
      g.gain.linearRampToValueAtTime(0.025, s + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0005, s + 0.1);
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (pan) pan.pan.value = Math.random() * 1.6 - 0.8;
      o.connect(g);
      (pan ? g.connect(pan) : g).connect(this.ambBus);
      g.connect(this.revSend);
      o.start(s);
      o.stop(s + 0.12);
    }
  }

  cricket(t) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = 4200 + Math.random() * 600;
    const g = ctx.createGain();
    g.gain.value = 0;
    for (let i = 0; i < 4; i++) {
      g.gain.setValueAtTime(0.012, t + i * 0.05);
      g.gain.setValueAtTime(0, t + i * 0.05 + 0.025);
    }
    o.connect(g).connect(this.ambBus);
    o.start(t);
    o.stop(t + 0.25);
  }

  // ======================= 音效 =======================
  tone(type, f0, f1, dur, vol = 0.2, t = this.ctx.currentTime, rev = 0.15) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g).connect(this.sfxBus);
    if (rev) {
      const s = ctx.createGain();
      s.gain.value = rev;
      g.connect(s).connect(this.revSend);
    }
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  burst(dur, vol, type, freq, q = 1, t = this.ctx.currentTime, f1 = null) {
    const ctx = this.ctx;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (f1) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    s.connect(f).connect(g).connect(this.sfxBus);
    s.start(t, Math.random() * 2);
    s.stop(t + dur + 0.02);
  }

  arp(notes, step = 0.07, vol = 0.12, dur = 0.8) {
    const t = this.ctx.currentTime;
    notes.forEach((n, i) => this.piano(midi(n), t + i * step, dur, vol, this.sfxBus, 0.5));
  }

  play(name) {
    if (!this.ctx) return;
    const now = performance.now();
    if (this.last[name] && now - this.last[name] < 45) return;
    this.last[name] = now;
    const t = this.ctx.currentTime;
    switch (name) {
      case 'step':
        this.burst(0.06, 0.05, 'lowpass', 900 + Math.random() * 300);
        break;
      case 'swing':
        this.burst(0.16, 0.06, 'bandpass', 900, 1.2, t, 2600);
        break;
      case 'till':
        this.tone('sine', 140, 70, 0.14, 0.25);
        this.burst(0.18, 0.14, 'lowpass', 700, 0.8, t + 0.02);
        break;
      case 'water':
        this.burst(0.35, 0.12, 'bandpass', 2400, 1.5, t, 1200);
        this.burst(0.25, 0.06, 'highpass', 4000, 0.7, t + 0.08);
        break;
      case 'refill':
        for (let i = 0; i < 5; i++) this.tone('sine', 500 + i * 120, 900 + i * 150, 0.08, 0.06, t + i * 0.06);
        this.burst(0.5, 0.08, 'bandpass', 1500, 1, t);
        break;
      case 'chop':
        this.tone('triangle', 320, 180, 0.12, 0.28);
        this.burst(0.08, 0.16, 'bandpass', 1800, 2, t);
        break;
      case 'fall':
        this.burst(0.9, 0.18, 'lowpass', 1600, 0.6, t, 200);
        this.tone('sine', 90, 45, 0.5, 0.3, t + 0.7);
        break;
      case 'mine':
        this.tone('square', 1300, 1250, 0.07, 0.07, t, 0.2);
        this.tone('sine', 2600, 2500, 0.15, 0.06, t);
        this.burst(0.08, 0.12, 'bandpass', 3000, 2, t);
        break;
      case 'break':
        this.burst(0.3, 0.2, 'lowpass', 2000, 0.6, t, 300);
        break;
      case 'cut':
        this.burst(0.18, 0.1, 'highpass', 2500, 0.8, t, 6000);
        break;
      case 'plant':
        this.tone('sine', 300, 520, 0.12, 0.12);
        break;
      case 'harvest':
        this.tone('sine', 480, 980, 0.1, 0.12);
        this.arp([84, 88, 91], 0.05, 0.07, 0.5);
        break;
      case 'pickup':
        this.arp([79, 86], 0.05, 0.08, 0.4);
        break;
      case 'coin':
        this.tone('square', 1568, 1568, 0.06, 0.05, t, 0.1);
        this.tone('square', 2093, 2093, 0.2, 0.05, t + 0.06, 0.2);
        break;
      case 'ship':
        this.tone('triangle', 260, 180, 0.15, 0.2);
        this.play('coin');
        break;
      case 'eat':
        for (let i = 0; i < 3; i++) this.burst(0.07, 0.12, 'bandpass', 1400, 2, t + i * 0.11);
        this.tone('sine', 600, 900, 0.15, 0.08, t + 0.35);
        break;
      case 'cast':
        this.burst(0.3, 0.08, 'bandpass', 1500, 1, t, 4000);
        this.burst(0.2, 0.12, 'lowpass', 900, 1, t + 0.35);
        break;
      case 'bite':
        this.tone('triangle', 1320, 1320, 0.12, 0.2, t, 0.3);
        this.tone('triangle', 1760, 1760, 0.2, 0.2, t + 0.1, 0.3);
        this.burst(0.15, 0.14, 'lowpass', 900, 1, t);
        break;
      case 'reel':
        this.tone('square', 900 + Math.random() * 100, 900, 0.03, 0.025, t, 0);
        break;
      case 'catch':
        this.arp([72, 76, 79, 84, 88], 0.07, 0.13, 1);
        this.burst(0.3, 0.12, 'lowpass', 1200, 1, t);
        break;
      case 'escape':
        this.arp([76, 72, 67], 0.1, 0.1, 0.6);
        break;
      case 'pet':
        this.tone('sine', 700, 1000, 0.15, 0.08);
        this.tone('sine', 900, 1300, 0.15, 0.08, t + 0.12);
        break;
      case 'cluck':
        for (let i = 0; i < 3; i++) this.tone('square', 600 + Math.random() * 200, 400, 0.06, 0.05, t + i * 0.09, 0.05);
        break;
      case 'moo': {
        const ctx = this.ctx;
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(140, t);
        o.frequency.linearRampToValueAtTime(110, t + 0.8);
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.setValueAtTime(400, t);
        f.frequency.linearRampToValueAtTime(900, t + 0.3);
        f.frequency.linearRampToValueAtTime(300, t + 0.8);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.12, t + 0.1);
        g.gain.linearRampToValueAtTime(0, t + 0.85);
        o.connect(f).connect(g).connect(this.sfxBus);
        o.start(t);
        o.stop(t + 0.9);
        break;
      }
      case 'baa': {
        const ctx = this.ctx;
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = 330;
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 22;
        const lg = ctx.createGain();
        lg.gain.value = 25;
        lfo.connect(lg).connect(o.frequency);
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass';
        f.frequency.value = 1100;
        f.Q.value = 2;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.12, t + 0.05);
        g.gain.linearRampToValueAtTime(0, t + 0.5);
        o.connect(f).connect(g).connect(this.sfxBus);
        o.start(t);
        lfo.start(t);
        o.stop(t + 0.55);
        lfo.stop(t + 0.55);
        break;
      }
      case 'place':
        this.tone('triangle', 220, 160, 0.12, 0.2);
        break;
      case 'craft':
        for (let i = 0; i < 3; i++) this.tone('triangle', 500, 380, 0.08, 0.12, t + i * 0.12);
        this.arp([79, 84], 0.06, 0.08, 0.5);
        break;
      case 'buy':
        this.play('coin');
        break;
      case 'build':
        for (let i = 0; i < 4; i++) this.tone('triangle', 420, 300, 0.08, 0.14, t + i * 0.16);
        break;
      case 'bundle':
        this.arp([65, 69, 72, 77, 81, 84, 89], 0.11, 0.13, 2);
        break;
      case 'awake':
        this.arp([53, 60, 65, 69, 72, 77, 81, 84, 89, 93], 0.13, 0.14, 3);
        break;
      case 'sleep':
        this.arp([77, 72, 69, 65], 0.22, 0.09, 1.4);
        break;
      case 'morning':
        this.arp([65, 69, 72, 77, 76, 77], 0.16, 0.12, 1.6);
        break;
      case 'click':
        this.tone('sine', 900, 700, 0.04, 0.05, t, 0);
        break;
      case 'open':
        this.tone('sine', 500, 800, 0.08, 0.06, t, 0.1);
        break;
      case 'error':
        this.tone('triangle', 260, 200, 0.14, 0.1, t, 0);
        break;
      case 'chat':
        this.tone('sine', 1100, 1400, 0.06, 0.04, t, 0.1);
        break;
      case 'invite':
        this.arp([72, 79, 84], 0.08, 0.1, 0.8);
        break;
      case 'tired':
        this.tone('sine', 300, 180, 0.4, 0.1);
        break;
    }
  }
}

export const sound = new FarmAudio();
