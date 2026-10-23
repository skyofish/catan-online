'use strict';
// 平台共享：智谱 GLM-TTS 语音合成（与 AI 玩家共用 ZHIPU_API_KEY）。
// 浏览器向本服务器要语音，服务器调用智谱、把结果存成 wav 文件缓存起来：
// 同一句话（同一音色、语速）只生成一次，教程台词这类固定文本以后都不再花钱。
// 没有配置 Key、接口出错或超时时返回错误，前端自动改用浏览器自带的朗读。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const env = (k) => (process.env[k] || '').trim();
const off = (k) => /^(0|false|off|no)$/i.test(env(k));
const base = env('ZHIPU_BASE_URL') ? env('ZHIPU_BASE_URL').replace(/\/$/, '') : 'https://open.bigmodel.cn/api/paas/v4';

// 智谱的系统音色
const VOICES = ['tongtong', 'chuichui', 'xiaochen', 'jam', 'kazi', 'douji', 'luodo'];
const CFG = {
  // 默认与 AI 玩家共用 ZHIPU_API_KEY；也可以单独配置 ZHIPU_TTS_API_KEY
  key: off('ZHIPU_TTS_ENABLED') ? '' : env('ZHIPU_TTS_API_KEY') || env('ZHIPU_API_KEY'),
  url: env('ZHIPU_TTS_URL') || `${base}/audio/speech`,
  model: env('ZHIPU_TTS_MODEL') || 'glm-tts',
  timeout: Number(env('ZHIPU_TTS_TIMEOUT_SECONDS')) * 1000 || 20000,
  concurrency: 2,
  perUserPerMin: Number(env('TTS_USER_PER_MIN')) || 30, // 每人每分钟最多生成几句（命中缓存不算）
  maxCacheMB: Number(env('TTS_CACHE_MB')) || 300,
  // 角色音色：可以在 .env 里改
  roles: {
    mentor: env('TTS_VOICE_MENTOR') || 'xiaochen',
    narrator: env('TTS_VOICE_NARRATOR') || 'tongtong',
    players: (env('TTS_VOICE_PLAYERS') || 'chuichui,tongtong,jam,kazi,douji,luodo')
      .split(',')
      .map((x) => x.trim())
      .filter((x) => VOICES.includes(x) || /^[\w-]{2,64}$/.test(x)),
  },
};

const stats = { calls: 0, cached: 0, errors: 0, chars: 0, lastError: null, lastErrorAt: null };
const enabled = () => !!CFG.key;
let dir = null;

function init(dbPath) {
  dir = path.join(path.dirname(dbPath), 'tts-cache');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  console.log(enabled() ? `语音合成：智谱 ${CFG.model}（教程 ${CFG.roles.mentor}，玩家 ${CFG.roles.players.join('/')}）` : '语音合成：未配置（使用浏览器自带朗读）');
}

// 朗读前的文本整理：去掉标记、符号读法
const ROMAN = { Ⅰ: '一', Ⅱ: '二', Ⅲ: '三', Ⅳ: '四', Ⅴ: '五', Ⅵ: '六', Ⅶ: '七', Ⅷ: '八' };
function clean(text) {
  return String(text || '')
    .replace(/<br\s*\/?>/gi, '。')
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z]+;/g, '')
    .replace(/[ⅠⅡⅢⅣⅤⅥⅦⅧ]/g, (c) => ROMAN[c])
    .replace(/£\s*(\d+)/g, '$1英镑')
    .replace(/[·•]/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}️]/gu, '')
    .replace(/\s+/g, ' ')
    .replace(/。{2,}/g, '。')
    .replace(/^[。，\s]+/, '')
    .trim()
    .slice(0, 400);
}

let active = 0;
const waiting = [];
async function slot(fn) {
  if (active >= CFG.concurrency) await new Promise((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    const n = waiting.shift();
    if (n) n();
  }
}

const inflight = new Map();
const hits = new Map(); // userId -> [时间]

async function synth(text, voice, speed) {
  stats.calls++;
  stats.chars += text.length;
  const res = await fetch(CFG.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CFG.key}` },
    body: JSON.stringify({ model: CFG.model, input: text, voice, speed, response_format: 'wav' }),
    signal: AbortSignal.timeout(CFG.timeout),
  });
  const type = res.headers.get('content-type') || '';
  if (!res.ok || /json/.test(type)) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data.error && data.error.message) || `HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100) throw new Error('返回的音频为空');
  return buf;
}

function prune() {
  try {
    const files = fs.readdirSync(dir).map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { f, size: st.size, t: st.atimeMs || st.mtimeMs };
    });
    let total = files.reduce((s, x) => s + x.size, 0);
    const max = CFG.maxCacheMB * 1024 * 1024;
    if (total <= max) return;
    files.sort((a, b) => a.t - b.t);
    for (const x of files) {
      if (total <= max * 0.8) break;
      fs.rmSync(path.join(dir, x.f), { force: true });
      total -= x.size;
    }
  } catch {}
}
setInterval(prune, 30 * 60 * 1000).unref();

/**
 * 取得一句话的音频（wav Buffer）。role 为 mentor / narrator / player，seat 决定玩家用哪个音色。
 * 出错时抛出异常，带 status（HTTP 状态码）。
 */
async function speech(userId, { text, role = 'narrator', seat = 0, speed = 1 }) {
  if (!enabled()) throw Object.assign(new Error('服务器没有配置语音合成'), { status: 503 });
  const t = clean(text);
  if (!t) throw Object.assign(new Error('没有要朗读的文字'), { status: 400 });
  const voices = CFG.roles.players.length ? CFG.roles.players : VOICES;
  const voice = role === 'mentor' ? CFG.roles.mentor : role === 'player' ? voices[Math.abs(Number(seat) || 0) % voices.length] : CFG.roles.narrator;
  const sp = Math.max(0.5, Math.min(2, Math.round((Number(speed) || 1) * 20) / 20));
  const key = crypto.createHash('sha1').update(`${CFG.model}|${voice}|${sp}|${t}`).digest('hex');
  const file = path.join(dir, key + '.wav');
  try {
    const buf = fs.readFileSync(file);
    stats.cached++;
    return buf;
  } catch {}
  if (inflight.has(key)) return inflight.get(key);
  // 只有真正去生成时才计入限额
  const now = Date.now();
  const list = (hits.get(userId) || []).filter((x) => now - x < 60000);
  if (list.length >= CFG.perUserPerMin) throw Object.assign(new Error('语音请求太频繁'), { status: 429 });
  list.push(now);
  hits.set(userId, list);
  const p = slot(() => synth(t, voice, sp))
    .then((buf) => {
      try {
        fs.writeFileSync(file, buf);
      } catch {}
      return buf;
    })
    .catch((e) => {
      stats.errors++;
      stats.lastError = e.name === 'TimeoutError' ? '请求超时' : e.message;
      stats.lastErrorAt = Date.now();
      throw Object.assign(new Error('语音合成失败：' + stats.lastError), { status: 502 });
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

const publicStats = () => ({ enabled: enabled(), model: CFG.model, roles: CFG.roles, ...stats });

module.exports = { init, enabled, speech, clean, publicStats, VOICES };
