'use strict';
// 雾夜追猎端到端测试：建房、阵营与角色、加电脑、跨游戏邀请、开局补位、移动、掉线代管、对局结束记战绩、再来一局。
// 用 HUNT_SPEED 把对局加速，几秒钟跑完一整局。
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');

const PORT = 3992;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hunt-test-'));
const ENV = { ...process.env, PORT, DB_PATH: path.join(DB_DIR, 'catan.db'), ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'pw', HUNT_SPEED: '1', HUNT_AFK_MS: '300' };

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
function client(name, p = '/hunt/ws') {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}${p}`);
  const c = { ws, name, room: null, you: null, state: null, map: null, events: [], msgs: [], waiters: [] };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'room') {
      c.room = m.d.room;
      c.you = m.d.you;
    }
    if (m.t === 'state') {
      c.state = m.d;
      if (m.d.setup) c.setup = m.d.setup;
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
    assert.ok(games.some((g) => g.id === 'hunt' && g.path === '/hunt/' && g.live), '平台应列出雾夜追猎');
    const cfg = (await http('GET', '/api/hunt/config')).data;
    assert.ok(Object.keys(cfg.SURVIVORS).length === 6 && Object.keys(cfg.HUNTERS).length === 3 && cfg.MAP_KEYS.length === 3, '6 名求生者、3 名追猎者、3 张地图');
    const page = await (await fetch(BASE + '/hunt/')).text();
    assert.ok(page.includes('雾夜追猎') && !page.includes('{{PLATFORM_NAME}}'));
    assert.strictEqual((await fetch(BASE + '/hunt', { redirect: 'manual' })).status, 301);
    for (const f of ['/hunt/js/app.js', '/hunt/js/scene.js', '/hunt/js/audio.js', '/hunt/css/style.css', '/farm/vendor/three.module.min.js']) assert.strictEqual((await fetch(BASE + f)).status, 200, f);
    console.log('✓ 平台目录、配置接口与页面');

    // ---------- 建房、阵营、角色、电脑、邀请 ----------
    const a = await login('A', sA);
    a.send('create', { map: 'harbor', title: '测试局' });
    await a.wait((m) => m.t === 'room');
    const code = a.room.code;
    assert.strictEqual(a.room.map, 'harbor');
    assert.strictEqual(a.room.players[0].role, 'survivor');
    a.send('char', { char: 'runner' });
    await a.wait((m) => m.t === 'room' && a.room.players[0].char === 'runner');
    a.send('addBot', { level: 'hard', role: 'hunter' });
    await a.wait((m) => m.t === 'room' && a.room.players.length === 2);
    assert.strictEqual(a.room.players[1].role, 'hunter');
    a.send('addBot', { level: 'easy', role: 'hunter' });
    await a.wait((m) => m.t === 'error' && /已经有追猎者/.test(m.d.msg));
    a.send('role', { role: 'hunter' });
    await a.wait((m) => m.t === 'error' && /已经有追猎者/.test(m.d.msg) && a.msgs.filter((x) => x.t === 'error').length >= 2);
    a.send('addBot', { level: 'ai', role: 'survivor' });
    await a.wait((m) => m.t === 'error' && /智谱/.test(m.d.msg));
    // 在卡坦岛页面的小雷也能收到邀请，并拒绝
    const cCatan = await login('C', sC, '/catan/ws');
    a.send('online');
    const ol = (await a.wait((m) => m.t === 'online' && m.d.some((u) => u.username === '小雷'))).d;
    a.send('invite', { userId: ol.find((u) => u.username === '小雷').id });
    const inv = (await cCatan.wait((m) => m.t === 'invite')).d;
    assert.strictEqual(inv.game, 'hunt');
    assert.strictEqual(inv.path, '/hunt/');
    cCatan.send('inviteReply', { game: 'hunt', fromUser: inv.fromUser, code, accept: false });
    await a.wait((m) => m.t === 'toast' && /小雷 暂时不能加入/.test(m.d.msg));
    cCatan.ws.close();
    console.log('✓ 建房、选角色、加电脑追猎者（只能一名）、无 Key 时拒绝 AI、跨游戏邀请与拒绝');

    const b = await login('B', sB);
    b.send('join', { code });
    await a.wait((m) => m.t === 'room' && a.room.players.length === 3);
    // 求生者角色不能和真人重复
    b.send('char', { char: 'runner' });
    await b.wait((m) => m.t === 'error' && /已经有人选了/.test(m.d.msg));
    b.send('char', { char: 'nurse' });
    await b.wait((m) => m.t === 'room' && b.room.players.find((p) => p.id === b.you).char === 'nurse');
    b.send('settings', { map: 'garden' });
    await b.wait((m) => m.t === 'error' && /房主/.test(m.d.msg));

    // ---------- 开局：空位补电脑、下发地图、移动 ----------
    a.send('start');
    await a.wait((m) => m.t === 'room' && a.room.started);
    await sleep(300);
    assert.strictEqual(a.room.players.length, 5, '空位由电脑补齐到 1 + 4');
    assert.strictEqual(a.room.players.filter((p) => p.role === 'hunter').length, 1);
    assert.strictEqual(new Set(a.room.players.filter((p) => p.role === 'survivor').map((p) => p.char)).size, 4, '求生者角色不重复');
    assert.strictEqual(a.state.phase, 'prep');
    assert.ok(a.setup && a.setup.map.key === 'harbor' && a.setup.map.rows.length === 64 && a.setup.machines.length === 7, '应下发地图与发报机位置');
    const p0 = { ...meOf(a) };
    a.send('act', { type: 'move', x: 1, z: 0 });
    await sleep(400);
    assert.strictEqual(meOf(a).x, p0.x, '准备阶段不能移动');
    for (let i = 0; i < 80 && a.state.phase !== 'play'; i++) await sleep(100);
    assert.strictEqual(a.state.phase, 'play');
    // 朝四个方向各走一下，至少有一个方向走得动，而且速度不超标
    let moved = 0;
    for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const s = { ...meOf(a) };
      const t0 = a.state.t;
      a.send('act', { type: 'move', x: x * 5, z: z * 5 });
      await sleep(500);
      const d = Math.hypot(meOf(a).x - s.x, meOf(a).z - s.z);
      assert.ok(d <= cfg.RULES.survivorSpeed * 1.6 * (a.state.t - t0) + 0.3, '移动速度由服务器决定');
      moved = Math.max(moved, d);
    }
    a.send('act', { type: 'move', x: 0, z: 0 });
    assert.ok(moved > 0.8, '应能移动');
    assert.ok(meOf(a).hint === null || typeof meOf(a).hint.type === 'string');
    assert.strictEqual(a.state.players.find((p) => p.id === b.you).hint, undefined, '别人的互动提示不下发');
    a.send('act', { type: 'attack' });
    await a.wait((m) => m.t === 'error' && /不能出刀/.test(m.d.msg));
    console.log('✓ 开局补齐电脑、下发地图、准备阶段冻结、服务器权威移动、求生者不能出刀');

    // ---------- 增量协议与拥塞控制 ----------
    {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/hunt/ws`);
      await new Promise((r) => (ws.onopen = r));
      const acc = { players: null };
      let bytes = 0;
      let count = 0;
      let lastN = 0;
      let ack = true;
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.t !== 'state') return;
        const d = m.d;
        assert.ok(d.n === lastN + 1 || d.setup, '增量状态应按顺序编号');
        lastN = d.n;
        if (d.setup) acc.players = d.setup.players.map((p) => ({ id: p.id }));
        else {
          bytes += ev.data.length;
          count++;
        }
        for (const k in d) if (k !== 'p' && k !== 'n') acc[k] = d[k];
        d.p.forEach((o, i) => o && Object.assign(acc.players[i], o));
        if (ack) ws.send(JSON.stringify({ t: 'k', d: { n: d.n } }));
      };
      const send = (t, d = {}) => ws.send(JSON.stringify({ t, d }));
      send('hello', { session: sC });
      send('proto', { v: 2 });
      send('join', { code });
      await sleep(1500);
      const full = a.state;
      assert.ok(count > 20, '观战者应持续收到状态');
      assert.strictEqual(acc.players.length, 5);
      for (const [i, pl] of full.players.entries()) {
        assert.ok(Math.abs(acc.players[i].x - pl.x) < 1 && Math.abs(acc.players[i].z - pl.z) < 1, '增量合并后的位置应与完整状态一致');
        assert.strictEqual(acc.players[i].st, pl.st);
      }
      assert.deepStrictEqual(acc.pallets, full.pallets);
      assert.strictEqual(acc.machines.length, 7);
      const avg = bytes / count;
      const fullSize = JSON.stringify({ t: 'state', d: full }).length;
      assert.ok(avg < fullSize * 0.4, `增量状态应明显更小（${Math.round(avg)} 对 ${fullSize}）`);
      // 不再确认：服务器应把下发降到每秒一次左右，而不是继续堆积
      ack = false;
      await sleep(1200);
      const before = count;
      await sleep(2000);
      assert.ok(count - before <= 4, `连接堵住时应停止堆积（2 秒内又发了 ${count - before} 份）`);
      // 恢复确认后重新跟上
      ack = true;
      ws.send(JSON.stringify({ t: 'k', d: { n: lastN } }));
      const mid = count;
      await sleep(1000);
      assert.ok(count - mid > 10, '恢复后应重新按正常频率下发');
      ws.close();
      console.log(`✓ 增量协议：平均每份 ${Math.round(avg)} 字节（完整状态 ${fullSize} 字节）；连接堵住时暂停下发、恢复后跟上`);
    }

    // ---------- 掉线代管、回来恢复 ----------
    b.ws.close();
    await a.wait((m) => m.t === 'room' && a.room.players.find((p) => p.name === '小雨')?.autoBot, 5000);
    const b2 = await login('B2', sB);
    b2.send('join', { code });
    await b2.wait((m) => m.t === 'room' && b2.you);
    assert.strictEqual(b2.room.players.find((p) => p.id === b2.you).autoBot, false, '回来后恢复手动');
    await sleep(200);
    assert.ok(b2.setup, '重连后重新下发地图');
    console.log('✓ 掉线由电脑代管，重连回到原座位');

    a.ws.close();
    b2.ws.close();
    await sleep(100);
    await stopServer();

    // ---------- 加速跑完一局：真人当追猎者，战绩 ----------
    await startServer({ ...ENV, HUNT_SPEED: '40' });
    const a2 = await login('A2', sA);
    a2.send('create', { role: 'hunter' });
    await a2.wait((m) => m.t === 'room');
    assert.strictEqual(a2.room.players[0].role, 'hunter', '可以直接以追猎者身份开房');
    a2.send('addBot', { level: 'hard', role: 'survivor' });
    await sleep(200);
    a2.send('start');
    await a2.wait((m) => m.t === 'room' && a2.room.started);
    // 追猎者挂机：求生者应当能修完机器逃走
    await a2.wait((m) => m.t === 'room' && a2.room.ended, 60000);
    assert.ok(a2.state.phase === 'ended' && a2.state.result && a2.state.scores.length === 5, '应有结算结果');
    assert.strictEqual(a2.state.result.winner, 'survivors', '追猎者挂机时求生者应当获胜');
    let me = null;
    for (let i = 0; i < 20; i++) {
      me = (await http('GET', '/api/hunt/me', null, sA)).data;
      if (me.stats.games) break;
      await sleep(100);
    }
    assert.strictEqual(me.stats.games, 1, '战绩应记录 1 局');
    assert.strictEqual(me.stats.wins, 0);
    assert.strictEqual(me.recent[0].players, 5);
    const lb = (await http('GET', '/api/hunt/leaderboard', null, sA)).data.rows;
    assert.ok(lb.some((r) => r.username === '阿杰'));
    assert.strictEqual((await http('GET', '/api/catan/me', null, sA)).data.stats.games, 0, '战绩不应算进别的游戏');
    console.log(`✓ 对局结束（${a2.state.result.escaped} 人逃脱，用时 ${Math.round(a2.state.t)} 秒），战绩与排行榜独立记录`);

    a2.send('backToLobby');
    await a2.wait((m) => m.t === 'room' && !a2.room.started);
    assert.strictEqual(a2.room.players.length, 5, '再来一局时电脑留在房间');
    console.log('✓ 回到房间再来一局');
    a2.ws.close();
    console.log('✅ 雾夜追猎端到端测试通过');
  } catch (e) {
    console.error('❌', e);
    process.exitCode = 1;
  } finally {
    if (srv && srv.exitCode === null) srv.kill();
    fs.rmSync(DB_DIR, { recursive: true, force: true });
  }
})();
