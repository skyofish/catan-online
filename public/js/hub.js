// 平台大厅：登录、选择游戏、在线状态、接收游戏邀请。
import { getSession, setSession, takeHashSession, api, upgradeToHttps, safeNext, wsUrl } from './session.js';
import { initFullscreen } from './fullscreen.js';

initFullscreen();

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const params = new URLSearchParams(location.search);
// 旧版邀请链接
if (params.get('room')) location.replace('/catan/?room=' + encodeURIComponent(params.get('room')));
const next = safeNext(params.get('next'));

takeHashSession();
upgradeToHttps();

let user = null;
let ws = null;
let retry = 0;
let pollTimer = null;

// 本地备用的游戏目录（未登录时也能展示柜子里有什么）
const PREVIEW = [
  { id: 'catan', name: '卡坦岛', tagline: '在小岛上开拓、交易、建造，率先拿到胜利分', players: '2–8 人', minutes: '约 60 分钟' },
  { id: 'dorm', name: '猛鬼宿舍', tagline: '熄灯后猛鬼出没。躺平发育、造塔守门，活到天亮', players: '1–8 人', minutes: '约 10 分钟' },
];

// ---------------- 盒盖插画 ----------------
// 卡坦岛：用固定种子画一座 19 块的小岛
function catanArt() {
  const colors = ['#3f8a47', '#d98a58', '#a6d468', '#f0cf62', '#9aa3ae', '#3f8a47', '#a6d468', '#f0cf62', '#d98a58', '#e8d4a0', '#9aa3ae', '#3f8a47', '#f0cf62', '#a6d468', '#d98a58', '#3f8a47', '#f0cf62', '#9aa3ae', '#a6d468'];
  const rows = [3, 4, 5, 4, 3];
  const R = 15;
  const W = Math.sqrt(3) * R;
  let i = 0;
  let hexes = '';
  rows.forEach((n, r) => {
    for (let c = 0; c < n; c++) {
      const x = 160 + (c - (n - 1) / 2) * W;
      const y = 100 + (r - 2) * R * 1.5;
      const pts = [];
      for (let k = 0; k < 6; k++) {
        const a = (Math.PI / 180) * (60 * k - 90);
        pts.push(`${(x + (R - 0.6) * Math.cos(a)).toFixed(1)},${(y + (R - 0.6) * Math.sin(a)).toFixed(1)}`);
      }
      hexes += `<polygon points="${pts.join(' ')}" fill="${colors[i++]}" stroke="rgba(40,25,10,.55)" stroke-width="1.2"/>`;
    }
  });
  return `<svg viewBox="0 0 320 200" aria-hidden="true">
    <ellipse cx="160" cy="104" rx="104" ry="86" fill="#e7cf94" opacity=".9"/>
    ${hexes}
    <circle cx="160" cy="100" r="5.5" fill="#f6ecd2" stroke="#7a5531"/>
  </svg>`;
}
// 猛鬼宿舍：熄灯后的走廊，尽头一只发光的眼睛
function dormArt() {
  let doors = '';
  for (let i = 0; i < 4; i++) {
    const x = 34 + i * 70;
    doors += `<rect x="${x}" y="40" width="34" height="58" rx="2" fill="#1d1416" stroke="#3b2328" stroke-width="2"/>
      <rect x="${x + 4}" y="46" width="26" height="14" fill="${i === 2 ? '#d8c27a' : '#120c0d'}" opacity="${i === 2 ? 0.55 : 1}"/>
      <circle cx="${x + 28}" cy="72" r="2" fill="#6d5b4a"/>`;
  }
  return `<svg viewBox="0 0 320 200" aria-hidden="true">
    <defs>
      <radialGradient id="dorm-eye" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#ffd0d0"/><stop offset=".35" stop-color="#e0262c"/><stop offset="1" stop-color="#e0262c" stop-opacity="0"/></radialGradient>
      <linearGradient id="dorm-floor" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a1a1d"/><stop offset="1" stop-color="#0a0607"/></linearGradient>
    </defs>
    <rect x="0" y="100" width="320" height="100" fill="url(#dorm-floor)"/>
    ${doors}
    <path d="M0 100 H320" stroke="#4a2c31" stroke-width="2"/>
    <g opacity=".9"><path d="M210 190 C200 150 214 118 236 112 C258 118 272 150 262 190 C252 182 246 192 236 184 C226 192 220 182 210 190 Z" fill="#d9d4cf" opacity=".18"/>
      <circle cx="228" cy="134" r="9" fill="url(#dorm-eye)"/><circle cx="246" cy="134" r="9" fill="url(#dorm-eye)"/></g>
    <path d="M60 170 l6 -3 l-2 8 l9 -5 M150 186 l8 -2 l-3 6" stroke="#7a1218" stroke-width="2" fill="none" opacity=".7"/>
  </svg>`;
}
const ART = { catan: catanArt, dorm: dormArt };

function boxHTML(g, { preview = false } = {}) {
  const live = g.live || {};
  const status = [];
  if (live.open) status.push(`${live.open} 个房间等人加入`);
  if (live.playing) status.push(`${live.playing} 人正在玩`);
  const st = live.stats;
  const mine = st && st.games ? `你玩过 ${st.games} 局，赢了 ${st.wins} 局` : '你还没有玩过';
  const href = live.myRoom ? `${g.path}?room=${encodeURIComponent(live.myRoom)}` : g.path;
  return `<li class="box box-${esc(g.id)} ${preview ? '' : 'playable'}">
    <div class="box-art">${(ART[g.id] || (() => ''))()}<h3 class="box-title">${esc(g.name)}</h3>${live.myRoom ? '<span class="live-badge">你的对局进行中</span>' : ''}</div>
    <div class="box-body">
      <p class="tagline">${esc(g.tagline)}</p>
      <p class="meta">${esc(g.players)}，${esc(g.minutes)}${g.features ? '。' + g.features.map(esc).join('，') : ''}</p>
      <p class="status">${status.length ? status.join('，') : '现在没有人在玩，开一局吧'}</p>
      <p class="mine">${mine}</p>
      ${preview ? '' : `<a class="btn primary" href="${esc(href)}">${live.myRoom ? '回到对局' : '进入'}</a>`}
    </div>
  </li>`;
}

const EMPTY_BOX = `<li class="box empty"><div><b>下一款游戏</b>正在准备中</div></li>`;

// ---------------- 视图 ----------------
function show(view) {
  document.body.dataset.state = view;
  $('#view-login').hidden = view !== 'login';
  $('#view-hall').hidden = view !== 'hall';
}

function showLogin(notice) {
  user = null;
  clearInterval(pollTimer);
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  $('#shelf-preview').innerHTML = PREVIEW.map((g) => boxHTML(g, { preview: true })).join('') + EMPTY_BOX;
  try {
    notice = notice || sessionStorage.getItem('hub.notice');
    sessionStorage.removeItem('hub.notice');
  } catch {}
  const err = $('#login-error');
  err.textContent = notice || '';
  err.hidden = !notice;
  try {
    const last = localStorage.getItem('hub.lastUser');
    if (last && !$('#login-name').value) $('#login-name').value = last;
  } catch {}
  show('login');
  setTimeout(() => $('#login-name').focus(), 30);
}

function greeting(name) {
  const h = new Date().getHours();
  const when = h < 5 ? '夜深了' : h < 11 ? '早上好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好';
  const ask = h >= 18 || h < 5 ? '今晚玩点什么？' : '想玩点什么？';
  return `${when}，${esc(name)}。${ask}`;
}

async function loadHall() {
  try {
    const d = await api('/api/games');
    $('#online').innerHTML = `<span class="dot"></span>现在 ${d.online} 人在线`;
    $('#shelf').innerHTML = d.games.map((g) => boxHTML(g)).join('') + EMPTY_BOX;
  } catch (e) {
    if (e.status === 401) return showLogin('登录已过期，请重新进门');
  }
}

async function enterHall(u) {
  user = u;
  if (next) return location.replace(next);
  $('#greet').innerHTML = greeting(u.username);
  show('hall');
  await loadHall();
  clearInterval(pollTimer);
  pollTimer = setInterval(loadHall, 15000);
  connect();
}

// ---------------- 在线与邀请 ----------------
function connect() {
  if (!user) return;
  ws = new WebSocket(wsUrl('/hub/ws'));
  ws.onopen = () => {
    retry = 0;
    ws.send(JSON.stringify({ t: 'hello', d: { session: getSession() } }));
  };
  ws.onmessage = (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (m.t === 'hello') loadHall();
    else if (m.t === 'invite') showInvite(m.d);
    else if (m.t === 'kicked') {
      setSession(null);
      showLogin(m.d.reason);
    } else if (m.t === 'auth') {
      setSession(null);
      showLogin('登录已过期，请重新进门');
    }
  };
  ws.onclose = () => {
    ws = null;
    if (user) setTimeout(connect, Math.min(8000, 500 * 2 ** retry++));
  };
}

function send(t, d) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t, d }));
}

function chime() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    [784, 1175].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      const t = ctx.currentTime + i * 0.12;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.15, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 1);
    });
  } catch {}
}

function showInvite(d) {
  const root = $('#invite-root');
  for (const el of root.querySelectorAll('.invite-card')) if (el.dataset.code === d.code) el.remove();
  const card = document.createElement('div');
  card.className = 'invite-card';
  card.dataset.code = d.code;
  const gameName = d.gameName || '卡坦岛';
  const path = d.path || '/catan/';
  card.innerHTML = `<div><b>${esc(d.from)}</b> 邀请你玩${esc(gameName)}「${esc(d.title)}」<small>${esc(d.detail || `${d.size} 人地图`)}，已有 ${d.players} / ${d.max} 人</small></div>
    <div class="ic-btns"><button class="btn ghost ic-no">忽略</button><button class="btn primary ic-yes">加入</button></div><i class="ic-timer"></i>`;
  root.prepend(card);
  while (root.children.length > 3) root.lastChild.remove();
  const timer = setTimeout(() => decline(), 60000);
  function decline() {
    clearTimeout(timer);
    send('inviteReply', { game: d.game || 'catan', fromUser: d.fromUser, code: d.code, accept: false });
    card.remove();
  }
  card.querySelector('.ic-yes').onclick = () => {
    clearTimeout(timer);
    location.href = path + '?room=' + encodeURIComponent(d.code);
  };
  card.querySelector('.ic-no').onclick = decline;
  chime();
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification(`${d.from} 邀请你玩${gameName}`);
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  $('#toast-root').appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ---------------- 事件 ----------------
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#login-name').value.trim();
  const err = $('#login-error');
  if (!username) return;
  $('#btn-login').disabled = true;
  err.hidden = true;
  try {
    const r = await api('/api/login', { method: 'POST', body: { username } });
    setSession(r.token);
    try {
      localStorage.setItem('hub.lastUser', r.user.username);
    } catch {}
    await enterHall(r.user);
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    $('#btn-login').disabled = false;
  }
});

$('#btn-logout').addEventListener('click', async () => {
  try {
    await api('/api/logout', { method: 'POST' });
  } catch {}
  setSession(null);
  showLogin();
  toast('已退出登录');
});

// ---------------- 启动 ----------------
(async () => {
  if (!getSession()) return showLogin();
  try {
    const d = await api('/api/session');
    await enterHall(d.user);
  } catch (e) {
    if (e.status === 401) setSession(null);
    showLogin(e.status === 401 ? null : '暂时连不上服务器，请稍后刷新');
  }
})();
