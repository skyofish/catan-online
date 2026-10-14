import { sound } from './audio.js';
import { BoardView, RES_LIST, RES_NAME, TERRAIN_NAME } from './board.js';
import * as fx from './fx.js';
import { Voice } from './voice.js';

// ======================= 基础 =======================
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
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

const COST = {
  road: { wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
  city: { wheat: 2, ore: 3 },
  dev: { sheep: 1, wheat: 1, ore: 1 },
};
const DEV = {
  knight: { name: '骑士', desc: '移动强盗，并从相邻玩家处偷取 1 张资源。累计 3 张可争夺「最大军队」。' },
  vp: { name: '胜利点', desc: '直接计入 1 分，对其他玩家保密，无需打出。' },
  road: { name: '道路建设', desc: '免费建造 2 条道路。' },
  plenty: { name: '丰收之年', desc: '从银行拿取任意 2 张资源。' },
  monopoly: { name: '垄断', desc: '指定一种资源，所有其他玩家必须把该资源全部交给你。' },
};
const COLORS = ['#e53935', '#1e88e5', '#fb8c00', '#f5f5f5', '#43a047', '#8e24aa', '#6d4c41', '#00acc1'];
const icon = (r, cls = '') => `<svg class="ico ${cls}" viewBox="0 0 32 32" aria-hidden="true"><use href="#i-${r}"/></svg>`;
const costHTML = (c) => Object.entries(c).map(([k, n]) => `<span class="cost">${n > 1 ? `<em>${n}</em>` : ''}${icon(k)}</span>`).join('');
const hasRes = (have, need) => have && Object.entries(need).every(([k, n]) => (have[k] || 0) >= n);
const sum = (r) => (r ? RES_LIST.reduce((s, k) => s + (r[k] || 0), 0) : 0);
const resText = (r) => RES_LIST.filter((k) => r[k]).map((k) => `${r[k]} ${RES_NAME[k]}`).join('，');

// 从 HTTP 自动跳转到 HTTPS 时，登录状态通过网址片段（#s=…，不会发给服务器）带过来
(() => {
  const m = location.hash.match(/^#s=([^&]+)/);
  if (!m) return;
  try {
    localStorage.setItem('catan.session', JSON.stringify(decodeURIComponent(m[1])));
  } catch {}
  history.replaceState(null, '', location.pathname + location.search);
})();

const S = {
  ws: null,
  session: LS.get('catan.session', null),
  user: null,
  room: null,
  you: null,
  game: null,
  board: null,
  gameId: null,
  mode: null,
  chat: [],
  unread: 0,
  rightTab: 'log',
  homeTab: 'rooms',
  queue: Promise.resolve(),
  prevHand: null,
  lastLogId: 0,
  connected: false,
  retry: 0,
  tradeDraft: { give: {}, get: {} },
  bankDraft: { give: null, get: null, times: 1 },
  seenTradeId: null,
  overShown: false,
  seenSlots: new Set(),
};
window.__S = S;
const voice = new Voice({ send: (t, d) => S.ws && S.ws.readyState === 1 && S.ws.send(JSON.stringify({ t, d })), onChange: () => renderVoice(), toast: (m, k) => toast(m, k) });
window.__voice = voice;

// ======================= 网络 =======================
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  S.ws = ws;
  ws.onopen = () => {
    S.connected = true;
    S.retry = 0;
    setConn(true);
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
    setConn(false);
    const delay = Math.min(8000, 500 * 2 ** S.retry++);
    setTimeout(connect, delay);
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
function setConn(ok) {
  document.body.classList.toggle('offline', !ok);
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (S.session) headers.Authorization = 'Bearer ' + S.session;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/login') signedOut();
    const e = new Error(data.error || '请求失败，请稍后再试');
    e.status = res.status;
    throw e;
  }
  return data;
}

function signedOut(reason) {
  voice.leave();
  S.session = null;
  S.user = null;
  LS.set('catan.session', null);
  S.room = null;
  S.game = null;
  S.board = null;
  S.gameId = null;
  closeModal();
  showScreen('login');
  if (reason) showLoginError(reason);
}

function onMessage(t, d) {
  switch (t) {
    case 'hello': {
      S.user = d.user;
      $('#me-name').textContent = d.user.username;
      const params = new URLSearchParams(location.search);
      const code = params.get('room') || sessionStorage.getItem('catan.room');
      if (code) send('join', { code });
      else showScreen('home');
      send('list');
      break;
    }
    case 'auth':
      signedOut();
      break;
    case 'kicked':
      signedOut(d.reason);
      sound.play('error');
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
    case 'error':
      toast(d.msg, 'error');
      sound.play('error');
      if (/房间不存在/.test(d.msg)) {
        sessionStorage.removeItem('catan.room');
        history.replaceState(null, '', location.pathname);
        showScreen('home');
      }
      break;
    case 'toast':
      toast(d.msg);
      break;
    case 'left':
      voice.leave();
      S.room = null;
      S.game = null;
      S.board = null;
      S.gameId = null;
      sessionStorage.removeItem('catan.room');
      history.replaceState(null, '', location.pathname);
      if (d && d.kicked) toast('你被房主移出了房间', 'warn');
      closeModal();
      showScreen('home');
      send('list');
      break;
  }
}

// ======================= 屏幕切换 =======================
function showScreen(name) {
  const login = name === 'login';
  const target = login ? 'home' : name;
  for (const s of $$('.screen')) s.hidden = s.id !== `screen-${target}`;
  document.body.dataset.screen = name;
  $('#login-form').hidden = !login;
  $('#ledger-main').hidden = login;
  if (target === 'home') loadDemo();
  if (login) setTimeout(() => $('#login-name').focus(), 50);
  if (name === 'home') refreshHomeTab();
}

// ======================= 登录 =======================
function showLoginError(msg) {
  const el = $('#login-error');
  el.textContent = msg || '';
  el.hidden = !msg;
}

function initLogin() {
  const last = LS.get('catan.lastUser', '');
  if (last) $('#login-name').value = last;
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    sound.unlock();
    const username = $('#login-name').value.trim();
    if (!username) return showLoginError('请输入账号');
    const btn = $('#btn-login');
    btn.disabled = true;
    showLoginError('');
    try {
      const r = await api('/api/login', { method: 'POST', body: { username } });
      S.session = r.token;
      LS.set('catan.session', r.token);
      LS.set('catan.lastUser', r.user.username);
      sound.play('join');
      send('hello', { session: S.session });
    } catch (err) {
      showLoginError(err.message);
      sound.play('error');
    } finally {
      btn.disabled = false;
    }
  });
  $('#btn-logout').addEventListener('click', async () => {
    try {
      await api('/api/logout', { method: 'POST' });
    } catch {}
    signedOut();
    send('hello', { session: null });
  });
}

// ======================= 首页 =======================
let demoView = null;
async function loadDemo() {
  const svg = $('#demo-board');
  if (!svg || svg.dataset.loaded) return;
  svg.dataset.loaded = '1';
  try {
    const res = await fetch('/api/demo?size=' + (S.createSize || 6));
    const b = await res.json();
    demoView = demoView || new BoardView(svg, { vertex() {}, edge() {}, tile() {} });
    demoView.setBoard(b, true);
  } catch {}
}

function initHome() {
  S.createSize = 4;
  $$('#size-pick button').forEach((b) =>
    b.addEventListener('click', () => {
      sound.unlock();
      sound.play('click');
      S.createSize = Number(b.dataset.size);
      $$('#size-pick button').forEach((x) => x.setAttribute('aria-pressed', x === b));
      $('#opt-special').checked = S.createSize > 4;
      $('#opt-vp').value = S.createSize === 8 ? 12 : 10;
      $('#demo-board').dataset.loaded = '';
      loadDemo();
    })
  );
  $('#btn-create').addEventListener('click', () => {
    sound.unlock();
    send('create', {
      size: S.createSize,
      targetVP: Number($('#opt-vp').value),
      specialBuild: $('#opt-special').checked,
      private: $('#opt-private').checked,
    });
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
    const { rows } = await api('/api/leaderboard');
    if (!rows.length) {
      box.innerHTML = '<p class="empty">还没有完成的对局。打完第一局，这里就会出现排名。</p>';
      return;
    }
    box.innerHTML = `<table class="rank-table">
      <thead><tr><th>名次</th><th>玩家</th><th>胜 / 局</th><th>胜率</th><th>平均分</th></tr></thead>
      <tbody>${rows
        .map(
          (r, i) => `<tr class="${S.user && r.id === S.user.id ? 'me' : ''}">
          <td class="rk">${i + 1}</td><td class="nm">${esc(r.username)}</td>
          <td>${r.wins} / ${r.games}</td><td>${pct(r.wins, r.games)}</td><td>${r.avg_vp}</td></tr>`
        )
        .join('')}</tbody></table>`;
  } catch (e) {
    box.innerHTML = `<p class="empty">${esc(e.message)}</p>`;
  }
}

async function loadMine() {
  const box = $('#htab-mine');
  if (!box.innerHTML) box.innerHTML = '<p class="empty">加载中…</p>';
  try {
    const { stats, recent } = await api('/api/me');
    const g = stats.games || 0;
    box.innerHTML = `<dl class="my-stats">
        <div><dt>对局</dt><dd>${g}</dd></div>
        <div><dt>胜场</dt><dd>${stats.wins || 0}</dd></div>
        <div><dt>胜率</dt><dd>${pct(stats.wins, g)}</dd></div>
        <div><dt>平均分</dt><dd>${stats.avg_vp ?? '—'}</dd></div>
      </dl>
      ${
        recent.length
          ? `<h3>最近对局</h3><ul class="recent">${recent
              .map(
                (m) => `<li class="${m.is_winner ? 'won' : ''}">
              <span class="rc-rank">${m.is_winner ? '胜' : `第 ${m.rank}`}</span>
              <span class="rc-main">${m.size} 人地图，${m.players} 人参加，${m.turns} 回合<small>${fmtDate(m.ended_at)}${m.is_winner ? '' : `，${esc(m.winner || '')} 获胜`}</small></span>
              <span class="rc-vp">${m.vp} 分</span></li>`
              )
              .join('')}</ul>`
          : '<p class="empty">你还没有完成过对局。</p>'
      }`;
  } catch (e) {
    box.innerHTML = `<p class="empty">${esc(e.message)}</p>`;
  }
}

function renderRoomList(list) {
  const box = $('#room-list');
  if (!box) return;
  if (!list.length) {
    box.innerHTML = `<p class="empty">还没有公开房间。创建一个，把链接发给朋友吧。</p>`;
    return;
  }
  box.innerHTML = list
    .map(
      (r) => `<button class="room-row ${r.mine ? 'mine' : ''}" data-code="${r.code}">
      <span class="rr-title">${esc(r.title)}</span>
      <span class="rr-meta">${r.size} 人地图</span>
      <span class="rr-count">${r.players}/${r.max}</span>
      <span class="rr-state ${r.started && !r.mine ? 'on' : ''}">${r.mine ? (r.ended ? '查看' : '回到对局') : r.ended ? '已结束' : r.started ? '观战' : '加入'}</span>
    </button>`
    )
    .join('');
  $$('.room-row', box).forEach((b) =>
    b.addEventListener('click', () => {
      sound.unlock();
      send('join', { code: b.dataset.code });
    })
  );
}

// ======================= 房间 / 大厅 =======================
async function applyRoom(d) {
  const prevRoom = S.room;
  S.room = d.room;
  S.you = d.you;
  sessionStorage.setItem('catan.room', d.room.code);
  if (new URLSearchParams(location.search).get('room') !== d.room.code) history.replaceState(null, '', `?room=${d.room.code}`);

  if (!d.game) {
    S.game = null;
    S.gameId = null;
    S.overShown = false;
    if (prevRoom && prevRoom.players.length < d.room.players.length) sound.play('join');
    showScreen('lobby');
    renderLobby();
    return;
  }

  const fresh = S.gameId !== d.room.gameId || !S.board;
  if (d.game.board) S.board = d.game.board;
  const prevGame = S.game;
  const events = d.events || [];

  if (document.body.dataset.screen !== 'game') {
    showScreen('game');
    S.mode = null;
  }
  if (fresh) {
    S.gameId = d.room.gameId;
    S.overShown = false;
    S.prevHand = null;
    S.lastLogId = 0;
    board.setBoard(S.board, true);
    const isStart = events.some((e) => e.type === 'start');
    if (isStart) {
      sound.play('join');
      for (let i = 0; i < Math.min(S.board.tiles.length, 25); i++) setTimeout(() => sound.play('tile'), i * 45);
    }
  }

  // 骰子先动画，再刷新状态
  const roll = events.find((e) => e.type === 'roll');
  if (roll && !document.hidden) {
    sound.play('dice');
    const anchor = fx.center($('#board-wrap'));
    await new Promise((res) => fx.rollDice(roll.dice[0], roll.dice[1], anchor, res));
  }

  S.game = d.game;
  if (S.mode && !modeValid()) S.mode = null;
  renderGame(!fresh || events.length > 0);
  if (!document.hidden) playEvents(events, prevGame);
  else for (const e of events) if (e.type === 'win') setTimeout(showGameOver, 300);
}

function renderLobby() {
  const r = S.room;
  const isHost = r.host === S.you;
  const me = r.players.find((p) => p.id === S.you);
  $('#lobby-title').textContent = r.title;
  $('#lobby-code').textContent = r.code;
  const link = `${location.origin}${location.pathname}?room=${r.code}`;
  $('#lobby-link').value = link;

  const sizeBox = $('#lobby-size');
  sizeBox.innerHTML = [4, 6, 8]
    .map((s) => `<button data-size="${s}" aria-pressed="${r.size === s}" ${isHost ? '' : 'disabled'}><b>${s} 人</b><small>${{ 4: '19', 6: '30', 8: '43' }[s]} 块地形</small></button>`)
    .join('');
  $$('button', sizeBox).forEach((b) => b.addEventListener('click', () => send('settings', { size: Number(b.dataset.size) })));
  $('#lobby-vp').value = r.targetVP;
  $('#lobby-vp').disabled = !isHost;
  $('#lobby-special').checked = r.specialBuild;
  $('#lobby-special').disabled = !isHost;

  const slots = [];
  for (let i = 0; i < r.max; i++) {
    const p = r.players[i];
    if (!p) {
      slots.push(`<li class="slot empty"><span class="chip"></span><span class="pn">等待玩家加入…</span></li>`);
      continue;
    }
    const isNew = !S.seenSlots.has(p.id);
    S.seenSlots.add(p.id);
    slots.push(`<li class="slot ${p.id === S.you ? 'me' : ''} ${p.connected ? '' : 'off'} ${isNew ? 'new' : ''}" data-pid="${p.id}">
      <span class="chip" style="--pc:${p.color}"></span>
      <span class="pn">${esc(p.name)}${p.id === r.host ? '<em class="tag host">房主</em>' : ''}${p.id === S.you ? '<em class="tag">你</em>' : ''}${p.connected ? '' : '<em class="tag off">离线</em>'}<span class="vmic" title="麦克风已打开"></span></span>
      ${isHost && p.id !== r.host ? `<button class="mini ghost" data-kick="${p.id}" aria-label="移出 ${esc(p.name)}">移出</button>` : ''}
    </li>`);
  }
  $('#lobby-players').innerHTML = slots.join('');
  $$('[data-kick]').forEach((b) => b.addEventListener('click', () => send('kick', { pid: b.dataset.kick })));
  renderVoice();
  $('#lobby-count').textContent = `${r.players.length} / ${r.max}`;

  // 颜色选择
  const used = new Set(r.players.filter((p) => p.id !== S.you).map((p) => p.color));
  $('#lobby-colors').innerHTML = me
    ? COLORS.map((c) => `<button class="swatch" style="--pc:${c}" data-color="${c}" aria-pressed="${me.color === c}" ${used.has(c) ? 'disabled' : ''} aria-label="选择颜色"></button>`).join('')
    : '<span class="muted">观战中</span>';
  $$('[data-color]').forEach((b) => b.addEventListener('click', () => send('color', { color: b.dataset.color })));

  $('#btn-addbot').hidden = !isHost;
  $('#btn-addbot').disabled = r.players.length >= r.max;
  $('#btn-start').hidden = !isHost;
  $('#btn-start').disabled = r.players.length < 2;
  $('#lobby-wait').hidden = isHost;
  $('#lobby-wait').textContent = me ? '等待房主开始游戏…' : '房间已满，你正在观战。';
}

function initLobby() {
  $('#btn-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#lobby-link').value);
      toast('邀请链接已复制');
    } catch {
      $('#lobby-link').select();
      document.execCommand('copy');
      toast('邀请链接已复制');
    }
    sound.play('coin');
  });
  $('#btn-addbot').addEventListener('click', () => {
    sound.play('click');
    send('addBot');
  });
  $('#btn-start').addEventListener('click', () => {
    sound.unlock();
    send('start');
  });
  $('#btn-leave-lobby').addEventListener('click', () => send('leave'));
  $('#lobby-vp').addEventListener('change', (e) => send('settings', { targetVP: Number(e.target.value) }));
  $('#lobby-special').addEventListener('change', (e) => send('settings', { specialBuild: e.target.checked }));
}

// ======================= 游戏渲染 =======================
const board = new BoardView($('#board'), {
  vertex: (id) => {
    const g = S.game;
    if (S.mode === 'city') act('city', { vertex: id });
    else act('settlement', { vertex: id });
    if (g.phase !== 'setup') S.mode = null;
  },
  edge: (id) => {
    act('road', { edge: id });
    if (S.game.phase !== 'setup' && S.game.sub !== 'roadBuilding') S.mode = null;
  },
  tile: (id) => act('robber', { tile: id }),
  select: (on) => {
    const [, , hint] = currentHotspots();
    $('#hint').textContent = on ? '已选中，再点一次确认' : hint || '';
    $('#hint').hidden = !on && !hint;
    if (on) sound.play('click');
  },
});

const me = () => S.game && S.game.players.find((p) => p.id === S.you);
const pname = (pid) => {
  const p = S.game && S.game.players.find((x) => x.id === pid);
  return p ? p.name : '?';
};
const pcolor = (pid) => {
  const p = S.game && S.game.players.find((x) => x.id === pid);
  return p ? p.color : '#999';
};
const isMyTurn = () => S.game && S.game.turn === S.you;
const amActive = () => S.game && S.game.active.includes(S.you);

function modeValid() {
  const g = S.game;
  if (!g || !g.me) return false;
  if (S.mode === 'road' || S.mode === 'settlement' || S.mode === 'city') {
    if (g.sub === 'main' && isMyTurn()) return true;
    if (g.sub === 'special' && g.special === S.you) return true;
  }
  return false;
}

function currentHotspots() {
  const g = S.game;
  const m = me();
  if (!g || !g.me || !m || g.phase === 'ended') return [null];
  const L = g.me.legal;
  if (g.phase === 'setup' && isMyTurn()) {
    return g.sub === 'settlement' ? ['vertex', L.settlements, '放置你的第 ' + g.setupRound + ' 个村庄（点击发光的路口' + (board.isTouch() ? '，再点一次确认）' : '）')] : ['edge', L.roads, '为刚放下的村庄连一条道路'];
  }
  if (g.sub === 'roadBuilding' && isMyTurn()) return ['edge', L.roads, `道路建设：再放置 ${g.freeRoads} 条免费道路`];
  if (g.sub === 'robber' && isMyTurn()) return ['tile', S.board.tiles.filter((t) => t.id !== g.robber).map((t) => t.id), '移动强盗：点击一块地形'];
  if (S.mode === 'road') return ['edge', L.roads, '选择修路的位置（Esc 取消）'];
  if (S.mode === 'settlement') return ['vertex', L.settlements, '选择建村庄的路口（Esc 取消）'];
  if (S.mode === 'city') return ['city', L.cities, '选择要升级为城市的村庄（Esc 取消）'];
  return [null];
}

function statusText() {
  const g = S.game;
  if (g.phase === 'ended') return `🏆 ${pname(g.winner)} 获胜！`;
  const cur = pname(g.turn);
  const mine = isMyTurn();
  if (g.phase === 'setup') return mine ? `初始放置（第 ${g.setupRound} 轮）：轮到你` : `初始放置（第 ${g.setupRound} 轮）：等待 ${cur}`;
  switch (g.sub) {
    case 'roll':
      return mine ? '轮到你：掷骰子（或先打出骑士）' : `等待 ${cur} 掷骰子`;
    case 'discard': {
      const n = g.discardPending[S.you];
      return n ? `你需要弃掉 ${n} 张牌` : `等待玩家弃牌：${Object.keys(g.discardPending).map(pname).join('、')}`;
    }
    case 'robber':
      return mine ? '移动强盗到新的地块' : `${cur} 正在移动强盗`;
    case 'steal':
      return mine ? '选择要偷取的玩家' : `${cur} 正在选择偷取对象`;
    case 'roadBuilding':
      return mine ? `道路建设：剩余 ${g.freeRoads} 条` : `${cur} 正在免费修路`;
    case 'special':
      return g.special === S.you ? '特殊建造阶段：你可以建造或购买发展卡' : `特殊建造阶段：${pname(g.special)}`;
    default:
      return mine ? '你的回合：建造、交易或结束回合' : `${cur} 的回合`;
  }
}

function renderGame(animate) {
  const g = S.game;
  board.update(g, { animate });
  const [kind, ids, hint] = currentHotspots();
  board.setHotspots(kind, ids || [], me() ? me().color : '#fff');
  $('#hint').textContent = hint || '';
  $('#hint').hidden = !hint;

  $('#status').textContent = statusText();
  $('#status').style.setProperty('--pc', pcolor(g.special || g.turn));
  $('#room-code').textContent = S.room.code;
  document.body.classList.toggle('my-turn', amActive());

  // 顶部骰子
  const dd = $('#dice-mini');
  if (g.dice) {
    dd.innerHTML = g.dice.map((v) => `<span class="dm">${'⚀⚁⚂⚃⚄⚅'[v - 1]}</span>`).join('') + `<b class="${g.dice[0] + g.dice[1] === 7 ? 'seven' : ''}">${g.dice[0] + g.dice[1]}</b>`;
  } else dd.innerHTML = '<span class="muted">—</span>';
  $('#bank-info').innerHTML = RES_LIST.map((k) => `<span title="银行剩余${RES_NAME[k]}">${icon(k)}${g.bank[k]}</span>`).join('') + `<span id="deck-badge" title="剩余发展卡">${icon('devback')}${g.devLeft}</span>`;

  renderPlayers();
  renderHand();
  renderActions();
  renderLog();
  renderTradePanel();
  renderModals();
}

function renderPlayers() {
  const g = S.game;
  const box = $('#players');
  box.innerHTML = g.players
    .map((p) => {
      const room = S.room.players.find((x) => x.id === p.id) || {};
      const active = g.active.includes(p.id);
      const lr = g.longestRoad === p.id;
      const la = g.largestArmy === p.id;
      const disc = g.discardPending[p.id];
      return `<li data-pid="${p.id}" class="pl ${active ? 'active' : ''} ${p.id === S.you ? 'me' : ''} ${room.connected === false ? 'off' : ''} ${g.winner === p.id ? 'winner' : ''}" id="pl-${p.id}" style="--pc:${p.color}">
        <div class="pl-top">
          <span class="chip"></span>
          <span class="pl-name">${esc(p.name)}</span><span class="vmic" title="麦克风已打开"></span>
          ${room.isBot ? '<em class="tag">电脑</em>' : ''}${room.autoBot ? '<em class="tag off">代管</em>' : ''}${room.connected === false && !room.autoBot ? '<em class="tag off">离线</em>' : ''}
          <span class="vp" title="胜利点">${p.vp}<small>分</small></span>
        </div>
        <div class="pl-stats">
          <span class="st ${p.resCount > 7 ? 'warn' : ''}" title="资源手牌">${icon('resback')}${p.resCount}</span>
          <span class="st" title="发展卡">${icon('devback')}${p.devCount}</span>
          <span class="st ${la ? 'award' : ''}" title="已打出骑士${la ? '（最大军队 +2）' : ''}">${icon('knight-s')}${p.knights}</span>
          <span class="st ${lr ? 'award' : ''}" title="最长道路${lr ? '（+2）' : ''}">${icon('road-s')}${p.roadLen}</span>
        </div>
        ${disc ? `<div class="pl-note">需要弃 ${disc} 张</div>` : ''}
        ${S.room.host === S.you && room.connected === false && !room.isBot ? `<button class="mini ghost" data-takeover="${p.id}">${room.autoBot ? '取消代管' : '电脑代管'}</button>` : ''}
      </li>`;
    })
    .join('');
  $$('[data-takeover]').forEach((b) => b.addEventListener('click', () => send('takeover', { pid: b.dataset.takeover })));
  renderVoice();
}

function renderHand() {
  const m = me();
  const box = $('#hand');
  if (!m) {
    box.innerHTML = '<p class="muted">观战中</p>';
    $('#devhand').innerHTML = '';
    return;
  }
  const prev = S.prevHand;
  box.innerHTML = RES_LIST.map((k) => {
    const n = m.res[k];
    const up = prev && n > prev[k];
    const down = prev && n < prev[k];
    return `<div class="hcard res-${k} ${n ? '' : 'zero'} ${up ? 'up' : ''} ${down ? 'down' : ''}" id="hand-${k}" title="${RES_NAME[k]}">
      ${icon(k)}<b>${n}</b><small>${RES_NAME[k]}</small></div>`;
  }).join('');
  S.prevHand = { ...m.res };

  // 发展卡
  const g = S.game;
  const groups = {};
  for (const d of m.dev) {
    groups[d.type] = groups[d.type] || { n: 0, fresh: 0 };
    groups[d.type].n++;
    if (d.turn >= g.turnCount) groups[d.type].fresh++;
  }
  const canPlayNow = isMyTurn() && ['roll', 'main'].includes(g.sub) && !g.devPlayed && g.phase === 'play';
  $('#devhand').innerHTML = Object.keys(groups).length
    ? Object.entries(groups)
        .map(([t, info]) => {
          const playable = t !== 'vp' && canPlayNow && info.n > info.fresh;
          return `<button class="devcard dev-${t} ${playable ? 'playable' : ''}" data-dev="${t}" ${playable ? '' : 'aria-disabled="true"'} title="${DEV[t].name}：${DEV[t].desc}${info.fresh ? `（${info.fresh} 张本回合刚买，下回合可用）` : ''}">
          <svg viewBox="0 0 32 32"><use href="#d-${t}"/></svg><span>${DEV[t].name}</span>${info.n > 1 ? `<em>×${info.n}</em>` : ''}</button>`;
        })
        .join('')
    : '<p class="muted small">暂无发展卡</p>';
  $$('#devhand [data-dev]').forEach((b) => b.addEventListener('click', () => playDev(b.dataset.dev, b.classList.contains('playable'))));
}

function renderActions() {
  const g = S.game;
  const m = me();
  const box = $('#actions');
  if (!m || g.phase === 'ended') {
    box.innerHTML = g.phase === 'ended' ? `<button class="btn primary" id="btn-over">查看结果</button>` : '';
    if ($('#btn-over')) $('#btn-over').onclick = showGameOver;
    return;
  }
  const mine = isMyTurn() && g.phase === 'play';
  const special = g.sub === 'special' && g.special === S.you;
  const main = (mine && g.sub === 'main') || special;
  const L = g.me.legal;
  const can = {
    road: main && hasRes(m.res, COST.road) && m.pieces.road > 0 && L.roads.length > 0,
    settlement: main && hasRes(m.res, COST.settlement) && m.pieces.settlement > 0 && L.settlements.length > 0,
    city: main && hasRes(m.res, COST.city) && m.pieces.city > 0 && L.cities.length > 0,
    dev: main && hasRes(m.res, COST.dev) && g.devLeft > 0,
  };
  const why = (k) => {
    if (!main) return '现在不能建造';
    if (!hasRes(m.res, COST[k])) return '资源不足';
    if (k === 'dev') return g.devLeft ? '' : '发展卡已售罄';
    if (m.pieces[k] <= 0) return '棋子已用完';
    return '没有可建造的位置';
  };
  const btn = (id, label, cost, ok, key, extra = '') =>
    `<button class="btn build ${S.mode === id ? 'on' : ''}" data-act="${id}" ${ok ? '' : `disabled title="${why(id)}"`} ${extra}>
      <span class="bl">${label}${key ? `<kbd>${key}</kbd>` : ''}</span><span class="bc">${costHTML(cost)}</span></button>`;
  const left = `${btn('road', '修路', COST.road, can.road, '1', `data-left="${m.pieces.road}"`)}${btn('settlement', '建村庄', COST.settlement, can.settlement, '2')}${btn('city', '升级城市', COST.city, can.city, '3')}${btn('dev', '发展卡', COST.dev, can.dev, '4')}`;
  let right = '';
  if (g.phase === 'setup') right = `<div class="turn-note">${isMyTurn() ? '在棋盘上点击放置' : '等待其他玩家放置'}</div>`;
  else if (mine && g.sub === 'roll') right = `<button class="btn primary big roll" data-act="roll"><span class="dice-ico">🎲</span>掷骰子<kbd>R</kbd></button>`;
  else if (mine && g.sub === 'main') right = `<button class="btn" data-act="trade">交易<kbd>T</kbd></button><button class="btn primary" data-act="end">结束回合<kbd>E</kbd></button>`;
  else if (special) right = `<button class="btn primary" data-act="endSpecial">完成建造<kbd>E</kbd></button>`;
  else if (mine && g.sub === 'roadBuilding') right = `<button class="btn" data-act="skipRoads">跳过剩余道路</button>`;
  else right = `<div class="turn-note">${esc(statusText())}</div>`;
  box.innerHTML = `<div class="builds">${left}</div><div class="turn-acts">${right}</div>`;
  $$('[data-act]', box).forEach((b) => b.addEventListener('click', () => doAction(b.dataset.act)));
  $('#pieces').innerHTML = `剩余棋子：道路 ${m.pieces.road}，村庄 ${m.pieces.settlement}，城市 ${m.pieces.city}`;
}

function doAction(a) {
  sound.unlock();
  const g = S.game;
  if (a === 'roll') return act('roll');
  if (a === 'end') {
    S.mode = null;
    return act('endTurn');
  }
  if (a === 'endSpecial') {
    S.mode = null;
    return act('endSpecial');
  }
  if (a === 'skipRoads') return act('skipRoads');
  if (a === 'trade') return openTrade();
  if (a === 'dev') return act('buyDev');
  if (['road', 'settlement', 'city'].includes(a)) {
    sound.play('click');
    S.mode = S.mode === a ? null : a;
    renderGame(false);
  }
  void g;
}

function renderLog() {
  const g = S.game;
  const box = $('#log');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.innerHTML = g.log
    .map((l) => `<li ${l.pid ? `style="--pc:${pcolor(l.pid)}"` : ''} class="${l.pid ? 'p' : 'sys'} ${l.id > S.lastLogId && S.lastLogId ? 'new' : ''}">${esc(l.text)}</li>`)
    .join('');
  S.lastLogId = g.log.length ? g.log[g.log.length - 1].id : 0;
  if (atBottom || true) box.scrollTop = box.scrollHeight;
}

function renderChat() {
  const box = $('#chat-list');
  if (!box) return;
  box.innerHTML = S.chat
    .map((c) => (c.sys ? `<li class="sys">${esc(c.text)}</li>` : `<li><b style="color:${c.color === '#f5f5f5' ? '#ddd' : c.color}">${esc(c.name)}</b>${esc(c.text)}</li>`))
    .join('');
  box.scrollTop = box.scrollHeight;
  const lc = $('#lobby-chat-list');
  if (lc) {
    lc.innerHTML = box.innerHTML;
    lc.scrollTop = lc.scrollHeight;
  }
}

function renderTabs() {
  $$('.rtab').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === S.rightTab));
  $('#pane-log').hidden = S.rightTab !== 'log';
  $('#pane-chat').hidden = S.rightTab !== 'chat';
  const badge = $('#chat-badge');
  badge.textContent = S.unread;
  badge.hidden = !S.unread;
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

// ======================= 事件动画 =======================
function playerAnchor(pid) {
  if (pid === S.you) return fx.center($('#hand')) || fx.center($(`#pl-${pid}`));
  return fx.center($(`#pl-${pid} .chip`)) || fx.center($(`#pl-${pid}`));
}
function handAnchor(pid, res) {
  if (pid === S.you && res) return fx.center($(`#hand-${res}`));
  return playerAnchor(pid);
}

function playEvents(events, prevGame) {
  const g = S.game;
  let produceDelay = 0;
  for (const e of events) {
    switch (e.type) {
      case 'turn':
        if (e.pid === S.you) {
          sound.play('turn');
          fx.banner(e.setup ? '轮到你放置' : '轮到你了', e.setup ? '先放村庄，再连一条路' : '掷骰子开始你的回合', me().color, { big: true });
          if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification('卡坦岛：轮到你了！');
        } else {
          sound.play('otherTurn');
          if (!e.setup) fx.banner(`${pname(e.pid)} 的回合`, '', pcolor(e.pid));
        }
        break;
      case 'special':
        if (e.pid === S.you) {
          sound.play('turn');
          fx.banner('特殊建造阶段', '你可以在别人的回合后建造', me().color);
        }
        break;
      case 'roll':
        board.flashNumber(e.dice[0] + e.dice[1]);
        break;
      case 'produce': {
        let i = 0;
        for (const gn of e.gains) {
          const from = board.tileScreen(gn.tile);
          for (let k = 0; k < gn.n; k++) {
            const delay = produceDelay + i * 110;
            fx.flyCard(gn.res, from, handAnchor(gn.pid, gn.res), { delay });
            setTimeout(() => sound.play('gain', gn.res), delay + 550);
            i++;
          }
          if (gn.pid === S.you) fx.floatText(from, `+${gn.n}`, '#fff6d0', { delay: produceDelay });
        }
        produceDelay += i * 110;
        break;
      }
      case 'seven':
        sound.play('seven');
        fx.shake();
        fx.banner('强盗出没！', '手牌超过 7 张的玩家需弃掉一半', '#c2412d', { big: true });
        break;
      case 'build': {
        const p = e.vertex !== undefined ? board.vertexScreen(e.vertex) : board.edgeScreen(e.edge);
        const col = pcolor(e.pid);
        if (e.kind === 'road') {
          sound.play('road');
          fx.burst(p, '#b98a55', 8, { spread: 30, size: 4 });
        } else if (e.kind === 'settlement') {
          sound.play('settlement');
          fx.burst(p, col, 14, { spread: 50 });
          fx.ripple(p, col);
          if (g.phase !== 'setup') fx.floatText(p, '+1 分', '#ffe69a');
        } else {
          sound.play('city');
          fx.burst(p, '#f5d26b', 26, { spread: 80, size: 7, dur: 900 });
          fx.ripple(p, '#f5d26b');
          fx.floatText(p, '城市！+1 分', '#ffe69a', { size: 20 });
        }
        break;
      }
      case 'robber':
        sound.play('robber');
        setTimeout(() => {
          board.shakeTile(e.tile);
          fx.burst(board.tileScreen(e.tile), '#3a3440', 16, { spread: 70, size: 8 });
        }, 350);
        break;
      case 'steal': {
        sound.play('steal');
        const known = e.res && (e.pid === S.you || e.victim === S.you);
        fx.flyCard(known ? e.res : 'back', playerAnchor(e.victim), handAnchor(e.pid, known ? e.res : null), { delay: 500 });
        if (e.victim === S.you) toast(`${pname(e.pid)} 偷走了你的 1 张${RES_NAME[e.res]}`, 'warn');
        if (e.pid === S.you) toast(`你从 ${pname(e.victim)} 偷到了 1 张${RES_NAME[e.res]}`);
        break;
      }
      case 'discard': {
        sound.play('discard');
        const a = playerAnchor(e.pid);
        const bank = fx.center($('#bank-info'));
        for (let i = 0; i < Math.min(e.n, 6); i++) fx.flyCard('back', a, bank, { delay: i * 80, dur: 600 });
        break;
      }
      case 'buyDev': {
        sound.play('card');
        fx.flyCard('back', fx.center($('#deck-badge')), playerAnchor(e.pid), { dur: 800 });
        if (e.pid === S.you && e.card) setTimeout(() => toast(`你获得了发展卡：${DEV[e.card].name}`, 'good'), 700);
        break;
      }
      case 'playDev':
        sound.play('devPlay', e.card);
        fx.showcase(e.card, DEV[e.card].name, `${pname(e.pid)} 打出`);
        break;
      case 'monopoly': {
        let i = 0;
        for (const f of e.from) for (let k = 0; k < Math.min(f.n, 5); k++) fx.flyCard(e.res, playerAnchor(f.pid), handAnchor(e.pid, e.res), { delay: 900 + i++ * 90 });
        setTimeout(() => sound.play('coin'), 1300);
        break;
      }
      case 'bankGive': {
        let i = 0;
        const bank = fx.center($('#bank-info'));
        for (const k of RES_LIST) for (let n = 0; n < e.res[k]; n++) fx.flyCard(k, bank, handAnchor(e.pid, k), { delay: 900 + i++ * 150 });
        break;
      }
      case 'bankTrade': {
        sound.play('coin');
        const bank = fx.center($('#bank-info'));
        let i = 0;
        for (const [k, n] of Object.entries(e.give)) for (let x = 0; x < Math.min(n, 4); x++) fx.flyCard(k, handAnchor(e.pid, k), bank, { delay: i++ * 70, dur: 600 });
        for (const [k, n] of Object.entries(e.get)) for (let x = 0; x < n; x++) fx.flyCard(k, bank, handAnchor(e.pid, k), { delay: 350 + i++ * 70, dur: 650 });
        break;
      }
      case 'tradeOffer':
        if (e.pid !== S.you) sound.play('offer');
        break;
      case 'tradeResponse':
        if (g.trade && g.trade.from === S.you) {
          sound.play(e.accept ? 'offer' : 'click');
          const el = $(`#pl-${e.pid}`);
          fx.pulse(el, e.accept ? 'flash-good' : 'flash-bad');
        }
        break;
      case 'trade': {
        sound.play('trade');
        let i = 0;
        for (const k of RES_LIST) {
          for (let n = 0; n < e.give[k]; n++) fx.flyCard(k, playerAnchor(e.pid), handAnchor(e.with, k), { delay: i++ * 90 });
          for (let n = 0; n < e.get[k]; n++) fx.flyCard(k, playerAnchor(e.with), handAnchor(e.pid, k), { delay: i++ * 90 });
        }
        break;
      }
      case 'award':
        if (e.pid) {
          setTimeout(() => {
            sound.play('award');
            fx.banner(e.award === 'road' ? '最长道路' : '最大军队', `${pname(e.pid)} 获得 2 分`, pcolor(e.pid));
            fx.pulse($(`#pl-${e.pid}`), 'flash-gold');
          }, 600);
        }
        break;
      case 'win':
        setTimeout(() => {
          fx.confetti(g.players.map((p) => p.color).concat(['#f5d26b']));
          sound.play(e.pid === S.you ? 'win' : me() ? 'lose' : 'win');
          fx.banner(e.pid === S.you ? '你赢了！' : `${pname(e.pid)} 获胜`, '', pcolor(e.pid), { big: true });
        }, 700);
        setTimeout(showGameOver, 2600);
        break;
    }
  }
  void prevGame;
}

// ======================= 弹窗 =======================
function openModal(html, { cls = '', dismiss = true, onClose } = {}) {
  closeModal();
  const root = $('#modal-root');
  root.innerHTML = `<div class="backdrop ${dismiss ? 'dismiss' : ''}"><div class="modal ${cls}" role="dialog" aria-modal="true">${html}</div></div>`;
  root.dataset.kind = cls;
  const bd = $('.backdrop', root);
  if (dismiss) bd.addEventListener('click', (e) => e.target === bd && (closeModal(), onClose && onClose()));
  $$('[data-close]', root).forEach((b) => b.addEventListener('click', () => (closeModal(), onClose && onClose())));
  const f = $('input, button.primary, button', root);
  if (f) setTimeout(() => f.focus(), 30);
  return root;
}
function closeModal() {
  const root = $('#modal-root');
  root.innerHTML = '';
  root.dataset.kind = '';
}
const modalKind = () => $('#modal-root').dataset.kind || '';

function renderModals() {
  const g = S.game;
  const m = me();
  const k = modalKind();
  if (!m) return;
  // 弃牌
  const need = g.discardPending[S.you];
  if (g.sub === 'discard' && need) {
    if (k !== 'discard') openDiscard(need);
    return;
  }
  if (k === 'discard') closeModal();
  // 偷取
  if (g.sub === 'steal' && isMyTurn()) {
    if (k !== 'steal') openSteal();
    return;
  }
  if (k === 'steal') closeModal();
  if (k === 'trade' && !(isMyTurn() && g.sub === 'main')) closeModal();
}

function stepper(res, value, max, prefix) {
  return `<div class="stepper res-${res}" data-res="${res}">
    <div class="st-ico">${icon(res)}</div>
    <div class="st-ctrl"><button class="mini" data-dec="${prefix}:${res}" aria-label="减少${RES_NAME[res]}">−</button><b>${value}</b><button class="mini" data-inc="${prefix}:${res}" aria-label="增加${RES_NAME[res]}" ${value >= max ? 'disabled' : ''}>+</button></div>
    <small>${prefix === 'disc' || prefix === 'give' ? `持有 ${me().res[res]}` : RES_NAME[res]}</small>
  </div>`;
}

function openDiscard(need) {
  const sel = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
  const draw = () => {
    const m = me();
    const n = sum(sel);
    const root = openModal(
      `<h2>强盗来了：弃掉 ${need} 张牌</h2>
      <p class="muted">你有 ${sum(m.res)} 张手牌，需要弃掉一半（向下取整）。已选择 ${n} / ${need}。</p>
      <div class="steppers">${RES_LIST.map((r) => stepper(r, sel[r], m.res[r], 'disc')).join('')}</div>
      <div class="modal-actions"><button class="btn ghost" id="disc-auto">自动选择</button><button class="btn primary" id="disc-ok" ${n === need ? '' : 'disabled'}>弃掉 ${need} 张</button></div>`,
      { cls: 'discard', dismiss: false }
    );
    $$('[data-inc]', root).forEach((b) =>
      b.addEventListener('click', () => {
        const r = b.dataset.inc.split(':')[1];
        if (sel[r] < me().res[r] && sum(sel) < need) sel[r]++;
        sound.play('click');
        draw();
      })
    );
    $$('[data-dec]', root).forEach((b) =>
      b.addEventListener('click', () => {
        const r = b.dataset.dec.split(':')[1];
        if (sel[r] > 0) sel[r]--;
        sound.play('click');
        draw();
      })
    );
    $('#disc-auto').addEventListener('click', () => {
      for (const r of RES_LIST) sel[r] = 0;
      const have = { ...me().res };
      for (let i = 0; i < need; i++) {
        const r = RES_LIST.reduce((a, b) => (have[a] - sel[a] >= have[b] - sel[b] ? a : b));
        sel[r]++;
      }
      draw();
    });
    $('#disc-ok').addEventListener('click', () => {
      act('discard', { res: sel });
      closeModal();
    });
  };
  draw();
}

function openSteal() {
  const g = S.game;
  const t = S.board.tiles[g.robber];
  const victims = [...new Set(t.vertices.map((v) => g.buildings[v] && g.buildings[v].owner).filter((o) => o && o !== S.you))].filter((pid) => g.players.find((p) => p.id === pid).resCount > 0);
  const root = openModal(
    `<h2>偷取一张资源</h2><p class="muted">选择一名与强盗所在地块相邻的玩家，随机拿走他的 1 张手牌。</p>
    <div class="victims">${victims
      .map((pid) => {
        const p = g.players.find((x) => x.id === pid);
        return `<button class="victim" data-v="${pid}" style="--pc:${p.color}"><span class="chip"></span><b>${esc(p.name)}</b><span>${icon('resback')}${p.resCount} 张</span></button>`;
      })
      .join('')}</div>`,
    { cls: 'steal', dismiss: false }
  );
  $$('[data-v]', root).forEach((b) => b.addEventListener('click', () => (act('steal', { victim: b.dataset.v }), closeModal())));
}

function playDev(type, playable) {
  const g = S.game;
  if (!playable) {
    sound.play('error');
    const m = me();
    const fresh = m.dev.filter((d) => d.type === type).every((d) => d.turn >= g.turnCount);
    return toast(
      type === 'vp' ? '胜利点卡自动计分，无需打出' : !isMyTurn() ? '只能在自己的回合打出发展卡' : g.devPlayed ? '每回合只能打出一张发展卡' : fresh ? '本回合购买的卡下回合才能使用' : '现在不能打出这张卡',
      'warn'
    );
  }
  if (type === 'knight' || type === 'road') return act('playDev', { card: type });
  if (type === 'monopoly') {
    const root = openModal(
      `<h2>垄断</h2><p class="muted">${DEV.monopoly.desc}</p>
      <div class="res-pick">${RES_LIST.map((r) => `<button class="rp res-${r}" data-r="${r}">${icon(r)}<span>${RES_NAME[r]}</span></button>`).join('')}</div>
      <div class="modal-actions"><button class="btn ghost" data-close>取消</button></div>`,
      { cls: 'dev' }
    );
    $$('[data-r]', root).forEach((b) => b.addEventListener('click', () => (act('playDev', { card: 'monopoly', res1: b.dataset.r }), closeModal())));
    return;
  }
  if (type === 'plenty') {
    const picks = [];
    const draw = () => {
      const root = openModal(
        `<h2>丰收之年</h2><p class="muted">从银行选择 2 张资源（可以相同）。已选：${picks.map((r) => RES_NAME[r]).join('、') || '无'}</p>
        <div class="res-pick">${RES_LIST.map((r) => `<button class="rp res-${r}" data-r="${r}" ${g.bank[r] ? '' : 'disabled'}>${icon(r)}<span>${RES_NAME[r]}</span><small>银行 ${g.bank[r]}</small></button>`).join('')}</div>
        <div class="modal-actions"><button class="btn ghost" data-close>取消</button></div>`,
        { cls: 'dev' }
      );
      $$('[data-r]', root).forEach((b) =>
        b.addEventListener('click', () => {
          picks.push(b.dataset.r);
          sound.play('click');
          if (picks.length === 2) {
            act('playDev', { card: 'plenty', res1: picks[0], res2: picks[1] });
            closeModal();
          } else draw();
        })
      );
    };
    draw();
  }
}

// ---------- 交易 ----------
function openTrade(tab = 'bank') {
  const g = S.game;
  const m = me();
  const ratios = g.me.ratios;
  const draw = () => {
    const bd = S.bankDraft;
    const td = S.tradeDraft;
    const give = bd.give;
    const times = bd.times;
    const okBank = give && bd.get && give !== bd.get && m.res[give] >= ratios[give] * times && g.bank[bd.get] >= times;
    const tg = RES_LIST.reduce((s, r) => s + (td.give[r] || 0), 0);
    const tw = RES_LIST.reduce((s, r) => s + (td.get[r] || 0), 0);
    const okPlayer = tg > 0 && tw > 0 && RES_LIST.every((r) => !(td.give[r] && td.get[r]));
    const root = openModal(
      `<div class="tabs" role="tablist"><button role="tab" data-tab="bank" aria-selected="${tab === 'bank'}">与银行 / 港口</button><button role="tab" data-tab="player" aria-selected="${tab === 'player'}">与玩家</button></div>
      ${
        tab === 'bank'
          ? `<p class="muted">点选要给出的资源，再点选想要的资源。比例取决于你拥有的港口。</p>
        <h3>给出</h3>
        <div class="res-pick">${RES_LIST.map((r) => `<button class="rp res-${r} ${give === r ? 'sel' : ''}" data-give="${r}" ${m.res[r] >= ratios[r] ? '' : 'disabled'}>${icon(r)}<span>${ratios[r]} : 1</span><small>持有 ${m.res[r]}</small></button>`).join('')}</div>
        <h3>换取</h3>
        <div class="res-pick">${RES_LIST.map((r) => `<button class="rp res-${r} ${bd.get === r ? 'sel' : ''}" data-get="${r}" ${r === give || !g.bank[r] ? 'disabled' : ''}>${icon(r)}<span>${RES_NAME[r]}</span><small>银行 ${g.bank[r]}</small></button>`).join('')}</div>
        <div class="times">数量 <button class="mini" id="t-dec">−</button><b>${times}</b><button class="mini" id="t-inc">+</button>
          ${give && bd.get ? `<span class="muted">${ratios[give] * times} ${RES_NAME[give]} → ${times} ${RES_NAME[bd.get]}</span>` : ''}</div>
        <div class="modal-actions"><button class="btn ghost" data-close>关闭</button><button class="btn primary" id="bank-go" ${okBank ? '' : 'disabled'}>确认交易</button></div>`
          : `<p class="muted">设置你愿意给出和想要换取的资源，向所有玩家发出报价。</p>
        <h3>你给出</h3><div class="steppers">${RES_LIST.map((r) => stepper(r, td.give[r] || 0, m.res[r], 'give')).join('')}</div>
        <h3>你想要</h3><div class="steppers">${RES_LIST.map((r) => stepper(r, td.get[r] || 0, 19, 'get')).join('')}</div>
        <div class="modal-actions"><button class="btn ghost" id="td-clear">清空</button><button class="btn primary" id="offer-go" ${okPlayer ? '' : 'disabled'}>发出报价</button></div>`
      }`,
      { cls: 'trade' }
    );
    $$('[data-tab]', root).forEach((b) => b.addEventListener('click', () => ((tab = b.dataset.tab), sound.play('click'), draw())));
    $$('[data-give]', root).forEach((b) => b.addEventListener('click', () => ((bd.give = b.dataset.give), bd.get === bd.give && (bd.get = null), (bd.times = 1), sound.play('click'), draw())));
    $$('[data-get]', root).forEach((b) => b.addEventListener('click', () => ((bd.get = b.dataset.get), sound.play('click'), draw())));
    if ($('#t-dec')) {
      $('#t-dec').onclick = () => ((bd.times = Math.max(1, bd.times - 1)), draw());
      $('#t-inc').onclick = () => ((bd.times = Math.min(10, bd.times + 1)), draw());
      $('#bank-go').onclick = () => {
        act('bankTrade', { give: bd.give, get: bd.get, times: bd.times });
        S.bankDraft = { give: null, get: null, times: 1 };
        closeModal();
      };
    }
    $$('[data-inc]', root).forEach((b) =>
      b.addEventListener('click', () => {
        const [p, r] = b.dataset.inc.split(':');
        td[p][r] = (td[p][r] || 0) + 1;
        if (p === 'give' && td.give[r] > m.res[r]) td.give[r] = m.res[r];
        const other = p === 'give' ? 'get' : 'give';
        td[other][r] = 0;
        sound.play('click');
        draw();
      })
    );
    $$('[data-dec]', root).forEach((b) =>
      b.addEventListener('click', () => {
        const [p, r] = b.dataset.dec.split(':');
        td[p][r] = Math.max(0, (td[p][r] || 0) - 1);
        sound.play('click');
        draw();
      })
    );
    if ($('#td-clear')) $('#td-clear').onclick = () => ((S.tradeDraft = { give: {}, get: {} }), draw());
    if ($('#offer-go'))
      $('#offer-go').onclick = () => {
        act('proposeTrade', { give: td.give, get: td.get });
        closeModal();
      };
  };
  draw();
}

function renderTradePanel() {
  const g = S.game;
  const box = $('#trade-panel');
  const t = g.trade;
  if (!t || !me() || g.phase === 'ended') {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const side = (r) => RES_LIST.filter((k) => r[k]).map((k) => `<span class="tp-res">${icon(k)}<b>${r[k]}</b></span>`).join('');
  if (t.from === S.you) {
    const rows = Object.entries(t.responses)
      .map(([pid, st]) => {
        const label = st === 'accept' ? `<button class="btn primary mini" data-with="${pid}">与 TA 成交</button>` : st === 'reject' ? '<span class="no">拒绝</span>' : '<span class="wait">考虑中…</span>';
        return `<li style="--pc:${pcolor(pid)}"><span class="chip"></span>${esc(pname(pid))}${label}</li>`;
      })
      .join('');
    box.innerHTML = `<div class="tp-head">你的报价</div>
      <div class="tp-deal"><div>${side(t.give)}</div><span class="arrow">⇄</span><div>${side(t.get)}</div></div>
      <ul class="tp-resp">${rows}</ul><button class="btn ghost mini" id="tp-cancel">撤回报价</button>`;
    $$('[data-with]', box).forEach((b) => b.addEventListener('click', () => act('confirmTrade', { id: t.id, with: b.dataset.with })));
    $('#tp-cancel').onclick = () => act('cancelTrade');
  } else {
    const myResp = t.responses[S.you];
    const canAfford = hasRes(me().res, t.get);
    box.innerHTML = `<div class="tp-head" style="--pc:${pcolor(t.from)}"><span class="chip"></span>${esc(pname(t.from))} 想交易</div>
      <div class="tp-deal"><div><small>你得到</small>${side(t.give)}</div><span class="arrow">⇄</span><div><small>你付出</small>${side(t.get)}</div></div>
      ${
        myResp === 'pending'
          ? `<div class="tp-btns"><button class="btn ghost mini" id="tp-no">拒绝</button><button class="btn primary mini" id="tp-yes" ${canAfford ? '' : 'disabled title="资源不足"'}>接受</button></div>`
          : `<div class="tp-wait">${myResp === 'accept' ? '已接受，等待对方确认…' : '已拒绝'}</div>`
      }`;
    if ($('#tp-yes')) {
      $('#tp-yes').onclick = () => act('respondTrade', { id: t.id, accept: true });
      $('#tp-no').onclick = () => act('respondTrade', { id: t.id, accept: false });
    }
    if (S.seenTradeId !== t.id) {
      S.seenTradeId = t.id;
      fx.pulse(box, 'pop-in');
    }
  }
}

// ---------- 结束 ----------
function showGameOver() {
  const g = S.game;
  if (!g || g.phase !== 'ended' || S.overShown) return;
  S.overShown = true;
  const ranked = g.players.slice().sort((a, b) => b.vp - a.vp);
  const isHost = S.room.host === S.you;
  const mins = Math.max(1, Math.round((Date.now() - (S.startTime || Date.now())) / 60000));
  void mins;
  const root = openModal(
    `<div class="trophy">🏆</div><h2>${esc(pname(g.winner))} 赢得了卡坦岛！</h2>
    <p class="muted">共 ${g.turnCount} 回合，目标 ${g.targetVP} 分</p>
    <ol class="ranking">${ranked
      .map((p, i) => {
        const vpc = p.dev ? p.dev.filter((d) => d.type === 'vp').length : 0;
        return `<li style="--pc:${p.color}" class="${p.id === g.winner ? 'win' : ''}"><span class="rk">${i + 1}</span><span class="chip"></span><b>${esc(p.name)}</b>
        <span class="rv">${p.vp} 分</span>
        <small>${p.stats ? `获得资源 ${p.stats.gained}，交易 ${p.stats.traded} 次，建造 ${p.stats.built} 次` : ''}${vpc ? `，胜利点卡 ${vpc}` : ''}${g.longestRoad === p.id ? '，最长道路' : ''}${g.largestArmy === p.id ? '，最大军队' : ''}</small></li>`;
      })
      .join('')}</ol>
    <h3>骰子点数分布</h3>
    <div class="hist">${g.rollHistory
      .slice(2)
      .map((n, i) => {
        const max = Math.max(1, ...g.rollHistory);
        return `<div class="hb ${i + 2 === 7 ? 'seven' : ''}"><i style="height:${(n / max) * 100}%"></i><b>${n}</b><small>${i + 2}</small></div>`;
      })
      .join('')}</div>
    <div class="modal-actions">${isHost ? '<button class="btn primary" id="go-lobby">返回房间再来一局</button>' : '<span class="muted">等待房主开始新一局…</span>'}<button class="btn ghost" data-close>查看棋盘</button></div>`,
    { cls: 'over' }
  );
  if ($('#go-lobby', root)) $('#go-lobby').onclick = () => send('backToLobby');
}

// ---------- 设置 / 规则 ----------
function openSettings() {
  const root = openModal(
    `<h2>声音设置</h2>
    <label class="row"><input type="checkbox" id="s-sfx" ${sound.sfxOn ? 'checked' : ''}> 音效</label>
    <label class="row">音效音量 <input type="range" id="s-sfxv" min="0" max="1" step="0.05" value="${sound.sfxVol}"></label>
    <label class="row"><input type="checkbox" id="s-music" ${sound.musicOn ? 'checked' : ''}> 背景音乐</label>
    <label class="row">音乐音量 <input type="range" id="s-musicv" min="0" max="1" step="0.05" value="${sound.musicVol}"></label>
    <label class="row"><input type="checkbox" id="s-notify"> 轮到我时发送浏览器通知</label>
    <div class="modal-actions"><button class="btn primary" data-close>完成</button></div>`,
    { cls: 'settings' }
  );
  $('#s-sfx', root).onchange = (e) => (sound.unlock(), sound.setSfx(e.target.checked), sound.play('click'));
  $('#s-sfxv', root).oninput = (e) => sound.setSfxVol(Number(e.target.value));
  $('#s-sfxv', root).onchange = () => sound.play('gain', 'wheat');
  $('#s-music', root).onchange = (e) => (sound.unlock(), sound.setMusic(e.target.checked));
  $('#s-musicv', root).oninput = (e) => sound.setMusicVol(Number(e.target.value));
  const nt = $('#s-notify', root);
  nt.checked = 'Notification' in window && Notification.permission === 'granted';
  nt.onchange = () => 'Notification' in window && Notification.requestPermission();
}

function openRules() {
  openModal(
    `<h2>规则速览</h2>
    <div class="rules">
      <h3>目标</h3><p>率先达到目标分数（默认 10 分）的玩家获胜。村庄 1 分、城市 2 分、最长道路 2 分、最大军队 2 分、胜利点卡各 1 分。</p>
      <h3>开局</h3><p>按顺序每人放 1 个村庄和 1 条路，再按相反顺序放第二组。第二个村庄周围的地形各给你 1 张资源。</p>
      <h3>回合</h3><p>掷骰子：点数对应的地形为相邻村庄产出 1 张、城市产出 2 张资源（强盗所在地块不产出）。之后可以自由交易和建造。</p>
      <h3>建造费用</h3>
      <ul class="costs"><li>道路 ${costHTML(COST.road)}</li><li>村庄 ${costHTML(COST.settlement)}</li><li>城市 ${costHTML(COST.city)}</li><li>发展卡 ${costHTML(COST.dev)}</li></ul>
      <h3>距离规则</h3><p>村庄不能与任何建筑相邻，中间至少隔一个路口。开局后新村庄必须连接自己的道路。</p>
      <h3>掷出 7</h3><p>手牌超过 7 张的玩家弃掉一半；掷骰者移动强盗，并从相邻玩家处偷 1 张牌。</p>
      <h3>交易</h3><p>与银行 4:1；拥有港口时 3:1 或指定资源 2:1。也可向其他玩家报价。</p>
      <h3>发展卡</h3><p>每回合最多打出 1 张，本回合购买的卡下回合才能用。骰子前也可以打出。</p>
      <h3>6 / 8 人特殊建造</h3><p>开启后，每名玩家结束回合时，其他玩家依次获得一次只能建造（不能交易）的机会。</p>
      <h3>快捷键</h3><p>R 掷骰，E 结束回合，T 交易，1–4 建造，Esc 取消，+ / − 缩放，0 复位视角。</p>
    </div>
    <div class="modal-actions"><button class="btn primary" data-close>明白了</button></div>`,
    { cls: 'rules-modal' }
  );
}

// ======================= 语音 =======================
function renderVoice() {
  const st = voice.stateByPid();
  for (const el of $$('#players .pl, #lobby-players .slot')) {
    const pid = el.dataset.pid || el.id.replace(/^pl-/, '');
    const v = st[pid];
    el.classList.toggle('mic-on', !!(v && !v.muted));
    el.classList.toggle('speaking', !!(v && v.speaking));
  }
  const n = voice.listeners();
  for (const b of $$('.vb-spk')) {
    b.classList.toggle('off', !voice.speakerOn);
    b.setAttribute('aria-pressed', voice.speakerOn);
    b.title = voice.speakerOn ? `扬声器已开（语音频道 ${n} 人），点击静音` : '扬声器已关闭，点击收听';
    b.querySelector('use').setAttribute('href', voice.speakerOn ? '#ic-spk' : '#ic-spk-off');
  }
  for (const b of $$('.vb-mic')) {
    b.classList.toggle('on', voice.micOn);
    b.classList.toggle('talking', voice.selfSpeaking);
    b.classList.toggle('unsupported', !voice.micSupported);
    b.setAttribute('aria-pressed', voice.micOn);
    b.title = !voice.micSupported ? '麦克风需要 HTTPS 才能使用' : voice.micOn ? '麦克风已打开，点击关闭' : '麦克风已关闭，点击开始说话';
    b.querySelector('use').setAttribute('href', voice.micOn ? '#ic-mic' : '#ic-mic-off');
  }
}

function initVoiceUI() {
  for (const b of $$('.vb-spk')) b.addEventListener('click', () => (sound.unlock(), voice.toggleSpeaker()));
  for (const b of $$('.vb-mic')) b.addEventListener('click', () => (sound.unlock(), voice.toggleMic()));
  renderVoice();
}

// ======================= 提示 =======================
function toast(msg, kind = '') {
  const root = $('#toast-root');
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  // 相同提示不重复堆叠；最多同时显示 2 条
  for (const old of root.children) if (old.textContent === msg) old.remove();
  root.appendChild(t);
  while (root.children.length > 2) root.firstChild.remove();
  setTimeout(() => t.classList.add('out'), 2800);
  setTimeout(() => t.remove(), 3300);
}

// ======================= 初始化 =======================
function initGameUI() {
  $('#btn-settings').onclick = openSettings;
  $('#btn-rules').onclick = openRules;
  $('#btn-leave').onclick = () => {
    const g = S.game;
    const playing = g && g.phase !== 'ended' && me();
    const root = openModal(
      `<h2>离开游戏？</h2><p class="muted">${playing ? '离开期间由电脑替你操作。之后在首页点「回到对局」，或重新打开邀请链接，就能接回自己的位置。' : '你将返回首页。'}</p>
      <div class="modal-actions"><button class="btn ghost" data-close>留下</button><button class="btn danger" id="leave-ok">离开</button></div>`,
      { cls: 'confirm' }
    );
    $('#leave-ok', root).onclick = () => (closeModal(), send('leave'));
  };
  $('#zoom-in').onclick = () => board.zoom(1 / 1.2);
  $('#zoom-out').onclick = () => board.zoom(1.2);
  $('#zoom-fit').onclick = () => board.fit();
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
    S.unread = 0;
    S.rightTab = 'chat';
    renderTabs();
  };
  $('#toggle-players').onclick = () => document.body.classList.toggle('players-open');
  $('#board-wrap').addEventListener('pointerdown', () => document.body.classList.remove('players-open', 'side-open'));

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    if (document.body.dataset.screen !== 'game' || !S.game) return;
    const g = S.game;
    const k = e.key.toLowerCase();
    if (k === 'escape') {
      if (modalKind() && !['discard', 'steal'].includes(modalKind())) closeModal();
      else if (S.mode) {
        S.mode = null;
        renderGame(false);
      }
      return;
    }
    if (modalKind()) return;
    if (k === '+' || k === '=') board.zoom(1 / 1.2);
    else if (k === '-') board.zoom(1.2);
    else if (k === '0') board.fit();
    if (!me()) return;
    if (k === 'r' && isMyTurn() && g.sub === 'roll') act('roll');
    else if (k === 'e' && isMyTurn() && g.sub === 'main') doAction('end');
    else if (k === 'e' && g.sub === 'special' && g.special === S.you) doAction('endSpecial');
    else if (k === 't' && isMyTurn() && g.sub === 'main') openTrade();
    else if (['1', '2', '3', '4'].includes(k)) {
      const btn = $(`[data-act="${['road', 'settlement', 'city', 'dev'][Number(k) - 1]}"]`);
      if (btn && !btn.disabled) btn.click();
    }
  });
  // 首次交互解锁音频
  const unlock = () => sound.unlock();
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.game) renderGame(false);
  });
  // 鼠标悬停地块显示信息
  $('#board').addEventListener('pointerover', (e) => {
    const t = e.target.closest('.tile');
    const tip = $('#tile-tip');
    if (!t || !S.board) return (tip.hidden = true);
    const tile = S.board.tiles[t.dataset.tile];
    tip.hidden = false;
    tip.textContent = `${TERRAIN_NAME[tile.terrain]}${tile.resource ? `：产出${RES_NAME[tile.resource]}` : ''}${tile.number ? `，点数 ${tile.number}` : ''}${S.game && S.game.robber === tile.id ? '（强盗占领）' : ''}`;
  });
  $('#board').addEventListener('pointerleave', () => ($('#tile-tip').hidden = true));
}

// 用 http:// 打开时，若同一地址的 HTTPS 已可用（证书有效），自动切换过去（麦克风需要 HTTPS）
function upgradeToHttps() {
  if (location.protocol !== 'http:' || /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 5000);
  fetch(`https://${location.hostname}/health`, { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal })
    .then(() => {
      const hash = S.session ? '#s=' + encodeURIComponent(S.session) : '';
      location.replace(`https://${location.hostname}${location.pathname}${location.search}${hash}`);
    })
    .catch(() => {});
}

upgradeToHttps();
initLogin();
initVoiceUI();
initHome();
initLobby();
initGameUI();
renderTabs();
connect();
