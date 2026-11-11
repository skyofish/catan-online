// 雾夜追猎：界面、网络、操作（摇杆 / 键盘 / 镜头）、本地走位预测、HUD 与事件编排。
import { getSession, takeHashSession, api, upgradeToHttps, goToLogin, wsUrl } from '/js/session.js';
import { initFullscreen } from '/js/fullscreen.js';
import { sound } from './audio.js';
import { Scene } from './scene.js';

initFullscreen();

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtT = (s) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s)) % 60).padStart(2, '0')}`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const COLORS = ['#e0b458', '#6fb3d9', '#e07a5f', '#8fc49a', '#b48ad6', '#e8e4d8', '#d96a8a', '#5fc4c0'];
const BOT_TAG = { easy: '菜鸟电脑', normal: '老手电脑', hard: '大神电脑', ai: '智谱 AI' };
const USE_LABEL = { decode: '修机', heal: '治疗', rescue: '救人', drop: '放板', vault: '翻越', gate: '开门', hatch: '跳地窖', pickup: '扛起', cage: '关笼', break: '砸板' };
const ACT_LABEL = { decode: '修发报机', heal: '治疗队友', rescue: '开笼救人', gate: '拉电闸', selfheal: '自我包扎', break: '砸木板', pickup: '扛起', cage: '关进铁笼' };
const ST_NAME = { ok: '在场', down: '倒地', carried: '被扛着', caged: '在笼中', escaped: '逃脱', dead: '淘汰' };
const BLOCKED = new Set(['vault', 'pickup', 'cage', 'break', 'wind', 'dash', 'cast']);
const CHANNEL = new Set(['decode', 'heal', 'gate', 'selfheal', 'rescue']);

takeHashSession();
if (!getSession()) goToLogin();
upgradeToHttps();

const S = {
  ws: null,
  user: null,
  cfg: null,
  room: null,
  you: null,
  st: null, // 最新的对局状态
  setup: null,
  gameId: null,
  chat: [],
  unread: 0,
  retry: 0,
  me: { x: 0, z: 0, d: 0 }, // 本地预测的位置
  input: { x: 0, y: 0 }, // 摇杆 / 键盘（屏幕方向）
  keys: new Set(),
  lastMove: { x: 0, z: 0, t: 0 },
  solid: null,
  dyn: null,
  qte: null,
  spec: null,
  endShown: null,
};
window.__S = S;
let scene = null;

// ======================= 网络 =======================
function connect() {
  const ws = (S.ws = new WebSocket(wsUrl('/hunt/ws')));
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
const act = (type, d = {}) => send('act', { type, ...d });

function onMsg(m) {
  const d = m.d;
  switch (m.t) {
    case 'auth':
      goToLogin('登录已过期，请重新登录');
      break;
    case 'kicked':
      goToLogin(d.reason);
      break;
    case 'hello': {
      S.user = d.user;
      $('#me-name').textContent = d.user.username;
      const want = new URLSearchParams(location.search).get('room') || sessionStorage.getItem('hunt.room');
      if (want) send('join', { code: want });
      else showHome();
      break;
    }
    case 'room':
      onRoom(d);
      break;
    case 'state':
      onState(d);
      break;
    case 'rooms':
      renderRoomList(d);
      break;
    case 'chat':
      addChat(d);
      break;
    case 'chatHistory':
      S.chat = d;
      renderChat();
      break;
    case 'toast':
      toast(d.msg);
      break;
    case 'error':
      toast(d.msg, true);
      sound.play('error');
      if (/房间不存在/.test(d.msg)) {
        sessionStorage.removeItem('hunt.room');
        history.replaceState(null, '', '/hunt/');
        if (!S.room) showHome();
      }
      break;
    case 'left':
      S.room = null;
      S.you = null;
      sessionStorage.removeItem('hunt.room');
      history.replaceState(null, '', '/hunt/');
      if (d && d.kicked) toast('你被请出了房间', true);
      showHome();
      break;
    case 'online':
      renderOnline(d);
      break;
    case 'invite':
      showInvite(d);
      break;
  }
}

// ======================= 页面切换 =======================
function screen(name) {
  document.body.dataset.screen = name;
  for (const s of ['home', 'lobby', 'game']) $('#screen-' + s).hidden = s !== name;
}
let listTimer = null;
function showHome() {
  screen('home');
  sound.setMood('lobby');
  send('list');
  clearInterval(listTimer);
  listTimer = setInterval(() => document.body.dataset.screen === 'home' && send('list'), 5000);
}
function onRoom(d) {
  const prevGame = S.room && S.room.gameId;
  S.room = d.room;
  S.you = d.you;
  sessionStorage.setItem('hunt.room', d.room.code);
  if (new URLSearchParams(location.search).get('room') !== d.room.code) history.replaceState(null, '', `/hunt/?room=${d.room.code}`);
  if (d.room.gameId !== prevGame) {
    S.st = null;
    S.setup = null;
    S.endShown = null;
    S.spec = null;
    $('#end').hidden = true;
  }
  if (d.room.started) showGame();
  else showLobby();
}

// ======================= 首页 =======================
const mapName = (k) => (S.cfg && S.cfg.MAP_INFO[k] ? S.cfg.MAP_INFO[k].name : '随机地图');
function renderRoomList(list) {
  const el = $('#room-list');
  el.innerHTML = list.length
    ? list
        .map(
          (r) => `<li data-code="${esc(r.code)}"><span class="rt">${esc(r.title)}</span>
        <span class="tag">${esc(mapName(r.map))}</span><span class="tag">${r.humans} 人 + ${r.players - r.humans} 电脑</span>
        <span class="tag ${r.started && !r.ended ? 'live' : ''}">${r.ended ? '已结束' : r.started ? '对局中' : '等人'}</span></li>`
        )
        .join('')
    : '<li class="empty">现在没有房间，开一局吧</li>';
  $$('li[data-code]', el).forEach((li) => li.addEventListener('click', () => send('join', { code: li.dataset.code })));
}
async function loadMe() {
  const el = $('#me-stats');
  try {
    const d = await api('/api/hunt/me');
    const st = d.stats || {};
    el.innerHTML = `<div class="big"><div><b>${st.games || 0}</b>局数</div><div><b>${st.wins || 0}</b>胜场</div><div><b>${st.avg_vp ? Math.round(st.avg_vp) : '-'}</b>平均演绎分</div></div>
      ${d.recent.length ? `<table><tr><th>时间</th><th>地图</th><th>结果</th><th>演绎分</th><th>时长</th></tr>${d.recent.map((r) => `<tr><td>${new Date(r.ended_at).toLocaleDateString()}</td><td>${esc(mapName(S.cfg.MAP_KEYS[r.target_vp]))}</td><td class="${r.is_winner ? 'win' : 'lose'}">${r.is_winner ? '胜' : '未胜'}</td><td>${r.vp}</td><td>${fmtT(r.turns)}</td></tr>`).join('')}</table>` : '<p class="muted">还没有打过。</p>'}`;
  } catch (e) {
    el.textContent = e.message;
  }
}
async function loadBoard() {
  const el = $('#leaderboard');
  try {
    const d = await api('/api/hunt/leaderboard');
    el.innerHTML = d.rows.length
      ? `<table><tr><th>#</th><th>玩家</th><th>胜场</th><th>局数</th><th>平均演绎分</th></tr>${d.rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.username)}</td><td>${r.wins}</td><td>${r.games}</td><td>${Math.round(r.avg_vp)}</td></tr>`).join('')}</table>`
      : '<p class="muted">还没有人上榜。</p>';
  } catch (e) {
    el.textContent = e.message;
  }
}
function charCard(key, role, cls = '', attrs = '') {
  const c = (role === 'hunter' ? S.cfg.HUNTERS : S.cfg.SURVIVORS)[key];
  return `<button class="char ${cls}" style="--c:${c.color}" ${attrs}><span class="tg">${esc(c.tag)}</span><b>${esc(c.name)}</b>
    <p>${esc(c.desc)}</p><p><i>天赋</i> ${esc(c.passive)}</p><p><i>${esc(c.skill.name)}</i>（冷却 ${c.skill.cd} 秒）${esc(c.skill.desc)}</p></button>`;
}
function codexHTML() {
  if (!S.cfg) return '';
  return `<div class="codex"><h4>求生者</h4>${Object.keys(S.cfg.SURVIVORS).map((k) => charCard(k, 'survivor', '', 'disabled')).join('')}
    <h4>追猎者</h4>${Object.keys(S.cfg.HUNTERS).map((k) => charCard(k, 'hunter', '', 'disabled')).join('')}</div>`;
}

// ======================= 房间大厅 =======================
function showLobby() {
  screen('lobby');
  document.body.classList.remove('hunter');
  sound.setMood('lobby');
  const r = S.room;
  const isHost = S.you && S.you === r.host;
  const me = r.players.find((p) => p.id === S.you);
  $('#lobby-title').textContent = r.title;
  $('#lobby-code').textContent = r.code;
  const mp = $('#lobby-map');
  mp.classList.toggle('can', !!isHost);
  mp.innerHTML =
    ['random', ...S.cfg.MAP_KEYS].map((k) => `<button data-map="${k}" class="${k === r.map ? 'on' : ''}">${esc(mapName(k))}</button>`).join('') +
    `<p class="muted map-desc">${esc(r.map === 'random' ? '开局时从三张地图里随机抽一张。' : S.cfg.MAP_INFO[r.map].desc)}</p>`;
  $$('[data-map]', mp).forEach((b) => b.addEventListener('click', () => isHost && send('settings', { map: b.dataset.map })));

  const slotHTML = (p) => {
    const def = (p.role === 'hunter' ? S.cfg.HUNTERS : S.cfg.SURVIVORS)[p.char];
    const tag = p.isBot ? BOT_TAG[p.bot] : p.autoBot ? '电脑代管' : p.connected ? '' : '离线';
    return `<li class="slot ${p.id === S.you ? 'me' : ''} ${p.connected ? '' : 'off'}"><span class="dot" style="color:${p.color}"></span>
      <span class="nm">${esc(p.name)}<small>${esc(def.name)}${tag ? ' · ' + tag : ''}</small></span>
      ${p.id === r.host ? '<span class="host">房主</span>' : ''}
      ${isHost && p.id !== S.you ? `<button class="x" data-kick="${p.id}" aria-label="移出">✕</button>` : ''}</li>`;
  };
  const emptyHTML = (role) => `<li class="slot empty"><span>${role === 'hunter' ? '空位（开局由电脑补上）' : '空位'}</span>${me && me.role !== role ? `<button class="btn dark small" data-role="${role}">换到这边</button>` : ''}</li>`;
  const hunters = r.players.filter((p) => p.role === 'hunter');
  const survs = r.players.filter((p) => p.role === 'survivor');
  $('#slots-hunter').innerHTML = hunters.length ? hunters.map(slotHTML).join('') : emptyHTML('hunter');
  $('#slots-survivor').innerHTML = survs.map(slotHTML).join('') + Array.from({ length: 4 - survs.length }, () => emptyHTML('survivor')).join('');
  $('#lobby-count').textContent = `${survs.length}/4`;
  $$('[data-kick]').forEach((b) => b.addEventListener('click', () => send('kick', { pid: b.dataset.kick })));
  $$('[data-role]').forEach((b) => b.addEventListener('click', () => send('role', { role: b.dataset.role })));

  // 选角色
  const cp = $('#char-pick');
  if (me) {
    const pool = me.role === 'hunter' ? S.cfg.HUNTERS : S.cfg.SURVIVORS;
    const taken = new Set(r.players.filter((p) => p !== me && p.role === 'survivor' && !p.isBot).map((p) => p.char));
    cp.innerHTML = Object.keys(pool)
      .map((k) => charCard(k, me.role, `${k === me.char ? 'on' : ''} ${me.role === 'survivor' && taken.has(k) ? 'taken' : ''}`, `data-char="${k}"`))
      .join('');
    $$('[data-char]', cp).forEach((b) =>
      b.addEventListener('click', () => {
        sound.play('click');
        send('char', { char: b.dataset.char });
      })
    );
  } else cp.innerHTML = '<p class="muted">你正在观战。</p>';
  $('#bot-row').hidden = !isHost;
  $('#bot-ai').hidden = !r.aiAvailable;
  $('#btn-start').hidden = !isHost;
  $('#lobby-hint').textContent = !S.you ? '' : isHost ? '可以一个人带电脑玩，也可以邀请朋友。空着的位置开局时自动补"老手"电脑。' : '等房主开始……';
}

// ======================= 对局 =======================
function showGame() {
  screen('game');
  sound.setMood('game');
  if (!scene) {
    scene = new Scene($('#stage'));
    try {
      if (localStorage.getItem('hunt.quality') === 'low') scene.setQuality('low');
    } catch {}
    window.__scene = scene;
    requestAnimationFrame(loop);
  }
  if (S.st && S.st.phase === 'ended') showEnd();
}
const mePl = () => (S.st && S.you ? S.st.players.find((p) => p.id === S.you) : null);
const info = (id) => (S.setup ? S.setup.players.find((p) => p.id === id) : null);
const myInfo = () => info(S.you);
const defOf = (i) => (i.role === 'hunter' ? S.cfg.HUNTERS : S.cfg.SURVIVORS)[i.char];

function onState(d) {
  if (d.setup) {
    S.setup = d.setup;
    S.gameId = d.gameId;
    const W = d.setup.map.W;
    S.W = W;
    S.solid = new Uint8Array(W * W);
    d.setup.map.rows.forEach((row, z) => {
      for (let x = 0; x < W; x++) if (row[x] !== '0') S.solid[z * W + x] = 1;
    });
    for (const o of d.setup.machines.concat(d.setup.cages)) S.solid[Math.floor(o.z) * W + Math.floor(o.x)] = 1;
    S.dyn = new Uint8Array(W * W);
    const mi = myInfo();
    document.body.classList.toggle('hunter', !!mi && mi.role === 'hunter');
    scene.build(d.setup, S.cfg, S.you);
    const me = d.players.find((p) => p.id === S.you) || d.players.find((p) => p.x !== null);
    S.me = { x: me.x, z: me.z, d: me.d };
    scene.yaw = me.d + Math.PI;
    scene.camDist = mi && mi.role === 'hunter' ? 8 : 6.8;
    $('#btn-attack').hidden = !(mi && mi.role === 'hunter');
    $('#pad').hidden = !mi;
    $('#stick').hidden = !mi;
    if (mi) {
      $('#skill-name').textContent = defOf(mi).skill.name;
    }
    $('#feed').innerHTML = '';
  }
  if (!S.setup || d.gameId !== S.gameId) return;
  const prev = S.st;
  S.st = d;
  // 动态障碍：倒下的木板、没开的大门（追猎者永远进不去）
  S.dyn.fill(0);
  const map = S.setup.map;
  const hunter = myInfo() && myInfo().role === 'hunter';
  map.pallets.forEach((p, i) => {
    if (d.pallets[i] === '1') S.dyn[p.z * S.W + p.x] = 1;
  });
  map.gates.forEach((g, i) => {
    if (hunter || !d.gates[i][1]) for (const c of g.cells) S.dyn[c.z * S.W + c.x] = 1;
  });
  scene.sync(d, myInfo() ? myInfo().role : 'spectator');
  for (const e of d.events || []) onEvent(e);
  renderHud(prev);
  if (d.phase === 'ended' && S.endShown !== S.gameId) {
    S.endShown = S.gameId;
    setTimeout(showEnd, 1800);
  }
}

// ---------------- 事件：动画、音效、横幅 ----------------
function banner(text, sub = '', cls = '') {
  const el = $('#banner');
  el.className = 'banner ' + cls;
  el.innerHTML = `${esc(text)}${sub ? `<small>${esc(sub)}</small>` : ''}`;
  el.hidden = false;
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  clearTimeout(banner.t);
  banner.t = setTimeout(() => (el.hidden = true), 2700);
}
function feed(text) {
  const el = document.createElement('div');
  el.textContent = text;
  $('#feed').prepend(el);
  while ($('#feed').children.length > 4) $('#feed').lastChild.remove();
  setTimeout(() => el.remove(), 5000);
}
function flash(cls = '') {
  const el = $('#flash');
  el.className = 'flash ' + cls;
  void el.offsetWidth;
  el.classList.add('go');
}
function onEvent(e) {
  const nm = (id) => (info(id) || {}).name || '?';
  const pos = (id) => {
    const c = scene.chars.get(id);
    return c && c.has ? c : null;
  };
  const near = (o, r = 26) => o && Math.hypot(o.x - scene.focus.x, o.z - scene.focus.z) < r;
  const iAm = (id) => id === S.you;
  const hunterSide = myInfo() && myInfo().role === 'hunter';
  switch (e.type) {
    case 'start':
      showIntro();
      sound.play('start');
      break;
    case 'go':
      sound.play('go');
      banner(hunterSide ? '开始追猎' : '快去修发报机', hunterSide ? '找到他们' : '头顶有光柱的就是');
      break;
    case 'swing':
      if (near(pos(e.pid))) sound.play('swing');
      break;
    case 'miss':
      if (near(pos(e.pid))) sound.play('miss');
      break;
    case 'hit': {
      const c = pos(e.pid);
      if (c) scene.burst(c.x, 1, c.z, 26, 0xd02a20, { additive: false, speed: 3, up: 2.5 });
      if (c) scene.burst(c.x, 1, c.z, 10, 0xffe0a0, { speed: 4, up: 2, life: 0.3 });
      if (near(c)) sound.play('hit');
      if (e.down) sound.play('down');
      if (iAm(e.pid)) {
        flash('red');
        scene.shake = 1;
        navigator.vibrate && navigator.vibrate(e.down ? [80, 40, 160] : 100);
        banner(e.down ? '你倒下了' : e.shock ? '恐惧震慑！' : '你受伤了', e.down ? '等队友来扶你' : '快跑', 'bad');
      } else if (iAm(e.by)) {
        scene.shake = 0.5;
        if (e.shock) banner('恐惧震慑！', '', 'good');
      }
      feed(`${nm(e.pid)} ${e.down ? '被打倒了' : '受伤了'}${e.shock ? '（恐惧震慑）' : ''}`);
      break;
    }
    case 'qteOk':
      if (iAm(e.pid)) sound.play('qteOk');
      break;
    case 'spark':
      scene.burst(e.x, 1, e.z, 40, 0xffd060, { speed: 5, up: 4 });
      if (near(e) || hunterSide) sound.play('spark');
      if (iAm(e.pid)) {
        scene.shake = 0.6;
        banner('校准失败', '位置暴露了', 'bad');
      } else if (hunterSide) feed('有人校准失败，位置暴露');
      break;
    case 'machine': {
      const m = S.setup.machines[e.m];
      scene.burst(m.x, 2.5, m.z, 50, 0x60ff90, { speed: 3, up: 5, life: 1.2 });
      sound.play('machine');
      feed(e.left > 0 ? `发报机修好了，还差 ${e.left} 台` : '最后一台发报机修好了');
      break;
    }
    case 'power':
      sound.play('power');
      banner('大门通电了', hunterSide ? '守住大门' : '去电闸开门！', hunterSide ? 'bad' : 'good');
      break;
    case 'pallet': {
      const p = S.setup.map.pallets[e.id];
      scene.burst(p.x + 0.5, 0.4, p.z + 0.5, 24, 0x8a7a5a, { additive: false, speed: 2.5, up: 1.5 });
      if (near({ x: p.x, z: p.z })) sound.play('pallet');
      if (e.stun) {
        sound.play('stun');
        if (hunterSide) {
          flash();
          scene.shake = 1;
          banner('被木板砸晕了', '', 'bad');
        } else if (iAm(e.pid)) banner('砸中了！', '', 'good');
        feed(`${nm(e.pid)} 用木板砸晕了追猎者`);
      }
      break;
    }
    case 'break': {
      const p = S.setup.map.pallets[e.id];
      scene.burst(p.x + 0.5, 0.6, p.z + 0.5, 36, 0x8a6a3a, { additive: false, speed: 4, up: 3 });
      if (near({ x: p.x, z: p.z })) sound.play('break');
      break;
    }
    case 'vault':
      if (near(pos(e.pid), 16)) sound.play('vault');
      break;
    case 'pickup':
      sound.play('pickup');
      if (iAm(e.pid)) banner('你被扛起来了', '挣扎中……', 'bad');
      break;
    case 'caged':
      sound.play('caged');
      if (iAm(e.pid)) banner('你被关进了铁笼', e.n >= 2 ? '这是第二次，时间只剩一半' : '等队友来救', 'bad');
      else if (!hunterSide) banner(`${nm(e.pid)} 被关进了铁笼`, '去救人', 'bad');
      feed(`${nm(e.pid)} 被关进了铁笼`);
      break;
    case 'rescued': {
      const c = pos(e.pid);
      if (c) scene.burst(c.x, 1, c.z, 30, 0xa0e0ff, { speed: 3, up: 3 });
      sound.play('rescued');
      if (iAm(e.pid)) banner('你被救出来了', '快跑', 'good');
      feed(`${nm(e.by)} 救出了 ${nm(e.pid)}`);
      break;
    }
    case 'free':
      sound.play('rescued');
      feed(`${nm(e.pid)} 挣脱了`);
      break;
    case 'healed': {
      const c = pos(e.pid);
      if (c) scene.burst(c.x, 1, c.z, 24, 0x80ffb0, { speed: 1.5, up: 3, grav: 0 });
      if (near(c)) sound.play('healed');
      break;
    }
    case 'stun':
      sound.play('stun');
      if (hunterSide) {
        flash();
        banner('被强光晃晕了', '', 'bad');
      }
      break;
    case 'skill': {
      const c = pos(e.pid);
      const snd = { runner: 'dash', guard: 'flare', illusion: 'vanish', scout: 'whistle', reaper: 'dash', weaver: 'web', phantom: 'blink' }[e.char] || 'skill';
      if (near(c) || e.char === 'scout') sound.play(snd);
      if (c && e.char === 'guard') scene.burst(c.x + Math.sin(c.d) * 1.5, 1.4, c.z + Math.cos(c.d) * 1.5, 50, 0xfff0c0, { speed: 6, up: 2, life: 0.5 });
      if (c && e.char === 'illusion') scene.burst(c.x, 1, c.z, 30, 0xb090ff, { additive: false, speed: 2, up: 2, grav: 0.5 });
      if (c && e.char === 'tinker') scene.burst(c.x, 1.2, c.z, 16, 0xffc040, { speed: 2, up: 3 });
      if (e.char === 'scout' && !hunterSide) feed(`${nm(e.pid)} 吹响了铜哨：追猎者的位置暴露了`);
      break;
    }
    case 'web':
      scene.burst(e.x, 0.3, e.z, 24, 0xf0f0ff, { speed: 2, up: 2 });
      sound.play('web');
      if (iAm(e.pid)) banner('踩到丝网了', '被减速，位置暴露', 'bad');
      else if (hunterSide) feed(`${nm(e.pid)} 踩中了丝网`);
      break;
    case 'blink':
      scene.burst(e.x, 1.2, e.z, 40, 0x90b8e0, { additive: false, speed: 3, up: 2, grav: 0.5, life: 1 });
      if (near(e)) sound.play('blink');
      break;
    case 'decoyPop':
      scene.burst(e.x, 1, e.z, 30, 0xb090ff, { additive: false, speed: 3, up: 2 });
      break;
    case 'gateOpen': {
      sound.play('gateOpen');
      banner('大门开了', hunterSide ? '' : '快逃！', hunterSide ? 'bad' : 'good');
      break;
    }
    case 'escape': {
      sound.play('escape');
      if (iAm(e.pid)) banner('你逃出来了', '', 'good');
      feed(`${nm(e.pid)} 逃脱了`);
      break;
    }
    case 'dead': {
      const c = pos(e.pid);
      if (c) scene.burst(c.x, 1, c.z, 40, 0xc0d0e0, { additive: false, speed: 1.5, up: 4, grav: 1, life: 1.6 });
      sound.play('dead');
      if (iAm(e.pid)) banner('你被淘汰了', '', 'bad');
      feed(`${nm(e.pid)} 被淘汰了`);
      break;
    }
    case 'hatch':
      sound.play('hatch');
      if (!hunterSide) banner('地窖开了', '找到那束蓝光', 'good');
      break;
  }
}

function showIntro() {
  const mi = myInfo();
  const el = $('#intro');
  const map = S.cfg.MAP_INFO[S.setup.map.key];
  el.innerHTML = `<div><h2>${esc(map.name)}</h2>${mi ? `<p class="role">${mi.role === 'hunter' ? '追猎者' : '求生者'} · ${esc(defOf(mi).name)}</p><p>${esc(mi.role === 'hunter' ? '打倒求生者，把他们关进铁笼。' : `修好 ${S.cfg.RULES.machinesNeed} 台发报机，打开大门逃出去。`)}</p>` : '<p>观战中</p>'}<p class="count" id="intro-count"></p></div>`;
  el.hidden = false;
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  setTimeout(() => (el.hidden = true), 5200);
}

// ---------------- HUD ----------------
let hudKey = '';
function renderHud() {
  const st = S.st;
  const me = mePl();
  const mi = myInfo();
  const R = S.cfg.RULES;
  if (st.phase === 'prep' && $('#intro-count')) $('#intro-count').textContent = Math.max(1, Math.ceil(R.prep - st.t));
  // 目标
  const obj = $('#hud-obj');
  const gp = Math.max(...st.gates.map((g) => (g[1] ? 1 : g[0])));
  const objHTML = st.powered ? (st.gates.some((g) => g[1]) ? '大门<b>已开</b>' : `电闸<b>${Math.round(gp * 100)}%</b>`) : `发报机 还差<b>${st.left}</b>台`;
  const survs = st.players.filter((p) => info(p.id).role === 'survivor');
  const key = objHTML + survs.map((p) => `${p.st}${p.hp}${Math.round(p.cg * 20)}`).join();
  if (key !== hudKey) {
    hudKey = key;
    obj.innerHTML = objHTML;
    obj.classList.toggle('power', st.powered);
    $('#hud-team').innerHTML = survs
      .map((p) => {
        const i = info(p.id);
        const d = defOf(i);
        const cls = p.st === 'ok' ? (p.hp === 1 ? 'hurt' : '') : p.st === 'carried' ? 'down' : p.st;
        return `<div class="tm ${cls} ${p.id === S.you ? 'me' : ''}" style="--c:${i.color};--fill:${p.st === 'dead' ? 0 : Math.round(p.cg * 100)}%" title="${esc(i.name)} ${ST_NAME[p.st]}"><div class="face"><span>${p.st === 'escaped' ? '✓' : p.st === 'dead' ? '✕' : esc(d.short[0])}</span></div><small>${esc(i.name)}</small></div>`;
      })
      .join('');
  }
  const pr = $('#progress');
  const useBtn = $('#btn-use');
  if (!me || !mi) {
    pr.hidden = true;
    return;
  }
  // 进度条
  let label = '';
  let val = 0;
  if (me.a === 'decode' && me.ai !== null) {
    label = ACT_LABEL.decode;
    val = st.machines[me.ai][0];
  } else if (me.a === 'gate' && me.ai !== null) {
    label = ACT_LABEL.gate;
    val = st.gates[me.ai][0];
  } else if (ACT_LABEL[me.a]) {
    label = ACT_LABEL[me.a];
    val = me.ap;
  } else if (me.st === 'caged') {
    label = `铁笼（第 ${me.cn} 次）· 等队友来救`;
    val = me.cg;
  } else if (me.st === 'carried') {
    label = '挣扎中';
    val = me.sg;
  } else if (me.st === 'down') {
    label = me.hl > 0 ? '队友正在扶你' : '倒地 · 可以慢慢爬向队友';
    val = me.hl;
  } else if (me.hl > 0) {
    label = '队友正在治疗你（别动）';
    val = me.hl;
  } else if (me.stun > 0) {
    label = '眩晕';
    val = clamp(me.stun / 3.2, 0, 1);
  }
  pr.hidden = !label;
  if (label) {
    $('#progress-label').textContent = label;
    $('#progress-bar').style.width = `${Math.round(val * 100)}%`;
  }
  // 互动键
  const channeling = CHANNEL.has(me.a);
  const hint = me.hint;
  useBtn.disabled = !hint && !channeling;
  useBtn.classList.toggle('hot', !!hint && !channeling);
  $('#use-label').textContent = channeling && (!hint || hint.type === me.a) ? '停下' : hint ? USE_LABEL[hint.type] : '互动';
  if (me.a === 'decode' && Math.random() < 0.35) sound.play('key');
  // 技能键
  const def = defOf(mi);
  const sk = $('#btn-skill');
  sk.classList.toggle('cd', me.cd > 0);
  $('#skill-mask').style.height = `${clamp(me.cd / def.skill.cd, 0, 1) * 100}%`;
  $('#skill-cd').textContent = me.cd > 0 ? Math.ceil(me.cd) : '';
  // 校准
  const q = me.qte;
  if (q && (!S.qte || S.qte.id !== q.id)) {
    S.qte = { id: q.id, start: performance.now() - q.e * 1000, a: q.a, b: q.b, sent: false };
    const arc = (f) => [Math.sin(f * Math.PI * 2) * 46, -Math.cos(f * Math.PI * 2) * 46];
    const [x1, y1] = arc(q.a);
    const [x2, y2] = arc(q.b);
    $('#qte-zone').setAttribute('d', `M${x1} ${y1} A46 46 0 0 1 ${x2} ${y2}`);
    $('#qte').hidden = false;
    sound.play('qte');
    navigator.vibrate && navigator.vibrate(30);
  } else if (!q && S.qte) {
    S.qte = null;
    $('#qte').hidden = true;
  }
  // 心跳与追逐
  const h = st.players.find((p) => info(p.id).role === 'hunter');
  let heart = 0;
  let chase = 0;
  if (h && h.x !== null) {
    if (mi.role === 'survivor' && (me.st === 'ok' || me.st === 'down')) {
      const d = Math.hypot(h.x - me.x, h.z - me.z);
      const rad = R.terror * (mi.char === 'scout' ? 1.4 : 1);
      heart = clamp(1 - d / rad, 0, 1);
      chase = d < 9 ? 1 : 0;
    } else if (mi.role === 'hunter') {
      chase = survs.some((p) => p.st === 'ok' && p.x !== null && Math.hypot(p.x - h.x, p.z - h.z) < 9) ? 0.8 : 0;
    }
  }
  sound.heart = heart;
  sound.chase += (chase - sound.chase) * 0.1;
  $('#danger').style.opacity = heart * 0.85;
  // 观战
  const sp = $('#spectate');
  const out = me.st === 'dead' || me.st === 'escaped';
  sp.hidden = !out || st.phase === 'ended';
  if (out) {
    const cands = st.players.filter((p) => p.id !== S.you && p.x !== null && p.st !== 'dead' && p.st !== 'escaped');
    if (!cands.some((p) => p.id === S.spec)) S.spec = cands.length ? cands[0].id : null;
    const key2 = me.st + S.spec;
    if (sp.dataset.k !== key2) {
      sp.dataset.k = key2;
      sp.innerHTML = `${me.st === 'escaped' ? '你已逃脱' : '你被淘汰了'}${S.spec ? ` · 正在看 ${esc(info(S.spec).name)}<button class="btn dark small" id="spec-next">换一个</button>` : ''}`;
      const b = $('#spec-next');
      if (b)
        b.onclick = () => {
          const i = cands.findIndex((p) => p.id === S.spec);
          S.spec = cands[(i + 1) % cands.length].id;
        };
    }
  }
  $('#pad').hidden = out;
  $('#stick').style.visibility = out ? 'hidden' : '';
}

function showEnd() {
  const st = S.st;
  if (!st || !st.result) return;
  const mi = myInfo();
  const r = st.result;
  const mine = !mi ? null : mi.role === 'hunter' ? (r.winner === 'hunter' ? 'win' : r.winner === 'draw' ? 'draw' : 'lose') : r.winner === 'survivors' ? 'win' : r.winner === 'draw' ? 'draw' : 'lose';
  const title = r.winner === 'draw' ? '平局' : mine === 'win' ? '胜利' : mine === 'lose' ? '失败' : r.winner === 'hunter' ? '追猎者获胜' : '求生者获胜';
  sound.setMood('lobby');
  sound.play(mine === 'lose' ? 'lose' : 'win');
  const isHost = S.room && S.you === S.room.host;
  const el = $('#end');
  el.innerHTML = `<div class="end-card"><h2 class="${mine === 'lose' ? 'lose' : 'win'}">${title}</h2>
    <p class="muted">${r.escaped} / ${r.total} 名求生者逃脱 · 用时 ${fmtT(st.t)}</p>
    <table><tr><th>玩家</th><th>角色</th><th>结局</th><th>演绎分</th></tr>${st.players
      .map((p, i) => {
        const pi = info(p.id);
        return `<tr><td style="color:${pi.color}">${esc(pi.name)}</td><td>${esc(defOf(pi).name)}</td><td>${pi.role === 'hunter' ? '追猎者' : ST_NAME[p.st]}</td><td>${st.scores ? st.scores[i] : ''}</td></tr>`;
      })
      .join('')}</table>
    <div class="actions">${isHost ? '<button class="btn gold" id="btn-again">回到房间</button>' : '<span class="muted">等房主回到房间……</span>'}<button class="btn dark" id="btn-quit">离开</button></div></div>`;
  el.hidden = false;
  const again = $('#btn-again');
  if (again) again.addEventListener('click', () => send('backToLobby'));
  $('#btn-quit').addEventListener('click', () => send('leave'));
}

// ======================= 操作 =======================
function hitsSolid(x, z, rad) {
  const W = S.W;
  for (let cz = Math.floor(z - rad); cz <= Math.floor(z + rad); cz++)
    for (let cx = Math.floor(x - rad); cx <= Math.floor(x + rad); cx++) {
      if (cx >= 0 && cz >= 0 && cx < W && cz < W && !S.solid[cz * W + cx] && !S.dyn[cz * W + cx]) continue;
      const nx = clamp(x, cx, cx + 1);
      const nz = clamp(z, cz, cz + 1);
      if ((x - nx) ** 2 + (z - nz) ** 2 < rad * rad) return true;
    }
  return false;
}
function moveLocal(p, dx, dz, rad) {
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.2));
  const sx = dx / steps;
  const sz = dz / steps;
  for (let i = 0; i < steps; i++) {
    if (!hitsSolid(p.x + sx, p.z + sz, rad)) {
      p.x += sx;
      p.z += sz;
    } else if (sx && !hitsSolid(p.x + sx, p.z, rad)) p.x += sx;
    else if (sz && !hitsSolid(p.x, p.z + sz, rad)) p.z += sz;
    else break;
  }
}

let lastT = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  if (document.body.dataset.screen !== 'game' || !S.st || !S.setup) return;
  const me = mePl();
  const playing = me && S.st.phase === 'play' && (me.st === 'ok' || me.st === 'down');
  // 键盘 + 摇杆 → 世界方向
  let ix = S.input.x;
  let iy = S.input.y;
  if (S.keys.size) {
    ix = (S.keys.has('d') || S.keys.has('arrowright') ? 1 : 0) - (S.keys.has('a') || S.keys.has('arrowleft') ? 1 : 0);
    iy = (S.keys.has('w') || S.keys.has('arrowup') ? 1 : 0) - (S.keys.has('s') || S.keys.has('arrowdown') ? 1 : 0);
  }
  let il = Math.hypot(ix, iy);
  if (il > 1) {
    ix /= il;
    iy /= il;
    il = 1;
  }
  const yaw = scene.yaw;
  let wx = Math.cos(yaw) * ix - Math.sin(yaw) * iy;
  let wz = -Math.sin(yaw) * ix - Math.cos(yaw) * iy;
  if (!playing || il < 0.15) wx = wz = 0;
  // 发送输入（节流）
  const lm = S.lastMove;
  if ((Math.abs(wx - lm.x) > 0.04 || Math.abs(wz - lm.z) > 0.04) && (now - lm.t > 60 || (!wx && !wz))) {
    act('move', { x: Math.round(wx * 100) / 100, z: Math.round(wz * 100) / 100 });
    S.lastMove = { x: wx, z: wz, t: now };
  }
  // 本地预测 + 向服务器位置修正
  if (me && me.x !== null) {
    const blocked = !playing || me.stun > 0 || BLOCKED.has(me.a);
    const moving = !blocked && (wx || wz);
    if (moving) {
      moveLocal(S.me, wx * me.v * dt, wz * me.v * dt, S.cfg.RULES.radius);
      S.me.d = Math.atan2(wx, wz);
    } else S.me.d = me.d;
    const ex = me.x - S.me.x;
    const ez = me.z - S.me.z;
    const err = Math.hypot(ex, ez);
    const k = err > 3 || blocked ? Math.min(1, dt * 14) : Math.min(1, dt * (moving ? 2.2 : 7));
    S.me.x += ex * k;
    S.me.z += ez * k;
  }
  // 镜头跟随
  let fx = S.me.x;
  let fz = S.me.z;
  const out = !me || me.st === 'dead' || me.st === 'escaped' || me.st === 'carried';
  if (out) {
    const id = !me ? (S.st.players.find((p) => p.x !== null && p.st === 'ok') || {}).id : me.st === 'carried' ? S.you : S.spec;
    const c = scene.chars.get(id);
    if (c && c.has) {
      fx = c.x;
      fz = c.z;
    }
  }
  scene.focus.x += (fx - scene.focus.x) * Math.min(1, dt * 18);
  scene.focus.z += (fz - scene.focus.z) * Math.min(1, dt * 18);
  // 校准指针
  if (S.qte) {
    const f = (now - S.qte.start) / 1000 / S.cfg.RULES.qteDur;
    $('#qte-needle').setAttribute('transform', `rotate(${f * 360})`);
  }
  scene.frame(dt, me && !out ? S.me : null);
}

function doUse() {
  const me = mePl();
  if (!me) return;
  if (S.qte) return doQte();
  if (CHANNEL.has(me.a) && (!me.hint || me.hint.type === me.a)) act('cancel');
  else if (me.hint) {
    act('use');
    sound.play('click');
  }
}
function doQte() {
  if (!S.qte || S.qte.sent) return;
  S.qte.sent = true;
  const f = (performance.now() - S.qte.start) / 1000 / S.cfg.RULES.qteDur;
  act('qte', { f });
  $('#qte').hidden = true;
}
const aimDir = () => Math.atan2(-Math.sin(scene.yaw), -Math.cos(scene.yaw));
function doAttack() {
  if (myInfo() && myInfo().role === 'hunter') act('attack', { d: aimDir() });
}
function doSkill() {
  const me = mePl();
  if (me && me.cd <= 0) act('skill', { d: aimDir() });
}

// 触屏 / 鼠标：左半屏是摇杆，其余地方拖动转镜头
const game = $('#screen-game');
const ptr = { stick: null, look: null };
const UI = 'button, .drawer, .end, .qte, .hud-top, .spectate, input';
game.addEventListener('pointerdown', (e) => {
  sound.unlock();
  if (e.target.closest(UI)) return;
  const touch = e.pointerType !== 'mouse';
  if (touch && e.clientX < window.innerWidth * 0.42 && !ptr.stick) {
    ptr.stick = { id: e.pointerId, x: e.clientX, y: e.clientY };
    const st = $('#stick');
    st.style.left = `${e.clientX - st.offsetWidth / 2}px`;
    st.style.top = `${e.clientY - st.offsetHeight / 2}px`;
    st.style.bottom = 'auto';
  } else if (!ptr.look) ptr.look = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0, mouse: !touch };
  game.setPointerCapture(e.pointerId);
});
game.addEventListener('pointermove', (e) => {
  if (ptr.stick && e.pointerId === ptr.stick.id) {
    const R = 50;
    let dx = (e.clientX - ptr.stick.x) / R;
    let dy = (e.clientY - ptr.stick.y) / R;
    const l = Math.hypot(dx, dy);
    if (l > 1) {
      dx /= l;
      dy /= l;
    }
    S.input.x = dx;
    S.input.y = -dy;
    $('#stick-knob').style.transform = `translate(${dx * 36}px, ${dy * 36}px)`;
  } else if (ptr.look && e.pointerId === ptr.look.id && scene) {
    const dx = e.clientX - ptr.look.x;
    const dy = e.clientY - ptr.look.y;
    ptr.look.x = e.clientX;
    ptr.look.y = e.clientY;
    ptr.look.moved += Math.abs(dx) + Math.abs(dy);
    scene.yaw -= dx * 0.0062;
    scene.pitch = clamp(scene.pitch + dy * 0.004, 0.3, 1.25);
  }
});
const pointerEnd = (e) => {
  if (ptr.stick && e.pointerId === ptr.stick.id) {
    ptr.stick = null;
    S.input.x = S.input.y = 0;
    $('#stick-knob').style.transform = '';
    const st = $('#stick');
    st.style.left = st.style.top = st.style.bottom = '';
  } else if (ptr.look && e.pointerId === ptr.look.id) {
    // 电脑上：没怎么拖动的一次点击 = 出刀
    if (ptr.look.mouse && ptr.look.moved < 6 && e.type === 'pointerup') doAttack();
    ptr.look = null;
  }
};
game.addEventListener('pointerup', pointerEnd);
game.addEventListener('pointercancel', pointerEnd);
game.addEventListener('contextmenu', (e) => e.preventDefault());
game.addEventListener(
  'wheel',
  (e) => {
    if (scene) scene.camDist = clamp(scene.camDist + Math.sign(e.deltaY) * 0.6, 4, 11);
  },
  { passive: true }
);
const press = (el, fn) =>
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    sound.unlock();
    fn();
  });
press($('#btn-use'), doUse);
press($('#btn-attack'), doAttack);
press($('#btn-skill'), doSkill);
press($('#qte'), doQte);

const MOVE_KEYS = ['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'];
window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select')) return;
  if (document.body.dataset.screen !== 'game') return;
  const k = e.key.toLowerCase();
  if (MOVE_KEYS.includes(k)) {
    S.keys.add(k);
    e.preventDefault();
  } else if (e.repeat) return;
  else if (k === ' ' || k === 'e') {
    e.preventDefault();
    doUse();
  } else if (k === 'q' || k === 'shift') doSkill();
  else if (k === 'j' || k === 'f') doAttack();
  else if (k === 'escape') {
    closeModal();
    $('#drawer').hidden = true;
  } else if (k === 'enter') $('#btn-chat').click();
});
window.addEventListener('keyup', (e) => S.keys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => {
  S.keys.clear();
  S.input.x = S.input.y = 0;
});

// ======================= 聊天 =======================
function addChat(m) {
  S.chat.push(m);
  if (S.chat.length > 120) S.chat.shift();
  renderChat();
  if (document.body.dataset.screen === 'game' && $('#drawer').hidden && !m.sys) {
    S.unread++;
    $('#chat-badge').hidden = false;
    $('#chat-badge').textContent = S.unread;
    feed(`${m.name}：${m.text}`);
  }
}
function renderChat() {
  const html = S.chat
    .slice(-80)
    .map((m) => (m.sys ? `<div class="sys">${esc(m.text)}</div>` : `<div><span class="who" style="color:${m.color}">${esc(m.name)}</span>${esc(m.text)}</div>`))
    .join('');
  for (const el of [$('#lobby-chat'), $('#game-chat')]) {
    el.innerHTML = html;
    el.scrollTop = el.scrollHeight;
  }
}
$$('[data-chat]').forEach((f) =>
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('input', f);
    const text = input.value.trim();
    if (!text) return;
    send('chat', { text });
    input.value = '';
    input.blur();
  })
);

// ======================= 邀请 =======================
function renderOnline(list) {
  const root = $('#modal-root');
  if (root.hidden || !root.querySelector('[data-online]')) return;
  const stName = { idle: '空闲', room: '在房间里', playing: '对局中' };
  root.querySelector('[data-online]').innerHTML = list.length
    ? list.map((u) => `<li><span>${esc(u.username)}</span><span class="st">${stName[u.status]}</span><button class="btn dark small" data-inv="${u.id}" ${u.invited ? 'disabled' : ''}>${u.invited ? '已邀请' : '邀请'}</button></li>`).join('')
    : '<li><span class="muted">没有其他在线的人</span></li>';
  $$('[data-inv]', root).forEach((b) =>
    b.addEventListener('click', () => {
      send('invite', { userId: Number(b.dataset.inv) });
      b.disabled = true;
      b.textContent = '已邀请';
    })
  );
}
function showInvite(d) {
  const root = $('#invite-root');
  for (const el of $$('.invite-card', root)) if (el.dataset.code === d.code) el.remove();
  const card = document.createElement('div');
  card.className = 'invite-card';
  card.dataset.code = d.code;
  card.innerHTML = `<div><b>${esc(d.from)}</b> 邀请你玩${esc(d.gameName || '卡坦岛')}「${esc(d.title)}」<small>${esc(d.detail || '')}，已有 ${d.players} / ${d.max} 人</small></div>
    <div class="ic-btns"><button class="btn ghost small ic-no">忽略</button><button class="btn gold small ic-yes">去</button></div><i class="ic-timer"></i>`;
  root.prepend(card);
  while (root.children.length > 3) root.lastChild.remove();
  const decline = () => {
    clearTimeout(timer);
    send('inviteReply', { game: d.game || 'catan', fromUser: d.fromUser, code: d.code, accept: false });
    card.remove();
  };
  const timer = setTimeout(decline, 60000);
  card.querySelector('.ic-yes').onclick = () => {
    clearTimeout(timer);
    card.remove();
    if ((d.game || 'catan') === 'hunt') send('join', { code: d.code });
    else location.href = `${d.path || '/catan/'}?room=${encodeURIComponent(d.code)}`;
  };
  card.querySelector('.ic-no').onclick = decline;
  sound.play('invite');
}

// ======================= 弹窗与提示 =======================
function modal(html) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal">${html}</div>`;
  root.hidden = false;
  root.onclick = (e) => {
    if (e.target === root || e.target.closest('[data-close-modal]')) closeModal();
  };
}
function closeModal() {
  $('#modal-root').hidden = true;
  $('#modal-root').innerHTML = '';
}
function toast(msg, err = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  $('#toast-root').appendChild(t);
  setTimeout(() => t.remove(), 2600);
}
function soundModal(extra = '') {
  const v = sound.vol;
  modal(`<h3>设置</h3><div class="vol">
      <label for="v-master">总音量</label><input id="v-master" type="range" min="0" max="1" step="0.05" value="${v.master}">
      <label for="v-music">配乐</label><input id="v-music" type="range" min="0" max="1" step="0.05" value="${v.music}">
      <label for="v-sfx">音效</label><input id="v-sfx" type="range" min="0" max="1" step="0.05" value="${v.sfx}">
    </div>${extra}<div class="actions"><button class="btn dark" data-close-modal>好</button></div>`);
  for (const k of ['master', 'music', 'sfx'])
    $('#v-' + k).addEventListener('input', (e) => {
      sound.unlock();
      sound.setVolume(k, Number(e.target.value));
    });
}

// ======================= 按钮 =======================
$$('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
    $$('.tab-pane').forEach((p) => (p.hidden = p.dataset.pane !== t.dataset.tab));
    if (t.dataset.tab === 'me') loadMe();
    if (t.dataset.tab === 'board') loadBoard();
    if (t.dataset.tab === 'help') $('#codex').innerHTML = codexHTML();
  })
);
$('#btn-create').addEventListener('click', () => {
  sound.unlock();
  send('create', { title: $('#create-title').value, private: $('#create-private').checked });
});
$('#join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('#join-code').value.trim().toUpperCase();
  if (code) send('join', { code });
});
$('#btn-leave-lobby').addEventListener('click', () => send('leave'));
$('#lobby-code').addEventListener('click', async () => {
  const link = `${location.origin}/hunt/?room=${S.room.code}`;
  try {
    await navigator.clipboard.writeText(link);
    toast('邀请链接已复制');
  } catch {
    toast(link);
  }
});
$$('[data-bot]').forEach((b) => b.addEventListener('click', () => send('addBot', { level: $('#bot-level').value, role: b.dataset.bot })));
$('#btn-start').addEventListener('click', () => {
  sound.unlock();
  send('start');
});
$('#btn-invite').addEventListener('click', () => {
  modal('<h3>邀请在线玩家</h3><ul data-online><li><span class="muted">加载中…</span></li></ul><div class="actions"><button class="btn dark" data-close-modal>关闭</button></div>');
  send('online');
});
$('#btn-sound-lobby').addEventListener('click', () => soundModal());
$('#btn-menu').addEventListener('click', () => {
  const q = scene && scene.quality === 'low';
  soundModal(`<div class="actions" style="justify-content:flex-start;margin-bottom:10px"><button class="btn dark" id="m-quality">画质：${q ? '低' : '高'}</button><button class="btn dark" id="m-help">怎么玩</button><button class="btn dark" id="m-leave">离开对局</button></div>`);
  $('#m-leave').addEventListener('click', () => {
    closeModal();
    send('leave');
  });
  $('#m-quality').addEventListener('click', (e) => {
    scene.setQuality(scene.quality === 'low' ? 'high' : 'low');
    try {
      localStorage.setItem('hunt.quality', scene.quality);
    } catch {}
    e.target.textContent = `画质：${scene.quality === 'low' ? '低' : '高'}`;
  });
  $('#m-help').addEventListener('click', () => modal(`<h3>怎么玩</h3><div class="help">${$('[data-pane="help"] ol').outerHTML}${$('[data-pane="help"] .muted').outerHTML}${codexHTML()}</div><div class="actions"><button class="btn dark" data-close-modal>知道了</button></div>`));
});
$('#btn-chat').addEventListener('click', () => {
  const d = $('#drawer');
  d.hidden = !d.hidden;
  S.unread = 0;
  $('#chat-badge').hidden = true;
  const c = $('#game-chat');
  c.scrollTop = c.scrollHeight;
  if (!d.hidden && matchMedia('(pointer: fine)').matches) $('input', d).focus();
});
$('[data-close-drawer]').addEventListener('click', () => ($('#drawer').hidden = true));

// ======================= 启动 =======================
(async () => {
  try {
    S.cfg = await api('/api/hunt/config');
  } catch (e) {
    toast('加载失败：' + e.message, true);
  }
  connect();
})();
