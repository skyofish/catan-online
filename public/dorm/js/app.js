// 猛鬼宿舍：界面、网络、对局 HUD 与事件编排。
import { getSession, takeHashSession, api, upgradeToHttps, goToLogin, wsUrl } from '/js/session.js';
import { initFullscreen } from '/js/fullscreen.js';

initFullscreen();
import { sound } from './audio.js';
import { Stage } from './render.js';
import { iconCanvas } from './sprites.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtT = (s) => {
  s = Math.max(0, Math.ceil(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmtN = (n) => (n >= 10000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k' : String(Math.floor(n)));
const COLORS = ['#e53935', '#1e88e5', '#fdd835', '#eceff1', '#43a047', '#ab47bc', '#ff7043', '#26c6da'];
const DIFF_KEYS = ['easy', 'normal', 'hard', 'nightmare'];
const BOT_TAG = { easy: '菜鸟电脑', normal: '老手电脑', hard: '大神电脑', ai: '智谱 AI' };

takeHashSession();
if (!getSession()) goToLogin();
upgradeToHttps();

const S = {
  ws: null,
  user: null,
  cfg: null,
  room: null,
  you: null,
  game: null,
  gameId: null,
  rooms: [],
  chat: [],
  unread: 0,
  retry: 0,
  homeDiff: 'normal',
  sel: null, // { room, cell } 选中的格子
  sheetKey: '',
  dockKey: '',
  lastBanner: 0,
  prevPhase: null,
  endShownFor: null,
  lastTick: -1,
};
window.__S = S;

let stage = null;
const BT = () => S.cfg.BUILD_TYPES;
const GEO = (i) => S.map.rooms[i];

// ======================= 网络 =======================
function connect() {
  const ws = (S.ws = new WebSocket(wsUrl('/dorm/ws')));
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

function onMsg(m) {
  const d = m.d;
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
      const want = new URLSearchParams(location.search).get('room') || sessionStorage.getItem('dorm.room');
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
        sessionStorage.removeItem('dorm.room');
        history.replaceState(null, '', '/dorm/');
        if (!S.room) showHome();
      }
      break;
    case 'left':
      S.room = null;
      S.you = null;
      sessionStorage.removeItem('dorm.room');
      history.replaceState(null, '', '/dorm/');
      if (d && d.kicked) toast('你被请出了宿舍楼', true);
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
  if (name !== 'game' && stage) stage.stop();
}

let listTimer = null;
function showHome() {
  screen('home');
  sound.setMood('lobby');
  renderDiffPick($('#create-diff'), S.homeDiff, true, (k) => {
    S.homeDiff = k;
    showHome();
  });
  send('list');
  clearInterval(listTimer);
  listTimer = setInterval(() => document.body.dataset.screen === 'home' && send('list'), 5000);
}

function onRoom(d) {
  const prevGame = S.room && S.room.gameId;
  S.room = d.room;
  S.you = d.you;
  sessionStorage.setItem('dorm.room', d.room.code);
  if (new URLSearchParams(location.search).get('room') !== d.room.code) history.replaceState(null, '', `/dorm/?room=${d.room.code}`);
  if (d.room.gameId !== prevGame) {
    S.gameId = d.room.gameId;
    S.game = null;
    S.map = null;
    S.rooms = [];
    S.sel = null;
    S.endShownFor = null;
    S.prevPhase = null;
    closeSheet();
    $('#end').hidden = true;
  }
  if (d.room.started) showGame();
  else showLobby();
}

// ======================= 首页 =======================
function diffDesc(k) {
  const D = S.cfg && S.cfg.DIFFICULTY[k];
  if (!D) return '';
  const smart = ['猛鬼随便挑人砸门', '猛鬼爱挑门最破的宿舍', '猛鬼会算计：挑最好打的，打不动就换人，还会鬼哭让防御停摆', '猛鬼极其狡猾，护甲厚、成长快，经常鬼哭'][D.smart];
  return `${Math.round(D.duration / 60)} 分钟后天亮，开局有 ${D.prep} 秒选宿舍。${smart}。`;
}

function renderDiffPick(el, cur, can, onPick) {
  const names = { easy: ['简单', '适合第一次'], normal: ['普通', '正常的夜晚'], hard: ['困难', '需要配合'], nightmare: ['噩梦', '九死一生'] };
  el.classList.toggle('can', can);
  el.innerHTML = DIFF_KEYS.map((k) => `<button data-d="${k}" class="${k === cur ? 'on' : ''}" ${can ? '' : 'tabindex="-1"'}>${names[k][0]}<small>${names[k][1]}</small></button>`).join('');
  $$('button', el).forEach((b) =>
    b.addEventListener('click', () => {
      if (!can) return;
      sound.play('click');
      onPick(b.dataset.d);
    })
  );
}

function renderRoomList(list) {
  const el = $('#room-list');
  const dn = (k) => (S.cfg ? S.cfg.DIFFICULTY[k].name : k);
  el.innerHTML = list.length
    ? list
        .map(
          (r) => `<li data-code="${esc(r.code)}"><span class="rt">${esc(r.title)}</span>
        <span class="tag">${esc(dn(r.diff))}</span><span class="tag">${r.players}/${r.max}</span>
        <span class="tag ${r.started && !r.ended ? 'live' : ''}">${r.ended ? '已结束' : r.started ? '熄灯中' : '等人'}</span></li>`
        )
        .join('')
    : '<li class="empty">现在没有亮着灯的宿舍楼，开一栋吧</li>';
  $$('li[data-code]', el).forEach((li) => li.addEventListener('click', () => send('join', { code: li.dataset.code })));
}

async function loadMe() {
  const el = $('#me-stats');
  try {
    const d = await api('/api/dorm/me');
    const st = d.stats || {};
    const dn = (i) => (S.cfg ? S.cfg.DIFFICULTY[DIFF_KEYS[i]].name : '');
    el.innerHTML = `<div class="big"><div><b>${st.games || 0}</b>局数</div><div><b>${st.wins || 0}</b>活到天亮</div><div><b>${st.avg_vp ? fmtT(st.avg_vp) : '-'}</b>平均存活</div></div>
      ${d.recent.length ? `<table><tr><th>时间</th><th>难度</th><th>人数</th><th>结果</th><th>存活</th></tr>${d.recent.map((r) => `<tr><td>${new Date(r.ended_at).toLocaleDateString()}</td><td>${dn(r.target_vp)}</td><td>${r.players}</td><td class="${r.is_winner ? 'win' : 'lose'}">${r.is_winner ? '活下来了' : '遇难'}</td><td>${fmtT(r.vp)}</td></tr>`).join('')}</table>` : '<p class="muted">还没有在宿舍楼里过过夜。</p>'}`;
  } catch (e) {
    el.textContent = e.message;
  }
}

async function loadBoard() {
  const el = $('#leaderboard');
  try {
    const d = await api('/api/dorm/leaderboard');
    el.innerHTML = d.rows.length
      ? `<table><tr><th>#</th><th>玩家</th><th>活到天亮</th><th>局数</th><th>平均存活</th></tr>${d.rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.username)}</td><td>${r.wins}</td><td>${r.games}</td><td>${fmtT(r.avg_vp)}</td></tr>`).join('')}</table>`
      : '<p class="muted">还没有人上榜。</p>';
  } catch (e) {
    el.textContent = e.message;
  }
}

// ======================= 房间大厅 =======================
function showLobby() {
  screen('lobby');
  sound.setMood('lobby');
  const r = S.room;
  const isHost = S.you && S.you === r.host;
  $('#lobby-title').textContent = r.title;
  $('#lobby-code').textContent = r.code;
  renderDiffPick($('#lobby-diff'), r.diff, isHost, (k) => send('settings', { diff: k }));
  $('#diff-desc').textContent = diffDesc(r.diff);
  $('#lobby-count').textContent = `${r.players.length}/${r.max}`;
  const slots = [];
  for (let i = 0; i < r.max; i++) {
    const p = r.players[i];
    if (!p) {
      slots.push('<li class="slot empty">空床位</li>');
      continue;
    }
    const tag = p.isBot ? BOT_TAG[p.bot] : p.autoBot ? '电脑代管' : p.connected ? '' : '离线';
    slots.push(`<li class="slot ${p.id === S.you ? 'me' : ''} ${p.connected ? '' : 'off'}" data-pid="${p.id}">
      <span class="dot" style="color:${p.color}"></span><span class="nm">${esc(p.name)} ${tag ? `<small>${tag}</small>` : ''}</span>
      ${p.id === r.host ? '<span class="host">房主</span>' : ''}
      ${isHost && p.id !== S.you ? `<button class="x" data-kick="${p.id}" aria-label="移出">✕</button>` : ''}</li>`);
  }
  $('#lobby-players').innerHTML = slots.join('');
  const me = r.players.find((p) => p.id === S.you);
  if (me) {
    const used = new Set(r.players.filter((p) => p !== me).map((p) => p.color));
    $('#lobby-players').insertAdjacentHTML('beforeend', `<li class="colors" style="grid-column:1/-1">${COLORS.map((c) => `<button style="background:${c}" class="${c === me.color ? 'on' : ''}" data-color="${c}" ${used.has(c) ? 'disabled' : ''} aria-label="颜色"></button>`).join('')}</li>`);
  }
  $$('[data-kick]').forEach((b) => b.addEventListener('click', () => send('kick', { pid: b.dataset.kick })));
  $$('[data-color]').forEach((b) => b.addEventListener('click', () => send('color', { color: b.dataset.color })));
  $('#bot-row').hidden = !isHost;
  $('#bot-ai').hidden = !r.aiAvailable;
  $('#btn-start').hidden = !isHost;
  $('#btn-start').disabled = !r.players.length;
  $('#lobby-hint').textContent = !S.you ? '你正在观战。' : isHost ? '可以一个人带电脑玩，也可以邀请朋友。最多 8 人。' : '等房主熄灯……';
}

// ======================= 对局 =======================
function showGame() {
  screen('game');
  if (!stage) {
    stage = new Stage($('#stage'));
    stage.onTap = onTap;
    window.__stage = stage;
  }
  if (S.map && stage.map !== S.map) stage.setMap(S.map);
  stage.start();
  stage.resize();
  updateInsets();
  renderPlayers();
  if (S.game && S.game.phase === 'ended') showEnd();
}

function updateInsets() {
  if (!stage) return;
  const top = $('.hud-top').getBoundingClientRect().bottom + 6;
  const dock = $('#dock').getBoundingClientRect();
  const ins = { top: Math.max(56, top), bottom: Math.max(60, window.innerHeight - dock.top + 4), left: 6, right: 6 };
  const old = stage.insets;
  if (old.top === ins.top && old.bottom === ins.bottom && S.insetsSet) return;
  S.insetsSet = true;
  stage.insets = ins;
  stage.refocus(true);
}
window.addEventListener('resize', () => setTimeout(updateInsets, 50));

function playersMap() {
  const m = new Map();
  if (!S.room) return m;
  for (const p of S.room.players) m.set(p.id, { ...p });
  if (S.game) for (const gp of S.game.players) Object.assign(m.get(gp.id) || {}, gp);
  return m;
}

function me() {
  return S.game && S.you ? S.game.players.find((p) => p.id === S.you) : null;
}
function myRoom() {
  const p = me();
  return p && p.room !== null ? S.rooms[p.room] : null;
}

function onState(d) {
  if (d.gameId !== S.gameId) {
    S.gameId = d.gameId;
    S.rooms = [];
  }
  if (d.map) S.map = d.map;
  if (!S.map) return;
  for (const r of d.rooms) {
    if (r.cells) S.rooms[r.i] = r;
    else if (S.rooms[r.i]) Object.assign(S.rooms[r.i], r);
  }
  const prev = S.game;
  S.game = d;
  if (document.body.dataset.screen !== 'game') return;
  if (stage.map !== S.map) stage.setMap(S.map);
  const pm = playersMap();
  stage.setState(d, S.rooms, pm, S.you);
  const now = performance.now() / 1000;
  for (const e of d.events || []) {
    stage.event(e, now);
    onEvent(e, pm);
  }
  // 准备阶段最后 5 秒滴答
  if (d.phase === 'prep') {
    const sec = Math.ceil(d.prepLeft);
    if (sec <= 5 && sec !== S.lastTick) {
      S.lastTick = sec;
      sound.play('tick');
    }
    sound.setMood('prep');
  } else if (d.phase === 'play') sound.setMood('play');
  if (d.phase === 'ended' && S.endShownFor !== S.gameId) setTimeout(showEnd, 1800);
  if (!prev || prev.phase !== d.phase) renderPlayers();
  renderHud();
  renderDock();
  if (S.sel) renderSheet();
}

function near(roomIdx) {
  const mr = me();
  if (!mr || mr.room === null) return 0.6;
  if (roomIdx === mr.room) return 1;
  const a = GEO(mr.room).center;
  const b = GEO(roomIdx).center;
  return Math.max(0, 1 - Math.hypot(a.x - b.x, a.y - b.y) / 14);
}
function ghostNear() {
  const mr = me();
  if (!mr || mr.room === null || !S.game) return 0.6;
  const a = GEO(mr.room).center;
  return Math.max(0, 1 - Math.hypot(a.x - S.game.ghost.x, a.y - S.game.ghost.y) / 14);
}

function banner(text, sub = '', force = false) {
  const now = Date.now();
  if (!force && now - S.lastBanner < 1500) return;
  S.lastBanner = now;
  const b = $('#banner');
  b.hidden = false;
  b.innerHTML = `${esc(text)}${sub ? `<small>${esc(sub)}</small>` : ''}`;
  b.style.animation = 'none';
  void b.offsetWidth;
  b.style.animation = '';
}

function onEvent(e, pm) {
  const mine = me();
  const myIdx = mine ? mine.room : null;
  const isMe = (pid) => pid === S.you;
  switch (e.type) {
    case 'start':
      banner('熄灯了', '从入口走进一间空宿舍，躺到床上', true);
      sound.play('claim');
      break;
    case 'claim':
      if (isMe(e.pid)) {
        sound.play('claim');
        stage.marker = null;
        if (e.auto) toast(`你吓得钻进了最近的 ${e.room + 1} 号宿舍`);
        else toast(`你在 ${e.room + 1} 号宿舍躺下了`);
      }
      break;
    case 'claimFail':
      if (isMe(e.pid)) {
        toast(`${e.room + 1} 号宿舍被别人抢先躺下了`, true);
        sound.play('error');
        stage.marker = null;
      }
      break;
    case 'bump':
      if (isMe(e.pid)) toast(`${e.room + 1} 号宿舍有人躺下了，你被请了出来`, true);
      break;
    case 'loot':
      if (isMe(e.pid)) {
        sound.play('coins');
        toast(e.e ? `储物柜里翻出一块电池：+${e.e} 电` : `储物柜里翻出 ${e.g} 金币`);
      }
      break;
    case 'bell':
      sound.play('bellring', { near: near(e.room) });
      break;
    case 'wake':
      banner('猛鬼醒了', '锁好门，别出声', true);
      sound.play('wake');
      break;
    case 'hunt':
      if (e.room === myIdx) {
        banner('它朝你来了……');
        sound.play('hunt', { near: 1 });
        if (navigator.vibrate) navigator.vibrate(80);
      }
      break;
    case 'shot':
      sound.play({ thunder: 'thunder', sword: 'slash', talisman: 'fire', trap: 'snap' }[e.kind] || 'shot', { near: ghostNear() });
      break;
    case 'hitDoor':
      sound.play('hitDoor', { near: near(e.room) });
      if (e.room === myIdx && navigator.vibrate) navigator.vibrate(30);
      break;
    case 'hitBed':
      sound.play('hitBed', { near: near(e.room) });
      if (e.room === myIdx && navigator.vibrate) navigator.vibrate([40, 30, 40]);
      break;
    case 'hitCell':
      sound.play('hitDoor', { near: near(e.room) * 0.8 });
      if (e.room === myIdx && navigator.vibrate) navigator.vibrate(20);
      break;
    case 'wreck':
      sound.play('wreck', { near: near(e.room) });
      if (e.room === myIdx) banner(`${S.cfg.BUILD[e.btype] ? S.cfg.BUILD[e.btype].name : '储物柜'}被砸烂了`, '它离床越来越近了……');
      break;
    case 'doorBroken':
      sound.play('doorBroken', { near: near(e.room) });
      setTimeout(() => sound.play('laugh', { near: near(e.room) }), 900);
      if (e.room === myIdx) {
        banner('门被砸烂了！', '它进来了', true);
        if (navigator.vibrate) navigator.vibrate([200, 80, 200]);
      }
      break;
    case 'kill': {
      const p = pm.get(e.pid);
      sound.play('kill');
      banner(isMe(e.pid) ? '你死了' : `${p ? p.name : '有人'} 遇难`, isMe(e.pid) ? '接下来只能看着了' : '', true);
      if (isMe(e.pid)) closeSheet();
      renderPlayers();
      break;
    }
    case 'reflect':
      sound.play('reflect', { near: near(e.room) });
      break;
    case 'scream':
      sound.play('scream', { near: near(e.room) });
      if (e.room === myIdx) banner('鬼哭！', '防御停摆 3 秒');
      break;
    case 'ghostLevel':
      sound.play('level');
      banner(`猛鬼 ${e.lv} 级`, `每击 ${S.game.ghost.dmg} · 护甲 ${S.game.ghost.armor}`);
      break;
    case 'retreat':
      sound.play('retreat');
      break;
    case 'build':
      if (isMe(e.pid)) sound.play(e.lv > 1 ? 'upgrade' : 'build');
      break;
    case 'sell':
      if (isMe(e.pid)) sound.play('sell');
      break;
    case 'bed':
      if (isMe(e.pid)) sound.play('bed');
      break;
    case 'door':
      if (isMe(e.pid)) sound.play('door');
      break;
    case 'ghostDie':
      sound.play('ghostHurt');
      break;
    case 'end':
      sound.setMood('end');
      setTimeout(() => sound.play(e.win ? 'victory' : 'defeat'), 300);
      banner(e.win ? (e.reason === 'ghostDead' ? '猛鬼伏诛' : '天亮了') : '无人生还', '', true);
      closeSheet();
      break;
  }
}

function renderHud() {
  const g = S.game;
  const clock = $('#hud-clock');
  clock.classList.toggle('prep', g.phase === 'prep');
  clock.querySelector('.lbl').textContent = g.phase === 'prep' ? '猛鬼醒来' : g.phase === 'ended' ? '结束' : '距天亮';
  $('#clock').textContent = fmtT(g.phase === 'prep' ? g.prepLeft : g.timeLeft);
  const gh = g.ghost;
  $('#g-lv').textContent = gh.lv;
  $('#g-hp').style.width = `${(gh.hp / gh.max) * 100}%`;
  $('#g-hptext').textContent = `${fmtN(gh.hp)} / ${fmtN(gh.max)}`;
  const st = {
    sleep: '沉睡中',
    hunt: gh.target !== null ? `前往 ${gh.target + 1} 号房` : '游荡',
    door: `砸 ${gh.target + 1} 号房的门`,
    smash: `在 ${gh.target + 1} 号房里砸东西`,
    bed: `扑向 ${gh.target + 1} 号房的床`,
    retreat: '逃回血池',
    heal: '在血池回血',
    dead: '已消散',
    flee: '退散了',
    feast: '……',
  }[gh.state];
  const extra = [gh.stun ? '被定住' : '', gh.root ? '被夹住' : '', gh.burn ? '灼烧中' : '', gh.slow ? `减速 ${Math.round(gh.slow * 100)}%` : ''].filter(Boolean).join(' · ');
  $('#g-stat').textContent = `${st} · 每击 ${gh.dmg} · 护甲 ${gh.armor}${extra ? ' · ' + extra : ''}`;
  const p = me();
  $('#hud-res').hidden = !p;
  if (p) {
    $('#r-gold').textContent = fmtN(p.gold);
    $('#r-inc').textContent = `+${p.income}/秒`;
    $('#r-energy').textContent = fmtN(p.energy);
    $('#r-erate').textContent = p.eRate ? `+${p.eRate}/秒` : '';
  }
  // 危险提示与紧张度
  const mr = myRoom();
  const targeted = mr && p && p.alive && gh.target === mr.i && ['hunt', 'door', 'smash', 'bed'].includes(gh.state);
  const attacking = targeted && ['door', 'smash', 'bed'].includes(gh.state);
  const inside = targeted && (gh.state === 'smash' || gh.state === 'bed' || mr.door[1] <= 0);
  $('#danger').classList.toggle('on', !!attacking && (inside || mr.door[1] < mr.door[2] * 0.4));
  let ten = g.phase === 'play' ? 0.15 : 0;
  if (targeted) ten = 0.45;
  if (attacking) ten = 0.55 + (1 - mr.door[1] / mr.door[2]) * 0.35 + (inside ? 0.3 : 0);
  sound.setTension(ten);
  $('#btn-focus').hidden = !p;
  $('#btn-focus').textContent = stage && stage.focusMode !== 'all' ? '全图' : p && p.st === 'bed' ? '我的宿舍' : '跟着我';
}

function costHTML(c, p) {
  if (!c) return '<span class="muted">满级</span>';
  const g = c.g || 0;
  const e = c.e || 0;
  return `<span class="g ${p && p.gold < g ? 'no' : ''}">${fmtN(g)} 金</span>${e ? `<span class="e ${p && p.energy < e ? 'no' : ''}">${e} 电</span>` : ''}`;
}
const afford = (c, p) => c && p && p.gold >= (c.g || 0) && p.energy >= (c.e || 0);

let iconCache = {};
function icon(type, lv = 1, size = 40) {
  const k = `${type}:${lv}:${size}`;
  if (!iconCache[k]) iconCache[k] = iconCanvas(type, lv, size);
  const c = iconCache[k];
  const out = document.createElement('canvas');
  out.width = c.width;
  out.height = c.height;
  out.getContext('2d').drawImage(c, 0, 0);
  return out;
}

function renderDock() {
  const g = S.game;
  const p = me();
  const r = myRoom();
  const el = $('#dock-main');
  const cfg = S.cfg;
  let key;
  let html;
  if (!S.you) {
    key = 'spec';
    html = '<div class="dock-hint">你正在观战</div>';
  } else if (g.phase === 'ended') {
    key = 'end';
    html = '';
  } else if (!p || p.st !== 'bed') {
    key = `claim${Math.ceil(g.prepLeft)}`;
    html = `<div class="dock-hint">点地面走动，点一张<b>空床</b>躺下占房 · ${Math.ceil(g.prepLeft)} 秒后熄灯</div>`;
  } else if (!p.alive || !r || r.dead) {
    key = 'dead';
    html = '<div class="dock-hint">你已经出局了，帮队友看着点……</div>';
  } else {
    const bl = r.bed[0];
    const dl = r.door[0];
    const bc = cfg.BED.cost[bl - 1];
    const dc = cfg.DOOR.cost[dl - 1];
    const bInc = bc ? `收入 ${cfg.BED.income[bl - 1]} → ${cfg.BED.income[bl]}/秒` : `收入 ${cfg.BED.income[bl - 1]}/秒`;
    const doorBroken = r.door[1] <= 0;
    const dTxt = doorBroken ? '门已经被砸烂' : `${fmtN(r.door[1])}/${fmtN(r.door[2])}`;
    key = [bl, dl, afford(bc, p), afford(dc, p), Math.round((r.door[1] / r.door[2]) * 50), doorBroken, bc && p.gold >= bc.g, dc && p.gold >= dc.g].join('|');
    html = `<button class="up ${afford(bc, p) ? 'can' : ''}" data-up="bed" ${bc ? '' : 'disabled'}><span class="ic" data-icon="bed"></span><span class="tx"><b>床 ${bl} 级</b><small>${bInc}</small></span><span class="cost">${costHTML(bc, p)}</span></button>
      <button class="up ${afford(dc, p) && !doorBroken ? 'can' : ''}" data-up="door" ${dc && !doorBroken ? '' : 'disabled'}><span class="ic" data-icon="door"></span><span class="tx"><b>门 ${dl} 级</b><small>${dTxt}</small><span class="hp"><i style="width:${(r.door[1] / r.door[2]) * 100}%"></i></span></span><span class="cost">${doorBroken ? '' : costHTML(dc, p)}</span></button>`;
  }
  if (key === S.dockKey) return;
  S.dockKey = key;
  el.innerHTML = html;
  $$('[data-icon]', el).forEach((s) => s.replaceWith(Object.assign(icon(s.dataset.icon, 1, 36), { className: 'ic' })));
  $$('[data-up]', el).forEach((b) =>
    b.addEventListener('click', () => {
      sound.play('click');
      send('act', { type: b.dataset.up });
    })
  );
}

// ---------------- 点击地图 ----------------
function onTap(hit) {
  sound.unlock();
  const g = S.game;
  if (!g || !S.you || g.phase === 'ended') return;
  const p = me();
  if (!p || !p.alive) return;
  if (!hit) return closeSheet();
  const r = hit.room !== null && hit.room >= 0 ? S.rooms[hit.room] : null;
  // 还没躺下：走路，点床就去躺
  if (p.st !== 'bed') {
    if (g.phase !== 'prep') return;
    if (r && r.owner && hit.room !== p.room) {
      const o = playersMap().get(r.owner);
      return toast(`${hit.room + 1} 号宿舍已经是 ${o ? o.name : '别人'} 的了`, true);
    }
    if (hit.kind === 'furniture') return toast('那里摆着家具');
    let tx = hit.x;
    let ty = hit.y;
    if (hit.kind === 'bed') {
      [tx, ty] = GEO(hit.room).bed.head;
      sound.play('click');
    } else sound.play('step');
    stage.marker = { x: tx, y: ty, t0: performance.now() / 1000 };
    send('act', { type: 'move', x: tx, y: ty });
    return;
  }
  if (hit.room !== p.room) {
    closeSheet();
    const o = r && r.owner ? playersMap().get(r.owner) : null;
    if (o) toast(`${hit.room + 1} 号房：${o.name}`);
    return;
  }
  if (hit.kind !== 'cell') {
    closeSheet();
    if (hit.kind === 'bed') toast('床：在下面升级，收入更高');
    return;
  }
  sound.play('click');
  S.sel = { room: hit.room, cell: hit.cell };
  stage.selected = S.sel;
  S.sheetKey = '';
  renderSheet();
  const sh = $('#sheet');
  if (!sh.hidden && window.innerWidth < 980) {
    const c = GEO(hit.room).cellC ? GEO(hit.room).cellC[hit.cell] : { x: GEO(hit.room).cells[hit.cell][0] + 0.5, y: GEO(hit.room).cells[hit.cell][1] + 0.5 };
    stage.ensureVisible(c.x, c.y, sh.getBoundingClientRect().top);
  }
}

function closeSheet() {
  S.sel = null;
  S.sheetKey = '';
  if (stage) {
    stage.selected = null;
    stage.preview = null;
  }
  $('#sheet').hidden = true;
}

// 某道具第 i 级（从 0 开始）的效果
function effectAt(type, i) {
  const b = S.cfg.BUILD[type];
  const pct = (x) => Math.round(x * 100) + '%';
  switch (type) {
    case 'turret':
    case 'thunder':
    case 'sword':
      return `伤害 ${b.dmg[i]}，每 ${b.cd} 秒一发，射程 ${b.range}`;
    case 'talisman':
      return `伤害 ${b.dmg[i]}，灼烧每秒 ${b.burn[i]}（${b.burnTime} 秒，无视护甲），射程 ${b.range}`;
    case 'trap':
      return `夹一下 ${b.dmg[i]}，定住 ${b.root} 秒，每 ${b.cd} 秒，范围 ${b.range}`;
    case 'bell':
      return `定身 ${b.stun[i]} 秒，每 ${b.cd[i]} 秒摇一次，范围 ${b.range}`;
    case 'lantern':
      return `相邻攻击建筑伤害 +${pct(b.boost[i])}`;
    case 'cat':
      return `每秒 +${b.gold[i]} 金币`;
    case 'altar':
      return `每秒修道具 ${b.heal[i]}，屋里道具耐久 +${pct(b.hpBoost[i])}`;
    case 'frost':
      return `减速 ${pct(b.slow[i])}，范围 ${b.range}`;
    case 'mirror':
      return `反弹 ${pct(b.reflect[i])}`;
    case 'repair':
      return `每秒修门 ${b.heal[i]}`;
    case 'generator':
      return `每秒发电 ${b.energy[i]}`;
  }
  return '';
}
const itemHp = (type, lv) => {
  const H = S.cfg.ITEM_HP;
  return Math.round(H.base * Math.pow(H.grow, lv - 1) * (H.mul[type] || 1));
};
function statLine(type, lv) {
  const b = S.cfg.BUILD[type];
  const next = lv < b.cost.length ? `<br><span class="muted">下一级：${effectAt(type, lv)}</span>` : '';
  return `${effectAt(type, lv - 1)}，耐久 ${itemHp(type, lv)}${next}`;
}

// 道具详情：每一级的花费、效果、耐久
function itemInfoHTML(type) {
  const b = S.cfg.BUILD[type];
  const rows = b.cost
    .map((c, i) => `<tr><td>${i + 1}</td><td class="cost">${costHTML(c)}</td><td>${effectAt(type, i)}</td><td>${itemHp(type, i + 1)}</td></tr>`)
    .join('');
  return `<div class="detail"><span data-icon="${type}" data-size="56"></span><div class="info"><b>${b.name}</b><br>${esc(b.desc)}</div></div>
    <table class="info-table"><tr><th>级</th><th>花费</th><th>效果</th><th>耐久</th></tr>${rows}</table>`;
}
function showItemInfo(type) {
  sound.play('click');
  modal(`${itemInfoHTML(type)}<div class="actions"><button class="btn dark" data-close-modal>知道了</button></div>`);
  $$('#modal-root [data-icon]').forEach((s) => s.replaceWith(icon(s.dataset.icon, 1, 56)));
}
// 道具图鉴（帮助里）
function codexHTML() {
  return `<h4 class="codex-title">道具图鉴 <small>点一项看每级数据</small></h4><ul class="codex">${S.cfg.BUILD_TYPES.map(
    (t) => `<li data-info="${t}"><span data-icon="${t}" data-size="32"></span><b>${S.cfg.BUILD[t].name}</b><small>${esc(S.cfg.BUILD[t].desc)}</small></li>`
  ).join('')}</ul>`;
}
function mountCodex(root) {
  $$('[data-icon]', root).forEach((s) => s.replaceWith(icon(s.dataset.icon, 1, Number(s.dataset.size) || 32)));
  $$('[data-info]', root).forEach((li) => li.addEventListener('click', () => showItemInfo(li.dataset.info)));
}
// 长按（手机）或右键（电脑）显示详情，不触发建造
function bindLongPress(el, type, onTap) {
  let timer = null;
  let long = false;
  el.addEventListener('pointerdown', () => {
    long = false;
    timer = setTimeout(() => {
      long = true;
      if (navigator.vibrate) navigator.vibrate(15);
      showItemInfo(type);
    }, 450);
  });
  const cancel = () => clearTimeout(timer);
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointerleave', cancel);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    cancel();
    long = true;
    showItemInfo(type);
  });
  el.addEventListener('click', () => {
    if (long) return;
    onTap();
  });
}

function renderSheet() {
  const sel = S.sel;
  const r = myRoom();
  const p = me();
  if (!sel || !r || !p || !p.alive || r.dead) return closeSheet();
  const cell = r.cells[sel.cell];
  const cfg = S.cfg;
  const el = $('#sheet');
  let key;
  if (!cell) {
    key = 'b' + BT().map((t) => +afford(cfg.BUILD[t].cost[0], p)).join('');
    stage.preview = null;
  } else if (cell[0] === 'chest') {
    key = 'chest';
    stage.preview = null;
  } else {
    const type = cell[0];
    const c = cfg.BUILD[type].cost[cell[1]];
    key = `d${type}${cell[1]}${afford(c, p)}`;
    stage.preview = type;
  }
  key += sel.cell;
  if (key === S.sheetKey) return;
  S.sheetKey = key;
  el.hidden = false;
  if (!cell) {
    el.innerHTML = `<div class="sheet-head"><b>在这一格建造 <small class="muted">长按看详情</small></b><button class="x" data-close aria-label="关闭">✕</button></div>
      <div class="builds">${BT().map((t) => {
        const b = cfg.BUILD[t];
        const c = b.cost[0];
        return `<button class="bcard ${afford(c, p) ? '' : 'off'}" data-build="${t}" title="${esc(b.desc)}" ${afford(c, p) ? '' : 'aria-disabled="true"'}><span data-icon="${t}"></span><b>${b.name}</b><small>${b.desc}</small><span class="cost">${costHTML(c, p)}</span></button>`;
      }).join('')}</div>`;
  } else if (cell[0] === 'chest') {
    el.innerHTML = `<div class="sheet-head"><b>旧储物柜</b><button class="x" data-close aria-label="关闭">✕</button></div>
      <div class="detail"><span data-icon="chest" data-size="56"></span><div class="info">上一个住在这里的人留下的柜子，门缝里透着光。<br>翻一翻，也许有金币或电池。</div></div>
      <div class="detail-actions"><button class="btn fu" data-open>搜一搜</button></div>`;
  } else {
    const type = cell[0];
    const b = cfg.BUILD[type];
    const lv = cell[1];
    const c = b.cost[lv];
    // 已花费的一半退还
    let spentG = 0;
    let spentE = 0;
    for (let i = 0; i < lv; i++) {
      spentG += b.cost[i].g || 0;
      spentE += b.cost[i].e || 0;
    }
    el.innerHTML = `<div class="sheet-head"><b>${b.name} · ${lv} 级</b><button class="x" data-close aria-label="关闭">✕</button></div>
      <div class="detail"><span data-icon="${type}" data-lv="${lv}" data-size="56"></span><div class="info">${b.desc}<br>${statLine(type, lv)}</div></div>
      <div class="detail-actions">
        <button class="btn dark small" data-more="${type}">每级数据</button>
        <button class="btn dark" data-sell>拆掉 <small>+${Math.floor(spentG * cfg.SELL_RATE)} 金${spentE ? ` +${Math.floor(spentE * cfg.SELL_RATE)} 电` : ''}</small></button>
        <button class="btn fu" data-upgrade ${c && afford(c, p) ? '' : 'disabled'}>${c ? `升级 ${costHTML(c)}` : '已满级'}</button>
      </div>`;
  }
  $$('[data-icon]', el).forEach((s) => s.replaceWith(icon(s.dataset.icon, Number(s.dataset.lv) || 1, Number(s.dataset.size) || 40)));
  $$('[data-build]', el).forEach((btn) =>
    bindLongPress(btn, btn.dataset.build, () => {
      if (btn.classList.contains('off')) {
        sound.play('error');
        return toast('还买不起，长按可以看详情', true);
      }
      send('act', { type: 'build', cell: sel.cell, btype: btn.dataset.build });
      S.sheetKey = '';
    })
  );
  const more = $('[data-more]', el);
  if (more) more.addEventListener('click', () => showItemInfo(more.dataset.more));
  const op = $('[data-open]', el);
  if (op)
    op.addEventListener('click', () => {
      send('act', { type: 'open', cell: sel.cell });
      closeSheet();
    });
  const up = $('[data-upgrade]', el);
  if (up) up.addEventListener('click', () => send('act', { type: 'upgrade', cell: sel.cell }));
  const sell = $('[data-sell]', el);
  if (sell)
    sell.addEventListener('click', () => {
      if (sell.dataset.confirm) {
        send('act', { type: 'sell', cell: sel.cell });
        closeSheet();
      } else {
        sell.dataset.confirm = '1';
        sell.innerHTML = '再点一次确认拆除';
      }
    });
  $('[data-close]', el).addEventListener('click', closeSheet);
}

function renderPlayers() {
  if (!S.room) return;
  const pm = playersMap();
  const g = S.game;
  $('#plist').innerHTML = [...pm.values()]
    .map((p) => {
      const dead = g && p.alive === false;
      const room = p.room !== null && p.room !== undefined ? `${p.room + 1} 号房` : '未入住';
      const tag = p.isBot ? BOT_TAG[p.bot] : p.autoBot ? '电脑代管' : p.connected ? '' : '离线';
      return `<li class="${dead ? 'dead' : ''}"><span class="dot" style="background:${p.color}"></span><span class="nm">${esc(p.name)}${p.id === S.you ? '（你）' : ''}</span><small>${tag ? tag + ' · ' : ''}${room}</small></li>`;
    })
    .join('');
}

function showEnd() {
  const g = S.game;
  if (!g || g.phase !== 'ended' || document.body.dataset.screen !== 'game') return;
  S.endShownFor = S.gameId;
  const pm = playersMap();
  const win = g.result && g.result.win;
  const title = win ? (g.result.reason === 'ghostDead' ? '猛鬼伏诛' : '天亮了') : '无人生还';
  const sub = win ? (g.result.reason === 'ghostDead' ? '你们亲手送走了它。' : '第一缕阳光照进走廊，猛鬼退散。') : '宿舍楼又安静了下来。';
  const rows = [...g.players]
    .sort((a, b) => b.alive - a.alive || b.dmg - a.dmg)
    .map((p) => {
      const info = pm.get(p.id) || {};
      return `<tr><td><span style="color:${info.color}">●</span> ${esc(info.name)}${p.id === S.you ? '（你）' : ''}</td><td class="${p.alive ? 'win' : 'lose'}">${p.alive ? '活着' : '遇难'}</td><td>${p.room !== null ? p.room + 1 + ' 号' : '-'}</td><td>${fmtN(p.dmg)}</td></tr>`;
    })
    .join('');
  const isHost = S.you && S.room && S.you === S.room.host;
  const el = $('#end');
  el.hidden = false;
  el.innerHTML = `<div class="end-card ${win ? 'win' : 'lose'}"><h2>${title}</h2><p class="muted">${sub} 猛鬼最终 ${g.ghost.lv} 级，${S.cfg.DIFFICULTY[g.diff].name}难度。</p>
    <table><tr><th>住户</th><th>结果</th><th>宿舍</th><th>对猛鬼伤害</th></tr>${rows}</table>
    <div class="end-actions">${isHost ? '<button class="btn fu" id="btn-again">回到房间，再来一夜</button>' : '<span class="muted">等房主开下一局…</span>'}
    <button class="btn dark" id="btn-view">看看战场</button><button class="btn ghost" id="btn-quit">离开</button></div></div>`;
  const again = $('#btn-again');
  if (again) again.addEventListener('click', () => send('backToLobby'));
  $('#btn-view').addEventListener('click', () => (el.hidden = true));
  $('#btn-quit').addEventListener('click', () => send('leave'));
}

// ======================= 聊天 =======================
function addChat(m) {
  S.chat.push(m);
  if (S.chat.length > 120) S.chat.shift();
  renderChat();
  if (document.body.dataset.screen === 'game' && $('#drawer').hidden && !m.sys) {
    S.unread++;
    $('#chat-badge').hidden = false;
    $('#chat-badge').textContent = S.unread;
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
  const name = d.gameName || '卡坦岛';
  card.innerHTML = `<div><b>${esc(d.from)}</b> 邀请你玩${esc(name)}「${esc(d.title)}」<small>${esc(d.detail || '')}，已有 ${d.players} / ${d.max} 人</small></div>
    <div class="ic-btns"><button class="btn ghost small ic-no">忽略</button><button class="btn fu small ic-yes">去</button></div><i class="ic-timer"></i>`;
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
    if ((d.game || 'catan') === 'dorm') send('join', { code: d.code });
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
  })
);
$('#btn-create').addEventListener('click', () => {
  sound.unlock();
  send('create', { diff: S.homeDiff, title: $('#create-title').value, private: $('#create-private').checked });
});
$('#join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('#join-code').value.trim().toUpperCase();
  if (code) send('join', { code });
});
$('#btn-leave-lobby').addEventListener('click', () => send('leave'));
$('#lobby-code').addEventListener('click', async () => {
  const link = `${location.origin}/dorm/?room=${S.room.code}`;
  try {
    await navigator.clipboard.writeText(link);
    toast('邀请链接已复制');
  } catch {
    toast(link);
  }
});
$$('[data-bot]').forEach((b) => b.addEventListener('click', () => send('addBot', { level: b.dataset.bot })));
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
  soundModal(`<div class="actions" style="justify-content:flex-start;margin-bottom:10px;flex-wrap:wrap"><button class="btn dark" id="m-help">怎么玩</button><button class="btn dark" id="m-leave">离开对局</button></div>`);
  $('#m-leave').addEventListener('click', () => {
    closeModal();
    send('leave');
  });
  $('#m-help').addEventListener('click', () => {
    modal(`<h3>怎么玩</h3><div class="help">${$('[data-pane="help"] ol').outerHTML}${codexHTML()}</div><div class="actions"><button class="btn dark" data-close-modal>知道了</button></div>`);
    mountCodex($('#modal-root'));
  });
});
$('#btn-chat').addEventListener('click', () => {
  const d = $('#drawer');
  d.hidden = !d.hidden;
  S.unread = 0;
  $('#chat-badge').hidden = true;
  renderPlayers();
  const c = $('#game-chat');
  c.scrollTop = c.scrollHeight;
});
$('[data-close-drawer]').addEventListener('click', () => ($('#drawer').hidden = true));
$('#btn-focus').addEventListener('click', () => {
  if (!stage) return;
  stage.userFocused = true;
  stage.manual = false;
  const p = me();
  stage.setFocus(stage.focusMode !== 'all' ? 'all' : p && p.st === 'bed' ? 'room' : 'me');
  renderHud();
});

// 键盘：B 升床、D 升门、F 切换视角、U 升级选中建筑、1–6 在选中格建造、Esc 关闭
window.addEventListener('keydown', (e) => {
  if (e.target.closest('input')) return;
  if (document.body.dataset.screen !== 'game' || !S.game) return;
  const k = e.key.toLowerCase();
  if (k === 'd' && me() && me().st !== 'bed') return walkKey('x');
  if (k === 'escape') {
    closeSheet();
    closeModal();
    $('#drawer').hidden = true;
  } else if (k === 'b') send('act', { type: 'bed' });
  else if (k === 'd') send('act', { type: 'door' });
  else if (k === 'f') $('#btn-focus').click();
  else if (k === 'u' && S.sel) send('act', { type: 'upgrade', cell: S.sel.cell });
  else if (/^[1-9]$/.test(k) && S.sel) send('act', { type: 'build', cell: S.sel.cell, btype: BT()[Number(k) - 1] });
  else if (['w', 'a', 's', 'x', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) walkKey(k);
});

// 键盘走路（准备阶段）：每按一下 / 按住时朝那个方向走一格
let walkTimer = 0;
function walkKey(k) {
  const p = me();
  if (!p || p.st === 'bed' || S.game.phase !== 'prep' || Date.now() - walkTimer < 140) return;
  walkTimer = Date.now();
  const [dx, dy] = { w: [0, -1], arrowup: [0, -1], s: [0, 1], arrowdown: [0, 1], a: [-1, 0], arrowleft: [-1, 0], x: [1, 0], arrowright: [1, 0] }[k];
  // 竖屏时地图是转置的
  const [wx, wy] = stage && stage.T ? [dy, dx] : [dx, dy];
  send('act', { type: 'move', x: Math.floor(p.x) + wx, y: Math.floor(p.y) + wy });
}

// 首次触碰时解锁声音
window.addEventListener('pointerdown', () => sound.unlock(), { once: false, passive: true });
document.addEventListener('visibilitychange', () => {
  if (!sound.ctx) return;
  if (document.hidden) sound.ctx.suspend();
  else sound.ctx.resume();
});

// ======================= 启动 =======================
(async () => {
  try {
    S.cfg = await api('/api/dorm/config');
    const pane = $('[data-pane="help"]');
    pane.insertAdjacentHTML('beforeend', codexHTML());
    mountCodex(pane);
  } catch {
    toast('暂时连不上服务器，请稍后刷新', true);
    return;
  }
  connect();
})();
