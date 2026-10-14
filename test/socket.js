'use strict';
// 端到端测试：管理员 API、账号登录、WebSocket 对局、禁用踢出、重启后续玩、战绩与排行榜。
// 需要 Node 22.13+（内置 WebSocket 客户端与 node:sqlite）。
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'catan-test-'));
const ENV = {
  ...process.env,
  PORT,
  DB_PATH: path.join(DB_DIR, 'catan.db'),
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD: 'test-secret',
  BOT_DELAY_MS: '5',
  AFK_TAKEOVER_MS: '200',
};

let srv = null;
async function startServer() {
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server', 'index.js')], { env: ENV, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    srv.stdout.on('data', (d) => /已启动/.test(d) && resolve());
    srv.once('exit', (c) => reject(new Error('服务器退出 ' + c)));
  });
}
async function stopServer() {
  const p = new Promise((r) => srv.once('exit', r));
  srv.kill('SIGTERM');
  await p;
}

async function http(method, url, body, token) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

function client(name) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const c = { ws, name, state: null, msgs: [], waiters: [] };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'room') c.state = m.d;
    c.msgs.push(m);
    c.waiters = c.waiters.filter((w) => !(w.pred(m) && (w.res(m), true)));
  };
  c.closed = new Promise((r) => (ws.onclose = r));
  c.send = (t, d = {}) => ws.send(JSON.stringify({ t, d }));
  c.wait = (pred, ms = 5000) =>
    new Promise((res, rej) => {
      const hit = c.msgs.find(pred);
      if (hit) return res(hit);
      c.waiters.push({ pred, res });
      setTimeout(() => rej(new Error(`${name} 等待超时`)), ms);
    });
  c.open = new Promise((r) => (ws.onopen = r));
  return c;
}

async function loginWS(name, session) {
  const c = client(name);
  await c.open;
  c.send('hello', { session });
  await c.wait((m) => m.t === 'hello' || m.t === 'auth');
  return c;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  try {
    await startServer();

    // ---------- 管理员 ----------
    assert.strictEqual((await http('POST', '/api/admin/login', { username: 'admin', password: 'wrong' })).status, 403, '错误密码应被拒绝');
    assert.strictEqual((await http('GET', '/api/admin/users')).status, 401, '未登录不能访问管理接口');
    const adm = (await http('POST', '/api/admin/login', { username: 'admin', password: 'test-secret' })).data.token;
    assert.ok(adm);
    const add = await http('POST', '/api/admin/users', { usernames: '小红, 小蓝 小绿 bad name! 小红' }, adm);
    assert.deepStrictEqual(add.data.created, ['小红', '小蓝', '小绿', 'bad']);
    assert.strictEqual(add.data.errors.length, 2, '非法字符与重复账号应报错');
    let users = (await http('GET', '/api/admin/users', null, adm)).data.users;
    const uid = (n) => users.find((u) => u.username === n).id;
    await http('DELETE', `/api/admin/users/${uid('bad')}`, null, adm);
    console.log('✓ 管理员登录与账号管理');

    // ---------- 玩家登录 ----------
    assert.strictEqual((await http('POST', '/api/login', { username: '不存在' })).status, 403);
    const sRed = (await http('POST', '/api/login', { username: '小红' })).data.token;
    const sBlue = (await http('POST', '/api/login', { username: '小蓝' })).data.token;
    const sGreen = (await http('POST', '/api/login', { username: '小绿' })).data.token;
    assert.ok(sRed && sBlue && sGreen);
    const anon = await loginWS('匿名', null);
    assert.ok(anon.msgs.some((m) => m.t === 'auth'), '未登录的 WebSocket 应被要求登录');
    anon.send('list');
    await anon.wait((m) => m.t === 'auth' && anon.msgs.filter((x) => x.t === 'auth').length >= 2);
    anon.ws.close();
    console.log('✓ 玩家登录（无密码）与未登录拦截');

    // ---------- 建房开局 ----------
    const a = await loginWS('A', sRed);
    a.send('create', { size: 4, targetVP: 5 });
    const code = (await a.wait((m) => m.t === 'room')).d.room.code;
    const b = await loginWS('B', sBlue);
    const g = await loginWS('G', sGreen);
    b.send('join', { code });
    g.send('join', { code });
    await a.wait((m) => m.t === 'room' && m.d.room.players.length === 3);
    assert.deepStrictEqual(a.state.room.players.map((p) => p.name).sort(), ['小红', '小绿', '小蓝'], '玩家名应为账号名');
    a.send('start');
    await a.wait((m) => m.t === 'room' && m.d.game);
    console.log('✓ 用账号建房、加入、开局');

    // ---------- 禁用账号：强制下线并由电脑接管 ----------
    await http('PATCH', `/api/admin/users/${uid('小绿')}`, { enabled: false }, adm);
    await g.wait((m) => m.t === 'kicked');
    await g.closed;
    assert.strictEqual((await http('POST', '/api/login', { username: '小绿' })).status, 403, '禁用后不能登录');
    const g2 = await loginWS('G2', sGreen);
    assert.ok(g2.msgs.some((m) => m.t === 'auth'), '禁用后旧会话失效');
    g2.ws.close();
    users = (await http('GET', '/api/admin/users', null, adm)).data.users;
    assert.strictEqual(users.find((u) => u.username === '小绿').enabled, false);
    await a.wait((m) => m.t === 'room' && m.d.room.players.find((p) => p.name === '小绿')?.autoBot);
    console.log('✓ 禁用账号：强制下线、无法登录、对局由电脑接管');

    // ---------- 重启后续玩 ----------
    await sleep(300);
    const before = a.state.game;
    const snapshot = { turn: before.turn, buildings: Object.keys(before.buildings).length, phase: before.phase };
    a.ws.close();
    b.ws.close();
    await sleep(50);
    await stopServer();
    await startServer();
    const a2 = await loginWS('A2', sRed);
    assert.ok(a2.msgs.some((m) => m.t === 'hello'), '重启后会话仍然有效');
    a2.send('join', { code });
    const restored = (await a2.wait((m) => m.t === 'room' && m.d.game)).d;
    assert.ok(restored.game.board, '恢复后应下发棋盘');
    assert.ok(Object.keys(restored.game.buildings).length >= snapshot.buildings, '建筑应保留');
    assert.strictEqual(restored.room.players.find((p) => p.name === '小红').id, a.state.you, '恢复后仍是原来的座位');
    console.log('✓ 服务器重启后对局恢复，玩家回到原座位');

    // ---------- 打完一局，记录战绩 ----------
    a2.ws.close(); // 所有真人离线，电脑代管直到分出胜负
    const deadline = Date.now() + 60000;
    let lb = [];
    while (Date.now() < deadline) {
      lb = (await http('GET', '/api/leaderboard', null, sBlue)).data.rows;
      if (lb.length) break;
      await sleep(300);
    }
    assert.ok(lb.length >= 1, '对局结束后应出现在排行榜');
    const me = (await http('GET', '/api/me', null, sRed)).data;
    assert.strictEqual(me.stats.games, 1);
    assert.strictEqual(me.recent.length, 1);
    assert.strictEqual(me.recent[0].players, 3);
    users = (await http('GET', '/api/admin/users', null, adm)).data.users;
    assert.strictEqual(users.find((u) => u.username === '小绿').games, 1, '被禁用账号的对局也计入战绩');
    assert.ok(!lb.some((r) => r.username === '小绿'), '排行榜不显示被禁用账号');
    console.log(`✓ 战绩记录与排行榜（${me.recent[0].turns} 回合，胜者 ${me.recent[0].winner}）`);

    // ---------- 删除账号：战绩保留名字 ----------
    await http('DELETE', `/api/admin/users/${uid('小蓝')}`, null, adm);
    assert.strictEqual((await http('GET', '/api/me', null, sBlue)).status, 401, '删除后会话失效');
    const after = (await http('GET', '/api/me', null, sRed)).data;
    assert.strictEqual(after.recent.length, 1, '删除其他账号不影响自己的战绩');
    console.log('✓ 删除账号');

    console.log('✅ 端到端测试通过');
  } catch (e) {
    console.error('❌', e);
    process.exitCode = 1;
  } finally {
    if (srv && srv.exitCode === null) srv.kill();
    fs.rmSync(DB_DIR, { recursive: true, force: true });
  }
})();
