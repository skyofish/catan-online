'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { unpack } = require('../public/tank/js/protocol.mjs');

const PORT = 3991;
const BASE = `http://127.0.0.1:${PORT}`;
const clients = new Set();

async function request(url, { method = 'GET', body, token } = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body && JSON.stringify(body),
  });
  assert.ok(res.ok, `${method} ${url}: ${res.status}`);
  return res.json();
}

async function socket(pathname, token, { compact = false, autoAck = true } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}${pathname}`);
  const inbox = [];
  const waiters = new Set();
  clients.add(ws);
  ws.addEventListener('close', () => clients.delete(ws), { once: true });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.t === 'frame') {
      if (autoAck) send('ack', { n: msg.d.n, id: msg.d.id });
      msg.d = unpack(msg.d);
    }
    const waiter = [...waiters].find((w) => w.matches(msg));
    if (waiter) {
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(msg.d);
    } else {
      inbox.push(msg);
      if (inbox.length > 40) inbox.shift();
    }
  });

  const send = (t, d = {}) => ws.send(JSON.stringify({ t, d }));
  const wait = (t, test = () => true, ms = 5000) => new Promise((resolve, reject) => {
    const matches = (m) => m.t === t && test(m.d);
    const found = inbox.findIndex(matches);
    if (found >= 0) return resolve(inbox.splice(found, 1)[0].d);
    const waiter = { matches, resolve, timer: setTimeout(() => {
      waiters.delete(waiter);
      reject(new Error(`等待 ${t} 超时`));
    }, ms) };
    waiters.add(waiter);
  });
  await Promise.race([
    once(ws, 'open', { signal: AbortSignal.timeout(5000) }),
    once(ws, 'error', { signal: AbortSignal.timeout(5000) }).then(() => { throw new Error('WebSocket 无法连接'); }),
  ]);
  if (token) {
    send('hello', { session: token });
    await wait('hello');
    if (compact) send('sync', { v: 2 });
  }
  return { send, wait, close: async () => {
    const closed = once(ws, 'close', { signal: AbortSignal.timeout(5000) });
    ws.close();
    await closed;
  } };
}

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tank-test-'));
  const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '../server/index.js')], {
    env: { ...process.env, HOST: '127.0.0.1', PORT, DB_PATH: path.join(dir, 'test.db'), ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'test' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    await Promise.race([
      (async () => { for await (const chunk of server.stdout) if (String(chunk).includes('已启动')) return; })(),
      once(server, 'exit').then(([code]) => { throw new Error(`服务器退出 ${code}`); }),
    ]);
    const { token: admin } = await request('/api/admin/login', { method: 'POST', body: { username: 'admin', password: 'test' } });
    const names = ['甲组', '乙组', '丙组', '丁组', '戊组'];
    await request('/api/admin/users', { method: 'POST', token: admin, body: { usernames: names.join(' ') } });
    const tokens = await Promise.all(names.map(async (username) =>
      (await request('/api/login', { method: 'POST', body: { username } })).token));

    const catalogue = await request('/api/games', { token: tokens[0] });
    assert.equal(catalogue.games.find((game) => game.id === 'tank').path, '/tank/');
    assert.equal((await request('/api/tank/config')).maps.length, 3);
    for (const asset of ['/tank/', '/tank/art/iron-line.jpg', '/tank/css/style.css', '/tank/js/app.js?v=2', '/tank/js/field.js?v=2', '/tank/js/audio.js',
      '/tank/js/movement.mjs', '/tank/js/protocol.mjs', '/tank/js/prediction.mjs']) {
      assert.equal((await fetch(BASE + asset)).status, 200, asset);
    }
    const unauthenticated = await socket('/tank/ws');
    unauthenticated.send('create');
    assert.equal((await unauthenticated.wait('auth')).ok, false);
    await unauthenticated.close();

    const [a, b, c, d, extra] = await Promise.all(tokens.map((token, i) =>
      socket('/tank/ws', token, { compact: i !== 2, autoAck: i !== 1 })));
    const hub = await socket('/hub/ws', tokens[1]);
    a.send('create', { map: 'depot', title: '测试编队', private: true });
    const { room: { code }, you: aId } = await a.wait('room');
    extra.send('list');
    assert.equal((await extra.wait('rooms')).length, 0, '隐藏编队不出现在公开列表');
    a.send('online');
    const online = await a.wait('online');
    assert.equal(online.length, 4);
    const friend = online.find((p) => p.username === names[1]);
    a.send('invite', { userId: friend.id });
    const invite = await hub.wait('invite');
    assert.equal(invite.path, '/tank/');
    assert.equal(invite.code, code);
    hub.send('inviteReply', { game: 'tank', fromUser: invite.fromUser, code, accept: false });
    await a.wait('toast', ({ msg }) => /暂时不能加入/.test(msg));

    let bId;
    for (const [i, player] of [b, c, d].entries()) {
      player.send('join', { code: code.toLowerCase() });
      const joined = await player.wait('room', ({ room }) => room.players.length === i + 2);
      if (!i) bId = joined.you;
    }
    extra.send('join', { code });
    await extra.wait('error', ({ msg }) => msg.includes('最多四人'));
    b.send('start');
    await b.wait('error', ({ msg }) => msg.includes('只有房主'));
    a.send('configure', { map: 'foundry' });
    await d.wait('room', ({ room }) => room.map === 'foundry');
    a.send('start');
    const first = await d.wait('frame', ({ grid }) => !!grid);
    assert.equal(first.players.length, 4);
    assert.equal(new Set(first.players.map(({ color }) => color)).size, 4);
    assert.equal(first.grid.length, 20 * 14);
    const initialX = first.players.find(({ id }) => id === aId).x;
    const legacy = await c.wait('state', ({ grid }) => !!grid);
    assert.deepEqual(legacy.grid, first.grid);
    a.send('input', { dir: 3, fire: true, n: 1 });
    const fired = await d.wait('frame', (state) => state.shots.some((shot) => !shot.enemy));
    assert.ok(fired.players.find(({ id }) => id === aId).x < initialX);
    assert.equal(fired.players.find(({ id }) => id === aId).inputSeq, 1);
    a.send('input', { dir: -1, fire: false, n: 2 });
    await d.wait('frame', (state) => state.players.find(({ id }) => id === aId).inputSeq === 2);

    const stalled = await b.wait('frame', ({ n }) => n === 8);
    await assert.rejects(b.wait('frame', ({ n }) => n > stalled.n, 240), /超时/);
    const fireAtCrate = () => a.send('input', { dir: 0, fire: true, n: 3 });
    fireAtCrate();
    const repeatFire = setInterval(fireAtCrate, 65);
    let changed;
    try {
      changed = await d.wait('frame', ({ tiles }) => tiles?.some(([i]) => i === 10 * 20 + 8));
    } finally {
      clearInterval(repeatFire);
    }
    a.send('input', { dir: -1, fire: false, n: 4 });
    assert.equal(changed.grid, undefined);
    b.send('ack', { id: stalled.id, n: stalled.n });
    const resumed = await b.wait('frame', ({ n }) => n > stalled.n);
    assert.ok(resumed.tiles.some(([i]) => i === 10 * 20 + 8), '拥塞恢复后应补齐漏收的地形变化');

    await b.close();
    await d.wait('room', ({ room }) => room.players.some((p) => p.id === bId && !p.online));
    const back = await socket('/tank/ws', tokens[1], { compact: true });
    back.send('join', { code });
    const rejoined = await back.wait('room', ({ room }) => room.phase === 'playing');
    assert.equal(rejoined.you, bId);
    const loaded = await back.wait('frame', ({ grid }) => !!grid);
    assert.equal(loaded.id, first.id);
    assert.equal((await request('/api/games', { token: tokens[1] })).games.find((g) => g.id === 'tank').live.myRoom, code);

    const ended = await d.wait('frame', (s) => !!s.result, 45_000);
    assert.equal(ended.result.reason, 'core');
    const stats = await request('/api/tank/me', { token: tokens[0] });
    assert.equal(stats.stats.games, 1);
    assert.equal(stats.stats.wins, 0);
    assert.equal(stats.recent[0].size, 4);
    a.send('rematch');
    await d.wait('room', ({ room }) => room.phase === 'lobby' && room.players.length === 4);
    a.send('leave');
    await a.wait('left');
    await back.wait('room', ({ room }) => room.host === bId && room.players.length === 3);
    console.log('✅ 坦克大战端到端测试通过（四人联机、邀请、重连、战绩、再来一局）');
  } finally {
    for (const ws of clients) ws.close();
    if (server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit');
      server.kill('SIGTERM');
      await exited;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
