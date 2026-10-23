// 工业革命主题的音效与配乐，全部由 Web Audio 实时合成（不需要音频文件）。
// 音效：铁锤敲砧、煤块滚落、铁水叮当、啤酒桶、运河水声、蒸汽与铁轨、收银机、齿轮、汽笛、钟声。
// 配乐：运河时代是 3/4 拍的手风琴式华尔兹（D 多利亚调式）；铁路时代是 2/4 拍、带「哐当哐当」节奏的进行曲。
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
    this.sfxOn = LS('brass.sfx', true);
    this.musicOn = LS('brass.music', true);
    this.sfxVol = LS('brass.sfxVol', 0.7);
    this.musicVol = LS('brass.musicVol', 0.4);
    this.musicTimer = null;
    this.era = 'canal';
    this.step = 0;
    this.lastPlay = {};
  }

  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const c = (this.ctx = new AC());
      this.master = c.createGain();
      this.master.gain.value = this.sfxVol;
      // 轻微的房间混响（短延迟回授），让金属声更有空间感
      const comp = c.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      this.master.connect(comp);
      comp.connect(c.destination);
      this.verb = c.createGain();
      this.verb.gain.value = 0.18;
      const d1 = c.createDelay();
      d1.delayTime.value = 0.083;
      const fb = c.createGain();
      fb.gain.value = 0.35;
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2600;
      this.verb.connect(d1);
      d1.connect(lp);
      lp.connect(fb);
      fb.connect(d1);
      lp.connect(comp);
      this.musicBus = c.createGain();
      this.musicBus.gain.value = this.musicVol * 0.55;
      const mlp = c.createBiquadFilter();
      mlp.type = 'lowpass';
      mlp.frequency.value = 3200;
      const mdel = c.createDelay();
      mdel.delayTime.value = 0.31;
      const mfb = c.createGain();
      mfb.gain.value = 0.25;
      this.musicBus.connect(mlp);
      mlp.connect(comp);
      mlp.connect(mdel);
      mdel.connect(mfb);
      mfb.connect(mdel);
      mdel.connect(comp);
      this.noiseBuf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    if (this.musicOn) this.startMusic();
  }

  setSfx(on) {
    this.sfxOn = on;
    SAVE('brass.sfx', on);
  }
  setSfxVol(v) {
    this.sfxVol = v;
    SAVE('brass.sfxVol', v);
    if (this.master) this.master.gain.value = v;
  }
  setMusic(on) {
    this.musicOn = on;
    SAVE('brass.music', on);
    if (on) this.startMusic();
    else this.stopMusic();
  }
  setMusicVol(v) {
    this.musicVol = v;
    SAVE('brass.musicVol', v);
    if (this.musicBus) this.musicBus.gain.value = v * 0.55;
  }
  setEra(era) {
    if (this.era === era) return;
    this.era = era;
    if (this.musicTimer) {
      this.stopMusic();
      this.startMusic();
    }
  }

  // ---------- 基础发声 ----------
  tone(freq, { t = 0, dur = 0.2, type = 'sine', vol = 0.3, attack = 0.005, slide = 0, bus = null, filter = null, verb = false, detune = 0 } = {}) {
    if (!this.ctx) return;
    const c = this.ctx;
    const now = c.currentTime + t;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, now);
    if (detune) o.detune.value = detune;
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
    if (verb && !bus) g.connect(this.verb);
    o.start(now);
    o.stop(now + dur + 0.05);
  }
  noise({ t = 0, dur = 0.1, vol = 0.3, freq = 1500, q = 1, type = 'bandpass', sweep = 0, bus = null, attack = 0.002 } = {}) {
    if (!this.ctx) return;
    const c = this.ctx;
    const now = c.currentTime + t;
    const s = c.createBufferSource();
    s.buffer = this.noiseBuf;
    const f = c.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, now);
    if (sweep) f.frequency.exponentialRampToValueAtTime(Math.max(30, freq * sweep), now + dur);
    f.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(vol, now + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    s.connect(f);
    f.connect(g);
    g.connect(bus || this.master);
    s.start(now, Math.random() * 1.5);
    s.stop(now + dur + 0.02);
  }
  // 金属撞击：一组不成谐波的泛音
  metal(base, { t = 0, vol = 0.18, dur = 0.9, partials = [1, 2.76, 5.4, 8.93] } = {}) {
    partials.forEach((p, i) => this.tone(base * p, { t, dur: dur / (1 + i * 0.6), type: 'sine', vol: vol / (1 + i * 0.7), verb: true }));
    this.noise({ t, dur: 0.04, vol: vol * 0.9, freq: 4000, q: 0.8 });
  }

  play(name, arg) {
    if (!this.sfxOn || !this.ctx) return;
    // 同一种声音 40ms 内只响一次（批量动画时避免爆音）
    const now = performance.now();
    if (this.lastPlay[name] && now - this.lastPlay[name] < 40) return;
    this.lastPlay[name] = now;
    const f = this['s_' + name];
    if (f) f.call(this, arg);
  }

  s_click() {
    this.tone(1400, { dur: 0.04, type: 'square', vol: 0.05, filter: { freq: 2200 } });
    this.noise({ dur: 0.02, vol: 0.06, freq: 3000 });
  }
  s_select() {
    this.tone(660, { dur: 0.08, type: 'triangle', vol: 0.08 });
    this.tone(990, { t: 0.05, dur: 0.1, type: 'triangle', vol: 0.06 });
  }
  s_error() {
    this.tone(150, { dur: 0.22, type: 'sawtooth', vol: 0.08, filter: { freq: 600 } });
    this.tone(110, { t: 0.1, dur: 0.25, type: 'sawtooth', vol: 0.07, filter: { freq: 500 } });
  }
  // 铁锤敲砧（建造）
  s_build(ind) {
    this.metal(ind === 'pottery' ? 620 : 380, { vol: 0.2 });
    this.metal(ind === 'pottery' ? 640 : 395, { t: 0.18, vol: 0.16 });
    this.noise({ t: 0.32, dur: 0.18, vol: 0.12, freq: 300, type: 'lowpass' });
    this.tone(70, { t: 0.32, dur: 0.25, vol: 0.2, slide: 0.6 });
  }
  s_coal() {
    for (let i = 0; i < 5; i++) this.noise({ t: i * 0.05 + Math.random() * 0.03, dur: 0.08, vol: 0.12, freq: 500 + Math.random() * 600, q: 2 });
    this.tone(90, { dur: 0.3, vol: 0.12, slide: 0.7 });
  }
  s_iron() {
    this.metal(820, { vol: 0.12, dur: 0.7 });
    this.tone(1650, { t: 0.08, dur: 0.4, vol: 0.05 });
  }
  s_beer() {
    this.tone(1800, { dur: 0.15, vol: 0.07 });
    this.tone(2400, { t: 0.04, dur: 0.18, vol: 0.05 });
    for (let i = 0; i < 4; i++) this.tone(420 - i * 40, { t: 0.15 + i * 0.07, dur: 0.08, vol: 0.06, slide: 0.6 });
  }
  s_coins(n = 3) {
    for (let i = 0; i < Math.min(6, n); i++) {
      const t = i * 0.06 + Math.random() * 0.02;
      this.tone(2600 + Math.random() * 900, { t, dur: 0.12, vol: 0.05 });
      this.tone(3900 + Math.random() * 600, { t: t + 0.01, dur: 0.08, vol: 0.03 });
    }
  }
  // 运河：水声 + 船桨
  s_canal() {
    this.noise({ dur: 0.9, vol: 0.12, freq: 900, q: 0.6, sweep: 0.4, type: 'bandpass', attack: 0.1 });
    for (let i = 0; i < 3; i++) this.tone(300 + Math.random() * 120, { t: 0.2 + i * 0.22, dur: 0.12, vol: 0.06, slide: 1.8 });
  }
  // 铁路：蒸汽 + 铁轨哐当
  s_rail() {
    this.noise({ dur: 0.7, vol: 0.14, freq: 5000, q: 0.4, type: 'highpass', sweep: 0.6, attack: 0.03 });
    for (let i = 0; i < 4; i++) {
      this.noise({ t: 0.35 + i * 0.17, dur: 0.05, vol: 0.16, freq: 1600, q: 3 });
      this.tone(120, { t: 0.35 + i * 0.17, dur: 0.08, vol: 0.1, slide: 0.6 });
    }
  }
  // 翻面：钱币瀑布 + 铃声
  s_flip() {
    this.s_coins(5);
    this.metal(1320, { t: 0.18, vol: 0.09, dur: 1.2, partials: [1, 2, 3.01, 4.2] });
  }
  s_sell() {
    this.noise({ dur: 0.12, vol: 0.18, freq: 250, type: 'lowpass' });
    this.tone(80, { dur: 0.2, vol: 0.2, slide: 0.6 });
    setTimeout(() => this.s_coins(4), 180);
  }
  // 收银机
  s_loan() {
    this.noise({ dur: 0.06, vol: 0.12, freq: 2000, q: 2 });
    this.noise({ t: 0.08, dur: 0.06, vol: 0.12, freq: 1800, q: 2 });
    this.metal(1760, { t: 0.18, vol: 0.12, dur: 1.4, partials: [1, 2.01, 3.9] });
    this.s_coins(6);
  }
  // 齿轮棘轮
  s_develop() {
    for (let i = 0; i < 7; i++) this.noise({ t: i * 0.055, dur: 0.025, vol: 0.12, freq: 2600 - i * 120, q: 6 });
    this.tone(220, { t: 0.4, dur: 0.2, type: 'triangle', vol: 0.08, slide: 1.5 });
  }
  s_scout() {
    for (let i = 0; i < 6; i++) this.noise({ t: i * 0.07, dur: 0.06, vol: 0.08, freq: 3500, q: 0.8 });
    this.tone(880, { t: 0.45, dur: 0.3, type: 'triangle', vol: 0.06, slide: 1.5 });
  }
  s_card() {
    this.noise({ dur: 0.08, vol: 0.09, freq: 3000, q: 0.7, sweep: 0.5 });
  }
  // 工厂汽笛（轮到你）
  s_turn() {
    const c = this.ctx;
    if (!c) return;
    for (const [f, d] of [
      [392, 0],
      [494, 4],
      [587, -3],
    ])
      this.tone(f, { dur: 0.9, type: 'sawtooth', vol: 0.05, attack: 0.08, filter: { freq: 1400, q: 2 }, detune: d, verb: true });
    this.noise({ dur: 0.9, vol: 0.05, freq: 2500, q: 0.6, attack: 0.08 });
  }
  s_otherTurn() {
    this.tone(1200, { dur: 0.05, type: 'square', vol: 0.03, filter: { freq: 1800 } });
    this.tone(900, { t: 0.25, dur: 0.05, type: 'square', vol: 0.03, filter: { freq: 1500 } });
  }
  // 钟楼报时（一轮结束）
  s_round() {
    [523, 659, 784, 1047].forEach((f, i) => this.metal(f / 2, { t: i * 0.28, vol: 0.09, dur: 1.4, partials: [1, 2, 2.4, 3, 4.2] }));
  }
  // 长汽笛 + 鼓点（时代结束）
  s_era() {
    for (const [f, d] of [
      [311, 0],
      [370, 5],
      [466, -4],
    ])
      this.tone(f, { dur: 2.4, type: 'sawtooth', vol: 0.06, attack: 0.2, filter: { freq: 1200, q: 1.5 }, detune: d, verb: true });
    for (let i = 0; i < 10; i++) this.noise({ t: 0.3 + i * 0.09, dur: 0.07, vol: 0.12 + i * 0.01, freq: 180, type: 'lowpass' });
    this.tone(55, { t: 1.25, dur: 0.8, vol: 0.25, slide: 0.7 });
  }
  s_score() {
    this.tone(880, { dur: 0.1, type: 'triangle', vol: 0.07 });
    this.tone(1320, { t: 0.06, dur: 0.14, type: 'triangle', vol: 0.06 });
  }
  s_crumble() {
    this.noise({ dur: 0.5, vol: 0.14, freq: 400, type: 'lowpass', sweep: 0.5 });
    for (let i = 0; i < 4; i++) this.noise({ t: 0.05 + i * 0.08, dur: 0.06, vol: 0.08, freq: 900 + Math.random() * 500, q: 2 });
  }
  // 铜管号角（胜利）
  s_win() {
    const seq = [
      [392, 0, 0.18],
      [523, 0.18, 0.18],
      [659, 0.36, 0.18],
      [784, 0.54, 0.6],
      [659, 1.2, 0.2],
      [784, 1.4, 1.2],
    ];
    for (const [f, t, d] of seq) {
      this.tone(f, { t, dur: d + 0.1, type: 'sawtooth', vol: 0.07, attack: 0.03, filter: { freq: 2200, q: 1 }, verb: true });
      this.tone(f / 2, { t, dur: d + 0.1, type: 'triangle', vol: 0.06 });
    }
    for (let i = 0; i < 6; i++) this.noise({ t: 1.4 + i * 0.1, dur: 0.3, vol: 0.04, freq: 8000, q: 0.5 });
  }
  s_lose() {
    [392, 370, 349, 311].forEach((f, i) => this.tone(f, { t: i * 0.32, dur: 0.5, type: 'triangle', vol: 0.09 }));
  }
  s_chat() {
    this.tone(1046, { dur: 0.1, vol: 0.05 });
    this.tone(1318, { t: 0.08, dur: 0.12, vol: 0.04 });
  }
  s_join() {
    this.metal(660, { vol: 0.08, dur: 0.8, partials: [1, 2, 3.01] });
    this.metal(880, { t: 0.15, vol: 0.07, dur: 0.8, partials: [1, 2, 3.01] });
  }
  s_coach() {
    this.tone(784, { dur: 0.12, type: 'triangle', vol: 0.05 });
    this.tone(1175, { t: 0.08, dur: 0.18, type: 'triangle', vol: 0.05 });
  }

  // ---------- 背景音乐 ----------
  startMusic() {
    if (!this.ctx || this.musicTimer) return;
    if (this.era === 'rail') return this.startRail();
    this.startCanal();
  }
  stopMusic() {
    clearInterval(this.musicTimer);
    this.musicTimer = null;
  }
  // 运河时代：D 多利亚调式的 3/4 拍华尔兹，手风琴（方波 + 低通）旋律，「嘭—嚓—嚓」伴奏
  startCanal() {
    const B = this.musicBus;
    const D = [146.8, 164.8, 174.6, 196, 220, 246.9, 261.6, 293.7, 329.6, 349.2, 392, 440];
    const chords = [
      [73.4, 146.8, 174.6, 220], // Dm
      [98, 146.8, 196, 246.9], // G
      [87.3, 130.8, 174.6, 220], // F
      [65.4, 130.8, 164.8, 196], // C
      [73.4, 146.8, 174.6, 220],
      [110, 164.8, 220, 261.6], // Am
      [98, 146.8, 196, 246.9],
      [110, 138.6, 164.8, 220], // A
    ];
    let note = 7;
    const beat = 0.36;
    const tick = () => {
      if (!this.musicOn || !this.ctx) return;
      const s = this.step++;
      const bar = Math.floor(s / 3) % chords.length;
      const ch = chords[bar];
      const b = s % 3;
      if (b === 0) this.tone(ch[0], { dur: beat * 1.4, type: 'triangle', vol: 0.11, bus: B });
      else for (const f of ch.slice(1)) this.tone(f, { dur: beat * 0.55, type: 'square', vol: 0.012, filter: { freq: 900 }, bus: B });
      // 旋律：随机游走，句尾回到和弦音
      const phraseEnd = s % 24 >= 21;
      if (Math.random() < (b === 0 ? 0.85 : 0.5) && !(phraseEnd && b === 2)) {
        note = Math.max(4, Math.min(D.length - 1, note + [-2, -1, -1, 0, 1, 1, 2][Math.floor(Math.random() * 7)]));
        if (phraseEnd) note = D.indexOf(ch[2]) >= 0 ? D.indexOf(ch[2]) : note;
        const f = D[note] * 2;
        const len = b === 0 && Math.random() < 0.4 ? beat * 2 : beat * 0.95;
        this.tone(f, { dur: len, type: 'square', vol: 0.022, attack: 0.03, filter: { freq: 1500, q: 0.7 }, bus: B, detune: 6 });
        this.tone(f, { dur: len, type: 'sawtooth', vol: 0.012, attack: 0.03, filter: { freq: 1200 }, bus: B, detune: -7 });
      }
      // 远处工厂的锤声
      if (s % 24 === 12) this.tone(392 * 2.76, { dur: 0.5, vol: 0.008, bus: B });
    };
    tick();
    this.musicTimer = setInterval(tick, beat * 1000);
  }
  // 铁路时代：2/4 拍进行曲，低音固定音型 + 车轮的「哐当」 + 铜管旋律
  startRail() {
    const B = this.musicBus;
    const scale = [196, 220, 246.9, 261.6, 293.7, 329.6, 349.2, 392, 440, 493.9];
    const bass = [98, 98, 146.8, 98, 110, 110, 164.8, 110, 87.3, 87.3, 130.8, 87.3, 98, 98, 146.8, 123.5];
    let note = 4;
    const beat = 0.25;
    const tick = () => {
      if (!this.musicOn || !this.ctx) return;
      const s = this.step++;
      const bf = bass[s % bass.length];
      if (s % 2 === 0) this.tone(bf, { dur: beat * 1.6, type: 'triangle', vol: 0.12, bus: B });
      // 车轮：哐当—哐当
      if (s % 4 === 0 || s % 4 === 1) this.noise({ dur: 0.05, vol: 0.05, freq: 1400, q: 3, bus: B });
      if (s % 2 === 1) this.noise({ dur: 0.12, vol: 0.022, freq: 6000, q: 0.5, type: 'highpass', bus: B });
      if (s % 8 === 0) {
        note = Math.max(0, Math.min(scale.length - 1, note + [-2, -1, 0, 1, 2, 3][Math.floor(Math.random() * 6)]));
        const f = scale[note] * 2;
        this.tone(f, { dur: beat * 3, type: 'sawtooth', vol: 0.02, attack: 0.04, filter: { freq: 1600 }, bus: B });
        this.tone(f * 1.5, { dur: beat * 3, type: 'sawtooth', vol: 0.01, attack: 0.04, filter: { freq: 1400 }, bus: B });
      } else if (s % 8 === 4 && Math.random() < 0.7) {
        const f = scale[Math.max(0, note - 1)] * 2;
        this.tone(f, { dur: beat * 1.6, type: 'sawtooth', vol: 0.016, attack: 0.03, filter: { freq: 1500 }, bus: B });
      } else if (s % 2 === 1 && Math.random() < 0.3) {
        this.tone(scale[(note + 2) % scale.length] * 2, { dur: beat * 0.8, type: 'square', vol: 0.012, filter: { freq: 1300 }, bus: B });
      }
      // 每 64 拍一声远处的汽笛
      if (s % 64 === 60) this.tone(466, { dur: 1.2, type: 'sawtooth', vol: 0.012, attack: 0.15, filter: { freq: 1000, q: 2 }, bus: B });
    };
    tick();
    this.musicTimer = setInterval(tick, beat * 1000);
  }
}

export const sound = new Sound();
