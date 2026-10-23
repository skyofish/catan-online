import { sound } from './audio.js';
import { BoardView, IND_NAME, ROMAN, REGION_COLOR, MERCHANT_TYPE, isLight } from './board.js';
import * as fx from './fx.js';
import { Coach } from './tutorial.js';
import { Voice } from '/catan/js/voice.js';
import { getSession, takeHashSession, api as platformApi, upgradeToHttps, goToLogin, wsUrl } from '/js/session.js';
import { initFullscreen } from '/js/fullscreen.js';

initFullscreen();

// ======================= 基础 =======================
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const COLORS = ['#b8322a', '#2c5f8d', '#d29b1c', '#3b7a4a', '#7a4b8f', '#5b6770'];
const LEVEL_TAG = { easy: '学徒', normal: '工头', hard: '大亨', ai: 'AI' };
const CARD_IND = { iron: ['iron'], coal: ['coal'], brewery: ['brewery'], pottery: ['pottery'], cg: ['cotton', 'goods'] };
const CARD_IND_NAME = { iron: '炼铁厂', coal: '煤矿', brewery: '酿酒厂', pottery: '陶瓷厂', cg: '棉纺 / 制造' };
const IND_LIST = ['cotton', 'goods', 'pottery', 'brewery', 'coal', 'iron'];
const ACT = {
  build: { name: '建造', icon: 'a-build', key: 'B' },
  network: { name: '网络', icon: 'a-network', key: 'N' },
  develop: { name: '开发', icon: 'a-develop', key: 'D' },
  sell: { name: '出售', icon: 'a-sell', key: 'S' },
  loan: { name: '贷款', icon: 'a-loan', key: 'L' },
  scout: { name: '侦察', icon: 'a-scout', key: '' },
  pass: { name: '跳过', icon: 'a-pass', key: '' },
};
const icon = (id, cls = '') => `<svg class="ico ${cls}" viewBox="0 0 32 32" aria-hidden="true"><use href="#${id}"/></svg>`;
const sicon = (id, cls = '') => `<svg class="ico ${cls}" viewBox="0 0 20 20" aria-hidden="true"><use href="#${id}"/></svg>`;
const aicon = (id) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><use href="#${id}"/></svg>`;
const money = (n) => `£${n}`;
const signed = (n) => (n > 0 ? `+${n}` : `${n}`);

takeHashSession();
if (!getSession()) goToLogin();

const S = {
  ws: null,
  session: getSession(),
  user: null,
  room: null,
  you: null,
  game: null,
  map: null,
  gameId: null,
  chat: [],
  unread: 0,
  rightTab: 'log',
  homeTab: 'rooms',
  queue: Promise.resolve(),
  flow: null,
  selCard: null,
  connected: false,
  retry: 0,
  overShown: false,
  seenSlots: new Set(),
  lastLogId: 0,
  hint: null,
};
window.__S = S;
window.__send = (t, d) => send(t, d);
const voice = new Voice({ send: (t, d) => S.ws && S.ws.readyState === 1 && S.ws.send(JSON.stringify({ t, d })), onChange: () => renderVoice(), toast: (m, k) => toast(m, k) });

// ======================= 网络 =======================
function connect() {
  const ws = new WebSocket(wsUrl('/brass/ws'));
  S.ws = ws;
  ws.onopen = () => {
    S.connected = true;
    S.retry = 0;
    document.body.classList.remove('offline');
    send('hello', { session: S.session });
  };
  ws.onmessage = (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    onMessage(m.t, m.d);
  };
  ws.onclose = () => {
    S.connected = false;
    document.body.classList.add('offline');
    setTimeout(connect, Math.min(8000, 500 * 2 ** S.retry++));
  };
}
function send(t, d = {}) {
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify({ t, d }));
  else toast('连接中断，正在重连…', 'warn');
}
function act(type, data = {}) {
  sound.play('click');
  send('act', { type, ...data });
}
async function api(path, opts) {
  try {
    return await platformApi(path, opts);
  } catch (e) {
    if (e.status === 401) signedOut();
    throw e;
  }
}
function signedOut(reason) {
  voice.leave();
  S.session = null;
  goToLogin(reason);
}

function onMessage(t, d) {
  switch (t) {
    case 'hello': {
      S.user = d.user;
      $('#me-name').textContent = d.user.username;
      const params = new URLSearchParams(location.search);
      const code = params.get('room') || sessionStorage.getItem('brass.room');
      if (params.get('tutorial') === '1' && !code) send('tutorial');
      else if (code) send('join', { code });
      else showScreen('home');
      send('list');
      break;
    }
    case 'auth':
      signedOut();
      break;
    case 'kicked':
      signedOut(d.reason);
      break;
    case 'rooms':
      renderRoomList(d);
      break;
    case 'voice':
      voice.handleRoster(d);
      break;
    case 'rtc':
      voice.handleSignal(d);
      break;
    case 'voiceToken':
      voice.agoraRenew(d);
      break;
    case 'online':
      renderOnline(d);
      break;
    case 'invite':
      showInvite(d);
      break;
    case 'room':
      S.queue = S.queue.then(() => applyRoom(d)).catch((e) => console.error(e));
      break;
    case 'chatHistory':
      S.chat = d || [];
      renderChat();
      break;
    case 'chat':
      S.chat.push(d);
      if (S.chat.length > 150) S.chat.shift();
      renderChat();
      if (!d.sys && d.pid !== S.you) {
        sound.play('chat');
        if (S.rightTab !== 'chat') {
          S.unread++;
          renderTabs();
        }
        if (d.pid) chatBubble(d);
      }
      break;
    case 'hint':
      showHint(d);
      break;
    case 'error':
      toast(d.msg, 'error');
      sound.play('error');
      if (/房间不存在|别人的教程/.test(d.msg)) {
        sessionStorage.removeItem('brass.room');
        history.replaceState(null, '', location.pathname);
        showScreen('home');
      }
      break;
    case 'toast':
      toast(d.msg);
      break;
    case 'left':
      voice.leave();
      coach.stop();
      S.room = null;
      S.game = null;
      S.gameId = null;
      S.flow = null;
      sessionStorage.removeItem('brass.room');
      history.replaceState(null, '', location.pathname);
      if (d && d.kicked) toast('你被房主移出了房间', 'warn');
      closeModal();
      closeSheet();
      showScreen('home');
      send('list');
      break;
  }
}

// ======================= 屏幕 =======================
function showScreen(name) {
  for (const s of $$('.screen')) s.hidden = s.id !== `screen-${name}`;
  document.body.dataset.screen = name;
  if (name === 'home') {
    drawSkyline();
    refreshHomeTab();
  }
}

// ---------- 首页：工业城天际线 ----------
function drawSkyline() {
  const svg = $('#skyline');
  if (!svg || svg.dataset.done) return;
  svg.dataset.done = '1';
  let rnd = 7;
  const r = () => ((rnd = (rnd * 9301 + 49297) % 233280) / 233280);
  let back = '';
  let front = '';
  let smoke = '';
  let lights = '';
  for (let x = -20; x < 1620; ) {
    const w = 60 + r() * 120;
    const h = 90 + r() * 160;
    back += `<rect x="${x}" y="${600 - h - 60}" width="${w}" height="${h + 60}" fill="#3b2a26"/>`;
    if (r() < 0.6) {
      const cx = x + w * (0.2 + r() * 0.6);
      const ch = 80 + r() * 120;
      back += `<rect x="${cx}" y="${600 - h - 60 - ch}" width="${10 + r() * 8}" height="${ch}" fill="#3b2a26"/>`;
    }
    x += w + 10;
  }
  for (let x = -40; x < 1640; ) {
    const w = 120 + r() * 160;
    const h = 60 + r() * 110;
    const y = 600 - h;
    // 锯齿屋顶的厂房
    let roof = '';
    const teeth = Math.max(2, Math.floor(w / 40));
    for (let k = 0; k < teeth; k++) {
      const x0 = x + (k * w) / teeth;
      const x1 = x + ((k + 1) * w) / teeth;
      roof += `L${x0} ${y} L${x1} ${y - 26} L${x1} ${y}`;
    }
    front += `<path d="M${x} 600 ${roof} L${x + w} 600 Z" fill="#1c120e"/>`;
    for (let k = 0; k < Math.floor(w / 26); k++) if (r() < 0.55) lights += `<rect class="win" style="animation-delay:${(r() * 6).toFixed(1)}s" x="${x + 10 + k * 26}" y="${y + 18 + (k % 2) * 22}" width="9" height="12" fill="#ffc861"/>`;
    if (r() < 0.75) {
      const cx = x + w * (0.15 + r() * 0.7);
      const ch = 120 + r() * 150;
      front += `<rect x="${cx}" y="${y - ch}" width="${14 + r() * 8}" height="${ch}" fill="#1c120e"/><rect x="${cx - 3}" y="${y - ch}" width="${20 + r() * 8}" height="6" fill="#1c120e"/>`;
      for (let k = 0; k < 4; k++) smoke += `<circle class="sk-puff" style="animation-delay:${(k * 1.6 + r() * 2).toFixed(1)}s" cx="${cx + 9}" cy="${y - ch - 6}" r="${14 + r() * 10}"/>`;
    }
    x += w + 20 + r() * 40;
  }
  svg.innerHTML = `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1e1520"/><stop offset=".55" stop-color="#5e2f22"/><stop offset=".85" stop-color="#b8643a"/><stop offset="1" stop-color="#e9a04f"/></linearGradient><linearGradient id="haze" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b8643a" stop-opacity="0"/><stop offset="1" stop-color="#7a3a22" stop-opacity=".55"/></linearGradient></defs>
    <rect width="1600" height="600" fill="url(#sky)"/><circle cx="1180" cy="430" r="80" fill="#ffcf82" opacity=".35"/>
    <g class="sk-smoke">${smoke}</g>${back}${front}${lights}
    <path d="M0 596 H1600" stroke="#2a1a12" stroke-width="10"/>
    <g class="sk-train"><rect x="0" y="560" width="90" height="26" rx="3" fill="#120c09"/><rect x="66" y="542" width="22" height="20" fill="#120c09"/><rect x="14" y="544" width="12" height="18" fill="#120c09"/><rect x="96" y="566" width="80" height="20" rx="2" fill="#120c09"/><rect x="182" y="566" width="80" height="20" rx="2" fill="#120c09"/><g fill="#ffc861" opacity=".8"><rect x="106" y="570" width="10" height="7"/><rect x="126" y="570" width="10" height="7"/><rect x="146" y="570" width="10" height="7"/><rect x="192" y="570" width="10" height="7"/><rect x="212" y="570" width="10" height="7"/><rect x="232" y="570" width="10" height="7"/></g></g>`;
}

function initHome() {
  $('#btn-tutorial').addEventListener('click', () => {
    sound.unlock();
    sound.play('join');
    send('tutorial');
  });
  $('#btn-create').addEventListener('click', () => {
    sound.unlock();
    send('create', { intro: $('#opt-intro').checked, private: $('#opt-private').checked });
  });
  const join = () => {
    sound.unlock();
    const code = $('#join-code').value.trim().toUpperCase();
    if (code.length < 4) return toast('请输入房间号', 'warn');
    send('join', { code });
  };
  $('#btn-join').addEventListener('click', join);
  $('#join-code').addEventListener('keydown', (e) => e.key === 'Enter' && join());
  $('#btn-refresh').addEventListener('click', () => refreshHomeTab(true));
  $$('[data-htab]').forEach((b) =>
    b.addEventListener('click', () => {
      sound.play('click');
      S.homeTab = b.dataset.htab;
      refreshHomeTab(true);
    })
  );
  setInterval(() => document.body.dataset.screen === 'home' && S.connected && S.homeTab === 'rooms' && send('list'), 5000);
}
function refreshHomeTab(force) {
  $$('[data-htab]').forEach((b) => b.setAttribute('aria-selected', b.dataset.htab === S.homeTab));
  for (const t of ['rooms', 'rank', 'mine']) $(`#htab-${t}`).hidden = t !== S.homeTab;
  if (!S.session) return;
  if (S.homeTab === 'rooms') {
    if (force && S.connected) send('list');
  } else if (S.homeTab === 'rank') loadRank();
  else loadMine();
}
const fmtDate = (t) => {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const pct = (w, g) => (g ? Math.round((w / g) * 100) + '%' : '—');
async function loadRank() {
  const box = $('#htab-rank');
  if (!box.innerHTML) box.innerHTML = '<p class="empty">加载中…</p>';
  try {
    const { rows } = await api('/api/brass/leaderboard');
    if (!rows.length) {
      box.innerHTML = '<p class="empty">还没有完成的对局。打完第一局，这里就会出现排名。</p>';
      return;
    }
    box.innerHTML = `<table class="rank-table"><thead><tr><th>名次</th><th>工厂主</th><th>胜 / 局</th><th>胜率</th><th>平均分</th></tr></thead>
      <tbody>${rows.map((r, i) => `<tr class="${S.user && r.id === S.user.id ? 'me' : ''}"><td class="rk">${i + 1}</td><td class="nm">${esc(r.username)}</td><td>${r.wins} / ${r.games}</td><td>${pct(r.wins, r.games)}</td><td>${r.avg_vp}</td></tr>`).join('')}</tbody></table>`;
  } catch (e) {
    box.innerHTML = `<p class="empty">${esc(e.message)}</p>`;
  }
}
async function loadMine() {
  const box = $('#htab-mine');
  if (!box.innerHTML) box.innerHTML = '<p class="empty">加载中…</p>';
  try {
    const { stats, recent } = await api('/api/brass/me');
    const g = stats.games || 0;
    box.innerHTML = `<dl class="my-stats"><div><dt>对局</dt><dd>${g}</dd></div><div><dt>胜场</dt><dd>${stats.wins || 0}</dd></div><div><dt>胜率</dt><dd>${pct(stats.wins, g)}</dd></div><div><dt>平均分</dt><dd>${stats.avg_vp ?? '—'}</dd></div></dl>
      ${recent.length ? `<h3>最近对局</h3><ul class="recent">${recent.map((m) => `<li class="${m.is_winner ? 'won' : ''}"><span class="rc-rank">${m.is_winner ? '胜' : `第 ${m.rank}`}</span><span class="rc-main">${m.size} 人局${m.target_vp ? '（入门短局）' : ''}，${m.turns} 轮<small>${fmtDate(m.ended_at)}${m.is_winner ? '' : `，${esc(m.winner || '')} 获胜`}</small></span><span class="rc-vp">${m.vp} 分</span></li>`).join('')}</ul>` : '<p class="empty">你还没有完成过对局。不妨先试试新手教程。</p>'}`;
  } catch (e) {
    box.innerHTML = `<p class="empty">${esc(e.message)}</p>`;
  }
}
function renderRoomList(list) {
  const box = $('#room-list');
  if (!box) return;
  if (!list.length) {
    box.innerHTML = '<p class="empty">还没有公开房间。创建一个，把链接发给朋友吧。</p>';
    return;
  }
  box.innerHTML = list
    .map(
      (r) => `<button class="room-row ${r.mine ? 'mine' : ''}" data-code="${r.code}">
      <span class="rr-title">${esc(r.title)}</span>
      <span class="rr-meta">${r.tutorial ? '教程' : r.started ? (r.era === 'rail' ? '铁路时代' : '运河时代') : r.intro ? '入门短局' : '等待开始'}</span>
      <span class="rr-count">${r.players}/${r.max}</span>
      <span class="rr-state ${r.started && !r.mine ? 'on' : ''}">${r.mine ? (r.ended ? '查看' : '回到对局') : r.ended ? '已结束' : r.started ? '观战' : '加入'}</span></button>`
    )
    .join('');
  $$('.room-row', box).forEach((b) => b.addEventListener('click', () => (sound.unlock(), send('join', { code: b.dataset.code }))));
}

// ======================= 房间 =======================
async function applyRoom(d) {
  const prevRoom = S.room;
  S.room = d.room;
  S.you = d.you;
  sessionStorage.setItem('brass.room', d.room.code);
  if (new URLSearchParams(location.search).get('room') !== d.room.code) history.replaceState(null, '', `?room=${d.room.code}`);
  if (!d.game) {
    S.game = null;
    S.gameId = null;
    S.overShown = false;
    if (prevRoom && prevRoom.players.length < d.room.players.length) sound.play('join');
    showScreen('lobby');
    renderLobby();
    startOnlinePolling();
    coach.stop();
    return;
  }
  const fresh = S.gameId !== d.room.gameId || !S.map;
  if (d.game.map) S.map = d.game.map;
  const prev = S.game;
  const events = d.events || [];
  if (document.body.dataset.screen !== 'game') {
    showScreen('game');
    S.flow = null;
  }
  if (fresh) {
    S.gameId = d.room.gameId;
    S.overShown = false;
    S.lastLogId = 0;
    board.setMap(S.map);
    if (events.some((e) => e.type === 'start')) {
      sound.play('join');
      fx.banner('工业革命：伯明翰', '运河时代 · 1770', '#c8963e', { big: true, dur: 2400 });
    }
  }
  sound.setEra(d.game.era);
  if (fresh && d.room.tutorial) coach.attach(S, { send, board, act, openFlow: startFlow });
  else if (!d.room.tutorial) coach.stop();

  // 时代结束：先在旧地图上计分、拆除，再切到新时代
  const eraEnd = events.find((e) => e.type === 'eraEnd');
  if (eraEnd && prev && !document.hidden) await playEraEnd(eraEnd, prev, d.game, events);

  const order0 = prev ? playerRects() : null;
  S.game = d.game;
  if (S.flow && !flowValid()) closeSheet();
  if (S.selCard && !(me() && me().hand && me().hand.some((c) => c.id === S.selCard))) S.selCard = null;
  if (S.hint && !isMyTurn()) S.hint = null;
  renderGame();
  if (order0 && events.some((e) => e.type === 'roundEnd')) flipPlayers(order0);
  if (!document.hidden) playEvents(events, prev);
  else if (events.some((e) => e.type === 'win')) setTimeout(showGameOver, 300);
  coach.onUpdate(events);
}

function renderLobby() {
  const r = S.room;
  const isHost = r.host === S.you;
  const meP = r.players.find((p) => p.id === S.you);
  $('#lobby-title').textContent = r.title;
  $('#lobby-code').textContent = r.code;
  $('#lobby-link').value = `${location.origin}${location.pathname}?room=${r.code}`;
  const slots = [];
  for (let i = 0; i < r.max; i++) {
    const p = r.players[i];
    if (!p) {
      slots.push(`<li class="slot empty"><span class="chip"></span><span class="pn">空位：等待工厂主加入…</span></li>`);
      continue;
    }
    const isNew = !S.seenSlots.has(p.id);
    S.seenSlots.add(p.id);
    slots.push(`<li class="slot ${p.id === S.you ? 'me' : ''} ${p.connected ? '' : 'off'} ${isNew ? 'new' : ''}" data-pid="${p.id}">
      <span class="chip" style="--pc:${p.color}"></span>
      <span class="pn">${esc(p.name)}${p.id === r.host ? '<em class="tag host">房主</em>' : ''}${p.id === S.you ? '<em class="tag">你</em>' : ''}${p.isBot ? `<em class="tag ${p.bot === 'ai' ? 'ai' : ''}">${LEVEL_TAG[p.bot] || '电脑'}</em>` : ''}${p.connected ? '' : '<em class="tag off">离线</em>'}<span class="vmic" title="麦克风已打开"></span></span>
      ${isHost && p.id !== r.host ? `<button class="mini ghost" data-kick="${p.id}">移出</button>` : ''}</li>`);
  }
  $('#lobby-players').innerHTML = slots.join('');
  $$('[data-kick]').forEach((b) => b.addEventListener('click', () => send('kick', { pid: b.dataset.kick })));
  $('#lobby-count').textContent = `${r.players.length} / ${r.max}（2–4 人）`;
  const used = new Set(r.players.filter((p) => p.id !== S.you).map((p) => p.color));
  $('#lobby-colors').innerHTML = meP
    ? COLORS.map((c) => `<button class="swatch" style="--pc:${c}" data-color="${c}" aria-pressed="${meP.color === c}" ${used.has(c) ? 'disabled' : ''} aria-label="选择颜色"></button>`).join('')
    : '<span class="muted">观战中</span>';
  $$('[data-color]').forEach((b) => b.addEventListener('click', () => send('color', { color: b.dataset.color })));
  $('#bot-row').hidden = !isHost;
  $$('#bot-row [data-bot]').forEach((b) => (b.disabled = r.players.length >= r.max));
  $('#bot-row .ai-btn').hidden = !r.aiAvailable;
  $('#lobby-intro').checked = r.intro;
  $('#lobby-intro').disabled = !isHost;
  $('#btn-start').hidden = !isHost;
  $('#btn-start').disabled = r.players.length < 2;
  $('#lobby-wait').hidden = isHost;
  $('#lobby-wait').textContent = meP ? '等待房主开始游戏…' : '房间已满，你正在观战。';
  renderVoice();
}
function initLobby() {
  $('#btn-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#lobby-link').value);
    } catch {
      $('#lobby-link').select();
      document.execCommand('copy');
    }
    toast('邀请链接已复制');
    sound.play('coins', 2);
  });
  $$('#bot-row [data-bot]').forEach((b) => b.addEventListener('click', () => (sound.play('click'), send('addBot', { level: b.dataset.bot }))));
  $('#btn-start').addEventListener('click', () => (sound.unlock(), send('start')));
  $('#btn-leave-lobby').addEventListener('click', () => send('leave'));
  $('#lobby-intro').addEventListener('change', (e) => send('settings', { intro: e.target.checked }));
}

// ======================= 游戏渲染 =======================
const board = new BoardView($('#board'), { inspect: (t, e) => inspect(t, e) });
const coach = new Coach();

const me = () => S.game && S.game.players.find((p) => p.id === S.you);
const P = (pid) => S.game && S.game.players.find((p) => p.id === pid);
const pname = (pid) => (P(pid) ? P(pid).name : '?');
const pcolor = (pid) => (P(pid) ? P(pid).color : '#999');
const HOT = '#ffcf4a';
const isMyTurn = () => S.game && S.game.phase !== 'ended' && S.game.turn === S.you && !!S.game.me;
const placeName = (id) => {
  if (!S.map) return id;
  const l = S.map.locs.find((x) => x.id === id) || S.map.merchants.find((x) => x.id === id);
  return l ? l.name : id;
};
const linkName = (id) => {
  const l = S.map.links.find((x) => x.id === id);
  return l ? (l.via ? [l.a, l.via, l.b] : [l.a, l.b]).map(placeName).join('—') : id;
};
const tileName = (ind, lv) => `${ROMAN[lv]}级${IND_NAME[ind]}`;
const T = (ind, lv) => S.map.tiles[ind][lv];
const cardName = (c) => (c.k === 'loc' ? placeName(c.v) : c.k === 'ind' ? CARD_IND_NAME[c.v] : c.k === 'wloc' ? '万能地点' : '万能产业');
const colorsMap = () => Object.fromEntries(S.game.players.map((p) => [p.id, p.color]));

function renderGame() {
  const g = S.game;
  board.update(g, { me: S.you, colors: colorsMap() });
  renderHud();
  renderPlayers();
  renderHand();
  renderActions();
  renderLog();
  renderHot();
  document.body.classList.toggle('my-turn', isMyTurn());
  document.body.classList.toggle('era-rail', g.era === 'rail');
}

function renderHud() {
  const g = S.game;
  const era = g.era === 'canal' ? '运河时代' : '铁路时代';
  $('#era-chip').innerHTML = `<b>${era}</b><span>第 ${g.round} 轮 · 约剩 ${g.roundsLeft} 轮</span><span class="deck" title="牌堆剩余">${sicon('i-card')}${g.deck}</span>`;
  $('#era-chip').className = `era-chip ${g.era}`;
  let st = '';
  if (g.phase === 'ended') st = `🏆 ${esc(pname(g.winner))} 获胜！`;
  else if (isMyTurn()) st = `<b>轮到你</b>：还有 <em class="pips">${'●'.repeat(g.actionsLeft)}</em> 个行动`;
  else st = `等待 <b style="color:${pcolor(g.turn)}">${esc(pname(g.turn))}</b> 行动${S.room.thinking === g.turn ? '（思考中…）' : ''}`;
  $('#status').innerHTML = st;
  $('#status').style.setProperty('--pc', pcolor(g.turn));
}

function playerRects() {
  const out = {};
  for (const el of $$('#players .pl')) out[el.dataset.pid] = el.getBoundingClientRect();
  return out;
}
// 行动顺序变化时，玩家卡片滑到新位置
function flipPlayers(before) {
  for (const el of $$('#players .pl')) {
    const a = before[el.dataset.pid];
    if (!a) continue;
    const b = el.getBoundingClientRect();
    const dy = a.top - b.top;
    const dx = a.left - b.left;
    if (!dx && !dy) continue;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0,0)' }], { duration: 700, easing: 'cubic-bezier(.3,1.2,.4,1)' });
  }
}

function renderPlayers() {
  const g = S.game;
  $('#players').innerHTML = g.order
    .map((pid, i) => {
      const p = P(pid);
      const room = S.room.players.find((x) => x.id === p.id) || {};
      const active = g.turn === p.id && g.phase !== 'ended';
      const dt = p.discardTop;
      return `<li data-pid="${p.id}" id="pl-${p.id}" class="pl ${active ? 'active' : ''} ${p.id === S.you ? 'me' : ''} ${room.connected === false ? 'off' : ''} ${g.winner === p.id ? 'winner' : ''}" style="--pc:${p.color}">
        <div class="pl-top">
          <span class="ord" title="本轮行动顺序">${i + 1}</span>
          <span class="chip"></span>
          <span class="pl-name">${esc(p.name)}</span><span class="vmic" title="麦克风已打开"></span>
          ${room.isBot ? `<em class="tag ${room.bot === 'ai' ? 'ai' : ''}">${LEVEL_TAG[room.bot] || '电脑'}</em>` : ''}${S.room.thinking === p.id ? '<em class="tag thinking">思考中</em>' : ''}${room.autoBot ? '<em class="tag off">代管</em>' : ''}${room.connected === false && !room.autoBot ? '<em class="tag off">离线</em>' : ''}
          <span class="vp" title="胜利分">${p.vp}<small>分</small></span>
        </div>
        <div class="pl-stats">
          <span class="st money" title="现金">${sicon('i-coin')}<b>${p.money}</b></span>
          <span class="st inc ${p.income < 0 ? 'neg' : ''}" title="收入等级（每轮结束时领取）">${sicon('i-income')}<b>${signed(p.income)}</b></span>
          <span class="st" title="本轮已花费（花得少的下轮先行动）">花 £${p.spent}</span>
          <span class="st" title="手牌">${sicon('i-card')}${p.handCount}</span>
          <span class="st" title="剩余线路板块">${g.era === 'canal' ? sicon('i-boat') : sicon('i-train')}${p.linksLeft}</span>
        </div>
        <div class="inc-track" title="收入轨位置 ${p.incomePos}"><i style="width:${(p.incomePos / 99) * 100}%"></i></div>
        ${dt ? `<div class="pl-discard" title="最近弃掉的牌">弃：${esc(cardName(dt))}</div>` : ''}
        ${S.room.host === S.you && room.connected === false && !room.isBot && !S.room.tutorial ? `<button class="mini ghost" data-takeover="${p.id}">${room.autoBot ? '取消代管' : '电脑代管'}</button>` : ''}
        <button class="mini ghost pl-mat" data-mat="${p.id}" title="查看产业板">${aicon('a-mat')}</button>
      </li>`;
    })
    .join('');
  $$('[data-takeover]').forEach((b) => b.addEventListener('click', () => send('takeover', { pid: b.dataset.takeover })));
  $$('[data-mat]').forEach((b) => b.addEventListener('click', (e) => (e.stopPropagation(), openMat(b.dataset.mat))));
  renderVoice();
}

function cardHTML(c, { sel = false, playable = true, small = false } = {}) {
  if (c.k === 'loc') {
    const L = S.map.locs.find((x) => x.id === c.v);
    return `<button class="card loc ${sel ? 'sel' : ''} ${small ? 'small' : ''}" data-card="${c.id}" style="--rc:${REGION_COLOR[L.region]}" ${playable ? '' : 'aria-disabled="true"'}>
      <span class="c-head">${sicon('i-pin')}地点</span><span class="c-name">${esc(L.name)}</span><span class="c-slots">${[...new Set(L.slots.flat())].map((i) => icon('i-' + i)).join('')}</span></button>`;
  }
  if (c.k === 'ind') {
    return `<button class="card ind ${sel ? 'sel' : ''} ${small ? 'small' : ''}" data-card="${c.id}" ${playable ? '' : 'aria-disabled="true"'}>
      <span class="c-head">${sicon('i-factory')}产业</span><span class="c-icons">${CARD_IND[c.v].map((i) => icon('i-' + i)).join('')}</span><span class="c-name">${CARD_IND_NAME[c.v]}</span></button>`;
  }
  return `<button class="card wild ${sel ? 'sel' : ''} ${small ? 'small' : ''}" data-card="${c.id}" ${playable ? '' : 'aria-disabled="true"'}>
    <span class="c-head">${sicon('i-star')}万能</span><span class="c-icons">${c.k === 'wloc' ? sicon('i-pin', 'big') : sicon('i-factory', 'big')}</span><span class="c-name">${c.k === 'wloc' ? '任意地点' : '任意产业'}</span></button>`;
}

function renderHand() {
  const m = me();
  const box = $('#hand');
  if (!m) {
    box.innerHTML = '<p class="muted">观战中</p>';
    $('#hand-title').textContent = '观战';
    return;
  }
  $('#hand-title').textContent = `手牌 ${m.hand.length}`;
  box.innerHTML = m.hand.map((c) => cardHTML(c, { sel: S.selCard === c.id })).join('') || '<p class="muted small">没有手牌了，等待本时代结束</p>';
  $$('[data-card]', box).forEach((b) =>
    b.addEventListener('click', () => {
      sound.unlock();
      const id = b.dataset.card;
      if (S.flow && S.flow.pickCard) return S.flow.pickCard(id);
      S.selCard = S.selCard === id ? null : id;
      sound.play('select');
      // 选中一张牌：直接显示它能建在哪
      if (S.selCard && isMyTurn()) startFlow('build');
      else if (!S.selCard && S.flow && S.flow.kind === 'build' && !S.flow.sheet) closeSheet();
      renderHand();
      renderHot();
    })
  );
}

// 每个行动是否可用
function actionAvail() {
  const g = S.game;
  const o = g.me;
  if (!o) return {};
  const net = o.links;
  return {
    build: o.build.some((x) => x.ok),
    network: net.single.some((x) => x.ok),
    develop: o.develop.some((x) => x.ok),
    sell: o.sell.some((x) => x.ok),
    loan: !o.loan,
    scout: !o.scout,
    pass: true,
  };
}
function renderActions() {
  const g = S.game;
  const box = $('#actions');
  const m = me();
  if (!m || g.phase === 'ended') {
    box.innerHTML = g.phase === 'ended' ? `<button class="btn primary big" id="btn-over">查看结果</button>` : '<div class="turn-note">观战中</div>';
    if ($('#btn-over')) $('#btn-over').onclick = showGameOver;
    return;
  }
  if (!isMyTurn()) {
    box.innerHTML = `<div class="turn-note"><span class="spinner"></span>等待 <b style="color:${pcolor(g.turn)}">${esc(pname(g.turn))}</b> 行动…</div>`;
    return;
  }
  const av = actionAvail();
  const why = { build: '没有能建造的地方（看看钱、煤和手牌）', network: g.era === 'canal' ? '没有能修的运河' : '没有能修的铁路（需要煤和钱）', develop: '没有可开发的板块', sell: '没有可出售的工厂（需要连到商人和足够的啤酒）', loan: g.me.loan, scout: g.me.scout, pass: '' };
  box.innerHTML = `<div class="act-head"><span>剩余行动</span><em class="pips">${'●'.repeat(g.actionsLeft)}${'○'.repeat(Math.max(0, 2 - g.actionsLeft))}</em><span class="muted">每个行动弃 1 张牌</span></div>
    <div class="act-grid">${Object.entries(ACT)
      .map(([k, a]) => `<button class="act-btn ${S.flow && S.flow.kind === k ? 'on' : ''}" data-act="${k}" ${av[k] ? '' : `disabled title="${esc(why[k] || '')}"`}>${aicon(a.icon)}<span>${a.name}</span>${a.key ? `<kbd>${a.key}</kbd>` : ''}</button>`)
      .join('')}<button class="act-btn hint-btn" data-act="hint" title="让电脑给你出个主意">${aicon('a-hint')}<span>提示</span><kbd>H</kbd></button></div>`;
  $$('[data-act]', box).forEach((b) => b.addEventListener('click', () => (sound.unlock(), b.dataset.act === 'hint' ? askHint() : startFlow(b.dataset.act))));
}

function renderLog() {
  const g = S.game;
  const box = $('#log');
  box.innerHTML = g.log.map((l) => `<li ${l.pid ? `style="--pc:${pcolor(l.pid)}"` : ''} class="${l.pid ? 'p' : 'sys'} ${l.id > S.lastLogId && S.lastLogId ? 'new' : ''}">${esc(l.text)}</li>`).join('');
  S.lastLogId = g.log.length ? g.log[g.log.length - 1].id : 0;
  box.scrollTop = box.scrollHeight;
}
function renderChat() {
  const html = S.chat.map((c) => (c.sys ? `<li class="sys">${esc(c.text)}</li>` : `<li><b style="color:${c.color}">${esc(c.name)}</b>${esc(c.text)}</li>`)).join('');
  for (const id of ['#chat-list', '#lobby-chat-list']) {
    const box = $(id);
    if (!box) continue;
    box.innerHTML = html;
    box.scrollTop = box.scrollHeight;
  }
}
function renderTabs() {
  $$('.rtab').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === S.rightTab));
  $('#pane-log').hidden = S.rightTab !== 'log';
  $('#pane-chat').hidden = S.rightTab !== 'chat';
  $('#chat-badge').textContent = S.unread;
  $('#chat-badge').hidden = !S.unread;
  $('#drawer-badge').hidden = !S.unread;
}
function chatBubble(c) {
  const el = $(`#pl-${c.pid}`);
  if (!el) return;
  const b = document.createElement('div');
  b.className = 'bubble';
  b.textContent = c.text.slice(0, 40);
  el.appendChild(b);
  setTimeout(() => b.remove(), 3500);
}

// ======================= 行动流程 =======================
// S.flow = { kind, ... }；地图热点根据 flow 计算；确认面板在 #sheet
function flowValid() {
  return isMyTurn() && !!S.flow;
}
function startFlow(kind) {
  if (!isMyTurn()) return;
  if (S.flow && S.flow.kind === kind && kind !== 'build') {
    closeSheet();
    return;
  }
  closeSheet(true);
  S.flow = { kind };
  sound.play('select');
  if (kind === 'develop') openDevelopSheet();
  else if (kind === 'loan') openSimpleSheet('loan');
  else if (kind === 'pass') openSimpleSheet('pass');
  else if (kind === 'scout') openScoutSheet();
  else if (kind === 'sell') {
    S.flow.picked = new Set();
    // 只有一座可卖时直接选中
    const ok = S.game.me.sell.filter((x) => x.ok);
    if (ok.length === 1) S.flow.picked.add(`${ok[0].loc}:${ok[0].slot}`);
    openSellSheet();
  } else if (kind === 'network') {
    setFlowHint(S.game.era === 'canal' ? '点地图上发光的路线修运河（£3）' : '点地图上发光的路线修铁路（£5 + 1 块煤）');
  } else if (kind === 'build') {
    setFlowHint(S.selCard ? `用「${cardName(me().hand.find((c) => c.id === S.selCard))}」可以建在发光的格子上` : '点地图上发光的格子选择建造位置（先点一张手牌可以只看这张牌能建的地方）');
  }
  renderActions();
  renderHot();
  coach.onFlow(S.flow);
}
function setFlowHint(text) {
  $('#hint').textContent = text || '';
  $('#hint').hidden = !text;
}

function renderHot() {
  const g = S.game;
  if (!g || !isMyTurn() || !S.flow) {
    board.setHot(null);
    if (!S.flow) setFlowHint('');
    if (!isMyTurn()) $('#suggest').hidden = true;
    return;
  }
  const color = HOT;
  const f = S.flow;
  if (f.kind === 'build') {
    const opts = g.me.build.filter((o) => o.ok && (!S.selCard || o.cards.includes(S.selCard)));
    const seen = new Map();
    for (const o of opts) seen.set(`${o.loc}:${o.slot}`, { loc: o.loc, slot: o.slot });
    board.setHot({ kind: 'slot', items: [...seen.values()], color, picked: f.at ? new Set([`${f.at.loc}:${f.at.slot}`]) : null, onPick: (it) => openBuildSheet(it.loc, it.slot) });
    if (!seen.size) setFlowHint(S.selCard ? '这张牌现在没有能建造的地方' : '现在没有能建造的地方');
  } else if (f.kind === 'network') {
    const L = g.me.links;
    if (f.first) {
      const list = (L.pairs[f.first] || []).map((x) => ({ id: x.id, label: '£15' }));
      board.setHot({ kind: 'link', items: [{ id: f.first, label: '①' }, ...list], color, picked: new Set([f.first, ...(f.second ? [f.second] : [])]), onPick: (it) => (it.id === f.first ? null : pickSecondLink(it.id)) });
    } else {
      const items = L.single.filter((x) => x.ok).map((x) => ({ id: x.id, label: money(x.cost) }));
      board.setHot({ kind: 'link', items, color, onPick: (it) => openLinkSheet(it.id) });
    }
  } else if (f.kind === 'sell') {
    const items = g.me.sell.map((x) => ({ loc: x.loc, slot: x.slot, dim: !x.ok }));
    board.setHot({
      kind: 'tile',
      items,
      color,
      picked: f.picked,
      onPick: (it) => {
        const o = g.me.sell.find((x) => x.loc === it.loc && x.slot === it.slot);
        if (!o.ok) return toast(o.why, 'warn');
        const key = `${it.loc}:${it.slot}`;
        if (f.picked.has(key)) f.picked.delete(key);
        else f.picked.add(key);
        sound.play('select');
        openSellSheet();
        renderHot();
      },
    });
  } else board.setHot(null);
}

function closeSheet(keepFlow = false) {
  const sh = $('#sheet');
  sh.hidden = true;
  sh.innerHTML = '';
  document.body.classList.remove('sheet-open');
  if (!keepFlow) {
    S.flow = null;
    setFlowHint('');
    if (S.game) {
      renderActions();
      renderHot();
    }
  }
}
function openSheet(html, { onConfirm, wide = false } = {}) {
  const sh = $('#sheet');
  sh.hidden = false;
  sh.className = `sheet ${wide ? 'wide' : ''}`;
  sh.innerHTML = `<div class="sheet-in">${html}</div>`;
  document.body.classList.add('sheet-open');
  if (S.flow) S.flow.sheet = true;
  $$('[data-cancel]', sh).forEach((b) => b.addEventListener('click', () => (sound.play('click'), closeSheet())));
  const ok = $('[data-ok]', sh);
  if (ok && onConfirm) ok.addEventListener('click', () => !ok.disabled && onConfirm());
  setFlowHint('');
  coach.onFlow(S.flow);
  return sh;
}

// 默认弃哪张牌：能建造的选项最少的那张（万能牌留着）
function defaultCard(allowed) {
  const m = me();
  const list = (allowed || m.hand.map((c) => c.id)).map((id) => m.hand.find((c) => c.id === id)).filter(Boolean);
  if (S.selCard && list.some((c) => c.id === S.selCard)) return S.selCard;
  const uses = (c) => (c.k === 'wloc' || c.k === 'wind' ? 99 : S.game.me.build.filter((o) => o.ok && o.cards.includes(c.id)).length);
  list.sort((a, b) => uses(a) - uses(b));
  return list[0] ? list[0].id : null;
}
function cardPicker(allowed, chosen, label = '弃掉哪张牌') {
  const m = me();
  return `<div class="picker"><div class="pk-label">${label}</div><div class="pk-cards">${m.hand
    .map((c) => {
      const ok = !allowed || allowed.includes(c.id);
      return ok ? cardHTML(c, { sel: c.id === chosen, small: true }) : '';
    })
    .join('')}</div></div>`;
}
function bindPicker(sh, onPick) {
  $$('.pk-cards [data-card]', sh).forEach((b) => b.addEventListener('click', () => (sound.play('select'), onPick(b.dataset.card))));
}
function srcText(list, kind) {
  if (!list || !list.length) return '';
  const name = kind === 'coal' ? '煤' : kind === 'iron' ? '铁' : '啤酒';
  return list
    .map((s) => {
      if (s.market) return `市场 ${s.n} 块`;
      if (s.merchant) return `${placeName(s.merchant)}商人的啤酒`;
      const own = s.owner === S.you ? '你' : pname(s.owner);
      return `${placeName(s.loc)}（${esc(own)}的${kind === 'beer' ? '酿酒厂' : kind === 'coal' ? '煤矿' : '炼铁厂'}）${s.n} ${kind === 'beer' ? '桶' : '块'}`;
    })
    .join('、')
    .replace(/^/, `${name}：`);
}
function tileStats(ind, lv) {
  const t = T(ind, lv);
  const res = [];
  if (t.coal) res.push(`${sicon('i-cube-coal')}×${t.coal}`);
  if (t.iron) res.push(`${sicon('i-cube-iron')}×${t.iron}`);
  return `<div class="tstats">
    <span title="造价">${sicon('i-coin')}£${t.cost}</span>${res.length ? `<span title="建造消耗">${res.join(' ')}</span>` : ''}
    ${['cotton', 'goods', 'pottery'].includes(ind) ? `<span title="出售需要的啤酒">${sicon('i-beer')}×${t.beer}</span>` : ''}
    ${t.res ? `<span title="建好后放上的方块">产出 ${t.res} 块${ind === 'coal' ? '煤' : '铁'}</span>` : ''}
    ${ind === 'brewery' ? `<span>产出 ${S.game.era === 'canal' ? 1 : 2} 桶啤酒</span>` : ''}
    <span title="翻面后每个时代计分">${sicon('i-vp')}${t.vp} 分</span><span title="翻面时收入前进">${sicon('i-income')}+${t.income} 格</span><span title="线路图标">↔${t.links}</span>
    ${t.canal ? '<span class="warn">仅运河时代</span>' : ''}${t.rail ? '<span class="warn">仅铁路时代</span>' : ''}${t.nodev ? `<span class="warn">${sicon('i-bulb')}不能开发</span>` : ''}</div>`;
}

// ---------- 建造 ----------
function openBuildSheet(loc, slot) {
  const g = S.game;
  const opts = g.me.build.filter((o) => o.ok && o.loc === loc && o.slot === slot && (!S.selCard || o.cards.includes(S.selCard)));
  if (!opts.length) return;
  S.flow = { kind: 'build', at: { loc, slot }, ind: opts[0].ind, card: null };
  const draw = () => {
    const f = S.flow;
    const o = opts.find((x) => x.ind === f.ind) || opts[0];
    // 默认用这个城镇的地点牌，其次产业牌，最后万能牌
    if (!f.card || !o.cards.includes(f.card)) {
      const hand = me().hand;
      const pick = (k) => o.cards.find((id) => hand.find((c) => c.id === id && c.k === k));
      f.card = (S.selCard && o.cards.includes(S.selCard) && S.selCard) || pick('loc') || pick('ind') || pick('wind') || pick('wloc') || o.cards[0];
    }
    const L = S.map.locs.find((x) => x.id === loc);
    const sh = openSheet(
      `<div class="sh-head">${aicon('a-build')}<h3>在${esc(L.name)}建造</h3><button class="mini ghost" data-cancel>取消</button></div>
      ${opts.length > 1 ? `<div class="seg ind-seg">${opts.map((x) => `<button data-ind="${x.ind}" aria-selected="${x.ind === o.ind}">${icon('i-' + x.ind)}${IND_NAME[x.ind]}</button>`).join('')}</div>` : ''}
      <div class="sh-tile">${icon('i-' + o.ind, 'big')}<div><b>${tileName(o.ind, o.lv)}</b>${o.over ? '<em class="tag">覆盖建造</em>' : ''}${tileStats(o.ind, o.lv)}</div></div>
      <p class="sh-cost">共需 <b>${money(o.cost)}</b>${o.coal && o.coal.length ? `<br>${esc(srcText(o.coal, 'coal'))}` : ''}${o.iron && o.iron.length ? `<br>${esc(srcText(o.iron, 'iron'))}` : ''}</p>
      ${cardPicker(o.cards, f.card, '用哪张牌建造')}
      <div class="sh-actions"><button class="btn ghost" data-cancel>取消</button><button class="btn primary" data-ok>确认建造</button></div>`,
      {
        onConfirm: () => {
          act('build', { card: f.card, loc, slot, ind: o.ind });
          S.selCard = null;
          closeSheet();
        },
      }
    );
    $$('[data-ind]', sh).forEach((b) => b.addEventListener('click', () => ((f.ind = b.dataset.ind), sound.play('select'), draw())));
    bindPicker(sh, (id) => ((f.card = id), draw()));
    S.flow.pickCard = (id) => o.cards.includes(id) && ((f.card = id), draw());
  };
  draw();
  renderHot();
}

// ---------- 网络 ----------
function openLinkSheet(id) {
  const g = S.game;
  const o = g.me.links.single.find((x) => x.id === id);
  if (!o) return;
  S.flow = { kind: 'network', link: id, card: S.flow && S.flow.card };
  const pairs = g.me.links.pairs[id] || [];
  const draw = () => {
    const f = S.flow;
    f.card = f.card || defaultCard();
    const sh = openSheet(
      `<div class="sh-head">${aicon('a-network')}<h3>修建${g.era === 'canal' ? '运河' : '铁路'}</h3><button class="mini ghost" data-cancel>取消</button></div>
      <p class="sh-route">${g.era === 'canal' ? sicon('i-boat') : sicon('i-train')} <b>${esc(linkName(id))}</b>${f.second ? ` ＋ <b>${esc(linkName(f.second))}</b>` : ''}</p>
      <p class="sh-cost">共需 <b>${money(f.second ? (pairs.find((x) => x.id === f.second) || {}).cost : o.cost)}</b>${g.era === 'rail' ? `<br>${f.second ? '煤 2 块、啤酒 1 桶（自动从最近的来源拿）' : esc(srcText(o.coal, 'coal'))}` : ''}</p>
      <p class="muted small">时代结束时，这条线路按两端城镇的「↔」图标计分（翻面的工厂才有图标，商人算 2 个）。</p>
      ${g.era === 'rail' && pairs.length && !f.second ? '<button class="btn wide" id="ln-two">再修一段（一次两段：共 £15，多要 1 块煤和 1 桶啤酒）</button>' : ''}
      ${cardPicker(null, f.card)}
      <div class="sh-actions"><button class="btn ghost" data-cancel>取消</button><button class="btn primary" data-ok>确认修建</button></div>`,
      {
        onConfirm: () => {
          act('network', { card: f.card, links: f.second ? [id, f.second] : [id] });
          closeSheet();
        },
      }
    );
    bindPicker(sh, (cid) => ((f.card = cid), draw()));
    S.flow.pickCard = (cid) => ((f.card = cid), draw());
    if ($('#ln-two')) $('#ln-two').onclick = () => {
      S.flow.first = id;
      $('#sheet').hidden = true;
      setFlowHint('再点一段相连的铁路（发光的）');
      renderHot();
    };
  };
  S.flow.redraw = draw;
  draw();
  renderHot();
}
function pickSecondLink(id) {
  S.flow.second = id;
  sound.play('select');
  S.flow.redraw();
  renderHot();
}

// ---------- 出售 ----------
function openSellSheet() {
  const g = S.game;
  const f = S.flow;
  f.card = f.card || defaultCard();
  f.merchants = f.merchants || {};
  const picked = g.me.sell.filter((x) => f.picked.has(`${x.loc}:${x.slot}`));
  const rows = picked
    .map((x) => {
      const key = `${x.loc}:${x.slot}`;
      const ms = x.merchants;
      const opt = ms.length > 1 ? `<select data-merch="${key}"><option value="">自动（优先有啤酒的）</option>${ms.map((m) => `<option value="${m.id}:${m.i}" ${f.merchants[key] === `${m.id}:${m.i}` ? 'selected' : ''}>${esc(placeName(m.id))}${m.beer ? ' 🍺' : ''}</option>`).join('')}</select>` : `<span>${esc(placeName(ms[0].id))}${ms[0].beer ? ' 🍺' : ''}</span>`;
      return `<li>${icon('i-' + x.ind)}<b>${esc(placeName(x.loc))} ${tileName(x.ind, x.lv)}</b><span class="muted">需要啤酒 ${x.beer}</span>${opt}</li>`;
    })
    .join('');
  const sh = openSheet(
    `<div class="sh-head">${aicon('a-sell')}<h3>出售商品</h3><button class="mini ghost" data-cancel>取消</button></div>
    <p class="muted small">点地图上你的棉纺厂 / 制造厂 / 陶瓷厂选择要卖的（可以一次卖多座）。卖出后工厂翻面：收入上升，时代结束时计分。喝到商人的啤酒还有奖励。</p>
    ${rows ? `<ul class="sell-list">${rows}</ul>` : '<p class="empty">还没有选择工厂</p>'}
    ${cardPicker(null, f.card)}
    <div class="sh-actions"><button class="btn ghost" data-cancel>取消</button><button class="btn primary" data-ok ${picked.length ? '' : 'disabled'}>出售 ${picked.length || ''} 座</button></div>`,
    {
      onConfirm: () => {
        const sales = picked.map((x) => {
          const key = `${x.loc}:${x.slot}`;
          const m = f.merchants[key];
          return { loc: x.loc, slot: x.slot, merchant: m ? { id: m.split(':')[0], i: Number(m.split(':')[1]) } : undefined };
        });
        act('sell', { card: f.card, sales });
        closeSheet();
      },
    }
  );
  $$('[data-merch]', sh).forEach((s) => s.addEventListener('change', () => (f.merchants[s.dataset.merch] = s.value)));
  bindPicker(sh, (id) => ((f.card = id), openSellSheet()));
  f.pickCard = (id) => ((f.card = id), openSellSheet());
}

// ---------- 开发 ----------
function ironNote(n) {
  const g = S.game;
  let free = 0;
  for (const row of Object.values(g.board)) for (const t of row) if (t && t.ind === 'iron' && !t.flipped) free += t.res;
  const fromBoard = Math.min(free, n);
  let cost = 0;
  let c = g.market.iron;
  for (let i = fromBoard; i < n; i++) {
    if (c > 0) {
      cost += S.map.ironPrices[S.map.ironPrices.length - c];
      c--;
    } else cost += 6;
  }
  return { cost, text: `${fromBoard ? `炼铁厂的铁 ${fromBoard} 块（免费）` : ''}${fromBoard && n - fromBoard ? '，' : ''}${n - fromBoard ? `市场买 ${n - fromBoard} 块（£${cost}）` : ''}` };
}
function openDevelopSheet() {
  const g = S.game;
  const f = S.flow;
  f.inds = f.inds || [];
  f.card = f.card || defaultCard();
  const m = me();
  const cnt = (ind) => f.inds.filter((x) => x === ind).length;
  const cols = IND_LIST.map((ind) => {
    const stack = m.mat[ind];
    const k = cnt(ind);
    const lv = stack[k];
    const ok = lv && !T(ind, lv).nodev && f.inds.length < 2;
    return `<button class="dev-col ${k ? 'on' : ''}" data-dev="${ind}" ${ok || k ? '' : 'disabled'}>
      ${icon('i-' + ind, 'big')}<b>${IND_NAME[ind]}</b><span>${lv ? `下一块：${tileName(ind, lv)}` : stack.length ? '' : '已用完'}</span>${k ? `<em class="cnt">×${k}</em>` : ''}${lv && T(ind, lv).nodev ? `<small>${sicon('i-bulb')}灯泡</small>` : ''}${lv && T(ind, lv).canal ? '<small class="warn">仅运河</small>' : ''}${lv && T(ind, lv).rail ? '<small class="warn">仅铁路</small>' : ''}</button>`;
  }).join('');
  const iron = f.inds.length ? ironNote(f.inds.length) : null;
  const sh = openSheet(
    `<div class="sh-head">${aicon('a-develop')}<h3>开发</h3><button class="mini ghost" data-cancel>取消</button></div>
    <p class="muted small">从产业板上移除 1–2 块最低等级的板块（每块消耗 1 块铁），让更高级、更值钱的工厂提前登场。铁路时代不能建「仅运河」板块，记得提前开发掉。</p>
    <div class="dev-grid">${cols}</div>
    <p class="sh-cost">${iron ? `需要铁 ${f.inds.length} 块：${esc(iron.text)}` : '点选要开发的产业（再点一次同一个可以开发两块）'}</p>
    ${f.inds.length ? '<button class="mini ghost" id="dev-clear">重新选择</button>' : ''}
    ${cardPicker(null, f.card)}
    <div class="sh-actions"><button class="btn ghost" data-cancel>取消</button><button class="btn primary" data-ok ${f.inds.length ? '' : 'disabled'}>开发 ${f.inds.length || ''} 块</button></div>`,
    { wide: true, onConfirm: () => (act('develop', { card: f.card, inds: f.inds }), closeSheet()) }
  );
  $$('[data-dev]', sh).forEach((b) =>
    b.addEventListener('click', () => {
      if (f.inds.length < 2) f.inds.push(b.dataset.dev);
      sound.play('select');
      openDevelopSheet();
    })
  );
  if ($('#dev-clear')) $('#dev-clear').onclick = () => ((f.inds = []), openDevelopSheet());
  bindPicker(sh, (id) => ((f.card = id), openDevelopSheet()));
  f.pickCard = (id) => ((f.card = id), openDevelopSheet());
}

// ---------- 贷款 / 跳过 ----------
function openSimpleSheet(kind) {
  const g = S.game;
  const f = S.flow;
  f.card = f.card || defaultCard();
  const m = me();
  const body =
    kind === 'loan'
      ? `<p class="sh-big">${sicon('i-coin')} 立即获得 <b>£30</b></p><p>收入等级 <b>${signed(m.income)}</b> → <b class="neg">${signed(m.income - 3)}</b>（每轮少领 £3）</p><p class="muted small">钱不够周转时贷款很常见。收入等级最低是 -10。</p>`
      : `<p>不做任何事，只弃掉一张牌。</p>`;
  const sh = openSheet(
    `<div class="sh-head">${aicon(ACT[kind].icon)}<h3>${ACT[kind].name}</h3><button class="mini ghost" data-cancel>取消</button></div>${body}
    ${cardPicker(null, f.card)}
    <div class="sh-actions"><button class="btn ghost" data-cancel>取消</button><button class="btn primary" data-ok>确认${ACT[kind].name}</button></div>`,
    { onConfirm: () => (act(kind, { card: f.card }), closeSheet()) }
  );
  bindPicker(sh, (id) => ((f.card = id), openSimpleSheet(kind)));
  f.pickCard = (id) => ((f.card = id), openSimpleSheet(kind));
}

// ---------- 侦察 ----------
function openScoutSheet() {
  const f = S.flow;
  f.cards = f.cards || [];
  const m = me();
  const sh = openSheet(
    `<div class="sh-head">${aicon('a-scout')}<h3>侦察</h3><button class="mini ghost" data-cancel>取消</button></div>
    <p>弃掉 3 张牌，换来 <b>万能地点牌</b> 和 <b>万能产业牌</b> 各一张。手里已有万能牌时不能侦察。</p>
    <div class="picker"><div class="pk-label">选择 3 张（已选 ${f.cards.length} / 3）</div><div class="pk-cards">${m.hand.map((c) => cardHTML(c, { sel: f.cards.includes(c.id), small: true })).join('')}</div></div>
    <div class="sh-actions"><button class="btn ghost" data-cancel>取消</button><button class="btn primary" data-ok ${f.cards.length === 3 ? '' : 'disabled'}>确认侦察</button></div>`,
    { onConfirm: () => (act('scout', { cards: f.cards }), closeSheet()) }
  );
  const toggle = (id) => {
    const i = f.cards.indexOf(id);
    if (i >= 0) f.cards.splice(i, 1);
    else if (f.cards.length < 3) f.cards.push(id);
    sound.play('select');
    openScoutSheet();
  };
  bindPicker(sh, toggle);
  f.pickCard = toggle;
}

// ---------- 提示 ----------
function askHint() {
  if (!isMyTurn()) return;
  send('hint');
  sound.play('select');
}
function describeAction(a) {
  const m = me();
  const c = a.card && m.hand.find((x) => x.id === a.card);
  const cn = c ? `（弃「${cardName(c)}」）` : '';
  switch (a.type) {
    case 'build':
      return `在${placeName(a.loc)}建造${tileName(a.ind, m.mat[a.ind][0])}${cn}`;
    case 'network':
      return `修建 ${a.links.map(linkName).join(' 和 ')}${cn}`;
    case 'develop':
      return `开发 ${a.inds.map((i) => IND_NAME[i]).join('、')}${cn}`;
    case 'sell':
      return `出售 ${a.sales.map((s) => placeName(s.loc)).join('、')} 的货${cn}`;
    case 'loan':
      return `贷款 £30${cn}`;
    case 'scout':
      return '侦察：弃 3 张换万能牌';
    default:
      return `跳过${cn}`;
  }
}
function showHint(a) {
  if (!a || !isMyTurn()) return;
  S.hint = a;
  const box = $('#suggest');
  box.hidden = false;
  box.innerHTML = `<span>💡 建议：${esc(describeAction(a))}</span><button class="mini" id="hint-do">照做</button><button class="mini ghost" id="hint-x">✕</button>`;
  $('#hint-do').onclick = () => {
    closeSheet(true);
    act(a.type, a);
    S.hint = null;
    box.hidden = true;
  };
  $('#hint-x').onclick = () => ((S.hint = null), (box.hidden = true));
  // 在地图上指一下
  if (a.loc) {
    const p = board.slotPos(a.loc, a.slot);
    board.glowTile(a.loc, a.slot);
    void p;
  }
  if (a.links) for (const id of a.links) board.glowLink(id);
  if (a.sales) for (const s of a.sales) board.glowTile(s.loc, s.slot);
}

// ======================= 地图上点击查看 =======================
function inspect(target, e) {
  const tip = $('#tip');
  if (!target || !S.game) return (tip.hidden = true);
  let html = '';
  const g = S.game;
  if (target.classList.contains('tile-pos') || target.classList.contains('slot')) {
    const loc = target.dataset.loc;
    const s = Number(target.dataset.slot);
    const t = g.board[loc][s];
    const L = S.map.locs.find((x) => x.id === loc);
    if (t) {
      const st = T(t.ind, t.lv);
      html = `<b style="color:${pcolor(t.owner)}">${esc(pname(t.owner))}</b> 的 ${tileName(t.ind, t.lv)}（${esc(L.name)}）<br>${t.flipped ? `已翻面：时代结束计 ${st.vp} 分，↔${st.links}` : `未翻面${t.res ? `，剩 ${t.res} ${t.ind === 'brewery' ? '桶啤酒' : '块' + (t.ind === 'coal' ? '煤' : '铁')}` : ''}；翻面后 ${st.vp} 分、收入 +${st.income} 格`}`;
    } else html = `${esc(L.name)}：可建 ${L.slots[s].map((i) => IND_NAME[i]).join(' 或 ')}`;
  } else if (target.classList.contains('merchant')) {
    const id = target.dataset.m;
    const M = S.map.merchants.find((x) => x.id === id);
    const st = g.merchants[id];
    html = st ? `<b>${esc(M.name)}</b> 商人：收购 ${st.map((x) => MERCHANT_TYPE[x.type]).join('、')}<br>喝这里的啤酒出售：${M.bonusText}` : `<b>${esc(M.name)}</b>：本局人数下不开放`;
  } else if (target.classList.contains('route')) {
    const id = target.dataset.link;
    const l = S.map.links.find((x) => x.id === id);
    html = `${esc(linkName(id))}：${l.canal && l.rail ? '运河与铁路都能修' : l.canal ? '只能修运河' : '只能修铁路'}${g.links[id] ? `<br>已被 <b style="color:${pcolor(g.links[id])}">${esc(pname(g.links[id]))}</b> 修建` : ''}`;
  }
  if (!html) return (tip.hidden = true);
  tip.innerHTML = html;
  tip.hidden = false;
  const wrap = $('#board-wrap').getBoundingClientRect();
  tip.style.left = Math.min(wrap.width - 230, Math.max(8, e.clientX - wrap.left + 12)) + 'px';
  tip.style.top = Math.max(8, e.clientY - wrap.top - 10) + 'px';
  clearTimeout(tip._t);
  tip._t = setTimeout(() => (tip.hidden = true), 4000);
}

// ======================= 事件动画 =======================
function playerAnchor(pid) {
  if (pid === S.you && $('#hand')) {
    const r = fx.center($('#hand'));
    if (r) return r;
  }
  return fx.center($(`#pl-${pid} .chip`)) || fx.center($(`#pl-${pid}`)) || { x: innerWidth / 2, y: 60 };
}
const bankAnchor = () => fx.center($('#era-chip')) || { x: innerWidth / 2, y: 40 };
function srcPoint(s, res, marketCount) {
  if (s.market) return board.marketScreen(res, marketCount);
  if (s.merchant) return board.slotScreen(s.merchant, s.slot);
  return board.slotScreen(s.loc, s.slot);
}

function playEvents(events, prev) {
  const g = S.game;
  let delay = 0;
  const later = (ms, fn) => setTimeout(fn, ms);
  // 本次之前的市场数量（用于计算方块从哪个格子飞出）
  const mk = prev ? { ...prev.market } : { ...g.market };
  for (const e of events) {
    switch (e.type) {
      case 'turn':
        if (e.pid === S.you) {
          later(delay + 300, () => {
            sound.play('turn');
            fx.banner('轮到你了', e.actions === 1 ? '本轮只有 1 个行动' : '你有 2 个行动', me().color, { big: true });
            if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification('伯明翰：轮到你了！');
          });
        } else later(delay, () => sound.play('otherTurn'));
        break;
      case 'build': {
        const to = board.slotScreen(e.loc, e.slot);
        let d = delay;
        for (const s of e.coal || []) {
          for (let i = 0; i < Math.min(s.n, 4); i++) fx.fly('coal', srcPoint(s, 'coal', mk.coal), to, { delay: d + i * 120, dur: 700 });
          if (s.market) mk.coal -= s.n;
          later(d + 500, () => sound.play('coal'));
          d += 260;
        }
        for (const s of e.iron || []) {
          for (let i = 0; i < Math.min(s.n, 4); i++) fx.fly('iron', srcPoint(s, 'iron', mk.iron), to, { delay: d + i * 120, dur: 700 });
          if (s.market) mk.iron -= s.n;
          later(d + 500, () => sound.play('iron'));
          d += 260;
        }
        if (e.cost) {
          fx.coins(playerAnchor(e.pid), bankAnchor(), Math.min(6, Math.ceil(e.cost / 4)), { delay });
          fx.floatText(playerAnchor(e.pid), `-£${e.cost}`, '#ffb0a0', { delay });
        }
        later(d + 350, () => {
          board.dropTile(e.loc, e.slot);
          sound.play('build', e.ind);
          fx.burst(to, pcolor(e.pid), 12, { spread: 46 });
          if (e.over) fx.floatText(to, '覆盖建造！', '#ffe08a', { size: 15 });
        });
        if (e.pid !== S.you) ticker(e.pid, `在${placeName(e.loc)}建造了${tileName(e.ind, e.lv)}`);
        delay = d + 500;
        break;
      }
      case 'market': {
        const from = board.slotScreen(e.loc, e.slot);
        for (let i = 0; i < Math.min(e.n, 6); i++) {
          mk[e.res]++;
          fx.fly(e.res, from, board.marketScreen(e.res, mk[e.res]), { delay: delay + 300 + i * 110, dur: 650 });
        }
        if (e.money) {
          later(delay + 700, () => sound.play('coins', 4));
          fx.coins(bankAnchor(), playerAnchor(e.pid), Math.min(6, Math.ceil(e.money / 3)), { delay: delay + 700 });
          fx.floatText(from, `+£${e.money}`, '#c8f7a8', { delay: delay + 700 });
        }
        delay += 600;
        break;
      }
      case 'flip':
        later(delay + 450, () => {
          board.flipTile(e.loc, e.slot);
          sound.play('flip');
          const p = board.slotScreen(e.loc, e.slot);
          fx.burst(p, '#ffd36b', 22, { spread: 70, size: 5 });
          fx.floatText(p, `收入 +${e.income} 格`, '#c8f7a8', { size: 16 });
          fx.pulse($(`#pl-${e.pid}`), 'flash-gold');
        });
        delay += 500;
        break;
      case 'link': {
        let d = delay;
        for (const s of e.coal || []) {
          const to = board.linkScreen(e.links[0]);
          fx.fly('coal', srcPoint(s, 'coal', mk.coal), to, { delay: d, dur: 700 });
          if (s.market) mk.coal -= s.n;
          d += 200;
        }
        for (const s of e.beer || []) {
          fx.fly('beer', srcPoint(s, 'beer'), board.linkScreen(e.links[e.links.length - 1]), { delay: d, dur: 700, size: 28 });
          later(d + 500, () => sound.play('beer'));
          d += 200;
        }
        if (e.cost) fx.floatText(playerAnchor(e.pid), `-£${e.cost}`, '#ffb0a0', { delay });
        e.links.forEach((id, i) =>
          later(d + i * 500, () => {
            board.drawLinkAnim(id, e.era);
            sound.play(e.era === 'canal' ? 'canal' : 'rail');
          })
        );
        if (e.pid !== S.you) ticker(e.pid, `修建了${e.era === 'canal' ? '运河' : '铁路'} ${e.links.map(linkName).join('、')}`);
        delay = d + e.links.length * 500 + 400;
        break;
      }
      case 'sell': {
        const from = board.slotScreen(e.loc, e.slot);
        const mpos = board.slotScreen(e.merchant, e.mi);
        let d = delay;
        for (const s of e.beer || []) {
          fx.fly('beer', srcPoint(s, 'beer'), from, { delay: d, dur: 700, size: 28 });
          later(d + 450, () => sound.play('beer'));
          d += 260;
        }
        fx.fly('crate', from, mpos, { delay: d + 200, dur: 800, size: 30, cls: 'crate', html: `<svg viewBox="0 0 32 32"><use href="#i-${e.ind}"/></svg>` });
        later(d + 900, () => sound.play('sell'));
        if (e.bonus) later(d + 1000, () => fx.floatText(mpos, `🍺 ${e.bonus.text}`, '#ffe08a', { size: 16 }));
        if (e.pid !== S.you) ticker(e.pid, `把${placeName(e.loc)}的货卖给了${placeName(e.merchant)}`);
        delay = d + 700;
        break;
      }
      case 'develop':
        later(delay, () => {
          sound.play('develop');
          const a = playerAnchor(e.pid);
          for (const r of e.removed) fx.fly(r.ind, a, { x: a.x, y: a.y - 120 }, { dur: 900, size: 34, arc: 0.1 });
          fx.floatText(a, e.free ? '免费开发！' : '开发', '#ffe08a');
        });
        if (e.pid !== S.you && !e.free) ticker(e.pid, `开发了 ${e.removed.map((r) => tileName(r.ind, r.lv)).join('、')}`);
        delay += 400;
        break;
      case 'loan':
        later(delay, () => {
          sound.play('loan');
          fx.coins(bankAnchor(), playerAnchor(e.pid), 8);
          fx.floatText(playerAnchor(e.pid), '+£30', '#c8f7a8', { size: 22 });
        });
        if (e.pid !== S.you) ticker(e.pid, `贷款 £30（收入 ${signed(e.before)} → ${signed(e.level)}）`);
        delay += 400;
        break;
      case 'scout':
        later(delay, () => {
          sound.play('scout');
          fx.floatText(playerAnchor(e.pid), '侦察：获得万能牌', '#ffe08a');
        });
        if (e.pid !== S.you) ticker(e.pid, '派人侦察，换来两张万能牌');
        break;
      case 'pass':
        if (e.pid !== S.you) ticker(e.pid, '跳过');
        break;
      case 'discard':
        later(delay, () => sound.play('card'));
        break;
      case 'shortfall':
        later(delay, () => {
          sound.play('error');
          fx.banner(`${pname(e.pid)} 付不起收入`, `${e.removed.length ? `卖掉 ${e.removed.length} 座工厂` : ''}${e.vpLost ? ` 扣 ${e.vpLost} 分` : ''}`, '#b8322a');
        });
        break;
      case 'roundEnd':
        later(delay + 300, () => {
          sound.play('round');
          fx.banner(`第 ${e.round} 轮结束`, '花钱少的先行动 · 按收入等级领钱', '#8a6236');
          for (const inc of e.income) {
            const a = playerAnchor(inc.pid);
            if (inc.amount > 0) {
              fx.coins(bankAnchor(), a, Math.min(6, inc.amount), { delay: 400 });
              fx.floatText(a, `收入 +£${inc.amount}`, '#c8f7a8', { delay: 500 });
            } else if (inc.amount < 0) fx.floatText(a, `付出 £${-inc.amount}`, '#ffb0a0', { delay: 500 });
          }
          setTimeout(() => sound.play('coins', 5), 600);
        });
        delay += 900;
        break;
      case 'eraStart':
        break;
      case 'win':
        later(delay + 800, () => {
          fx.confetti(g.players.map((p) => p.color).concat(['#f2c94c', '#fff3c4']));
          fx.fireworks(g.players.map((p) => p.color).concat(['#f2c94c']));
          sound.play(e.pid === S.you || !me() ? 'win' : 'lose');
          fx.banner(e.pid === S.you ? '你成为了伯明翰的工业大亨！' : `${pname(e.pid)} 获胜`, '', pcolor(e.pid), { big: true, dur: 2600 });
        });
        later(delay + 3200, showGameOver);
        break;
    }
  }
  void prev;
}

// 别人的行动：屏幕上方的小条
function ticker(pid, text) {
  const root = $('#ticker-root');
  const t = document.createElement('div');
  t.className = 'toast ticker';
  t.style.setProperty('--pc', pcolor(pid));
  t.innerHTML = `<i class="chip"></i><b>${esc(pname(pid))}</b> ${esc(text)}`;
  root.appendChild(t);
  while (root.children.length > 3) root.firstChild.remove();
  setTimeout(() => t.classList.add('out'), 3200);
  setTimeout(() => t.remove(), 3700);
}

// 时代结束：在旧地图上逐条线路、逐座工厂计分；运河时代还要拆掉运河和Ⅰ级工厂
async function playEraEnd(e, prev, next, events) {
  const inter = { ...next, era: e.era, links: Object.fromEntries(e.links.map((l) => [l.id, l.pid])), board: JSON.parse(JSON.stringify(next.board)) };
  // 把被拆掉的Ⅰ级工厂放回去，好演示拆除
  const removed = [];
  for (const [loc, row] of Object.entries(prev.board)) {
    row.forEach((t, s) => {
      if (t && e.era === 'canal' && t.lv === 1 && !inter.board[loc][s]) {
        inter.board[loc][s] = { ...t, flipped: e.tiles.some((x) => x.loc === loc && x.slot === s) || t.flipped };
        removed.push({ loc, slot: s });
      }
    });
  }
  if (e.era === 'rail') inter.board = prev.board;
  S.game = inter;
  closeSheet();
  board.update(inter, { me: S.you, colors: Object.fromEntries(next.players.map((p) => [p.id, p.color])) });
  sound.play('era');
  fx.banner(e.era === 'canal' ? '运河时代结束' : '铁路时代结束', '线路与翻面的工厂计分', '#c8963e', { big: true, dur: 1800 });
  await fx.wait(1600);
  for (const l of e.links) {
    if (l.vp) {
      board.glowLink(l.id, `+${l.vp}`);
      sound.play('score');
    }
    await fx.wait(e.links.length > 20 ? 70 : 140);
  }
  await fx.wait(300);
  for (const t of e.tiles) {
    board.glowTile(t.loc, t.slot, `+${t.vp}`);
    sound.play('score');
    await fx.wait(e.tiles.length > 20 ? 70 : 140);
  }
  await fx.wait(500);
  for (const p of next.players) {
    const before = (prev.players.find((x) => x.id === p.id) || {}).vp || 0;
    const gain = (e.totals[p.id] || 0) - before;
    if (gain) fx.floatText(playerAnchor(p.id), `+${gain} 分`, '#ffe08a', { size: 22 });
  }
  await fx.wait(1000);
  if (e.era === 'canal' && events.some((x) => x.type === 'eraStart')) {
    board.fadeLinks();
    sound.play('crumble');
    for (const r of removed) board.crumble(r.loc, r.slot);
    await fx.wait(1100);
    sound.setEra('rail');
    await fx.eraCinematic('铁路时代', '运河已被填平，Ⅰ级工厂退出历史舞台。每轮 2 个行动，修铁路需要煤。', 'rail');
  }
}

// ======================= 弹窗 =======================
function openModal(html, { cls = '', dismiss = true } = {}) {
  closeModal();
  const root = $('#modal-root');
  root.innerHTML = `<div class="backdrop ${dismiss ? 'dismiss' : ''}"><div class="modal ${cls}" role="dialog" aria-modal="true">${html}</div></div>`;
  root.dataset.kind = cls;
  const bd = $('.backdrop', root);
  if (dismiss) bd.addEventListener('click', (e) => e.target === bd && closeModal());
  $$('[data-close]', root).forEach((b) => b.addEventListener('click', closeModal));
  return root;
}
function closeModal() {
  const root = $('#modal-root');
  root.innerHTML = '';
  root.dataset.kind = '';
}

// 产业板
function openMat(pid = S.you) {
  const g = S.game;
  if (!g) return;
  const p = P(pid) || g.players[0];
  const tabs = g.players.map((x) => `<button data-mp="${x.id}" aria-selected="${x.id === p.id}" style="--pc:${x.color}"><i class="chip"></i>${esc(x.name)}</button>`).join('');
  const cols = IND_LIST.map((ind) => {
    const stack = p.mat[ind];
    const levels = [...new Set(stack)];
    const lvList = Object.keys(S.map.tiles[ind]).map(Number);
    return `<div class="mat-col"><div class="mc-head">${icon('i-' + ind)}<b>${IND_NAME[ind]}</b><span>剩 ${stack.length}</span></div>
      ${lvList
        .map((lv) => {
          const n = stack.filter((x) => x === lv).length;
          const t = T(ind, lv);
          const top = stack[0] === lv;
          return `<div class="mc-tile ${n ? '' : 'gone'} ${top ? 'top' : ''}" style="--pc:${p.color}">
          <span class="mc-lv">${ROMAN[lv]}</span><span class="mc-n">${n ? '×' + n : '—'}</span>
          <span class="mc-row">£${t.cost}${t.coal ? ` ${sicon('i-cube-coal')}${t.coal}` : ''}${t.iron ? ` ${sicon('i-cube-iron')}${t.iron}` : ''}${['cotton', 'goods', 'pottery'].includes(ind) ? ` ${sicon('i-beer')}${t.beer}` : ''}</span>
          <span class="mc-row">${sicon('i-vp')}${t.vp} ${sicon('i-income')}+${t.income} ↔${t.links}${t.canal ? ' <em>运</em>' : ''}${t.rail ? ' <em class="rl">铁</em>' : ''}${t.nodev ? sicon('i-bulb') : ''}</span></div>`;
        })
        .join('')}
      </div>`;
    void levels;
  }).join('');
  const root = openModal(
    `<h2>产业板</h2><div class="mat-tabs">${tabs}</div>
    <p class="muted small">每种产业从最低等级开始建；高亮的是下一块。「运」= 仅运河时代可建，「铁」= 仅铁路时代可建；${sicon('i-bulb')} = 不能开发。数字依次是：造价、煤、铁、出售所需啤酒；分数、翻面时收入前进的格数、线路图标。</p>
    <div class="mat-grid">${cols}</div>
    <div class="modal-actions"><button class="btn primary" data-close>关闭</button></div>`,
    { cls: 'mat-modal' }
  );
  $$('[data-mp]', root).forEach((b) => b.addEventListener('click', () => openMat(b.dataset.mp)));
}

function showGameOver() {
  const g = S.game;
  if (!g || g.phase !== 'ended' || S.overShown) return;
  S.overShown = true;
  const ranked = g.players.slice().sort((a, b) => b.vp - a.vp || b.income - a.income || b.money - a.money);
  const isHost = S.room.host === S.you;
  // 分数曲线
  const hist = g.history || [];
  const maxV = Math.max(10, ...g.players.map((p) => p.vp));
  const W = 420;
  const H = 150;
  const lines = g.players
    .map((p) => {
      const pts = [[0, 0], ...hist.map((h, i) => [i + 1, h[p.id] || 0])];
      const n = Math.max(1, hist.length);
      return `<polyline fill="none" stroke="${p.color}" stroke-width="3" stroke-linejoin="round" points="${pts.map(([x, y]) => `${(x / n) * W},${H - (y / maxV) * H}`).join(' ')}"/>`;
    })
    .join('');
  const root = openModal(
    `<div class="trophy">🏆</div><h2>${esc(pname(g.winner))} 成为伯明翰的工业大亨！</h2>
    <p class="muted">${g.intro ? '入门短局' : '两个时代'}，共 ${hist.length} 轮</p>
    <ol class="ranking">${ranked
      .map(
        (p, i) => `<li style="--pc:${p.color}" class="${p.id === g.winner ? 'win' : ''}"><span class="rk">${i + 1}</span><span class="chip"></span><b>${esc(p.name)}</b><span class="rv">${p.vp} 分</span>
        <small>线路 ${p.stats.vpLinks} 分 · 工厂 ${p.stats.vpTiles} 分 · 收入 ${signed(p.income)} · £${p.money} · 建造 ${p.stats.built} · 卖货 ${p.stats.sold} · 贷款 ${p.stats.loans}</small></li>`
      )
      .join('')}</ol>
    <h3>分数走势</h3><svg class="hist" viewBox="-6 -6 ${W + 12} ${H + 12}">${lines}</svg>
    <div class="modal-actions">${S.room.tutorial ? '<button class="btn primary" id="go-home">开一局真正的游戏</button>' : isHost ? '<button class="btn primary" id="go-lobby">返回房间再来一局</button>' : '<span class="muted">等待房主开始新一局…</span>'}<button class="btn ghost" data-close>查看地图</button></div>`,
    { cls: 'over' }
  );
  if ($('#go-lobby', root)) $('#go-lobby').onclick = () => send('backToLobby');
  if ($('#go-home', root)) $('#go-home').onclick = () => (closeModal(), send('leave'));
}

function openSettings() {
  const root = openModal(
    `<h2>声音设置</h2>
    <label class="row"><input type="checkbox" id="s-sfx" ${sound.sfxOn ? 'checked' : ''}> 音效</label>
    <label class="row">音效音量 <input type="range" id="s-sfxv" min="0" max="1" step="0.05" value="${sound.sfxVol}"></label>
    <label class="row"><input type="checkbox" id="s-music" ${sound.musicOn ? 'checked' : ''}> 背景音乐（运河时代华尔兹 / 铁路时代进行曲）</label>
    <label class="row">音乐音量 <input type="range" id="s-musicv" min="0" max="1" step="0.05" value="${sound.musicVol}"></label>
    <label class="row"><input type="checkbox" id="s-narrate" ${coach.narrateOn ? 'checked' : ''}> 教程语音讲解</label>
    <label class="row"><input type="checkbox" id="s-notify"> 轮到我时发送浏览器通知</label>
    <div class="modal-actions"><button class="btn primary" data-close>完成</button></div>`,
    { cls: 'settings' }
  );
  $('#s-sfx', root).onchange = (e) => (sound.unlock(), sound.setSfx(e.target.checked), sound.play('click'));
  $('#s-sfxv', root).oninput = (e) => sound.setSfxVol(Number(e.target.value));
  $('#s-sfxv', root).onchange = () => sound.play('build', 'goods');
  $('#s-music', root).onchange = (e) => (sound.unlock(), sound.setMusic(e.target.checked));
  $('#s-musicv', root).oninput = (e) => sound.setMusicVol(Number(e.target.value));
  $('#s-narrate', root).onchange = (e) => coach.setNarrate(e.target.checked);
  const nt = $('#s-notify', root);
  nt.checked = 'Notification' in window && Notification.permission === 'granted';
  nt.onchange = () => 'Notification' in window && Notification.requestPermission();
}

function openRules() {
  openModal(
    `<h2>规则速览</h2>
    <div class="rules">
      <h3>目标</h3><p>游戏分<b>运河时代</b>和<b>铁路时代</b>。每个时代结束时，你修的每段线路按两端城镇的「↔」图标计分，<b>翻面</b>的工厂按板块上的分数计分。两个时代后分数最高者获胜（同分比收入，再比现金）。</p>
      <h3>轮与行动</h3><p>每轮每人 2 个行动（运河时代第 1 轮只有 1 个），每个行动都要弃 1 张手牌，回合结束补到 8 张。所有人手牌打光，时代结束。本轮<b>花钱最少</b>的人下一轮先行动。每轮结束按<b>收入等级</b>领钱（负数就要付钱）。</p>
      <h3>六种行动</h3>
      <p><b>建造</b>：地点牌可在那个城镇建；产业牌可在你网络内（有你工厂的城镇或你线路的两端）建该产业；万能牌随意。从产业板上最低等级的那块开始建。运河时代每个城镇每人最多 1 座；能放单一图标格子时必须放那里。</p>
      <p><b>网络</b>：运河 £3；铁路 £5 + 1 块煤，或一次两段 £15 + 2 块煤 + 1 桶啤酒。线路必须连着你的网络（场上还没有你的东西时随便放）。</p>
      <p><b>开发</b>：花 1 块铁移除产业板上的 1 块板块（最多 2 块），让高级工厂提前出场。带灯泡的陶瓷厂不能开发。</p>
      <p><b>出售</b>：把棉纺厂 / 制造厂 / 陶瓷厂的货卖给连通的、收购这种货的商人，并喝掉所需的啤酒（自己的酿酒厂随便用；别人的要连通；也可以喝那个商人的啤酒，还有奖励）。卖完工厂<b>翻面</b>。</p>
      <p><b>贷款</b>：拿 £30，收入降 3 级。<b>侦察</b>：弃 3 张换万能地点 + 万能产业牌。<b>跳过</b>：只弃牌。</p>
      <h3>煤、铁、啤酒</h3><p><b>煤</b>：从连通的最近的煤矿拿（免费，谁的都行）；没有就从市场买，但这个城镇要连到商人。<b>铁</b>：任何炼铁厂都能拿（不需要连通），没有就从市场买。煤矿 / 炼铁厂 / 酿酒厂被拿空就<b>翻面</b>，主人收入上升——所以别人用你的煤也是帮你。煤矿连着商人、炼铁厂无论如何，建好时会把方块卖给市场换钱。</p>
      <h3>时代交替</h3><p>运河时代结束：计分后拆掉所有运河与Ⅰ级工厂，牌全部重洗。铁路时代不能建「仅运河」的板块（Ⅰ级），要先开发掉。</p>
      <h3>覆盖建造</h3><p>可以用更高级的同种工厂覆盖自己的工厂；场上（含市场）一块煤都没有时可以覆盖别人的煤矿，铁也一样。</p>
      <h3>快捷键</h3><p>B 建造，N 网络，D 开发，S 出售，L 贷款，H 提示，M 产业板，Esc 取消，+ / − 缩放，0 复位视角。</p>
    </div>
    <div class="modal-actions"><button class="btn primary" data-close>明白了</button></div>`,
    { cls: 'rules-modal' }
  );
}

// ======================= 邀请在线玩家 =======================
const STATUS_TEXT = { idle: '空闲', room: '在房间中', playing: '对局中' };
let onlineTimer = null;
function startOnlinePolling() {
  if (onlineTimer) return;
  const tick = () => {
    if (document.body.dataset.screen !== 'lobby' || !S.connected) {
      clearInterval(onlineTimer);
      onlineTimer = null;
      return;
    }
    send('online');
  };
  tick();
  onlineTimer = setInterval(tick, 4000);
}
function renderOnline(list) {
  const box = $('#online-list');
  if (!box || !S.room) return;
  const meP = S.room.players.find((p) => p.id === S.you);
  const full = S.room.players.length >= S.room.max;
  $('#online-count').textContent = list.length ? `${list.length} 人在线` : '';
  if (!list.length) {
    box.innerHTML = '<li class="empty">现在没有其他在线玩家。把上面的链接发给朋友吧。</li>';
    return;
  }
  box.innerHTML = list.map((u) => `<li class="ol-row"><span class="ol-dot ${u.status}"></span><span class="ol-name">${esc(u.username)}</span><span class="ol-status">${STATUS_TEXT[u.status] || ''}</span><button class="mini ${u.invited ? 'ghost' : ''}" data-invite="${u.id}" ${!meP || full || u.invited ? 'disabled' : ''}>${u.invited ? '已邀请' : '邀请'}</button></li>`).join('');
  $$('[data-invite]', box).forEach((b) =>
    b.addEventListener('click', () => {
      sound.play('click');
      send('invite', { userId: Number(b.dataset.invite) });
      b.disabled = true;
      b.textContent = '已邀请';
    })
  );
}
function showInvite(d) {
  if (!S.user) return;
  const root = $('#invite-root');
  for (const el of $$('.invite-card', root)) if (el.dataset.code === d.code) el.remove();
  const inGame = S.game && S.game.phase !== 'ended' && S.room && S.room.code !== d.code && S.you;
  const other = d.game && d.game !== 'brass';
  const card = document.createElement('div');
  card.className = 'invite-card';
  card.dataset.code = d.code;
  card.innerHTML = `<div class="ic-text"><b>${esc(d.from)}</b> 邀请你${other ? `玩${esc(d.gameName)}，` : ''}加入「${esc(d.title)}」<small>${esc(d.detail || '')}，已有 ${d.players} / ${d.max} 人${inGame ? '。接受后，你当前的对局将暂时由电脑代打' : ''}</small></div>
    <div class="ic-btns"><button class="btn ghost ic-no">忽略</button><button class="btn primary ic-yes">加入</button></div><i class="ic-timer"></i>`;
  root.prepend(card);
  while (root.children.length > 3) root.lastChild.remove();
  const close = () => {
    card.classList.add('out');
    setTimeout(() => card.remove(), 250);
  };
  const timer = setTimeout(() => (send('inviteReply', { game: d.game || 'brass', fromUser: d.fromUser, code: d.code, accept: false }), close()), 60000);
  card.querySelector('.ic-yes').onclick = () => {
    clearTimeout(timer);
    if (other) return void (location.href = `${d.path}?room=${encodeURIComponent(d.code)}`);
    sound.unlock();
    closeModal();
    send('join', { code: d.code });
    card.remove();
  };
  card.querySelector('.ic-no').onclick = () => {
    clearTimeout(timer);
    send('inviteReply', { game: d.game || 'brass', fromUser: d.fromUser, code: d.code, accept: false });
    close();
  };
  sound.play('join');
}

// ======================= 语音 =======================
function renderVoice() {
  const st = voice.stateByPid();
  for (const el of $$('#players .pl, #lobby-players .slot')) {
    const v = st[el.dataset.pid];
    el.classList.toggle('mic-on', !!(v && !v.muted));
    el.classList.toggle('speaking', !!(v && v.speaking));
  }
  const n = voice.listeners();
  for (const b of $$('.vb-spk')) {
    b.classList.toggle('off', !voice.speakerOn);
    b.title = voice.speakerOn ? `扬声器已开（语音频道 ${n} 人），点击静音` : '扬声器已关闭，点击收听';
    b.querySelector('use').setAttribute('href', voice.speakerOn ? '#ic-spk' : '#ic-spk-off');
  }
  for (const b of $$('.vb-mic')) {
    b.classList.toggle('on', voice.micOn);
    b.classList.toggle('talking', voice.selfSpeaking);
    b.classList.toggle('unsupported', !voice.micSupported);
    b.title = !voice.micSupported ? '麦克风需要 HTTPS 才能使用' : voice.micOn ? '麦克风已打开，点击关闭' : '麦克风已关闭，点击开始说话';
    b.querySelector('use').setAttribute('href', voice.micOn ? '#ic-mic' : '#ic-mic-off');
  }
}

// ======================= 提示 =======================
function toast(msg, kind = '') {
  const root = $('#toast-root');
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  for (const old of root.children) if (old.textContent === msg) old.remove();
  root.appendChild(t);
  while (root.children.length > 3) root.firstChild.remove();
  setTimeout(() => t.classList.add('out'), 2800);
  setTimeout(() => t.remove(), 3300);
}

// ======================= 初始化 =======================
function initGameUI() {
  $('#btn-settings').onclick = openSettings;
  $('#btn-rules').onclick = openRules;
  $('#btn-more').onclick = () => {
    const root = openModal(
      `<h2>菜单</h2><div class="menu-list">
        <button class="btn" data-m="rules">？ 规则速览</button>
        <button class="btn" data-m="mat">${aicon('a-mat')} 产业板</button>
        <button class="btn" data-m="sound">♪ 声音设置</button>
        <button class="btn" data-m="players">☰ 展开玩家详情</button>
        <button class="btn danger" data-m="leave">⎋ 离开</button></div>
        <div class="modal-actions"><button class="btn primary" data-close>返回游戏</button></div>`,
      { cls: 'menu-modal' }
    );
    const go = { rules: openRules, mat: () => openMat(), sound: openSettings, players: () => (closeModal(), document.body.classList.toggle('players-open')), leave: () => $('#btn-leave').click() };
    $$('[data-m]', root).forEach((b) => b.addEventListener('click', () => go[b.dataset.m]()));
  };
  $('#btn-mat').onclick = () => openMat();
  $('#btn-leave').onclick = () => {
    const g = S.game;
    const playing = g && g.phase !== 'ended' && me();
    const root = openModal(
      `<h2>离开${S.room && S.room.tutorial ? '教程' : '游戏'}？</h2><p class="muted">${S.room && S.room.tutorial ? '教程会结束，可以随时从首页重新开始。' : playing ? '离开期间由电脑替你操作。之后在首页点「回到对局」，或重新打开邀请链接，就能接回自己的位置。' : '你将返回首页。'}</p>
      <div class="modal-actions"><button class="btn ghost" data-close>留下</button><button class="btn danger" id="leave-ok">离开</button></div>`,
      { cls: 'confirm' }
    );
    $('#leave-ok', root).onclick = () => (closeModal(), send('leave'));
  };
  $('#zoom-in').onclick = () => board.zoom(1 / 1.25);
  $('#zoom-out').onclick = () => board.zoom(1.25);
  $('#zoom-fit').onclick = () => board.toggleFit();
  $$('.rtab').forEach((b) =>
    b.addEventListener('click', () => {
      S.rightTab = b.dataset.tab;
      if (S.rightTab === 'chat') S.unread = 0;
      renderTabs();
    })
  );
  const sendChat = (input) => {
    const text = input.value.trim();
    if (!text) return;
    send('chat', { text });
    input.value = '';
  };
  $('#chat-form').addEventListener('submit', (e) => (e.preventDefault(), sendChat($('#chat-input'))));
  $('#lobby-chat-form').addEventListener('submit', (e) => (e.preventDefault(), sendChat($('#lobby-chat-input'))));
  $$('.emote').forEach((b) => b.addEventListener('click', () => send('chat', { text: b.textContent, emote: true })));
  $('#toggle-side').onclick = () => {
    document.body.classList.toggle('side-open');
    document.body.classList.remove('players-open');
    S.unread = 0;
    S.rightTab = 'chat';
    renderTabs();
  };
  $('#toggle-players').onclick = () => {
    document.body.classList.toggle('players-open');
    document.body.classList.remove('side-open');
  };
  $('#board-wrap').addEventListener('pointerdown', () => document.body.classList.remove('players-open', 'side-open'));
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) return;
    if (document.body.dataset.screen !== 'game' || !S.game) return;
    const k = e.key.toLowerCase();
    if (k === 'escape') {
      if ($('#modal-root').dataset.kind) closeModal();
      else if (S.flow) closeSheet();
      else if (S.selCard) ((S.selCard = null), renderHand(), renderHot());
      return;
    }
    if ($('#modal-root').dataset.kind) return;
    if (k === '+' || k === '=') board.zoom(1 / 1.25);
    else if (k === '-') board.zoom(1.25);
    else if (k === '0') board.toggleFit();
    else if (k === 'm') openMat();
    if (!isMyTurn()) return;
    const map = { b: 'build', n: 'network', d: 'develop', s: 'sell', l: 'loan' };
    if (map[k]) {
      const btn = $(`[data-act="${map[k]}"]`);
      if (btn && !btn.disabled) startFlow(map[k]);
    } else if (k === 'h') askHint();
  });
  const unlock = () => sound.unlock();
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });
  for (const b of $$('.vb-spk')) b.addEventListener('click', () => (sound.unlock(), voice.toggleSpeaker()));
  for (const b of $$('.vb-mic')) b.addEventListener('click', () => (sound.unlock(), voice.toggleMic()));
  document.addEventListener('visibilitychange', () => !document.hidden && S.game && renderGame());
}

upgradeToHttps();
initHome();
initLobby();
initGameUI();
renderTabs();
renderVoice();
connect();
