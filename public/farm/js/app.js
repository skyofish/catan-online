// 青野牧歌：界面、网络、操作（摇杆 / 点地面 / 键盘）、HUD 与各种面板。
import { getSession, takeHashSession, api, upgradeToHttps, goToLogin, wsUrl } from '/js/session.js';
import { initFullscreen } from '/js/fullscreen.js';
import { sound } from './audio.js';

initFullscreen();

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmtTime = (m) => {
  const h = Math.floor(m / 60) % 24;
  const mm = m % 60;
  return `${h}:${String(mm).padStart(2, '0')}`;
};
const WX = { sun: '☀', rain: '🌧', snow: '❄' };
const WX_NAME = { sun: '晴', rain: '雨', snow: '雪' };

takeHashSession();
if (!getSession()) goToLogin();
upgradeToHttps();

const S = {
  ws: null,
  user: null,
  cfg: null,
  retry: 0,
  you: null,
  farm: null,
  world: null, // { W, H, ground, wet, objs, meta }
  me: null, // { inv, energy, maxEnergy, water }
  self: null, // 本地预测的位置 { x, y, dir, f, moving }
  players: [],
  sel: 0,
  chat: [],
  unread: 0,
  seq: 1,
  sheet: null,
  fishing: null,
  lastSend: 0,
  sentPos: null,
  timeAt: 0,
  timeVal: 360,
  energyShownAt: 0,
  sleeping: false,
  autoWalk: null,
  scene: null,
};
window.__S = S;
try {
  S.sel = Number(localStorage.getItem('farm.sel')) || 0;
} catch {}

const ITEM = (id) => (S.cfg && S.cfg.ITEMS[id]) || { name: id, icon: '❔' };
const icon = (id) => ITEM(id).icon || '❔';
// 种子：作物图标 + 一个小种子袋角标，一眼分得清是什么种子
function iconHTML(id) {
  const d = ITEM(id);
  if (d.kind === 'seed' && S.cfg) return `<span class="seed-ico">${esc(ITEM(d.crop).icon)}<i>🌱</i></span>`;
  return esc(icon(id));
}

// ======================= 提示 =======================
function toast(msg, err = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = msg;
  $('#toast-root').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}
function gtoast(msg, kind = '') {
  const root = $('#game-toasts');
  if (!root || document.body.dataset.screen !== 'game') return toast(msg, kind === 'warn');
  for (const old of root.children) if (old.textContent === msg) old.remove();
  const el = document.createElement('div');
  el.className = 'gtoast ' + kind;
  el.textContent = msg;
  root.appendChild(el);
  while (root.children.length > 3) root.firstChild.remove();
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 400);
  }, 2400);
}

function show(screen) {
  document.body.dataset.screen = screen;
  for (const id of ['home', 'game']) $('#screen-' + id).hidden = id !== screen;
  if (screen === 'game') sound.setMode('game');
  else sound.setMode('home');
}

// ======================= 网络 =======================
function connect() {
  const ws = (S.ws = new WebSocket(wsUrl('/farm/ws')));
  ws.onopen = () => {
    S.retry = 0;
    ws.send(JSON.stringify({ t: 'hello', d: { session: getSession() } }));
  };
  ws.onmessage = (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    onMsg(m);
  };
  ws.onclose = () => {
    S.ws = null;
    setTimeout(connect, Math.min(8000, 400 * 2 ** S.retry++));
  };
}
function send(t, d = {}) {
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify({ t, d }));
}
const pending = new Map();
function act(d, cb) {
  d.seq = S.seq++;
  if (cb) pending.set(d.seq, cb);
  send('act', d);
}

function wantedCode() {
  const q = new URLSearchParams(location.search);
  return q.get('farm') || q.get('room') || sessionStorage.getItem('farm.code');
}

const initQueue = [];
function onMsg(m) {
  const d = m.d;
  // 进入农场的过程中（加载 3D 场景）收到的同步先排队，进去之后按顺序补上
  if (S.initing && (m.t === 'tick' || m.t === 'me' || m.t === 'corr')) {
    initQueue.push(m);
    return;
  }
  switch (m.t) {
    case 'auth':
      goToLogin('登录已过期，请重新进门');
      break;
    case 'kicked':
      goToLogin(d.reason);
      break;
    case 'hello': {
      S.user = d.user;
      $('#me-name').textContent = d.user.username;
      const want = wantedCode();
      if (want) send('join', { code: want });
      else showHome();
      break;
    }
    case 'farms':
      renderFarms(d);
      break;
    case 'init':
      onInit(d);
      break;
    case 'tick':
      onTick(d);
      break;
    case 'me':
      onMe(d);
      break;
    case 'corr':
      if (S.self) Object.assign(S.self, { x: d.x, y: d.y });
      S.autoWalk = null;
      break;
    case 'ack': {
      const cb = pending.get(d.seq);
      pending.delete(d.seq);
      if (!d.ok && d.error && d.error !== '慢一点') {
        gtoast(d.error, 'warn');
        sound.play('error');
      }
      if (d.msg) gtoast(d.msg, 'good');
      if (cb) cb(d);
      break;
    }
    case 'chat':
      addChat(d);
      break;
    case 'emote':
      if (S.scene) S.scene.emote(d.pid, d.e);
      break;
    case 'farm':
      S.farm = d;
      renderDrawer();
      break;
    case 'toast':
      gtoast(d.msg);
      break;
    case 'error':
      gtoast(d.msg, 'warn');
      sound.play('error');
      if (/农场不存在|存档损坏/.test(d.msg)) {
        sessionStorage.removeItem('farm.code');
        history.replaceState(null, '', '/farm/');
        if (!S.world) showHome();
      }
      break;
    case 'left':
      leaveGame(d && d.deleted ? '这座农场已被农场主删除' : null);
      break;
    case 'online':
      renderOnline(d);
      break;
    case 'invite':
      showInvite(d);
      break;
  }
}

// ======================= 首页 =======================
let homeTab = 'farms';
function showHome() {
  show('home');
  S.world = null;
  send('list');
  if (homeTab === 'board') loadBoard();
}

function renderFarms(d) {
  const mine = d.mine || [];
  $('#farm-list').innerHTML = mine.length
    ? mine
        .map(
          (f) => `<li class="farm-item" data-code="${esc(f.code)}">
        <span class="fi-ico">${f.online ? '🏡' : '🌾'}</span>
        <div class="fi-main">
          <div class="fi-name">${esc(f.name)}</div>
          <div class="fi-meta">编号 ${esc(f.code)} · ${esc(f.owner || '')}${f.ownerId === S.user.id ? '（你）' : ''} · ${f.members} 位成员 · 已经营 ${f.days} 天 · 出货 ${f.earned} 金</div>
          ${f.online ? `<div class="fi-online">● ${f.online} 人在农场里</div>` : ''}
        </div>
        <button class="fi-x" data-forget="${esc(f.code)}" title="${f.ownerId === S.user.id ? '删除农场' : '从列表移除'}">✕</button>
      </li>`
        )
        .join('')
    : '<li class="muted">还没有农场。开垦一座，或者输入朋友的农场编号去帮忙吧。</li>';
  const open = d.open || [];
  $('#open-list').innerHTML = open.length
    ? open.map((f) => `<li class="farm-item" data-code="${esc(f.code)}"><span class="fi-ico">🏡</span><div class="fi-main"><div class="fi-name">${esc(f.name)}</div><div class="fi-meta">编号 ${esc(f.code)} · ${f.members} 位成员 · 已经营 ${f.days} 天</div><div class="fi-online">● ${f.online} 人在农场里</div></div></li>`).join('')
    : '<li class="muted">现在没有开放串门的农场。</li>';
}

async function loadBoard() {
  try {
    const r = await api('/api/farm/leaderboard');
    $('#leaderboard').innerHTML = r.rows.length
      ? `<table><tr><th>#</th><th>农场</th><th>农场主</th><th>天数</th><th>累计出货</th></tr>${r.rows.map((x, i) => `<tr><td>${i + 1}</td><td>${esc(x.name)}${x.code ? ` <small class="muted">${esc(x.code)}</small>` : ''}</td><td>${esc(x.owner || '—')}</td><td>${x.day_count}</td><td>${x.earned}</td></tr>`).join('')}</table>`
      : '<p class="muted">还没有农场上榜。</p>';
  } catch (e) {
    $('#leaderboard').innerHTML = `<p class="muted">${esc(e.message)}</p>`;
  }
}

$$('.tab').forEach((b) =>
  b.addEventListener('click', () => {
    homeTab = b.dataset.tab;
    $$('.tab').forEach((x) => x.classList.toggle('active', x === b));
    $$('.tab-pane').forEach((p) => (p.hidden = p.dataset.pane !== homeTab));
    if (homeTab === 'board') loadBoard();
    if (homeTab === 'open') send('list');
    sound.play('click');
  })
);
document.addEventListener('click', (e) => {
  const x = e.target.closest('[data-forget]');
  if (x) {
    e.stopPropagation();
    const mine = x.title === '删除农场';
    if (confirm(mine ? '删除这座农场？所有人的进度都会消失，不能恢复。' : '从你的列表里移除这座农场？之后输入编号还能回去。')) send('forget', { code: x.dataset.forget });
    return;
  }
  const f = e.target.closest('.farm-item[data-code]');
  if (f && document.body.dataset.screen === 'home') {
    sound.unlock();
    send('join', { code: f.dataset.code });
  }
});
$('#create-form').addEventListener('submit', (e) => {
  e.preventDefault();
  sound.unlock();
  send('create', { name: $('#create-name').value, public: $('#create-public').checked });
});
$('#join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  sound.unlock();
  const code = $('#join-code').value.trim().toUpperCase();
  if (code) send('join', { code });
});

// ======================= 进入农场 =======================
async function onInit(d) {
  S.initing = true;
  initQueue.length = 0;
  try {
    await enterFarm(d);
  } finally {
    S.initing = false;
  }
  for (const m of initQueue.splice(0)) onMsg(m);
}
async function enterFarm(d) {
  if (!S.cfg) S.cfg = await api('/api/farm/config');
  const C = S.cfg;
  S.farm = d.farm;
  S.you = d.you;
  const w = d.world;
  const dec = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  S.world = { W: w.W, H: w.H, ground: dec(w.ground), wet: dec(w.wet), objs: new Map(w.objs), meta: w.meta };
  S.me = d.me;
  S.self = { x: d.me.x, y: d.me.y, f: d.me.f, dir: [Math.PI, Math.PI / 2, 0, -Math.PI / 2][d.me.f || 2], moving: false };
  S.chat = d.chat || [];
  S.timeVal = w.meta.time;
  S.timeAt = performance.now() - (w.clock || 0) * C.TIME.realSecPer10Min * 1000;
  sessionStorage.setItem('farm.code', d.farm.code);
  history.replaceState(null, '', `/farm/?farm=${encodeURIComponent(d.farm.code)}`);
  show('game');
  if (!S.scene) {
    const { FarmScene } = await import('./scene.js');
    S.scene = new FarmScene($('#stage'), C);
  } else {
    // 换了一座农场：重新建场景
    const { FarmScene } = await import('./scene.js');
    S.scene.renderer.dispose();
    const old = $('#stage');
    const cv = old.cloneNode();
    old.replaceWith(cv);
    S.scene = new FarmScene(cv, C);
    bindCanvas();
  }
  S.scene.init(S.world);
  S.scene.setMeta(w.meta);
  applyPlayers(w.players);
  S.scene.syncAnimals(w.a, w.meta.animals);
  renderChat();
  applyMeta(w.meta);
  renderHotbar();
  renderMe();
  sound.unlock();
  if (!loopOn) {
    loopOn = true;
    requestAnimationFrame(loop);
  }
}

function leaveGame(msg) {
  sessionStorage.removeItem('farm.code');
  history.replaceState(null, '', '/farm/');
  closeSheet();
  $('#drawer').hidden = true;
  $('#dayend').hidden = true;
  stopFishing();
  S.world = null;
  if (msg) toast(msg, true);
  showHome();
}

function applyPlayers(list) {
  S.players = list.map(([id, x, y, f, held, anim, sleep, fish]) => ({ id, x, y, f, held, anim, sleep, fish }));
  const meIn = S.players.find((p) => p.id === S.you);
  const wasSleep = S.sleeping;
  S.sleeping = !!(meIn && meIn.sleep);
  if (S.sleeping !== wasSleep) renderSleep();
  const members = {};
  for (const m of (S.world.meta.members || [])) members[m.id] = m;
  S.scene.syncPlayers(S.players, S.you, members);
}

function onTick(d) {
  if (!S.world) return;
  const W = S.world;
  if (d.ch) {
    const tiles = new Set();
    let groundChanged = false;
    for (const [i, v] of d.ch.g) {
      W.ground[i] = v;
      tiles.add(i);
      groundChanged = true;
    }
    for (const [i, v] of d.ch.w) {
      W.wet[i] = v;
      tiles.add(i);
      groundChanged = true;
    }
    for (const [i, o] of d.ch.o) {
      if (o) W.objs.set(i, o);
      else W.objs.delete(i);
      tiles.add(i);
    }
    S.scene.tilesChanged([...tiles], groundChanged);
  }
  if (d.meta) applyMeta(d.meta);
  applyPlayers(d.p);
  S.scene.syncAnimals(d.a, W.meta.animals);
  if (d.ev) for (const e of d.ev) onEvent(e);
}

function onMe(d) {
  const before = S.me ? countInv(S.me.inv) : null;
  const prevEnergy = S.me ? S.me.energy : d.energy;
  S.me = d;
  if (S.self && Math.hypot(d.x - S.self.x, d.y - S.self.y) > 3) Object.assign(S.self, { x: d.x, y: d.y });
  if (before) {
    const after = countInv(d.inv);
    let k = 0;
    for (const [id, n] of after) {
      const diff = n - (before.get(id) || 0);
      if (diff > 0 && ITEM(id).kind !== 'tool') setTimeout(() => itemPop(iconHTML(id), `+${diff}`), k++ * 160);
    }
  }
  if (d.energy !== prevEnergy) S.energyShownAt = performance.now();
  renderHotbar();
  renderMe();
  if (S.sheet) refreshSheet();
}
const countInv = (inv) => {
  const m = new Map();
  for (const s of inv) if (s) m.set(s.id, (m.get(s.id) || 0) + s.n);
  return m;
};

// ======================= 农场信息（时间、钱、天气） =======================
function applyMeta(meta) {
  const prev = S.world.meta;
  S.world.meta = meta;
  if (meta.time !== S.timeVal) {
    S.timeVal = meta.time;
    S.timeAt = performance.now();
  }
  if (prev && prev.gold !== undefined && meta.gold > prev.gold) {
    const el = $('#hud-gold');
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  }
  const C = S.cfg;
  $('#hud-date').textContent = `第${meta.year}年 · ${C.SEASONS[meta.season].name} ${meta.day} 日`;
  $('#hud-time').textContent = fmtTime(meta.time);
  $('#hud-wx').textContent = WX[meta.weather] || '☀';
  $('#hud-wx').title = `今天${WX_NAME[meta.weather]}，明天${WX_NAME[meta.tomorrow]}`;
  $('#hud-gold b').textContent = meta.gold;
  // 表盘：太阳/月亮转一圈
  const k = (meta.time - 360) / 1200;
  $('#sun-moon').style.transform = `rotate(${-90 + k * 240}deg) translateX(-14px)`;
  const night = meta.time >= 1200;
  $('#sun-moon').style.background = night ? '#f4f0d8' : '#ffe7a0';
  S.scene.setMeta(meta);
  sound.setEnv({ weather: meta.weather, season: C.SEASONS[meta.season].id });
  if (S.sheet) refreshSheet();
  if (!$('#drawer').hidden) renderDrawer();
  if (S.sleeping) renderSleep();
}

// ======================= 事件 → 声音、动画、提示 =======================
function nearMe(e, r = 14) {
  if (!S.self || e.x === undefined) return true;
  return Math.hypot(e.x + 0.5 - S.self.x, e.y + 0.5 - S.self.y) < r;
}
function onEvent(e) {
  const mine = e.pid === S.you;
  S.scene.event(e);
  if (e.tool && !mine) S.scene.swing(e.pid);
  const snd = { till: 'till', water: 'water', refill: 'refill', chop: 'chop', fall: 'fall', cut: 'cut', plant: 'plant', harvest: 'harvest', pickup: 'pickup', place: 'place', ship: 'ship', buy: 'buy', craft: 'craft', eat: 'eat', build: 'build', cast: 'cast' };
  if (snd[e.type] && (mine || nearMe(e))) sound.play(snd[e.type]);
  if (e.type === 'mine' && (mine || nearMe(e))) sound.play(e.hp <= 0 ? 'break' : 'mine');
  if (e.type === 'chop' && e.hp === 0 && (mine || nearMe(e))) sound.play('break');
  switch (e.type) {
    case 'pet': {
      if (mine || nearMe(e)) sound.play('pet');
      const a = (S.world.meta.animals || []).find((x) => x.id === e.aid);
      if (a) sound.play({ chicken: 'cluck', cow: 'moo', sheep: 'baa' }[a.kind]);
      break;
    }
    case 'collect':
      if (mine) sound.play('harvest');
      break;
    case 'whiff':
      if (mine) sound.play('swing');
      break;
    case 'bite':
      if (mine) {
        sound.play('bite');
        if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
        S.biteAt = performance.now();
        updateCtx(true);
      }
      break;
    case 'nibble':
      if (mine) {
        S.biteAt = 0;
        gtoast('鱼跑掉了，再等等……');
        updateCtx(true);
      }
      break;
    case 'hooked':
      if (mine) startFishing(e.fish, e.diff);
      break;
    case 'fishEnd':
      if (mine) {
        stopFishing();
        S.biteAt = 0;
        if (e.why === 'catch') {
          sound.play('catch');
          gtoast(`钓到了${ITEM(e.fish).name}！`, 'good');
        } else if (e.why === 'escape') {
          sound.play('escape');
          gtoast('鱼挣脱了钩子……', 'warn');
        } else if (e.why === 'early') gtoast('拉得太早了');
        updateCtx(true);
      }
      break;
    case 'sleep':
      if (mine) sound.play('sleep');
      break;
    case 'day':
      onNewDay(e);
      break;
    case 'bundle':
      sound.play(e.awake ? 'awake' : 'bundle');
      break;
    case 'join':
      if (!mine) sound.play('chat');
      break;
  }
}

function onNewDay(e) {
  const r = e.report;
  const C = S.cfg;
  stopFishing();
  closeSheet();
  S.autoWalk = null;
  const me = S.me;
  if (me && S.self) Object.assign(S.self, { x: C.MAP.start.x, y: C.MAP.start.y });
  const el = $('#dayend');
  const items = r.sold.map((s) => `<li><span>${icon(s.id)}</span><span>${esc(ITEM(s.id).name)} × ${s.n}</span><span>${s.total} 金</span></li>`).join('');
  el.innerHTML = `<div class="card">
    <h2>第${r.year}年 ${C.SEASONS[r.season].name} ${r.day} 日</h2>
    <div class="wx">${r.newSeason ? `${C.SEASONS[r.season].name}天来了 · ` : ''}今天${WX_NAME[r.weather]} ${WX[r.weather]}</div>
    ${items ? `<ul>${items}</ul><div class="total">昨日出货 ${r.total} 金</div>` : '<p>昨天没有出货。</p>'}
    ${e.passedOut.length ? `<p>${esc(e.passedOut.join('、'))} 昨晚累倒在外面，被扶回了家。</p>` : ''}
    ${r.hungry.length ? `<p>${esc(r.hungry.join('、'))} 饿了一天……记得买干草。</p>` : ''}
    <button class="btn" id="dayend-ok">新的一天</button>
  </div>`;
  el.hidden = false;
  sound.play('morning');
  if (r.total) setTimeout(() => sound.play('coin'), 600);
  const close = () => (el.hidden = true);
  $('#dayend-ok').onclick = close;
  setTimeout(close, 7000);
}

// ======================= HUD =======================
function renderHotbar() {
  if (!S.me) return;
  const C = S.cfg;
  const hb = C.PLAYER.hotbar;
  S.sel = clamp(S.sel, 0, hb - 1);
  $('#hotbar').innerHTML = S.me.inv
    .slice(0, hb)
    .map((s, i) => {
      if (!s) return `<button class="slot empty ${i === S.sel ? 'sel' : ''}" data-hb="${i}"><span class="k">${i + 1}</span></button>`;
      const water = s.id === 'can' ? `<span class="wbar"><i style="width:${(S.me.water / C.PLAYER.canMax) * 100}%"></i></span>` : '';
      return `<button class="slot ${i === S.sel ? 'sel' : ''}" data-hb="${i}" title="${esc(ITEM(s.id).name)}"><span class="k">${i + 1}</span>${iconHTML(s.id)}${s.n > 1 ? `<span class="n">${s.n}</span>` : ''}${water}</button>`;
    })
    .join('');
  const held = S.me.inv[S.sel];
  $('#use-ico').innerHTML = held ? iconHTML(held.id) : '✋';
  $('#use-lbl').textContent = held ? useLabel(held.id) : '空手';
}
function useLabel(id) {
  const k = ITEM(id).kind;
  return { hoe: '翻地', can: '浇水', axe: '砍', pick: '敲', scythe: '割', rod: '抛竿' }[id] || (k === 'seed' ? '播种' : k === 'place' ? '放置' : k === 'food' ? '吃' : '使用');
}
$('#hotbar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-hb]');
  if (!b) return;
  selectSlot(Number(b.dataset.hb));
});
function selectSlot(i) {
  S.sel = i;
  try {
    localStorage.setItem('farm.sel', i);
  } catch {}
  sound.play('click');
  renderHotbar();
  updateCtx(true);
}

function renderMe() {
  if (!S.me) return;
  const k = S.me.energy / S.me.maxEnergy;
  $('#energy-fill').style.width = `${k * 100}%`;
  $('#energy-mini').classList.toggle('low', k < 0.25);
  $('#energy-mini').title = `体力 ${S.me.energy}/${S.me.maxEnergy}`;
}

// 角色旁边的体力圆环、水壶水位
function updateHudFollow() {
  if (!S.self || !S.me) return;
  const now = performance.now();
  const k = S.me.energy / S.me.maxEnergy;
  const p = S.scene.project(S.self.x, S.self.y, 1.2);
  const st = $('#stamina');
  const showSt = k < 1 && (now - S.energyShownAt < 3500 || k < 0.3);
  st.hidden = !showSt && !st.dataset.fading;
  if (showSt) {
    st.style.left = `${p.x + 42}px`;
    st.style.top = `${p.y - 10}px`;
    $('#stamina-arc').style.strokeDashoffset = `${94.25 * (1 - k)}`;
    st.classList.toggle('low', k < 0.25);
  }
  const held = S.me.inv[S.sel];
  const wg = $('#water-gauge');
  wg.hidden = !(held && held.id === 'can');
  if (!wg.hidden) {
    wg.style.left = `${p.x - 46}px`;
    wg.style.top = `${p.y - 6}px`;
    $('#water-fill').style.height = `${(S.me.water / S.cfg.PLAYER.canMax) * 100}%`;
  }
  const bite = $('#bite');
  const biting = S.biteAt && now - S.biteAt < 1500;
  bite.hidden = !biting;
  if (biting) {
    const q = S.scene.project(S.self.x, S.self.y, 2.6);
    bite.style.left = `${q.x}px`;
    bite.style.top = `${q.y}px`;
  }
}

function itemPop(ic, text, cls = '') {
  if (!S.self) return;
  const p = S.scene.project(S.self.x, S.self.y, 2.2);
  const el = document.createElement('div');
  el.className = 'pop ' + cls;
  el.style.left = `${p.x + (Math.random() - 0.5) * 30}px`;
  el.style.top = `${p.y}px`;
  el.innerHTML = `${ic}<small>${esc(text)}</small>`;
  $('#item-pops').appendChild(el);
  setTimeout(() => el.remove(), 1400);
}

// ======================= 地图判断（与服务器一致） =======================
const inRect = (x, y, r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
const BLOCK = new Set(['tree', 'stump', 'rock', 'ore', 'twig', 'weed', 'place', 'pillar']);
function walkable(x, y) {
  const W = S.world;
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (tx < 0 || ty < 0 || tx >= W.W || ty >= W.H) return false;
  const i = ty * W.W + tx;
  const g = W.ground[i];
  if (g === 3 || g === 4 || g === 7) return false;
  const M = S.cfg.MAP;
  const B = W.meta.buildings || {};
  for (const r of [M.house, M.bin, M.shop, M.shrine.altar]) if (inRect(tx, ty, r)) return false;
  if (inRect(tx, ty, M.coop)) return !(B.coop && B.coop.built);
  if (inRect(tx, ty, M.barn)) return !(B.barn && B.barn.built);
  const o = W.objs.get(i);
  return !(o && BLOCK.has(o.k) && !(o.k === 'tree' && o.s === 0));
}
function free(x, y) {
  const r = 0.24;
  return walkable(x, y) && walkable(x - r, y - r * 0.6) && walkable(x + r, y - r * 0.6) && walkable(x - r, y + r * 0.6) && walkable(x + r, y + r * 0.6);
}
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
function nearRect(r, d) {
  const s = S.self;
  const cx = clamp(s.x, r.x, r.x + r.w);
  const cy = clamp(s.y, r.y, r.y + r.h);
  return Math.hypot(s.x - cx, s.y - cy) <= d;
}

// 面前那一格（按工具挑最合适的格子）
function targetTile() {
  const s = S.self;
  const W = S.world;
  const fx = Math.sin(s.dir);
  const fy = Math.cos(s.dir);
  const held = S.me && S.me.inv[S.sel];
  if (held && held.id === 'rod') {
    for (let d = 1.2; d <= 4.6; d += 0.4) {
      const tx = Math.floor(s.x + fx * d);
      const ty = Math.floor(s.y + fy * d);
      if (tx >= 0 && ty >= 0 && tx < W.W && ty < W.H && W.ground[ty * W.W + tx] === 3) return { x: tx, y: ty, ok: true };
    }
    return { x: Math.floor(s.x + fx * 2.5), y: Math.floor(s.y + fy * 2.5), ok: false };
  }
  let tx = Math.floor(s.x + fx * 0.85);
  let ty = Math.floor(s.y + fy * 0.85);
  if (tx === Math.floor(s.x) && ty === Math.floor(s.y)) {
    tx = Math.floor(s.x + fx * 1.2);
    ty = Math.floor(s.y + fy * 1.2);
  }
  // 浇水：面前不是耕地时，在身边找一块干的耕地
  if (held && held.id === 'can' && W.ground[ty * W.W + tx] !== 2 && W.ground[ty * W.W + tx] !== 3) {
    let best = null;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = Math.floor(s.x) + dx;
      const y = Math.floor(s.y) + dy;
      const i = y * W.W + x;
      if (W.ground[i] === 2 && !W.wet[i]) {
        const d = dist(x + 0.5, y + 0.5, s.x + fx * 0.6, s.y + fy * 0.6);
        if (!best || d < best.d) best = { x, y, d };
      }
    }
    if (best) return { x: best.x, y: best.y, ok: true };
  }
  return { x: tx, y: ty, ok: dist(tx + 0.5, ty + 0.5, s.x, s.y) <= S.cfg.PLAYER.reach };
}

// ======================= 情境按钮 =======================
let ctxAction = null;
let ctxKey = '';
let ctxAt = 0;
function findInteractTile() {
  const s = S.self;
  const W = S.world;
  const t = targetTile();
  const good = (x, y) => {
    const o = W.objs.get(y * W.W + x);
    if (!o) return null;
    if (o.k === 'crop' && o.ready && !o.dead) return '收获';
    if (o.k === 'forage') return '采集';
    if (o.k === 'drop') return '捡起';
    return null;
  };
  if (good(t.x, t.y) && dist(t.x + 0.5, t.y + 0.5, s.x, s.y) <= S.cfg.PLAYER.reach) return { x: t.x, y: t.y, label: good(t.x, t.y) };
  let best = null;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const x = Math.floor(s.x) + dx;
    const y = Math.floor(s.y) + dy;
    const l = good(x, y);
    if (!l) continue;
    const d = dist(x + 0.5, y + 0.5, s.x, s.y);
    if (d <= S.cfg.PLAYER.reach && (!best || d < best.d)) best = { x, y, d, label: l };
  }
  return best;
}

function computeCtx() {
  const C = S.cfg;
  const M = C.MAP;
  const s = S.self;
  const meta = S.world.meta;
  const me = S.players.find((p) => p.id === S.you);
  if (me && me.fish) {
    if (S.biteAt && performance.now() - S.biteAt < 2100) return { ico: '❗', lbl: '提竿！', run: () => act({ type: 'hook' }) };
    return { ico: '🎣', lbl: '收竿', run: () => act({ type: 'reelIn' }) };
  }
  const t = findInteractTile();
  if (t) return { ico: '✋', lbl: t.label, run: () => doInteract(t.x, t.y) };
  for (const a of meta.animals || []) {
    const e = S.scene.animals.get(a.id);
    if (!e || e.inside) continue;
    if (dist(e.x, e.y, s.x, s.y) <= C.PLAYER.reach + 0.2 && (!a.petted || a.ready)) return { ico: a.ready ? '🧺' : '🤚', lbl: a.ready ? '收获' : `摸摸${a.name}`, run: () => act({ type: 'pet', id: a.id }) };
  }
  if (nearRect(M.bin, 2.2)) return { ico: '📦', lbl: '出货', run: () => openSheet('bin') };
  if (nearRect(M.shop, 3)) return { ico: '🛒', lbl: '商店', run: () => openSheet('shop') };
  if (dist(M.house.door.x + 0.5, M.house.door.y + 0.5, s.x, s.y) <= 2.4) return { ico: '🛏', lbl: '睡觉', run: () => openSheet('sleep') };
  if (dist(M.shrine.cx, M.shrine.cy, s.x, s.y) <= M.shrine.r + 1.4) return { ico: '🗿', lbl: '祭坛', run: () => openSheet('shrine') };
  for (const id of ['coop', 'barn']) {
    const b = meta.buildings && meta.buildings[id];
    const d = M[id].door;
    if (b && b.built && dist(d.x + 0.5, d.y + 0.5, s.x, s.y) <= 2.4) {
      const need = (meta.animals || []).some((a) => a.house === id && (a.ready || !a.petted));
      if (need) return { ico: '🧺', lbl: '照顾', run: () => act({ type: 'barn', id }) };
    }
  }
  return null;
}

function updateCtx(force) {
  const now = performance.now();
  if (!force && now - ctxAt < 180) return;
  ctxAt = now;
  if (!S.self || !S.world) return;
  ctxAction = computeCtx();
  const key = ctxAction ? ctxAction.ico + ctxAction.lbl : '';
  if (key === ctxKey) return;
  ctxKey = key;
  const b = $('#btn-ctx');
  b.hidden = !ctxAction;
  if (ctxAction) {
    $('#ctx-ico').textContent = ctxAction.ico;
    $('#ctx-lbl').textContent = ctxAction.lbl;
  }
}

// ======================= 操作 =======================
function faceTo(x, y) {
  const s = S.self;
  const dx = x - s.x;
  const dy = y - s.y;
  if (Math.abs(dx) + Math.abs(dy) < 0.01) return;
  s.dir = Math.atan2(dx, dy);
  s.f = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : dy > 0 ? 2 : 0;
  sendMove(true);
}

function swingLocal() {
  const e = S.scene.players.get(S.you);
  if (e) e.swingT = 0.0001;
}

function useHeld(tx, ty) {
  if (!S.me || S.sleeping) return;
  const held = S.me.inv[S.sel];
  const me = S.players.find((p) => p.id === S.you);
  if (me && me.fish) {
    if (S.biteAt && performance.now() - S.biteAt < 2100) return act({ type: 'hook' });
    return act({ type: 'reelIn' });
  }
  if (!held) {
    const t = tx === undefined ? findInteractTile() : { x: tx, y: ty };
    if (t) doInteract(t.x, t.y);
    return;
  }
  const k = ITEM(held.id).kind;
  if (k === 'food') return act({ type: 'eat', slot: S.sel });
  const t = tx === undefined ? targetTile() : { x: tx, y: ty };
  if (k === 'tool') {
    swingLocal();
    if (held.id !== 'rod') sound.play('swing');
  }
  faceTo(t.x + 0.5, t.y + 0.5);
  act({ type: 'use', slot: S.sel, x: t.x, y: t.y });
}

function doInteract(x, y) {
  faceTo(x + 0.5, y + 0.5);
  act({ type: 'interact', x, y });
}

// 点地面：够得着就直接用，够不着就走过去
function tapWorld(cx, cy) {
  if (!S.world || S.sleeping || S.fishing) return;
  sound.unlock();
  const p = S.scene.pick(cx, cy);
  if (!p) return;
  const s = S.self;
  const C = S.cfg;
  // 点到动物
  for (const a of S.world.meta.animals || []) {
    const e = S.scene.animals.get(a.id);
    if (e && !e.inside && dist(e.x, e.y, p.x, p.y) < 0.8) {
      if (dist(e.x, e.y, s.x, s.y) <= C.PLAYER.reach + 0.2) {
        faceTo(e.x, e.y);
        act({ type: 'pet', id: a.id });
      } else S.autoWalk = { x: e.x, y: e.y, then: () => act({ type: 'pet', id: a.id }), stop: C.PLAYER.reach - 0.3 };
      return;
    }
  }
  const tx = Math.floor(p.x);
  const ty = Math.floor(p.y);
  const W = S.world;
  if (tx < 0 || ty < 0 || tx >= W.W || ty >= W.H) return;
  // 点建筑：走过去打开
  const M = C.MAP;
  const bld = [[M.bin, () => openSheet('bin')], [M.shop, () => openSheet('shop')], [M.house, () => openSheet('sleep')], [M.shrine.altar, () => openSheet('shrine')]];
  for (const [r, fn] of bld) {
    if (inRect(tx, ty, r)) {
      const front = r === M.house ? { x: M.house.door.x + 0.5, y: M.house.door.y + 0.5 } : r === M.shop ? { x: M.shop.front.x + 0.5, y: M.shop.front.y + 0.6 } : { x: r.x + r.w / 2, y: r.y + r.h + 0.6 };
      if (dist(front.x, front.y, s.x, s.y) < 1.6) fn();
      else S.autoWalk = { x: front.x, y: front.y, then: fn, stop: 0.6 };
      return;
    }
  }
  const o = W.objs.get(ty * W.W + tx);
  const pickable = o && ((o.k === 'crop' && o.ready && !o.dead) || o.k === 'forage' || o.k === 'drop');
  const held = S.me && S.me.inv[S.sel];
  const isRod = held && held.id === 'rod';
  const reach = isRod ? 4.6 : C.PLAYER.reach;
  const run = () => {
    if (pickable && (!held || ITEM(held.id).kind !== 'tool' || held.id !== 'scythe')) doInteract(tx, ty);
    else useHeld(tx, ty);
  };
  if (dist(tx + 0.5, ty + 0.5, s.x, s.y) <= reach) run();
  else if (walkable(tx + 0.5, ty + 0.5) || pickable || o) S.autoWalk = { x: tx + 0.5, y: ty + 0.5, then: run, stop: Math.min(reach, 1.3) - 0.2 };
  else S.autoWalk = { x: tx + 0.5, y: ty + 0.5, then: isRod ? run : null, stop: isRod ? 3.5 : 0.8 };
}

// ======================= 输入：摇杆、键盘、按钮 =======================
const joy = { id: null, ox: 0, oy: 0, x: 0, y: 0, t0: 0, moved: false };
const keys = new Set();
const zone = $('#joy-zone');
zone.addEventListener('pointerdown', (e) => {
  sound.unlock();
  joy.id = e.pointerId;
  joy.ox = e.clientX;
  joy.oy = e.clientY;
  joy.x = joy.y = 0;
  joy.t0 = performance.now();
  joy.moved = false;
  zone.setPointerCapture(e.pointerId);
  const j = $('#joy');
  j.hidden = false;
  j.style.left = `${e.clientX}px`;
  j.style.top = `${e.clientY}px`;
  $('#joy-knob').style.transform = '';
  S.autoWalk = null;
});
zone.addEventListener('pointermove', (e) => {
  if (e.pointerId !== joy.id) return;
  const dx = e.clientX - joy.ox;
  const dy = e.clientY - joy.oy;
  const d = Math.hypot(dx, dy);
  if (d > 8) joy.moved = true;
  const R = 50;
  const k = d > R ? R / d : 1;
  joy.x = (dx * k) / R;
  joy.y = (dy * k) / R;
  $('#joy-knob').style.transform = `translate(${dx * k}px, ${dy * k}px)`;
});
const joyEnd = (e) => {
  if (e.pointerId !== joy.id) return;
  joy.id = null;
  joy.x = joy.y = 0;
  $('#joy').hidden = true;
  if (!joy.moved && performance.now() - joy.t0 < 300) tapWorld(e.clientX, e.clientY);
};
zone.addEventListener('pointerup', joyEnd);
zone.addEventListener('pointercancel', joyEnd);

let pointers = new Map();
let pinchD = 0;
function bindCanvas() {
  const cv = $('#stage');
  pointers = new Map();
  cv.addEventListener('pointerdown', (e) => {
    sound.unlock();
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now(), sx: e.clientX, sy: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchD = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });
  cv.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchD) S.scene.zoom(pinchD / d);
      pinchD = d;
    }
  });
  const up = (e) => {
    const p = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    if (!p) return;
    if (pointers.size === 0 && Math.hypot(p.x - p.sx, p.y - p.sy) < 10 && performance.now() - p.t < 400 && !pinchD) tapWorld(e.clientX, e.clientY);
    if (pointers.size < 2) setTimeout(() => (pinchD = 0), 50);
  };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', (e) => pointers.delete(e.pointerId));
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    S.scene.zoom(e.deltaY > 0 ? 1.08 : 1 / 1.08);
  }, { passive: false });
  // 鼠标悬停：显示要操作的格子（电脑上）
  cv.addEventListener('mousemove', (e) => {
    if (!S.world) return;
    const p = S.scene.pick(e.clientX, e.clientY);
    S.hover = p ? { x: Math.floor(p.x), y: Math.floor(p.y), t: performance.now() } : null;
  });
}
bindCanvas();

const typing = () => {
  const a = document.activeElement;
  return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA');
};
window.addEventListener('keydown', (e) => {
  if (typing()) {
    if (e.key === 'Escape') document.activeElement.blur();
    return;
  }
  if (document.body.dataset.screen !== 'game') return;
  sound.unlock();
  const k = e.key.toLowerCase();
  if (S.fishing) {
    if (k === ' ') {
      S.fishing.hold = true;
      e.preventDefault();
    }
    return;
  }
  if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
    keys.add(k);
    S.autoWalk = null;
    e.preventDefault();
  } else if (k === ' ' || k === 'j') {
    e.preventDefault();
    if (!e.repeat) useHeld();
  } else if (k === 'e' || k === 'k' || k === 'f') {
    if (ctxAction) ctxAction.run();
  } else if (/^[1-8]$/.test(k)) selectSlot(Number(k) - 1);
  else if (k === 'b' || k === 'i' || k === 'tab') {
    e.preventDefault();
    S.sheet === 'bag' ? closeSheet() : openSheet('bag');
  } else if (k === 'escape') {
    closeSheet();
    $('#drawer').hidden = true;
  } else if (k === 'enter') {
    openDrawer();
    setTimeout(() => $('#chat-form input').focus(), 50);
  } else if (k === 'q') {
    selectSlot((S.sel + 7) % 8);
  }
});
window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  keys.delete(k);
  if (S.fishing && k === ' ') S.fishing.hold = false;
});
window.addEventListener('blur', () => keys.clear());

function holdBtn(el, fn) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    sound.unlock();
    el.classList.add('down');
    fn();
  });
  const up = () => el.classList.remove('down');
  el.addEventListener('pointerup', up);
  el.addEventListener('pointerleave', up);
}
holdBtn($('#btn-use'), () => useHeld());
holdBtn($('#btn-ctx'), () => ctxAction && ctxAction.run());
$('#btn-bag').addEventListener('click', () => (S.sheet === 'bag' ? closeSheet() : openSheet('bag')));

// ======================= 主循环 =======================
let loopOn = false;
let lastT = performance.now();
let stepAcc = 0;
function loop(t) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (t - lastT) / 1000);
  lastT = t;
  if (!S.world || !S.scene || document.body.dataset.screen !== 'game') return;
  move(dt);
  // 时间：两次服务器报时之间平滑推进，太阳慢慢移动
  const per = S.cfg.TIME.realSecPer10Min * 1000;
  const smooth = S.debugTime ?? S.timeVal + Math.min(10, ((t - S.timeAt) / per) * 10);
  const held = S.me && S.me.inv[S.sel];
  // S.debugCam / S.debugTime：只用于截图检查画面
  const at = S.debugCam ? { x: S.debugCam.x, y: S.debugCam.y } : {};
  S.scene.update(dt, { time: smooth, self: { ...S.self, ...at, held: held ? held.id : null } });
  sound.setEnv({ night: S.scene.night });
  // 目标格子
  if (!S.sleeping && S.me && !S.fishing) {
    const hv = S.hover && t - S.hover.t < 1500 && dist(S.hover.x + 0.5, S.hover.y + 0.5, S.self.x, S.self.y) <= S.cfg.PLAYER.reach ? S.hover : null;
    const tg = hv ? { ...hv, ok: true } : targetTile();
    S.scene.setTarget(tg.x, tg.y, tg.ok);
  } else S.scene.setTarget(null);
  updateCtx();
  updateHudFollow();
  if (S.fishing) tickFishing(dt);
  // 脚步声
  if (S.self.moving) {
    stepAcc += dt;
    if (stepAcc > 0.32) {
      stepAcc = 0;
      sound.play('step');
    }
  }
}

function move(dt) {
  const s = S.self;
  if (S.sleeping || S.fishing || S.sheet === 'sleep') {
    s.moving = false;
    return;
  }
  let vx = joy.x;
  let vy = joy.y;
  if (keys.has('a') || keys.has('arrowleft')) vx -= 1;
  if (keys.has('d') || keys.has('arrowright')) vx += 1;
  if (keys.has('w') || keys.has('arrowup')) vy -= 1;
  if (keys.has('s') || keys.has('arrowdown')) vy += 1;
  // 自动走到点过的地方
  if (S.autoWalk && !vx && !vy) {
    const a = S.autoWalk;
    const d = dist(a.x, a.y, s.x, s.y);
    if (d <= (a.stop ?? 0.3)) {
      S.autoWalk = null;
      faceTo(a.x, a.y);
      if (a.then) a.then();
    } else {
      vx = (a.x - s.x) / d;
      vy = (a.y - s.y) / d;
      a.time = (a.time || 0) + dt;
      if (a.time > 12) S.autoWalk = null;
    }
  }
  const len = Math.hypot(vx, vy);
  if (len < 0.12) {
    s.moving = false;
    sendMove(false);
    return;
  }
  if (len > 1) {
    vx /= len;
    vy /= len;
  }
  const sp = S.cfg.PLAYER.speed * dt;
  const nx = s.x + vx * sp;
  const ny = s.y + vy * sp;
  let moved = false;
  if (free(nx, ny)) {
    s.x = nx;
    s.y = ny;
    moved = true;
  } else if (free(nx, s.y)) {
    s.x = nx;
    moved = true;
  } else if (free(s.x, ny)) {
    s.y = ny;
    moved = true;
  } else if (S.autoWalk) {
    // 被挡住了：试着绕一下
    const side = Math.sign(Math.sin(performance.now() / 600)) || 1;
    const px = s.x - vy * sp * side;
    const py = s.y + vx * sp * side;
    if (free(px, py)) {
      s.x = px;
      s.y = py;
      moved = true;
    }
  }
  s.moving = moved;
  s.dir = Math.atan2(vx, vy);
  s.f = Math.abs(vx) > Math.abs(vy) ? (vx > 0 ? 1 : 3) : vy > 0 ? 2 : 0;
  sendMove(false);
}

function sendMove(force) {
  const now = performance.now();
  const s = S.self;
  const p = S.sentPos;
  const changed = !p || Math.abs(p.x - s.x) > 0.01 || Math.abs(p.y - s.y) > 0.01 || p.f !== s.f || p.a !== (s.moving ? 1 : 0);
  const held = S.me && S.me.inv[S.sel];
  const h = held ? held.id : null;
  if (!force && !changed && now - S.lastSend < 1000 && p && p.h === h) return;
  if (!force && now - S.lastSend < 90) return;
  S.lastSend = now;
  S.sentPos = { x: s.x, y: s.y, f: s.f, a: s.moving ? 1 : 0, h };
  send('mv', { x: Math.round(s.x * 100) / 100, y: Math.round(s.y * 100) / 100, f: s.f, h, a: s.moving ? 1 : 0 });
}

// ======================= 钓鱼小游戏 =======================
// 按住屏幕让绿条上升、松开下落；鱼在里面时进度上涨，满了就钓到
function startFishing(fish, diff) {
  S.biteAt = 0;
  const zoneH = clamp(0.36 - diff * 0.035, 0.18, 0.34);
  S.fishing = { fish, diff, zone: 0.2, zv: 0, fishY: 0.5, fishV: 0, target: 0.5, progress: 0.3, hold: false, t: 0 };
  const el = $('#fishing');
  el.hidden = false;
  $('#fish-zone').style.height = `${zoneH * 100}%`;
  S.fishing.zoneH = zoneH;
  $('#fish-icon').textContent = diff >= 5 ? '✨' : '🐟';
  updateCtx(true);
}
function stopFishing() {
  S.fishing = null;
  $('#fishing').hidden = true;
}
function tickFishing(dt) {
  const f = S.fishing;
  f.t += dt;
  // 鱼的移动：越难越快、越爱乱跳
  if (Math.random() < dt * (0.6 + f.diff * 0.45)) f.target = clamp(f.fishY + (Math.random() - 0.5) * (0.4 + f.diff * 0.12), 0.05, 0.95);
  f.fishV += (f.target - f.fishY) * dt * (4 + f.diff * 2.5);
  f.fishV *= Math.pow(0.04, dt);
  f.fishY = clamp(f.fishY + f.fishV * dt * 2, 0.03, 0.97);
  // 绿条
  f.zv += (f.hold ? 2.6 : -2.2) * dt;
  f.zone += f.zv * dt;
  if (f.zone < 0) {
    f.zone = 0;
    f.zv = Math.abs(f.zv) * 0.3;
  }
  if (f.zone > 1 - f.zoneH) {
    f.zone = 1 - f.zoneH;
    f.zv = 0;
  }
  const inZone = f.fishY >= f.zone && f.fishY <= f.zone + f.zoneH;
  f.progress += (inZone ? 0.32 - f.diff * 0.02 : -(0.16 + f.diff * 0.035)) * dt;
  $('#fish-zone').style.bottom = `${f.zone * 100}%`;
  $('#fish-zone').classList.toggle('on', inZone);
  $('#fish-icon').style.top = `${(1 - f.fishY) * 100}%`;
  $('#fish-progress').style.height = `${clamp(f.progress, 0, 1) * 100}%`;
  if (inZone && Math.random() < dt * 8) sound.play('reel');
  if (f.progress >= 1 && f.t > 0.9) {
    act({ type: 'reel', ok: true });
    stopFishing();
  } else if (f.progress <= 0) {
    act({ type: 'reel', ok: false });
    stopFishing();
  }
}
const fishHold = (on) => (e) => {
  if (!S.fishing) return;
  if (e.target.closest && e.target.closest('.hud-top, .drawer, .sheet')) return;
  S.fishing.hold = on;
};
window.addEventListener('pointerdown', fishHold(true), true);
window.addEventListener('pointerup', fishHold(false), true);
window.addEventListener('pointercancel', fishHold(false), true);

// ======================= 面板 =======================
let bagPick = null;
let bagTab = 'inv';
let shopQty = {};
function openSheet(kind) {
  S.sheet = kind;
  bagPick = null;
  $('#sheet').hidden = false;
  $('#sheet-shade').hidden = false;
  sound.play('open');
  refreshSheet();
}
function closeSheet() {
  S.sheet = null;
  $('#sheet').hidden = true;
  $('#sheet-shade').hidden = true;
}
$('#sheet-shade').addEventListener('click', closeSheet);

function slotHTML(s, i, extra = '') {
  if (!s) return `<button class="slot empty ${extra}" data-slot="${i}"></button>`;
  return `<button class="slot ${extra}" data-slot="${i}" title="${esc(ITEM(s.id).name)}">${iconHTML(s.id)}${s.n > 1 ? `<span class="n">${s.n}</span>` : ''}</button>`;
}
const head = (title, sub = '') => `<h2>${title}<button class="icon-btn x" data-close aria-label="关闭">✕</button></h2>${sub ? `<p class="sub">${sub}</p>` : ''}`;

function refreshSheet() {
  if (!S.sheet || !S.me) return;
  const el = $('#sheet');
  const C = S.cfg;
  const meta = S.world.meta;
  const inv = S.me.inv;
  let html = '';
  if (S.sheet === 'bag') {
    html = head('背包', `体力 ${S.me.energy}/${S.me.maxEnergy} · 水壶 ${S.me.water}/${C.PLAYER.canMax}`);
    html += `<div class="stabs">${[['inv', '物品'], ['craft', '制作'], ['animals', '动物']].map(([k, n]) => `<button data-btab="${k}" class="${bagTab === k ? 'on' : ''}">${n}</button>`).join('')}</div>`;
    if (bagTab === 'inv') {
      html += `<div class="grid">${inv.map((s, i) => slotHTML(s, i, (i < C.PLAYER.hotbar ? '' : '') + (bagPick === i ? ' pick' : '') + (i === S.sel ? ' sel' : ''))).join('')}</div>`;
      html += `<p class="sub" style="margin-top:6px">前 ${C.PLAYER.hotbar} 格是快捷栏。点一件物品再点另一格可以交换位置。</p>`;
      const s = bagPick !== null ? inv[bagPick] : null;
      if (s) {
        const d = ITEM(s.id);
        const btns = [];
        if (bagPick >= C.PLAYER.hotbar) btns.push(`<button class="btn small" data-tohot>放到手边</button>`);
        else btns.push(`<button class="btn small" data-hold>拿在手上</button>`);
        if (d.energy) btns.push(`<button class="btn small cyan" data-eat>吃掉（+${d.energy} 体力）</button>`);
        if (d.kind !== 'tool') btns.push(`<button class="btn small danger" data-trash>扔掉</button>`);
        html += `<div class="inv-detail"><span class="big">${iconHTML(s.id)}</span><div><div class="nm">${esc(d.name)} × ${s.n}</div><div class="ds">${esc(itemDesc(s.id))}</div></div><div class="btns">${btns.join('')}</div></div>`;
      } else html += `<div class="inv-detail muted">点一件物品看看</div>`;
    } else if (bagTab === 'craft') {
      html += `<div class="rows">${Object.entries(C.RECIPES)
        .map(([id, r]) => {
          const have = Object.entries(r.in).every(([k, n]) => invCount(k) >= n);
          const need = Object.entries(r.in).map(([k, n]) => `${icon(k)}${ITEM(k).name} ${invCount(k)}/${n}`).join('　');
          return `<div class="row ${have ? '' : 'locked'}"><span class="ri">${icon(id)}</span><div class="rm"><div class="rn">${esc(ITEM(id).name)}${r.out > 1 ? ` ×${r.out}` : ''}</div><div class="rd">${esc(ITEM(id).desc || '')}<br>${need}</div></div><button class="btn small ${have ? 'primary' : ''}" data-craft="${id}" ${have ? '' : 'disabled'}>制作</button></div>`;
        })
        .join('')}</div>`;
    } else {
      const an = meta.animals || [];
      html += `<p class="sub">草料仓里有 ${meta.hay} 份干草。晴天动物自己去牧场吃草；下雨、下雪和冬天每只每天吃 1 份干草。</p>`;
      html += an.length
        ? `<div class="rows">${an.map((a) => `<div class="row"><span class="ri">${{ chicken: '🐔', cow: '🐄', sheep: '🐑' }[a.kind]}</span><div class="rm"><div class="rn">${esc(a.name)}</div><div class="rd">${'❤'.repeat(Math.round(a.fr / 200))}${'♡'.repeat(5 - Math.round(a.fr / 200))} · ${a.petted ? '今天摸过了' : '今天还没摸'}${a.ready ? ` · ${icon(C.ANIMALS[a.kind].product)}可以收了` : ''}</div></div></div>`).join('')}</div>`
        : '<p class="muted">还没有动物。在行商那里先盖鸡舍或畜棚，再买小动物。</p>';
    }
  } else if (S.sheet === 'shop') {
    const open = meta.time >= C.SHOP_HOURS[0] && meta.time < C.SHOP_HOURS[1];
    html = head('行商阿青的摊位', open ? `农场的钱：<b style="color:var(--gold)">${meta.gold}</b> 金 · 营业到 ${fmtTime(C.SHOP_HOURS[1])}` : `阿青收摊了，明早 ${fmtTime(C.SHOP_HOURS[0])} 再来`);
    html += `<div class="rows">${meta.shop
      .map((it) => {
        const q = shopQty[it.id] || 1;
        const d = ITEM(it.id);
        const crop = d.crop && C.CROPS[d.crop];
        const desc = crop ? `${crop.days} 天成熟${crop.regrow ? `，之后每 ${crop.regrow} 天收一次` : ''} · 卖 ${crop.price} 金${crop.yield ? ` ×${crop.yield}` : ''}` : it.id === 'hay' ? '存进草料仓，给动物过冬' : d.energy ? `回复 ${d.energy} 体力` : '';
        return `<div class="row shoprow"><span class="ri">${iconHTML(it.id)}</span><div class="rm"><div class="rn">${esc(d.name)}</div><div class="rd">${esc(desc)}</div></div><span class="rp">${it.price * q} 金</span><span class="qty"><button data-q="${it.id}" data-d="-1">−</button><b>${q}</b><button data-q="${it.id}" data-d="1">+</button></span><button class="btn small primary" data-buy="${it.id}" ${open ? '' : 'disabled'}>买</button></div>`;
      })
      .join('')}</div>`;
    html += `<h2 style="margin-top:14px;font-size:16px">建筑</h2><div class="rows">${Object.entries(C.BUILDINGS)
      .map(([id, b]) => {
        const st = meta.buildings[id];
        const status = st.built ? '已经盖好' : st.pending ? '施工中，明早完工' : `${b.cost.gold} 金 + ${b.cost.wood} 木材 + ${b.cost.stone} 石头（材料从你背包里出）`;
        return `<div class="row ${st.built || st.pending ? 'done' : ''}"><span class="ri">${id === 'coop' ? '🛖' : '🏚'}</span><div class="rm"><div class="rn">${b.name}</div><div class="rd">${esc(b.desc)} · ${status}</div></div>${st.built || st.pending ? '' : `<button class="btn small" data-buy="${id}" ${open ? '' : 'disabled'}>盖</button>`}</div>`;
      })
      .join('')}</div>`;
    html += `<h2 style="margin-top:14px;font-size:16px">动物</h2><div class="rows">${Object.entries(C.ANIMALS)
      .map(([id, a]) => {
        const built = meta.buildings[a.house].built;
        const n = (meta.animals || []).filter((x) => x.house === a.house).length;
        return `<div class="row ${built ? '' : 'locked'}"><span class="ri">${{ chicken: '🐔', cow: '🐄', sheep: '🐑' }[id]}</span><div class="rm"><div class="rn">${a.name}</div><div class="rd">${built ? `${C.BUILDINGS[a.house].name} ${n}/${C.BUILDINGS[a.house].cap}` : `需要${C.BUILDINGS[a.house].name}`} · 产${ITEM(a.product).name}${a.every > 1 ? `（每 ${a.every} 天）` : '（每天）'}</div></div><span class="rp">${a.buy} 金</span><button class="btn small" data-buy="${id}" ${built && open ? '' : 'disabled'}>买</button></div>`;
      })
      .join('')}</div>`;
  } else if (S.sheet === 'bin') {
    const binTotal = meta.bin.reduce((s, e) => s + (ITEM(e.id).price || 0) * e.n, 0);
    html = head('出货箱', `放进箱子的东西明早结算。今天已放入，约 <b style="color:var(--gold)">${binTotal}</b> 金`);
    html += `<div class="grid">${inv.map((s, i) => slotHTML(s && ITEM(s.id).price && ITEM(s.id).kind !== 'tool' ? s : null, i, bagPick === i ? 'pick' : '')).join('')}</div>`;
    const s = bagPick !== null ? inv[bagPick] : null;
    if (s && ITEM(s.id).price) {
      const p = ITEM(s.id).price;
      html += `<div class="inv-detail"><span class="big">${icon(s.id)}</span><div><div class="nm">${esc(ITEM(s.id).name)} × ${s.n}</div><div class="ds">每个 ${p} 金</div></div><div class="btns"><button class="btn small" data-ship="1">放 1 个</button><button class="btn small primary" data-ship="all">全部（${p * s.n} 金）</button></div></div>`;
    } else html += '<div class="inv-detail muted">点一件要卖的东西</div>';
    if (meta.bin.length) html += `<h2 style="margin-top:12px;font-size:15px">箱子里</h2><div class="rows">${meta.bin.map((e, i) => `<div class="row"><span class="ri">${icon(e.id)}</span><div class="rm"><div class="rn">${esc(ITEM(e.id).name)} × ${e.n}</div><div class="rd">${esc(e.by)} 放的</div></div><span class="rp">${(ITEM(e.id).price || 0) * e.n} 金</span><button class="btn small" data-unship="${i}">取回</button></div>`).join('')}</div>`;
  } else if (S.sheet === 'shrine') {
    const done = Object.values(meta.bundleDone).filter(Boolean).length;
    html = head('古代祭坛', meta.awake ? '祭坛已经完全苏醒。所有人的体力上限都提高了。' : `交齐一组供品，就能唤醒一根石柱（${done}/${C.BUNDLES.length}）。`);
    html += C.BUNDLES.map((b) => {
      const got = meta.bundles[b.id] || {};
      const isDone = meta.bundleDone[b.id];
      const canGive = !isDone && Object.entries(b.need).some(([id, n]) => (got[id] || 0) < n && invCount(id) > 0);
      const need = Object.entries(b.need).map(([id, n]) => `<span class="${(got[id] || 0) >= n ? 'ok' : ''}">${icon(id)} ${esc(ITEM(id).name)} ${Math.min(n, got[id] || 0)}/${n}${(got[id] || 0) < n && invCount(id) ? `（带着 ${invCount(id)}）` : ''}</span>`).join('');
      const rw = Object.entries(b.reward).map(([id, n]) => (id === 'gold' ? `${n} 金` : `${ITEM(id).name} ×${n}`)).join('、');
      return `<div class="bundle ${isDone ? 'done' : ''}"><h3><span>${isDone ? '✦' : '◇'} ${esc(b.name)}</span>${isDone ? '<small style="color:var(--cyan)">已唤醒</small>' : `<button class="btn small cyan" data-donate="${b.id}" ${canGive ? '' : 'disabled'}>献上</button>`}</h3><div class="need">${need}</div><div class="rw">奖励：${esc(rw)}</div></div>`;
    }).join('');
  } else if (S.sheet === 'sleep') {
    const awake = (meta.members || []).filter((m) => m.online && !m.sleep && m.id !== S.you);
    html = head('回家睡觉？', awake.length ? `还有 ${awake.map((m) => esc(m.name)).join('、')} 醒着。所有在线的人都睡下，天才会亮。` : '睡下之后就进入新的一天。');
    html += `<div style="display:flex;gap:10px;justify-content:flex-end"><button class="btn" data-close>再等等</button><button class="btn primary" data-sleep>睡觉</button></div>`;
  }
  el.innerHTML = html;
}

function itemDesc(id) {
  const d = ITEM(id);
  const C = S.cfg;
  if (d.kind === 'tool') return { hoe: '把草地翻成耕地', can: '给耕地浇水；对着池塘打水', axe: '砍树、砍树桩和树枝', pick: '敲石头、矿石，也能收回放下的东西', scythe: '割草（会存成干草）、清理枯死的作物', rod: '对着水抛竿钓鱼' }[id] || '';
  if (d.kind === 'seed') {
    const c = C.CROPS[d.crop];
    return `${c.season.map((s) => C.SEASONS.find((x) => x.id === s).name).join('、')}季播种 · ${c.days} 天成熟`;
  }
  return [d.desc, d.price ? `卖 ${d.price} 金` : '', d.energy ? `吃了回复 ${d.energy} 体力` : ''].filter(Boolean).join(' · ');
}
const invCount = (id) => (S.me ? S.me.inv.reduce((s, x) => s + (x && x.id === id ? x.n : 0), 0) : 0);

$('#sheet').addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  const C = S.cfg;
  if (t.dataset.close !== undefined) return closeSheet();
  if (t.dataset.btab) {
    bagTab = t.dataset.btab;
    bagPick = null;
    return refreshSheet();
  }
  if (t.dataset.slot !== undefined) {
    const i = Number(t.dataset.slot);
    sound.play('click');
    if (S.sheet === 'bag' && bagPick !== null && bagPick !== i) {
      act({ type: 'swap', a: bagPick, b: i });
      bagPick = null;
    } else bagPick = bagPick === i ? null : S.me.inv[i] ? i : null;
    return refreshSheet();
  }
  if (t.dataset.hold !== undefined) {
    selectSlot(bagPick);
    return closeSheet();
  }
  if (t.dataset.tohot !== undefined) {
    act({ type: 'swap', a: bagPick, b: S.sel });
    bagPick = S.sel;
    return;
  }
  if (t.dataset.eat !== undefined) return act({ type: 'eat', slot: bagPick });
  if (t.dataset.trash !== undefined) {
    if (confirm(`扔掉 ${ITEM(S.me.inv[bagPick].id).name}？`)) act({ type: 'trash', slot: bagPick }, () => (bagPick = null));
    return;
  }
  if (t.dataset.craft) return act({ type: 'craft', id: t.dataset.craft });
  if (t.dataset.q) {
    shopQty[t.dataset.q] = clamp((shopQty[t.dataset.q] || 1) + Number(t.dataset.d) * (e.shiftKey ? 10 : 1), 1, 99);
    return refreshSheet();
  }
  if (t.dataset.buy) {
    const id = t.dataset.buy;
    if (C.BUILDINGS[id] && !confirm(`花 ${C.BUILDINGS[id].cost.gold} 金盖${C.BUILDINGS[id].name}？`)) return;
    return act({ type: 'buy', id, n: shopQty[id] || 1 });
  }
  if (t.dataset.ship) {
    const s = S.me.inv[bagPick];
    if (!s) return;
    return act({ type: 'ship', slot: bagPick, n: t.dataset.ship === 'all' ? s.n : 1 }, (r) => {
      if (r.ok && t.dataset.ship === 'all') bagPick = null;
    });
  }
  if (t.dataset.unship !== undefined) return act({ type: 'unship', i: Number(t.dataset.unship) });
  if (t.dataset.donate) return act({ type: 'donate', bundle: t.dataset.donate });
  if (t.dataset.sleep !== undefined) {
    closeSheet();
    return act({ type: 'sleep' });
  }
});

// 睡着时的画面
function renderSleep() {
  const el = $('#dayend');
  if (!S.sleeping) {
    if (el.dataset.sleep) {
      el.hidden = true;
      delete el.dataset.sleep;
    }
    return;
  }
  const meta = S.world.meta;
  const online = (meta.members || []).filter((m) => m.online);
  const asleep = online.filter((m) => m.sleep).length;
  el.dataset.sleep = '1';
  el.hidden = false;
  el.style.background = 'radial-gradient(ellipse at 50% 40%, rgba(40,50,90,.92), rgba(14,18,40,.97))';
  el.style.color = '#e8ecf8';
  el.innerHTML = `<div class="card"><h2>Zzz…</h2><p>等其他人也睡下（${asleep}/${online.length}）</p><p class="muted">${online.filter((m) => !m.sleep).map((m) => esc(m.name)).join('、')}</p><button class="btn" id="btn-wake" style="color:#e8ecf8;border-color:#8890b0;background:rgba(255,255,255,.08)">起床</button></div>`;
  $('#btn-wake').onclick = () => act({ type: 'wake' });
}
new MutationObserver(() => {
  const el = $('#dayend');
  if (el.hidden || !el.dataset.sleep) {
    el.style.background = '';
    el.style.color = '';
  }
}).observe($('#dayend'), { attributes: true, attributeFilter: ['hidden'] });

// ======================= 抽屉：农场信息、设置、聊天 =======================
function openDrawer() {
  $('#drawer').hidden = false;
  S.unread = 0;
  $('#chat-badge').hidden = true;
  renderDrawer();
  renderChat();
  send('online');
}
$('#btn-menu').addEventListener('click', openDrawer);
$('#btn-chat').addEventListener('click', () => {
  openDrawer();
  setTimeout(() => $('#chat-form input').focus(), 50);
});
$('[data-close-drawer]').addEventListener('click', () => ($('#drawer').hidden = true));
let onlineList = [];
function renderOnline(list) {
  onlineList = list;
  renderDrawer();
}
function renderDrawer() {
  if (!S.world || $('#drawer').hidden) return;
  const meta = S.world.meta;
  const owner = S.farm && S.farm.owner === S.user.id;
  $('#drawer-title').textContent = meta.name;
  const st = meta.stats || {};
  const v = sound.vol;
  const idle = onlineList.filter((u) => u.status !== 'playing').slice(0, 8);
  $('#drawer-body').innerHTML = `
    <div class="farm-code"><span>农场编号</span><b>${esc(S.farm.code)}</b><button class="btn small" id="btn-copy">复制邀请链接</button></div>
    <ul class="plist">${(meta.members || []).map((m) => `<li class="${m.online ? '' : 'off'}"><i class="dot" style="background:${esc(m.color)}"></i>${esc(m.name)}${m.id === S.you ? '（你）' : ''}<span class="muted" style="margin-left:auto">${m.online ? (m.sleep ? '睡着了' : '在农场') : '不在'}</span></li>`).join('')}</ul>
    ${idle.length ? `<p class="sub" style="margin:6px 0 4px">邀请在线的朋友：</p><div class="menu-btns">${idle.map((u) => `<button class="btn small" data-invite="${u.id}" ${u.invited ? 'disabled' : ''}>${esc(u.username)}${u.invited ? ' ✓' : ''}</button>`).join('')}</div>` : ''}
    <p class="sub">已经营 ${st.days || 0} 天 · 累计出货 ${st.earned || 0} 金 · 收获 ${st.harvested || 0} · 钓鱼 ${st.fish || 0}</p>
    ${owner ? `<div class="menu-btns"><button class="btn small" id="btn-rename">改名</button><button class="btn small" id="btn-public">${S.farm.public ? '关闭串门' : '允许串门'}</button></div>` : ''}
    <div class="vol"><span>音乐</span><input type="range" min="0" max="1" step="0.05" value="${v.music}" data-vol="music"><span>音效</span><input type="range" min="0" max="1" step="0.05" value="${v.sfx}" data-vol="sfx"></div>
    <div class="menu-btns"><button class="btn small" id="btn-quality">画质：${S.scene.quality === 'high' ? '高' : '低'}</button><button class="btn small" id="btn-help">操作说明</button><button class="btn small danger" id="btn-leave">离开农场</button></div>`;
}
$('#drawer').addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.id === 'btn-copy') {
    const url = `${location.origin}/farm/?farm=${S.farm.code}`;
    (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject())
      .then(() => gtoast('邀请链接已复制', 'good'))
      .catch(() => prompt('复制这个链接发给朋友：', url));
  } else if (t.dataset.invite) {
    send('invite', { userId: Number(t.dataset.invite) });
    t.disabled = true;
  } else if (t.id === 'btn-rename') {
    const n = prompt('农场的新名字', S.world.meta.name);
    if (n) send('settings', { name: n });
  } else if (t.id === 'btn-public') send('settings', { public: !S.farm.public });
  else if (t.id === 'btn-quality') {
    S.scene.setQuality(S.scene.quality === 'high' ? 'low' : 'high');
    renderDrawer();
  } else if (t.id === 'btn-help') {
    $('#drawer').hidden = true;
    showHelp();
  } else if (t.id === 'btn-leave') send('leave');
});
$('#drawer').addEventListener('input', (e) => {
  if (e.target.dataset.vol) sound.setVol(e.target.dataset.vol, Number(e.target.value));
});
function showHelp() {
  S.sheet = 'help';
  $('#sheet').hidden = false;
  $('#sheet-shade').hidden = false;
  $('#sheet').innerHTML = head('操作说明') + `<div class="help">${$('[data-pane=help]').innerHTML}</div><p class="sub">电脑：WASD 移动，空格用工具，E 交互，1–8 切换快捷栏，B 背包，回车聊天，滚轮缩放。</p>`;
}

function addChat(m) {
  S.chat.push(m);
  if (S.chat.length > 100) S.chat.shift();
  renderChat();
  if ($('#drawer').hidden && !m.sys) {
    S.unread++;
    $('#chat-badge').hidden = false;
    $('#chat-badge').textContent = S.unread;
    sound.play('chat');
  }
  if (!m.sys && m.pid && S.scene && m.text.length <= 14) S.scene.emote(m.pid, m.text);
}
function renderChat() {
  const box = $('#game-chat');
  if (!box) return;
  box.innerHTML = S.chat.map((m) => (m.sys ? `<p class="sys">${esc(m.text)}</p>` : `<p><span class="nm" style="color:${esc(m.color)}">${esc(m.name)}</span>${esc(m.text)}</p>`)).join('');
  box.scrollTop = box.scrollHeight;
}
$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const inp = $('#chat-form input');
  const text = inp.value.trim();
  if (text) send('chat', { text });
  inp.value = '';
});
$('#emotes').innerHTML = ['👋', '❤', '😆', '👍', '❗', '❓', '🎵', '😴'].map((e) => `<button data-emote="${e}">${e}</button>`).join('');
$('#emotes').addEventListener('click', (e) => {
  const b = e.target.closest('[data-emote]');
  if (b) send('emote', { e: b.dataset.emote });
});

// ======================= 邀请（来自本游戏或其他游戏） =======================
function showInvite(d) {
  sound.play('invite');
  const el = document.createElement('div');
  el.className = 'invite';
  el.innerHTML = `<p><b>${esc(d.from)}</b> 邀请你去 ${esc(d.gameName || '')}「${esc(d.title)}」${d.detail ? `（${esc(d.detail)}）` : ''}</p><div class="btns"><button class="btn small" data-no>稍后</button><button class="btn small primary" data-yes>去看看</button></div>`;
  $('#invite-root').appendChild(el);
  const done = () => el.remove();
  el.querySelector('[data-no]').onclick = () => {
    send('inviteReply', { game: d.game, fromUser: d.fromUser, code: d.code, accept: false });
    done();
  };
  el.querySelector('[data-yes]').onclick = () => {
    done();
    if (d.game === 'farm') send('join', { code: d.code });
    else location.href = `${d.path}?room=${encodeURIComponent(d.code)}`;
  };
  setTimeout(done, 60000);
}

// 切到后台再回来：确保声音恢复
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) sound.unlock();
});

// ======================= 启动 =======================
(async () => {
  try {
    S.cfg = await api('/api/farm/config');
  } catch (e) {
    if (e.status === 401) return goToLogin();
  }
  connect();
})();
