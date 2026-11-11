// 雾夜追猎：全部声音用 Web Audio 实时合成（没有音频文件）。
// 配乐：大厅是走调的八音盒圆舞曲；对局里是低沉的风声和零星的八音盒；被追时叠上急促的弦乐顿弓和心跳。
const KEY = 'hunt.volume';
const NOTE = (n) => 440 * 2 ** ((n - 69) / 12);

class Sound {
  constructor() {
    this.vol = { master: 0.8, music: 0.6, sfx: 0.9 };
    try {
      Object.assign(this.vol, JSON.parse(localStorage.getItem(KEY)) || {});
    } catch {}
    this.ctx = null;
    this.mood = 'off';
    this.heart = 0;
    this.chase = 0;
    const unlock = () => this.unlock();
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock);
  }

  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const c = (this.ctx = new AC());
      this.master = c.createGain();
      this.musicG = c.createGain();
      this.sfxG = c.createGain();
      const comp = c.createDynamicsCompressor();
      this.master.connect(comp).connect(c.destination);
      this.musicG.connect(this.master);
      this.sfxG.connect(this.master);
      // 简单的混响：几条带反馈的延迟
      this.rev = c.createGain();
      this.rev.gain.value = 0.35;
      for (const [d, fb] of [[0.11, 0.35], [0.17, 0.3], [0.29, 0.25]]) {
        const dl = c.createDelay(1);
        dl.delayTime.value = d;
        const g = c.createGain();
        g.gain.value = fb;
        const lp = c.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 2200;
        this.rev.connect(dl).connect(lp).connect(g).connect(dl);
        g.connect(this.master);
      }
      const len = c.sampleRate;
      this.noiseBuf = c.createBuffer(1, len, c.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.applyVol();
      this.startLoops();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  applyVol() {
    if (!this.ctx) return;
    this.master.gain.value = this.vol.master;
    this.musicG.gain.value = this.vol.music * 0.5;
    this.sfxG.gain.value = this.vol.sfx;
  }
  setVolume(k, v) {
    this.vol[k] = v;
    try {
      localStorage.setItem(KEY, JSON.stringify(this.vol));
    } catch {}
    this.applyVol();
  }
  setMood(m) {
    this.mood = m;
  }

  // ---------------- 基础发声 ----------------
  tone(freq, { t = 0, dur = 0.3, type = 'sine', gain = 0.2, to = null, attack = 0.005, out = null, rev = 0, detune = 0 } = {}) {
    const c = this.ctx;
    if (!c) return;
    const t0 = c.currentTime + t;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    o.detune.value = detune;
    if (to) o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(out || this.sfxG);
    if (rev) {
      const r = c.createGain();
      r.gain.value = rev;
      g.connect(r).connect(this.rev);
    }
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }
  noise({ t = 0, dur = 0.3, gain = 0.2, type = 'lowpass', freq = 1000, to = null, q = 1, out = null, attack = 0.005 } = {}) {
    const c = this.ctx;
    if (!c) return;
    const t0 = c.currentTime + t;
    const s = c.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = true;
    const f = c.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(freq, t0);
    if (to) f.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    s.connect(f).connect(g).connect(out || this.sfxG);
    s.start(t0, Math.random());
    s.stop(t0 + dur + 0.05);
  }
  box(n, t = 0, gain = 0.12) {
    // 八音盒：正弦 + 高八度泛音，略微走调
    const f = NOTE(n);
    this.tone(f, { t, dur: 1.4, gain, out: this.musicG, rev: 0.6, detune: (Math.random() - 0.5) * 16 });
    this.tone(f * 3.01, { t, dur: 0.5, gain: gain * 0.25, out: this.musicG });
  }

  // ---------------- 循环：配乐、风声、心跳 ----------------
  startLoops() {
    const c = this.ctx;
    // 风
    const s = c.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = true;
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 380;
    f.Q.value = 0.6;
    this.windG = c.createGain();
    this.windG.gain.value = 0;
    s.connect(f).connect(this.windG).connect(this.musicG);
    s.start();
    this.windF = f;
    // 低音
    const d = c.createOscillator();
    d.type = 'sawtooth';
    d.frequency.value = NOTE(33);
    const df = c.createBiquadFilter();
    df.type = 'lowpass';
    df.frequency.value = 140;
    this.droneG = c.createGain();
    this.droneG.gain.value = 0;
    d.connect(df).connect(this.droneG).connect(this.musicG);
    d.start();

    // D 小调的圆舞曲
    const WALTZ = [62, 69, 65, 74, 69, 65, 61, 69, 64, 73, 69, 64, 58, 65, 62, 70, 65, 62, 57, 64, 61, 69, 64, 61];
    const SPARSE = [74, null, null, 69, null, 65, null, null, 73, null, null, null, 70, null, 65, null, null, 62, null, null, 61, null, null, null];
    let step = 0;
    let beat = 0;
    const tick = () => {
      const now = c.currentTime;
      const wind = this.mood === 'game' ? 0.5 : this.mood === 'lobby' ? 0.15 : 0;
      this.windG.gain.setTargetAtTime(wind, now, 1);
      this.windF.frequency.setTargetAtTime(300 + Math.sin(now * 0.3) * 150, now, 1);
      this.droneG.gain.setTargetAtTime(this.mood === 'game' ? 0.25 + this.chase * 0.3 : 0, now, 0.6);
      if (this.mood === 'lobby') {
        const n = WALTZ[step % WALTZ.length];
        this.box(n + (step % 3 === 0 ? -12 : 0), 0, step % 3 === 0 ? 0.14 : 0.08);
        if (step % 6 === 0) this.box(WALTZ[(step + 3) % WALTZ.length] + 12, 0.02, 0.06);
      } else if (this.mood === 'game') {
        const n = SPARSE[step % SPARSE.length];
        if (n && this.chase < 0.3) this.box(n, 0, 0.07);
      }
      step++;
      setTimeout(tick, this.mood === 'lobby' ? 380 : 620);
    };
    tick();
    // 追逐：弦乐顿弓 + 心跳
    const pulse = () => {
      const ch = this.chase;
      const hb = Math.max(this.heart, 0);
      if (this.mood === 'game' && ch > 0.05) {
        const root = [38, 38, 41, 38, 36, 38, 43, 41][beat % 8];
        for (const o of [0, 7, 12]) this.tone(NOTE(root + o), { dur: 0.14, type: 'sawtooth', gain: 0.05 * ch, out: this.musicG, rev: 0.3 });
        if (beat % 4 === 0) this.noise({ dur: 0.08, gain: 0.08 * ch, freq: 5000, type: 'highpass', out: this.musicG });
      }
      if (this.mood === 'game' && hb > 0.02) {
        this.tone(58, { dur: 0.16, gain: 0.5 * hb, to: 38 });
        this.tone(52, { t: 0.17, dur: 0.18, gain: 0.35 * hb, to: 34 });
      }
      beat++;
      setTimeout(pulse, hb > 0.02 ? 900 - hb * 520 : 260 - ch * 60);
    };
    pulse();
  }

  // ---------------- 音效 ----------------
  play(name) {
    if (!this.ctx) return;
    const T = (f, o) => this.tone(f, o);
    const N = (o) => this.noise(o);
    switch (name) {
      case 'click':
        T(900, { dur: 0.05, gain: 0.08, type: 'triangle' });
        break;
      case 'error':
        T(180, { dur: 0.18, gain: 0.15, type: 'square', to: 120 });
        break;
      case 'invite':
        T(NOTE(76), { dur: 0.3, gain: 0.15, rev: 0.5 });
        T(NOTE(81), { t: 0.14, dur: 0.4, gain: 0.15, rev: 0.5 });
        break;
      case 'start':
        for (let i = 0; i < 4; i++) T(NOTE(50 + [0, 3, 7, 12][i]), { t: i * 0.2, dur: 1.2, gain: 0.12, type: 'triangle', rev: 0.7 });
        N({ dur: 2, gain: 0.12, freq: 300, to: 1200 });
        break;
      case 'go':
        T(NOTE(38), { dur: 1.5, gain: 0.3, type: 'sawtooth', to: NOTE(26), rev: 0.5 });
        N({ dur: 0.6, gain: 0.2, freq: 200 });
        break;
      case 'key':
        T(1800 + Math.random() * 600, { dur: 0.03, gain: 0.05, type: 'square' });
        N({ dur: 0.03, gain: 0.06, freq: 3000, type: 'highpass' });
        break;
      case 'qte':
        T(NOTE(84), { dur: 0.12, gain: 0.14, type: 'triangle' });
        T(NOTE(84), { t: 0.14, dur: 0.12, gain: 0.14, type: 'triangle' });
        break;
      case 'qteOk':
        T(NOTE(79), { dur: 0.1, gain: 0.14 });
        T(NOTE(86), { t: 0.08, dur: 0.25, gain: 0.14, rev: 0.4 });
        break;
      case 'spark':
        N({ dur: 0.5, gain: 0.5, freq: 4000, to: 300, type: 'bandpass' });
        T(90, { dur: 0.4, gain: 0.4, type: 'sawtooth', to: 40 });
        for (let i = 0; i < 5; i++) T(2000 + Math.random() * 3000, { t: Math.random() * 0.3, dur: 0.05, gain: 0.1, type: 'square' });
        break;
      case 'machine':
        for (let i = 0; i < 3; i++) T(NOTE(72 + i * 4), { t: i * 0.1, dur: 0.6, gain: 0.16, type: 'triangle', rev: 0.6 });
        N({ dur: 0.3, gain: 0.1, freq: 6000, type: 'highpass' });
        break;
      case 'power':
        for (let i = 0; i < 3; i++) {
          T(440, { t: i * 0.9, dur: 0.8, gain: 0.18, type: 'sawtooth', to: 880 });
          T(446, { t: i * 0.9, dur: 0.8, gain: 0.12, type: 'sawtooth', to: 890 });
        }
        break;
      case 'swing':
        N({ dur: 0.22, gain: 0.3, freq: 600, to: 3000, type: 'bandpass', q: 2 });
        break;
      case 'miss':
        N({ dur: 0.15, gain: 0.12, freq: 2000, to: 500, type: 'bandpass' });
        break;
      case 'hit':
        T(120, { dur: 0.25, gain: 0.5, to: 45 });
        N({ dur: 0.18, gain: 0.4, freq: 1200, to: 200 });
        T(700, { t: 0.03, dur: 0.35, gain: 0.12, type: 'sawtooth', to: 380, rev: 0.4 });
        break;
      case 'down':
        T(300, { dur: 0.7, gain: 0.2, type: 'sawtooth', to: 80, rev: 0.6 });
        T(80, { t: 0.3, dur: 0.3, gain: 0.4, to: 40 });
        break;
      case 'pallet':
        N({ dur: 0.25, gain: 0.6, freq: 900, to: 150 });
        T(160, { dur: 0.2, gain: 0.5, type: 'square', to: 60 });
        break;
      case 'stun':
        for (let i = 0; i < 4; i++) T(NOTE(88 - i * 3), { t: i * 0.08, dur: 0.2, gain: 0.1, type: 'triangle' });
        break;
      case 'break':
        for (let i = 0; i < 4; i++) N({ t: i * 0.06, dur: 0.12, gain: 0.4, freq: 1500 - i * 250, type: 'bandpass' });
        T(110, { dur: 0.3, gain: 0.4, type: 'square', to: 50 });
        break;
      case 'vault':
        N({ dur: 0.3, gain: 0.15, freq: 400, to: 1800, type: 'bandpass' });
        T(140, { t: 0.28, dur: 0.1, gain: 0.2, to: 70 });
        break;
      case 'pickup':
        T(200, { dur: 0.4, gain: 0.2, type: 'sawtooth', to: 320 });
        N({ dur: 0.3, gain: 0.15, freq: 700 });
        break;
      case 'caged':
        for (let i = 0; i < 3; i++) T(NOTE(55 + i * 6.02), { t: i * 0.02, dur: 1.4, gain: 0.16, type: 'square', rev: 0.8 });
        N({ dur: 0.15, gain: 0.4, freq: 3000, type: 'highpass' });
        break;
      case 'rescued':
        for (let i = 0; i < 3; i++) T(NOTE(67 + [0, 4, 9][i]), { t: i * 0.09, dur: 0.5, gain: 0.15, type: 'triangle', rev: 0.5 });
        N({ dur: 0.12, gain: 0.25, freq: 2500, type: 'highpass' });
        break;
      case 'healed':
        for (let i = 0; i < 4; i++) T(NOTE(72 + [0, 4, 7, 12][i]), { t: i * 0.07, dur: 0.5, gain: 0.1, rev: 0.6 });
        break;
      case 'gateOpen':
        T(70, { dur: 2, gain: 0.3, type: 'sawtooth', to: 110 });
        N({ dur: 2, gain: 0.2, freq: 300, to: 900, type: 'bandpass', q: 3 });
        T(NOTE(72), { t: 1.6, dur: 1, gain: 0.15, rev: 0.7 });
        break;
      case 'escape':
        for (let i = 0; i < 5; i++) T(NOTE(62 + [0, 5, 9, 12, 17][i]), { t: i * 0.1, dur: 0.8, gain: 0.14, type: 'triangle', rev: 0.7 });
        break;
      case 'dead':
        T(NOTE(45), { dur: 2.5, gain: 0.3, rev: 0.9 });
        T(NOTE(45) * 2.76, { dur: 1.8, gain: 0.1, rev: 0.9 });
        T(NOTE(45) * 5.4, { dur: 1, gain: 0.05 });
        break;
      case 'hatch':
        T(90, { dur: 1.2, gain: 0.25, type: 'triangle', to: 180, rev: 0.6 });
        break;
      case 'skill':
        T(500, { dur: 0.3, gain: 0.14, type: 'triangle', to: 1200, rev: 0.4 });
        break;
      case 'flare':
        N({ dur: 0.7, gain: 0.4, freq: 800, to: 6000, type: 'bandpass' });
        T(1200, { dur: 0.5, gain: 0.12, to: 2400 });
        break;
      case 'dash':
        N({ dur: 0.5, gain: 0.35, freq: 300, to: 2500, type: 'bandpass', q: 1.5 });
        T(70, { dur: 0.5, gain: 0.3, type: 'sawtooth', to: 140 });
        break;
      case 'web':
        for (let i = 0; i < 6; i++) T(1500 + i * 300, { t: i * 0.03, dur: 0.1, gain: 0.07, type: 'triangle' });
        break;
      case 'blink':
        N({ dur: 1.2, gain: 0.25, freq: 2000, to: 200, type: 'bandpass', q: 2 });
        T(NOTE(50), { dur: 1.2, gain: 0.15, to: NOTE(38), rev: 0.8 });
        break;
      case 'vanish':
        N({ dur: 0.5, gain: 0.2, freq: 5000, to: 800, type: 'highpass' });
        T(1400, { dur: 0.4, gain: 0.1, to: 500, rev: 0.6 });
        break;
      case 'whistle':
        T(1900, { dur: 0.5, gain: 0.14, to: 2300, rev: 0.6 });
        T(2300, { t: 0.5, dur: 0.4, gain: 0.12, to: 1800, rev: 0.6 });
        break;
      case 'win':
        for (let i = 0; i < 6; i++) T(NOTE(62 + [0, 4, 7, 12, 16, 19][i]), { t: i * 0.13, dur: 1.2, gain: 0.14, type: 'triangle', rev: 0.8 });
        break;
      case 'lose':
        for (let i = 0; i < 4; i++) T(NOTE(62 - [0, 2, 5, 9][i]), { t: i * 0.3, dur: 1.4, gain: 0.14, type: 'sawtooth', rev: 0.8 });
        break;
    }
  }
}

export const sound = new Sound();
