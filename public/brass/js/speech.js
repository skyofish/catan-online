// 语音朗读：优先使用服务器的智谱 GLM-TTS（更像真人，按角色分配音色），
// 服务器没配置、请求失败或超时时，退回浏览器自带的中文朗读。
import { getSession } from '/js/session.js';

const LS = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};
// 44 字节的静音 wav：第一次点击时播放一下，解除手机浏览器的自动播放限制
const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';

export class Speaker {
  constructor() {
    this.cloud = false;
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.queue = [];
    this.playing = false;
    this.gen = 0;
    this.urls = new Map(); // 文本 → blob URL / Promise
    this.vol = LS.get('brass.voiceVol', 0.9);
    this.chatOn = LS.get('brass.chatVoice', true);
    this.failures = 0;
    const unlock = () => {
      this.audio.src = SILENT;
      this.audio.play().catch(() => {});
    };
    window.addEventListener('pointerdown', unlock, { once: true, capture: true });
  }

  setCloud(on) {
    this.cloud = !!on;
  }
  setVolume(v) {
    this.vol = v;
    LS.set('brass.voiceVol', v);
    this.audio.volume = v;
  }
  setChat(on) {
    this.chatOn = on;
    LS.set('brass.chatVoice', on);
  }
  get engine() {
    return this.cloud && this.failures < 3 ? '智谱语音' : '浏览器朗读';
  }

  key(text, o) {
    return `${o.role || 'narrator'}|${o.seat || 0}|${o.speed || 1}|${text}`;
  }
  // 向服务器要音频（带缓存）；失败返回 null
  fetchAudio(text, o = {}) {
    if (!this.cloud || this.failures >= 3) return Promise.resolve(null);
    const k = this.key(text, o);
    if (this.urls.has(k)) return this.urls.get(k);
    const p = (async () => {
      try {
        const res = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getSession() },
          body: JSON.stringify({ text, role: o.role, seat: o.seat, speed: o.speed }),
          signal: AbortSignal.timeout ? AbortSignal.timeout(25000) : undefined,
        });
        if (!res.ok) {
          // 服务器没配置：以后都不再尝试；其他错误连续 3 次也放弃
          if (res.status === 503) this.cloud = false;
          else this.failures++;
          this.urls.delete(k);
          return null;
        }
        this.failures = 0;
        return URL.createObjectURL(await res.blob());
      } catch {
        this.failures++;
        this.urls.delete(k);
        return null;
      }
    })();
    this.urls.set(k, p);
    // 最多缓存 80 句
    if (this.urls.size > 80) {
      const first = this.urls.keys().next().value;
      const v = this.urls.get(first);
      this.urls.delete(first);
      Promise.resolve(v).then((u) => u && URL.revokeObjectURL(u));
    }
    return p;
  }
  prefetch(text, o = {}) {
    if (text) this.fetchAudio(plain(text), o);
  }

  // 朗读：interrupt 为 true 时打断正在读的（教程翻页），否则排队（聊天台词）
  speak(text, o = {}) {
    const t = plain(text);
    if (!t) return;
    if (o.interrupt) this.stop();
    // 台词积压太多就丢掉旧的
    if (this.queue.length > 3) this.queue.splice(0, this.queue.length - 3);
    this.queue.push({ t, o, gen: this.gen });
    if (!this.playing) this.next();
  }
  stop() {
    this.gen++;
    this.queue = [];
    this.audio.pause();
    if (window.speechSynthesis) speechSynthesis.cancel();
    this.playing = false;
  }

  async next() {
    const item = this.queue.shift();
    if (!item) {
      this.playing = false;
      return;
    }
    this.playing = true;
    const url = await this.fetchAudio(item.t, item.o);
    if (item.gen !== this.gen) return;
    const done = () => item.gen === this.gen && setTimeout(() => this.next(), 250);
    if (url) {
      this.audio.src = url;
      this.audio.volume = this.vol;
      this.audio.onended = done;
      this.audio.onerror = () => (this.browserSay(item.t, item.o, done), void 0);
      try {
        await this.audio.play();
        return;
      } catch {
        // 自动播放被拦截等：退回浏览器朗读
      }
    }
    this.browserSay(item.t, item.o, done);
  }

  browserSay(text, o, done) {
    if (!window.speechSynthesis) return done();
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text.replace(/£\s*(\d+)/g, '$1英镑'));
      u.lang = 'zh-CN';
      u.rate = 1.05 * (o.speed || 1);
      u.pitch = o.role === 'mentor' ? 0.85 : 1;
      u.volume = this.vol;
      const v = speechSynthesis.getVoices().find((x) => /zh[-_]CN/i.test(x.lang));
      if (v) u.voice = v;
      u.onend = done;
      u.onerror = done;
      speechSynthesis.speak(u);
    } catch {
      done();
    }
  }
}

// 去掉 HTML 标记与表情，保留标点
export function plain(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '。')
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z]+;/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}️]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export const speaker = new Speaker();
