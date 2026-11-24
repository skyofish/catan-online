import { getSession, takeHashSession, upgradeToHttps, goToLogin, api, wsUrl } from '/js/session.js';
import { initFullscreen } from '/js/fullscreen.js';
import { createField } from './field.js?v=2';
import { createAudio } from './audio.js';
import { createPrediction } from './prediction.mjs';
import { DIRECTIONS, SHOT_COOLDOWN } from './movement.mjs';
import { unpack } from './protocol.mjs';

const $ = (selector) => document.querySelector(selector);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const mapHints = { depot: '钢墙与货箱交错', canyon: '两翼宽阔，中央曲折', foundry: '长直通道，中央多掩体' };
const statusNames = { idle: '空闲', room: '房间中', playing: '对局中' };
const field = createField($('#field'));
const audio = createAudio($('#audio'));
const prediction = createPrediction();
const hud = {
  wave: $('#wave'), remaining: $('#remaining'), coreCount: $('#core-count'),
  core: $('#core'), time: $('#time'), round: $('#round-message'),
};
const directionKeys = { ArrowUp: 0, KeyW: 0, ArrowRight: 1, KeyD: 1, ArrowDown: 2, KeyS: 2, ArrowLeft: 3, KeyA: 3 };
const movement = new Map();
const firing = new Set();
let config;
let ws;
let ready = false;
let reconnectDelay = 450;
let room = null;
let me = null;
let control = false;
let state = null;
let arena = null;
let localPlayer = null;
let receivedAt = 0;
let compact = false;
let rtt = null;
let requestedRoom = null;
let incoming = null;
let toastTimer;
let crewMarkup = '';
let inviteTimer;
let animation;
let input = { dir: -1, fire: false, n: 0 };
let sentInput = 0;
let lastLocalFire = -Infinity;

takeHashSession();
upgradeToHttps();
initFullscreen();
document.addEventListener('pointerdown', audio.unlock);
document.addEventListener('keydown', audio.unlock);

function notice(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

function send(type, data = {}) {
  if (ws?.readyState !== WebSocket.OPEN || (!ready && type !== 'hello')) return false;
  ws.send(JSON.stringify({ t: type, d: data }));
  return true;
}

function setConnection(connected, label) {
  ready = connected;
  $('#connection').textContent = label;
  $('#connection').classList.toggle('online', connected);
  for (const el of document.querySelectorAll('#open-create, #refresh, #join button')) el.disabled = !connected;
  if (room) {
    $('#start').disabled = !connected;
    $('#rematch').disabled = !connected;
  }
}

function mapInfo(id) {
  return config.maps.find((map) => map.id === id) || config.maps[0];
}

function mapLabel(map) {
  return `<span class="map-icon ${map.theme}" aria-hidden="true"></span><span>${esc(map.name)}<span class="map-tip">${esc(mapHints[map.id])}</span></span>`;
}

function show(view) {
  document.body.dataset.view = view;
  $('#lobby').hidden = view !== 'lobby';
  $('#room-view').hidden = view !== 'room';
  $('#battle').hidden = view !== 'battle';
  if (view === 'battle' && !animation) animation = requestAnimationFrame(draw);
  if (view !== 'battle' && animation) {
    cancelAnimationFrame(animation);
    animation = null;
  }
}

function draw(now) {
  const pose = ready && control && compact && room?.phase === 'playing' ? prediction.pose(now) : null;
  if (pose && input.fire && localPlayer?.hp && now - receivedAt < 225 && now - lastLocalFire >= SHOT_COOLDOWN * 1000) {
    lastLocalFire = now;
    const [dx, dy] = DIRECTIONS[pose.dir];
    field.muzzle(pose.x + dx * 23, pose.y + dy * 23, now);
    audio.play([{ type: 'fire' }]);
  }
  field.draw(now, me, pose);
  animation = requestAnimationFrame(draw);
}

function replaceCode(code) {
  history.replaceState(null, '', code ? '?room=' + encodeURIComponent(code) : location.pathname);
}

function join(code) {
  if (!send('join', { code })) {
    notice('正在重连，请稍后再试');
    return;
  }
  requestedRoom = code;
}

function exitRoom() {
  resetControls();
  if (!send('leave')) notice('正在重连，请稍后再试');
}

function renderList(rooms) {
  $('#rooms').innerHTML = rooms.length ? rooms.map((r) => {
    const full = r.players >= r.max;
    const label = r.mine ? (r.started ? '返回' : '加入') : r.started ? '作战中' : full ? '已满' : '加入';
    return `<li><div><b>${esc(r.title)}</b><small>${esc(mapInfo(r.map).name)} · ${r.players}/${r.max} 人${r.private ? ' · 隐藏' : ''}</small></div>
      <button type="button" data-code="${esc(r.code)}" ${(!r.mine && (r.started || full)) ? 'disabled' : ''}>${label}</button></li>`;
  }).join('') : '<li class="empty">暂无在线编队，创建一支开始作战。</li>';
}

function renderRoom(msg) {
  const previous = room;
  const changed = previous?.matchId !== msg.room.matchId;
  room = msg.room;
  me = msg.you;
  const controlsChanged = control !== (msg.control !== false);
  control = msg.control !== false;
  requestedRoom = null;
  replaceCode(room.code);
  if (previous?.code !== room.code) window.scrollTo(0, 0);
  if ($('#create-dialog').open) $('#create-dialog').close();
  if (room.phase !== 'lobby' && $('#invite-dialog').open) $('#invite-dialog').close();
  const host = room.host === me;
  if (room.phase === 'lobby') {
    if (changed) {
      state = null;
      window.scrollTo(0, 0);
    }
    show('room');
    $('#room-title').textContent = room.title;
    $('#room-code').textContent = room.code;
    const online = room.players.filter((p) => p.online).length;
    $('#crew-count').textContent = `${online} / ${room.max} 在线`;
    $('#crew').innerHTML = Array.from({ length: room.max }, (_, i) => {
      const p = room.players[i];
      if (!p) return `<li class="open-seat"><span class="crew-icon">+</span><div><strong>空闲席位</strong></div></li>`;
      return `<li style="--seat:${p.color}"><span class="crew-icon">P${i + 1}</span><div><strong>${esc(p.name)}${p.id === me ? '（你）' : ''}</strong>
        <small>${p.id === room.host ? '房主 · ' : ''}${p.online ? '在线' : '重连中'}</small></div></li>`;
    }).join('');
    $('#room-maps').innerHTML = config.maps.map((map) => `<button class="map" type="button" data-map="${map.id}" aria-pressed="${String(map.id === room.map)}" ${host ? '' : 'disabled'}>${mapLabel(map)}</button>`).join('');
    $('#start').hidden = !host;
    $('#start').disabled = !ready;
    $('#wait-host').hidden = host;
    $('#open-invite').disabled = room.players.length >= room.max || !ready;
    return;
  }

  $('#battle-map').textContent = mapInfo(room.map).name;
  if (changed) {
    state = null;
    arena = localPlayer = null;
    compact = false;
    field.reset(config, room.map);
    crewMarkup = '';
    $('#battle-crew').replaceChildren();
    $('#round-message').hidden = true;
    $('#result').hidden = true;
    resetControls();
    prediction.reset();
    lastLocalFire = -Infinity;
    send('ping', { n: performance.now() });
    window.scrollTo(0, 0);
  }
  if (controlsChanged && !changed) {
    resetControls();
    prediction.reset();
  }
  show('battle');
  $('#rematch').hidden = !host;
  $('#result-wait').hidden = host;
  $('#rematch').disabled = !ready;
  if (state) renderCrew();
}

function renderCrew() {
  const html = state.players.map((p, i) => {
    const user = room.players.find(({ id }) => id === p.id);
    const text = !user?.online ? '离线' : p.hp ? `${p.lives} 台战车 · ${p.kills} 击毁` : p.lives ? `${p.respawn} 秒后重返战场` : '已离开战斗';
    const armor = p.hp ? '◆'.repeat(p.hp) + '◇'.repeat(3 - p.hp) : '◇◇◇';
    return `<li style="--seat:${p.color}"><span class="crew-icon">P${i + 1}</span><div><strong>${esc(user?.name)}${p.id === me ? '（你）' : ''}</strong><small>${text}</small><small class="armor" aria-label="装甲 ${p.hp}/3">${armor}</small></div></li>`;
  }).join('');
  if (html !== crewMarkup) {
    $('#battle-crew').innerHTML = html;
    crewMarkup = html;
  }
}

function writeText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function renderState(next, isCompact = false) {
  if (next.id !== room?.matchId) return;
  const now = performance.now();
  receivedAt = now;
  compact = isCompact;
  if (next.grid) arena = { tile: config.tile, cols: config.cols, rows: config.rows, grid: next.grid.slice(), core: next.core };
  if (next.tiles && arena) {
    for (const [i, value] of next.tiles) arena.grid[i] = value;
  }
  localPlayer = next.players.find((p) => p.id === me);
  if (isCompact && control && arena && localPlayer) prediction.receive(localPlayer, arena, now);
  state = next;
  const events = now - lastLocalFire < Math.max(330, (rtt ?? 0) + 120)
    ? next.events.filter((e) => e.type !== 'fire' || e.owner !== me) : next.events;
  field.update(next, arena?.grid, events, now);
  audio.play(events);
  writeText(hud.wave, `${next.wave} / ${next.waves}`);
  writeText(hud.remaining, String(next.remaining));
  writeText(hud.coreCount, `${next.core.hp} / ${next.core.maxHp}`);
  if (hud.core.value !== next.core.hp) hud.core.value = next.core.hp;
  writeText(hud.time, `${Math.floor(next.time / 60)}:${String(next.time % 60).padStart(2, '0')}`);
  const preparing = next.phase === 'ready';
  if (hud.round.hidden === preparing) hud.round.hidden = !preparing;
  if (preparing) writeText(hud.round, `第 ${next.wave} 波来袭 · ${next.countdown}`);
  renderCrew();
  if (next.result) {
    resetControls();
    $('#result').hidden = false;
    $('#result-label').textContent = next.result.won ? '三波敌军全部击退' : `止步第 ${next.result.wave} 波`;
    $('#result-title').textContent = next.result.won ? '防线守住了' : '防卫失败';
    const details = { cleared: '能源信标安全', core: '能源信标失守', crew: '小队战车已耗尽', time: '作战超时' };
    $('#result-detail').textContent = `${details[next.result.reason]} · 全队击毁 ${next.result.kills} 台敌车`;
  }
}

function renderOnline(users) {
  $('#online').innerHTML = users.length ? users.map((u) => `<li><div><b>${esc(u.username)}</b><small>${statusNames[u.status] || '在线'}</small></div>
    <button type="button" data-user="${u.id}" ${u.invited ? 'disabled' : ''}>${u.invited ? '已邀请' : '邀请'}</button></li>`).join('') : '<li class="empty">目前没有其他好友在线。</li>';
}

function showInvite(invite) {
  incoming = invite;
  const el = $('#incoming');
  el.hidden = false;
  el.innerHTML = `<b>${esc(invite.from)} 邀请你一起玩</b><p>${esc(invite.gameName)} · ${esc(invite.detail || invite.title)}</p><div class="incoming-actions">
    <button type="button" class="primary" data-answer="yes">接受</button><button type="button" data-answer="no">婉拒</button></div>`;
  clearTimeout(inviteTimer);
  inviteTimer = setTimeout(() => { el.hidden = true; incoming = null; }, 30000);
}

function handle(msg) {
  const d = msg.d;
  switch (msg.t) {
    case 'hello': {
      setConnection(true, '已连线');
      reconnectDelay = 450;
      send('sync', { v: 2 });
      const code = room?.code || new URLSearchParams(location.search).get('room');
      if (code) join(code);
      else send('list');
      break;
    }
    case 'auth': goToLogin('请登录后加入铁线防卫'); break;
    case 'kicked': goToLogin(d.reason); break;
    case 'rooms': renderList(d); break;
    case 'room': renderRoom(d); break;
    case 'state': renderState(d); break;
    case 'frame':
      if (d.id !== room?.matchId) break;
      send('ack', { id: d.id, n: d.n });
      renderState(unpack(d), true);
      break;
    case 'pong': {
      const sample = performance.now() - d.n;
      if (sample >= 0 && sample < 10000) {
        rtt = rtt === null ? sample : rtt * .8 + sample * .2;
        prediction.setLatency(rtt);
      }
      break;
    }
    case 'online': renderOnline(d); break;
    case 'invite': showInvite(d); break;
    case 'left':
      room = state = null;
      if ($('#invite-dialog').open) $('#invite-dialog').close();
      replaceCode(null);
      show('lobby');
      send('list');
      window.scrollTo(0, 0);
      break;
    case 'error':
      if (requestedRoom) {
        if (!room || room.code === requestedRoom) {
          room = state = null;
          show('lobby');
          replaceCode(null);
          send('list');
        }
        requestedRoom = null;
      }
      if ($('#invite-dialog').open) send('online');
      notice(d.msg);
      break;
    case 'toast':
      if ($('#invite-dialog').open) send('online');
      notice(d.msg);
      break;
  }
}

function connect() {
  setConnection(false, '连接中');
  ws = new WebSocket(wsUrl('/tank/ws'));
  ws.onopen = () => send('hello', { session: getSession() });
  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    handle(msg);
  };
  ws.onclose = () => {
    setConnection(false, '正在重连');
    resetControls();
    prediction.reset();
    prediction.setLatency(40);
    rtt = null;
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 5000);
  };
}

function sendControls(repeat = false) {
  if (!ready || !control || room?.phase !== 'playing') return;
  if (sentInput !== input.n || (repeat && (input.dir >= 0 || input.fire))) {
    if (ws.bufferedAmount <= 4096 && send('input', input)) sentInput = input.n;
  }
}

function readControls() {
  const dir = [...movement.values()].at(-1) ?? -1;
  const fire = firing.size > 0;
  if (dir !== input.dir || fire !== input.fire) {
    input = { dir, fire, n: input.n + 1 };
    if (ready && control) prediction.input(dir, input.n, performance.now());
  }
  sendControls();
}

function resetControls() {
  movement.clear();
  firing.clear();
  document.querySelectorAll('.touch .pressed').forEach((el) => el.classList.remove('pressed'));
  readControls();
}

window.addEventListener('keydown', (event) => {
  if (!ready || !control || room?.phase !== 'playing' || /INPUT|BUTTON|TEXTAREA/.test(event.target.tagName)) return;
  if (!Object.hasOwn(directionKeys, event.code) && event.code !== 'Space') return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  event.preventDefault();
  if (event.repeat) return;
  if (event.code === 'Space') firing.add(event.code);
  else movement.set(event.code, directionKeys[event.code]);
  readControls();
});
window.addEventListener('keyup', (event) => {
  if (movement.delete(event.code) || firing.delete(event.code)) readControls();
});
window.addEventListener('blur', resetControls);
document.addEventListener('visibilitychange', () => { if (document.hidden) resetControls(); });

for (const button of document.querySelectorAll('.touch button')) {
  button.addEventListener('pointerdown', (event) => {
    if (!ready || !control || room?.phase !== 'playing') return;
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    if (button.hasAttribute('data-fire')) firing.add(event.pointerId);
    else movement.set(event.pointerId, Number(button.dataset.dir));
    button.classList.add('pressed');
    readControls();
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    button.addEventListener(type, (event) => {
      movement.delete(event.pointerId);
      firing.delete(event.pointerId);
      button.classList.remove('pressed');
      readControls();
    });
  }
}
setInterval(() => sendControls(true), 65);
setInterval(() => { if (room?.phase === 'playing') send('ping', { n: performance.now() }); }, 2500);
setInterval(() => { if (!room) send('list'); }, 10000);

$('#open-create').onclick = () => $('#create-dialog').showModal();
$('#refresh').onclick = () => send('list');
$('#create').onsubmit = (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  if (send('create', { title: data.get('title'), map: data.get('map'), private: data.has('private') })) $('#create-dialog').close();
  else notice('正在重连，请稍后再试');
};
$('#join').onsubmit = (event) => {
  event.preventDefault();
  join($('#code').value.trim().toUpperCase());
};
$('#rooms').onclick = (event) => {
  const code = event.target.closest('[data-code]')?.dataset.code;
  if (code) join(code);
};
$('#room-maps').onclick = (event) => {
  const map = event.target.closest('[data-map]')?.dataset.map;
  if (map) send('configure', { map });
};
$('#start').onclick = () => {
  $('#start').blur();
  send('start');
};
$('#leave-room').onclick = exitRoom;
$('#leave-battle').onclick = exitRoom;
$('#exit-result').onclick = exitRoom;
$('#rematch').onclick = () => send('rematch');
$('#copy-link').onclick = async () => {
  try {
    await navigator.clipboard.writeText(new URL(`/tank/?room=${room.code}`, location.origin).href);
    notice('邀请链接已复制');
  } catch {
    notice(`房间号 ${room.code}，队友可在大厅输入加入`);
  }
};
$('#open-invite').onclick = () => {
  if (send('online')) {
    $('#online').innerHTML = '<li class="empty">正在获取在线好友…</li>';
    $('#invite-dialog').showModal();
  } else notice('正在重连，请稍后再试');
};
$('#invite-refresh').onclick = () => send('online');
$('#online').onclick = (event) => {
  const button = event.target.closest('[data-user]');
  if (button && send('invite', { userId: Number(button.dataset.user) })) {
    button.disabled = true;
    button.textContent = '已发送';
  }
};
for (const button of document.querySelectorAll('[data-close]')) button.onclick = () => button.closest('dialog').close();
$('#incoming').onclick = (event) => {
  const answer = event.target.closest('[data-answer]')?.dataset.answer;
  if (!answer || !incoming) return;
  const invite = incoming;
  $('#incoming').hidden = true;
  incoming = null;
  clearTimeout(inviteTimer);
  send('inviteReply', { ...invite, accept: answer === 'yes' });
  if (answer === 'no') return;
  if (invite.game === 'tank') join(invite.code);
  else if (/^\/[a-z0-9-]+\/$/.test(invite.path)) location.href = `${invite.path}?room=${encodeURIComponent(invite.code)}`;
};

async function boot() {
  if (!getSession()) return goToLogin();
  try {
    config = await api('/api/tank/config');
    $('#create-maps').innerHTML = config.maps.map((map, i) => `<label class="map"><input type="radio" name="map" value="${map.id}" ${i === 0 ? 'checked' : ''}>${mapLabel(map)}</label>`).join('');
    show('lobby');
    connect();
  } catch {
    setConnection(false, '连接失败');
    notice('暂时无法连接游戏，正在重试');
    setTimeout(boot, 3000);
  }
}
boot();
