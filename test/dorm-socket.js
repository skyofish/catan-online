'use strict';
// 猛鬼宿舍端到端测试：建房、加电脑、选宿舍、建造、掉线代管、跨游戏邀请、对局结束记战绩、再来一局。
// 用 DORM_SPEED 把对局加速，几秒钟跑完一整夜。
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');

const PORT = 3996;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dorm-test-'));
const ENV = { ...process.env, PORT, DB_PATH: path.join(DB_DIR, 'catan.db'), ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'pw', DORM_SPEED: '1', DORM_AFK_MS: '300' };

let srv = null;
async function startServer(env) {
  srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server', 'index.js')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
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
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
function client(name, p = '/dorm/ws') {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}${p}`);
  const c = { ws, name, room: null, you: null, state: null, map: null, events: [], msgs: [], waiters: [] };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'room') {
      c.room = m.d.room;
      c.you = m.d.you;
    }
    if (m.t === 'state') {
      // 宿舍信息是增量下发的：没变化时只有门和床的血量
      if (!c.state || c.state.gameId !== m.d.gameId) c.rooms = [];
      for (const r of m.d.rooms) c.rooms[r.i] = r.cells ? r : { ...c.rooms[r.i], ...r };
      c.state = m.d;
      if (m.d.map) c.map = m.d.map;
      c.events.push(...(m.d.events || []));
    }
    if (m.t !== 'state') c.msgs.push(m);
    c.waiters = c.waiters.filter((w) => !(w.pred(m) && (w.res(m), true)));
  };
  c.closed = new Promise((r) => (ws.onclose = r));
  c.send = (t, d = {}) => ws.send(JSON.stringify({ t, d }));
  c.wait = (pred, ms = 8000) =>
    new Promise((res, rej) => {
      const hit = c.msgs.find(pred);
      if (hit) return res(hit);
      c.waiters.push({ pred, res });
      setTimeout(() => rej(new Error(`${name} 等待超时`)), ms);
    });
  c.open = new Promise((r) => (ws.onopen = r));
  return c;
}
async function login(name, session, p) {
  const c = client(name, p);
  await c.open;
  c.send('hello', { session });
  await c.wait((m) => m.t === 'hello' || m.t === 'auth');
  return c;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const meOf = (c) => c.state.players.find((p) => p.id === c.you);
// 依次尝试走向各间宿舍的床，直到躺下（电脑可能抢先）
async function claimAny(c, order = [0, 4, 1, 5, 2, 6, 3, 7]) {
  for (const i of order) {
    if (c.rooms[i] && c.rooms[i].owner) continue;
    c.events = [];
    c.send('act', { type: 'claim', room: i });
    for (let k = 0; k < 100; k++) {
      await sleep(100);
      if (meOf(c).st === 'bed') return meOf(c).room;
      if (c.events.some((e) => e.type === 'claimFail' && e.pid === c.you)) break;
      if (c.msgs.some((m) => m.t === 'error' && /有人/.test(m.d.msg))) {
        c.msgs = c.msgs.filter((m) => m.t !== 'error');
        break;
      }
    }
  }
  throw new Error(c.name + ' 没能躺下');
}

(async () => {
  try {
    await startServer(ENV);
    const adm = (await http('POST', '/api/admin/login', { username: 'admin', password: 'pw' })).data.token;
    await http('POST', '/api/admin/users', { usernames: '阿杰 小雨 小雷' }, adm);
    const sA = (await http('POST', '/api/login', { username: '阿杰' })).data.token;
    const sB = (await http('POST', '/api/login', { username: '小雨' })).data.token;
    const sC = (await http('POST', '/api/login', { username: '小雷' })).data.token;

    // ---------- 平台目录与配置 ----------
    const games = (await http('GET', '/api/games', null, sA)).data.games;
    assert.ok(games.some((g) => g.id === 'dorm' && g.path === '/dorm/' && g.live), '平台应列出猛鬼宿舍');
    const cfg = (await http('GET', '/api/dorm/config')).data;
    assert.ok(cfg.BUILD.turret && cfg.DIFFICULTY.nightmare, '应能读取游戏配置');
    const page = await (await fetch(BASE + '/dorm/')).text();
    assert.ok(page.includes('猛鬼宿舍') && !page.includes('{{PLATFORM_NAME}}'));
    assert.strictEqual((await fetch(BASE + '/dorm', { redirect: 'manual' })).status, 301);
    console.log('✓ 平台目录、配置接口与页面');

    // ---------- 建房、加电脑、邀请 ----------
    const a = await login('A', sA);
    a.send('create', { diff: 'easy', title: '测试楼' });
    await a.wait((m) => m.t === 'room');
    const code = a.room.code;
    assert.strictEqual(a.room.diff, 'easy');
    a.send('addBot', { level: 'hard' });
    a.send('addBot', { level: 'easy' });
    await a.wait((m) => m.t === 'room' && m.room === undefined && a.room.players.length === 3);
    a.send('addBot', { level: 'ai' });
    await a.wait((m) => m.t === 'error' && /智谱/.test(m.d.msg));
    // 在卡坦岛页面的小雷也能收到猛鬼宿舍的邀请，并拒绝
    const cCatan = await login('C', sC, '/catan/ws');
    a.send('online');
    const ol = (await a.wait((m) => m.t === 'online' && m.d.some((u) => u.username === '小雷'))).d;
    a.send('invite', { userId: ol.find((u) => u.username === '小雷').id });
    const inv = (await cCatan.wait((m) => m.t === 'invite')).d;
    assert.strictEqual(inv.game, 'dorm');
    assert.strictEqual(inv.code, code);
    cCatan.send('inviteReply', { game: 'dorm', fromUser: inv.fromUser, code, accept: false });
    await a.wait((m) => m.t === 'toast' && /小雷 暂时不能加入/.test(m.d.msg));
    cCatan.ws.close();
    console.log('✓ 建房、加电脑（无 Key 时拒绝 AI）、跨游戏邀请与拒绝');

    const b = await login('B', sB);
    b.send('join', { code });
    await a.wait((m) => m.t === 'room' && a.room.players.length === 4);
    a.send('settings', { diff: 'normal' });
    await a.wait((m) => m.t === 'room' && a.room.diff === 'normal');
    b.send('settings', { diff: 'hard' });
    await b.wait((m) => m.t === 'error' && /房主/.test(m.d.msg));

    // ---------- 开局：选宿舍、建造 ----------
    a.send('start');
    await a.wait((m) => m.t === 'room' && a.room.started);
    await sleep(300);
    assert.strictEqual(a.state.phase, 'prep');
    assert.ok(a.map && a.map.rooms.length === 8 && a.map.tiles.length === a.map.H, '应下发随机地图');
    // 开局都在入口
    for (const p of a.state.players) assert.strictEqual(a.map.tiles[Math.floor(p.y)][Math.floor(p.x)], 'E', '开局在宿舍楼入口');
    // 走不进墙
    a.send('act', { type: 'move', x: 0, y: 0 });
    await a.wait((m) => m.t === 'error' && /走不过去/.test(m.d.msg));
    const ra = await claimAny(a);
    assert.strictEqual(a.rooms[ra].owner, a.you);
    // 别人不能再进这间
    const [hx, hy] = a.map.rooms[ra].bed.head;
    b.send('act', { type: 'move', x: hx, y: hy });
    await b.wait((m) => m.t === 'error' && /有人/.test(m.d.msg));
    const rb = await claimAny(b, [7, 3, 6, 2, 5, 1, 4, 0]);
    assert.notStrictEqual(ra, rb);
    a.send('act', { type: 'move', x: hx, y: hy + 1 });
    await a.wait((m) => m.t === 'error' && /躺下/.test(m.d.msg));
    // 搜初始的储物柜、建造
    const chest = a.rooms[ra].cells.findIndex((c) => c && c[0] === 'chest');
    if (chest >= 0) {
      const before = meOf(a).gold + meOf(a).energy;
      a.send('act', { type: 'open', cell: chest });
      await sleep(300);
      assert.ok(meOf(a).gold + meOf(a).energy > before, '搜储物柜应得到东西');
      assert.strictEqual(a.rooms[ra].cells[chest], 0);
    }
    const empty = a.rooms[ra].cells.findIndex((c) => !c);
    a.send('act', { type: 'build', cell: empty, btype: 'turret' });
    a.send('act', { type: 'build', cell: 999, btype: 'turret' });
    await a.wait((m) => m.t === 'error' && /不能建造/.test(m.d.msg));
    await sleep(400);
    assert.deepStrictEqual(a.rooms[ra].cells[empty], ['turret', 1], '应建好桃木弩');
    for (let i = 0; i < 60 && meOf(a).gold < 25; i++) await sleep(100);
    a.send('act', { type: 'bed' });
    await sleep(300);
    assert.strictEqual(a.rooms[ra].bed[0], 2, '床应升到 2 级');
    console.log('✓ 随机地图、入口集合、走到床上占房（一间一人）、搜储物柜、建造、升级床');

    // ---------- 掉线代管、回来恢复 ----------
    b.ws.close();
    await a.wait((m) => m.t === 'room' && a.room.players.find((p) => p.name === '小雨')?.autoBot, 5000);
    const b2 = await login('B2', sB);
    b2.send('join', { code });
    await b2.wait((m) => m.t === 'room' && b2.you);
    assert.strictEqual(b2.room.players.find((p) => p.id === b2.you).autoBot, false, '回来后恢复手动');
    console.log('✓ 掉线由电脑代管，重连回到原座位');

    // ---------- 加速跑完一局：战绩 ----------
    a.ws.close();
    b2.ws.close();
    await sleep(100);
    await stopServer();
    // 内存中的对局随重启结束；加速重开一局跑到结束
    await startServer({ ...ENV, DORM_SPEED: '60' });
    const a2 = await login('A2', sA);
    a2.send('create', { diff: 'easy' });
    await a2.wait((m) => m.t === 'room');
    a2.send('addBot', { level: 'hard' });
    a2.send('addBot', { level: 'normal' });
    await sleep(200);
    a2.send('start');
    await a2.wait((m) => m.t === 'room' && a2.room.started);
    await sleep(200);
    a2.send('act', { type: 'claim', room: 4 });
    // 来不及走到的也会在猛鬼醒来时被塞进空宿舍
    const end = await a2.wait((m) => m.t === 'room' && a2.room.ended, 30000);
    assert.ok(end);
    assert.ok(a2.state.phase === 'ended' && a2.state.result, '应有结算结果');
    let me = null;
    for (let i = 0; i < 20; i++) {
      me = (await http('GET', '/api/dorm/me', null, sA)).data;
      if (me.stats.games) break;
      await sleep(100);
    }
    assert.strictEqual(me.stats.games, 1, '战绩应记录 1 局');
    assert.strictEqual(me.recent[0].players, 3);
    const lb = (await http('GET', '/api/dorm/leaderboard', null, sA)).data.rows;
    assert.ok(lb.some((r) => r.username === '阿杰'));
    const catanMe = (await http('GET', '/api/catan/me', null, sA)).data;
    assert.strictEqual(catanMe.stats.games, 0, '猛鬼宿舍的战绩不应算进卡坦岛');
    console.log(`✓ 对局结束（${a2.state.result.win ? '活到天亮' : '全员遇难'}，猛鬼 ${a2.state.ghost.lv} 级），战绩与排行榜独立记录`);

    a2.send('backToLobby');
    await a2.wait((m) => m.t === 'room' && !a2.room.started);
    assert.strictEqual(a2.room.players.length, 3, '再来一局时电脑留在房间');
    console.log('✓ 回到房间再来一局');
    a2.ws.close();
    console.log('✅ 猛鬼宿舍端到端测试通过');
  } catch (e) {
    console.error('❌', e);
    process.exitCode = 1;
  } finally {
    if (srv && srv.exitCode === null) srv.kill();
    fs.rmSync(DB_DIR, { recursive: true, force: true });
  }
})();
