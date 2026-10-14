// 所有音效均由 Web Audio 实时合成，无需音频文件。
const LS = (k, d) => {
  try {
    const v = localStorage.getItem(k);
    return v === null ? d : JSON.parse(v);
  } catch {
    return d;
  }
};
const SAVE = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
};

class Sound {
  constructor() {
    this.ctx = null;
    this.sfxOn = LS('catan.sfx', true);
    this.musicOn = LS('catan.music', true);
    this.sfxVol = LS('catan.sfxVol', 0.7);
    this.musicVol = LS('catan.musicVol', 0.35);
    this.musicTimer = null;
    this.step = 0;
  }

  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.sfxVol;
      this.master.connect(this.ctx.destination);
      this.musicBus = this.ctx.createGain();
      this.musicBus.gain.value = this.musicVol * 0.5;
      // 简易混响让音乐更柔和
      const delay = this.ctx.createDelay();
      delay.delayTime.value = 0.28;
      const fb = this.ctx.createGain();
      fb.gain.value = 0.32;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2200;
      this.musicBus.connect(lp);
      lp.connect(this.ctx.destination);
      lp.connect(delay);
      delay.connect(fb);
      fb.connect(delay);
      delay.connect(this.ctx.destination);
      this.noiseBuf = this.ctx.createBuffer(1, this.ctx.sampleRate, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    if (this.musicOn) this.startMusic();
  }

  setSfx(on) {
    this.sfxOn = on;
    SAVE('catan.sfx', on);
  }
  setSfxVol(v) {
    this.sfxVol = v;
    SAVE('catan.sfxVol', v);
    if (this.master) this.master.gain.value = v;
  }
  setMusic(on) {
    this.musicOn = on;
    SAVE('catan.music', on);
    if (on) this.startMusic();
    else this.stopMusic();
  }
  setMusicVol(v) {
    this.musicVol = v;
    SAVE('catan.musicVol', v);
    if (this.musicBus) this.musicBus.gain.value = v * 0.5;
  }

  // ---------- 基础发声 ----------
  tone(freq, { t = 0, dur = 0.2, type = 'sine', vol = 0.3, attack = 0.005, slide = 0, bus = null, filter = null } = {}) {
    if (!this.ctx) return;
    const c = this.ctx;
    const now = c.currentTime + t;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, now);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), now + dur);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(vol, now + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    let node = o;
    if (filter) {
      const f = c.createBiquadFilter();
      f.type = filter.type || 'lowpass';
      f.frequency.value = filter.freq || 1200;
      f.Q.value = filter.q || 1;
      o.connect(f);
      node = f;
    }
    node.connect(g);
    g.connect(bus || this.master);
    o.start(now);
    o.stop(now + dur + 0.05);
  }

  noise({ t = 0, dur = 0.1, vol = 0.3, freq = 1500, q = 1, type = 'bandpass', sweep = 0 } = {}) {
    if (!this.ctx) return;
    const c = this.ctx;
    const now = c.currentTime + t;
    const s = c.createBufferSource();
    s.buffer = this.noiseBuf;
    const f = c.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, now);
    if (sweep) f.frequency.exponentialRampToValueAtTime(freq * sweep, now + dur);
    f.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(vol, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    s.connect(f);
    f.connect(g);
    g.connect(this.master);
    s.start(now, Math.random() * 0.5);
    s.stop(now + dur + 0.02);
  }

  play(name, arg) {
    if (!this.sfxOn || !this.ctx) return;
    const fn = this['s_' + name];
    if (fn) fn.call(this, arg);
  }

  // ---------- 音效 ----------
  s_click() {
    this.tone(880, { dur: 0.05, type: 'triangle', vol: 0.12 });
  }
  s_hover() {
    this.tone(1320, { dur: 0.03, type: 'sine', vol: 0.04 });
  }
  s_error() {
    this.tone(140, { dur: 0.18, type: 'sawtooth', vol: 0.12, filter: { freq: 600 } });
    this.tone(110, { t: 0.09, dur: 0.2, type: 'sawtooth', vol: 0.12, filter: { freq: 500 } });
  }
  s_dice() {
    // 骰子在木桌上滚动：一串随机间隔的咔哒声，最后两声落定
    let t = 0;
    for (let i = 0; i < 11; i++) {
      t += 0.035 + Math.random() * 0.06;
      this.noise({ t, dur: 0.03, vol: 0.35 - i * 0.02, freq: 2500 + Math.random() * 2500, q: 4 });
      this.tone(300 + Math.random() * 400, { t, dur: 0.03, type: 'square', vol: 0.03 });
    }
    this.noise({ t: t + 0.12, dur: 0.06, vol: 0.4, freq: 900, q: 2 });
    this.tone(160, { t: t + 0.12, dur: 0.12, vol: 0.25 });
    this.noise({ t: t + 0.2, dur: 0.05, vol: 0.3, freq: 1100, q: 2 });
  }
  s_road() {
    this.tone(180, { dur: 0.12, type: 'triangle', vol: 0.3, slide: 0.6 });
    this.noise({ dur: 0.06, vol: 0.25, freq: 700, q: 1.5 });
  }
  s_settlement() {
    // 两下锤击 + 一个明亮的和弦
    this.tone(200, { dur: 0.1, type: 'triangle', vol: 0.35, slide: 0.5 });
    this.noise({ dur: 0.05, vol: 0.3, freq: 1200 });
    this.tone(220, { t: 0.14, dur: 0.1, type: 'triangle', vol: 0.35, slide: 0.5 });
    this.noise({ t: 0.14, dur: 0.05, vol: 0.3, freq: 1300 });
    [523, 659, 784].forEach((f, i) => this.tone(f, { t: 0.3 + i * 0.05, dur: 0.5, type: 'triangle', vol: 0.12 }));
  }
  s_city() {
    this.tone(130, { dur: 0.3, type: 'triangle', vol: 0.35, slide: 0.7 });
    this.noise({ dur: 0.15, vol: 0.25, freq: 400, q: 0.8 });
    [392, 494, 587, 784, 988].forEach((f, i) => this.tone(f, { t: 0.2 + i * 0.07, dur: 0.7, type: 'triangle', vol: 0.12 }));
    this.tone(196, { t: 0.2, dur: 1, type: 'sine', vol: 0.15 });
  }
  s_gain(res) {
    const base = { wood: 392, brick: 330, sheep: 523, wheat: 587, ore: 262 }[res] || 440;
    this.tone(base, { dur: 0.25, type: 'triangle', vol: 0.13 });
    this.tone(base * 1.5, { t: 0.06, dur: 0.3, type: 'sine', vol: 0.09 });
    if (res === 'sheep') this.tone(base * 1.2, { t: 0.02, dur: 0.18, type: 'sawtooth', vol: 0.03, filter: { freq: 1400, q: 6 } });
  }
  s_coin() {
    [1568, 2093].forEach((f, i) => this.tone(f, { t: i * 0.08, dur: 0.25, type: 'sine', vol: 0.1 }));
    this.tone(3136, { t: 0.08, dur: 0.15, type: 'sine', vol: 0.04 });
  }
  s_trade() {
    [0, 0.09, 0.18].forEach((t, i) => {
      this.tone(1760 + i * 220, { t, dur: 0.2, type: 'sine', vol: 0.09 });
      this.noise({ t, dur: 0.04, vol: 0.1, freq: 6000, q: 3 });
    });
    [523, 784].forEach((f) => this.tone(f, { t: 0.28, dur: 0.4, type: 'triangle', vol: 0.1 }));
  }
  s_card() {
    this.noise({ dur: 0.18, vol: 0.25, freq: 3000, q: 0.7, sweep: 0.4 });
    this.tone(660, { t: 0.1, dur: 0.15, type: 'sine', vol: 0.07 });
  }
  s_devPlay(card) {
    this.s_card();
    if (card === 'knight') {
      // 号角
      [[392, 0], [523, 0.15], [659, 0.3], [784, 0.45]].forEach(([f, t]) => this.tone(f, { t: t + 0.1, dur: 0.35, type: 'sawtooth', vol: 0.09, filter: { freq: 1800, q: 1 } }));
    } else if (card === 'monopoly') {
      [262, 311, 392, 466].forEach((f, i) => this.tone(f, { t: 0.1 + i * 0.06, dur: 0.6, type: 'square', vol: 0.05, filter: { freq: 1200 } }));
    } else {
      [659, 784, 988, 1319].forEach((f, i) => this.tone(f, { t: 0.1 + i * 0.07, dur: 0.4, type: 'triangle', vol: 0.09 }));
    }
  }
  s_robber() {
    this.tone(110, { dur: 0.9, type: 'sawtooth', vol: 0.14, slide: 0.6, filter: { freq: 500, q: 3 } });
    this.tone(116, { dur: 0.9, type: 'sawtooth', vol: 0.12, slide: 0.6, filter: { freq: 450, q: 3 } });
    this.noise({ t: 0.05, dur: 0.6, vol: 0.12, freq: 300, q: 0.7, type: 'lowpass' });
  }
  s_seven() {
    [311, 294, 277, 262].forEach((f, i) => this.tone(f, { t: i * 0.12, dur: 0.25, type: 'square', vol: 0.06, filter: { freq: 900 } }));
    this.tone(65, { t: 0.45, dur: 0.6, type: 'sine', vol: 0.3 });
  }
  s_steal() {
    this.noise({ dur: 0.25, vol: 0.25, freq: 1800, q: 1, sweep: 3 });
    this.tone(880, { t: 0.15, dur: 0.12, type: 'triangle', vol: 0.08, slide: 1.6 });
  }
  s_discard() {
    for (let i = 0; i < 3; i++) this.noise({ t: i * 0.07, dur: 0.1, vol: 0.18, freq: 2600, q: 0.8, sweep: 0.5 });
  }
  s_turn() {
    // 轮到你：清亮的钟声
    [784, 1175].forEach((f, i) => {
      this.tone(f, { t: i * 0.12, dur: 1.1, type: 'sine', vol: 0.14 });
      this.tone(f * 2.76, { t: i * 0.12, dur: 0.5, type: 'sine', vol: 0.03 });
    });
  }
  s_otherTurn() {
    this.tone(523, { dur: 0.3, type: 'sine', vol: 0.06 });
  }
  s_award() {
    [523, 659, 784, 1047].forEach((f, i) => this.tone(f, { t: i * 0.09, dur: 0.5, type: 'triangle', vol: 0.12 }));
    this.tone(262, { dur: 0.9, type: 'sine', vol: 0.12 });
  }
  s_offer() {
    this.tone(988, { dur: 0.12, type: 'sine', vol: 0.1 });
    this.tone(1319, { t: 0.1, dur: 0.18, type: 'sine', vol: 0.1 });
  }
  s_chat() {
    this.tone(1046, { dur: 0.08, type: 'sine', vol: 0.06, slide: 1.3 });
  }
  s_join() {
    [440, 660].forEach((f, i) => this.tone(f, { t: i * 0.08, dur: 0.2, type: 'triangle', vol: 0.1 }));
  }
  s_tile() {
    this.tone(300 + Math.random() * 300, { dur: 0.06, type: 'triangle', vol: 0.05 });
  }
  s_win() {
    const mel = [
      [523, 0, 0.2], [523, 0.2, 0.1], [523, 0.3, 0.1], [698, 0.4, 0.6],
      [784, 1.05, 0.2], [698, 1.25, 0.15], [784, 1.4, 0.15], [1047, 1.55, 1.2],
    ];
    for (const [f, t, d] of mel) {
      this.tone(f, { t, dur: d + 0.2, type: 'sawtooth', vol: 0.08, filter: { freq: 2400 } });
      this.tone(f / 2, { t, dur: d + 0.2, type: 'triangle', vol: 0.1 });
    }
    [262, 330, 392, 523].forEach((f) => this.tone(f, { t: 1.55, dur: 1.6, type: 'triangle', vol: 0.07 }));
    for (let i = 0; i < 6; i++) this.noise({ t: 1.55 + i * 0.1, dur: 0.3, vol: 0.06, freq: 8000, q: 0.5 });
  }
  s_lose() {
    [392, 370, 349, 330].forEach((f, i) => this.tone(f, { t: i * 0.3, dur: 0.5, type: 'triangle', vol: 0.1 }));
  }

  // ---------- 背景音乐：五声音阶生成式小曲 ----------
  startMusic() {
    if (!this.ctx || this.musicTimer) return;
    const scale = [261.6, 293.7, 329.6, 392, 440, 523.3, 587.3, 659.3];
    const chords = [
      [130.8, 196, 261.6],
      [110, 164.8, 220],
      [87.3, 130.8, 174.6],
      [98, 146.8, 196],
    ];
    let note = 3;
    const beat = 0.42;
    const tick = () => {
      if (!this.musicOn || !this.ctx) return;
      const s = this.step++;
      const bar = Math.floor(s / 8) % chords.length;
      if (s % 8 === 0) {
        for (const f of chords[bar]) this.tone(f, { dur: beat * 8, type: 'sine', vol: 0.05, attack: 0.6, bus: this.musicBus });
      }
      // 随机游走旋律，留白让它像海边的拨弦
      if (Math.random() < (s % 2 === 0 ? 0.62 : 0.28)) {
        note = Math.max(0, Math.min(scale.length - 1, note + [-2, -1, -1, 0, 1, 1, 2][Math.floor(Math.random() * 7)]));
        const f = scale[note];
        this.tone(f, { dur: 0.9, type: 'triangle', vol: 0.06, attack: 0.01, bus: this.musicBus });
        this.tone(f * 2, { dur: 0.4, type: 'sine', vol: 0.015, bus: this.musicBus });
      }
      if (s % 4 === 2) this.tone(chords[bar][0] * 2, { dur: 0.25, type: 'sine', vol: 0.03, bus: this.musicBus });
    };
    tick();
    this.musicTimer = setInterval(tick, beat * 1000);
  }
  stopMusic() {
    clearInterval(this.musicTimer);
    this.musicTimer = null;
  }
}

export const sound = new Sound();
