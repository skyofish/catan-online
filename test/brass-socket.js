'use strict';
// 工业革命：伯明翰 端到端测试：页面与目录、建房、电脑玩家、邀请、两位真人按「提示」打完整局、
// 服务器重启后续玩（与卡坦岛的房间共用一张表互不干扰）、掉线代管、新手教程、战绩与排行榜。
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');

const PORT = 3994;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'brass-test-'));
const ENV = { ...process.env, PORT, DB_PATH: path.join(DB_DIR, 'catan.db'), ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'pw', BRASS_BOT_DELAY_MS: '15', BRASS_HINT_LIMIT: '100000', AFK_TAKEOVER_MS: '400', ZHIPU_API_KEY: '' };

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(name, p = '/brass/ws') {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}${p}`);
  const c = { ws, name, room: null, you: null, game: null, map: null, events: [], msgs: [], waiters: [] };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'room') {
      c.room = m.d.room;
      c.you = m.d.you;
      c.game = m.d.game || null;
      if (m.d.game && m.d.game.map) c.map = m.d.game.map;
      c.events.push(...(m.d.events || []));
    }
    c.msgs.push(m);
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
const myTurn = (c) => c.game && c.game.phase !== 'ended' && c.game.turn === c.you && c.game.me;

// 轮到自己就要一个提示并照做；直到对局结束或达到条件
async function playUntil(clients, cond, ms = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    for (const c of clients) {
      if (c.dead || !myTurn(c) || c.busy) continue;
      c.busy = true;
      c.msgs = c.msgs.filter((m) => m.t !== 'hint' && m.t !== 'error');
      c.send('hint');
      let h;
      try {
        h = await c.wait((m) => m.t === 'hint' || m.t === 'error', 5000);
      } catch (e) {
        console.error('等待提示超时', c.name, c.game && c.game.turn, c.you, c.msgs.slice(-4).map((m) => m.t + ':' + JSON.stringify(m.d).slice(0, 120)));
        throw e;
      }
      if (h.t === 'error') {
        if (process.env.DEBUG) console.error('hint error', c.name, h.d.msg);
        await sleep(300);
      }
      if (h.t === 'hint' && h.d) {
        const before = c.game;
        c.send('act', h.d);
        if (process.env.DEBUG) {
          const r = await c.wait((m) => (m.t === 'room' && m.d.events && m.d.events.length) || m.t === 'error', 3000).catch(() => null);
          if (r && r.t === 'error') console.error('act error', c.name, JSON.stringify(h.d), r.d.msg);
        }
        // 等状态变化
        for (let i = 0; i < 100 && c.game === before; i++) await sleep(20);
      }
      c.busy = false;
    }
    if (cond()) return true;
    await sleep(30);
  }
  throw new Error('对局在限定时间内没有达到条件');
}

(async () => {
  try {
    await startServer(ENV);
    const adm = (await http('POST', '/api/admin/login', { username: 'admin', password: 'pw' })).data.token;
    await http('POST', '/api/admin/users', { usernames: '阿杰 小雨 小雷' }, adm);
    const sA = (await http('POST', '/api/login', { username: '阿杰' })).data.token;
    const sB = (await http('POST', '/api/login', { username: '小雨' })).data.token;
    const sC = (await http('POST', '/api/login', { username: '小雷' })).data.token;

    // ---------- 平台目录、页面、地图接口 ----------
    const games = (await http('GET', '/api/games', null, sA)).data.games;
    assert.ok(games.some((g) => g.id === 'brass' && g.path === '/brass/' && g.live), '平台应列出伯明翰');
    const page = await (await fetch(BASE + '/brass/')).text();
    assert.ok(page.includes('工业革命') && !page.includes('{{PLATFORM_NAME}}'));
    assert.strictEqual((await fetch(BASE + '/brass', { redirect: 'manual' })).status, 301);
    for (const f of ['/brass/js/app.js', '/brass/js/board.js', '/brass/js/fx.js', '/brass/js/audio.js', '/brass/js/tutorial.js', '/brass/css/style.css']) assert.strictEqual((await fetch(BASE + f)).status, 200, f);
    const map = (await http('GET', '/api/brass/map')).data;
    assert.ok(map.locs.length === 22 && map.merchants.length === 5 && map.links.length > 30);
    console.log('✓ 平台目录、页面与静态资源、地图接口');

    // ---------- 新手教程 ----------
    const t = await login('T', sC);
    t.send('tutorial');
    await t.wait((m) => m.t === 'room' && m.d.game);
    assert.ok(t.room.tutorial && t.room.private, '教程是私人房间');
    assert.strictEqual(t.game.turn, t.you, '教程里你先行动');
    const hand = t.game.players.find((p) => p.id === t.you).hand;
    assert.ok(hand.some((c) => c.k === 'loc' && c.v === 'birmingham') && hand.some((c) => c.k === 'loc' && c.v === 'coventry'), '教程手牌固定');
    assert.deepStrictEqual(t.game.merchants.oxford.map((m) => m.type), ['cotton', 'goods']);
    const bham = hand.find((c) => c.v === 'birmingham');
    t.send('act', { type: 'build', card: bham.id, loc: 'birmingham', slot: 0, ind: 'cotton' });
    await t.wait((m) => m.t === 'room' && m.d.events && m.d.events.some((e) => e.type === 'build'));
    // 导师行动后回到你
    await t.wait((m) => m.t === 'room' && t.game.round === 2 && myTurn(t), 8000);
    t.send('join', { code: t.room.code });
    const other = await login('O', sB);
    other.send('join', { code: t.room.code });
    await other.wait((m) => m.t === 'error' && /别人的教程/.test(m.d.msg));
    other.ws.close();
    t.send('leave');
    await t.wait((m) => m.t === 'left');
    t.send('list');
    const tl = (await t.wait((m) => m.t === 'rooms')).d;
    assert.ok(!tl.some((r) => r.tutorial), '离开教程后房间删除');
    t.ws.close();
    console.log('✓ 新手教程：固定开局、导师行动、别人不能加入、离开即删除');

    // ---------- 建房、加电脑、邀请 ----------
    const a = await login('A', sA);
    a.send('create', { title: '测试工厂' });
    await a.wait((m) => m.t === 'room');
    const code = a.room.code;
    a.send('addBot', { level: 'hard' });
    await a.wait((m) => m.t === 'room' && a.room.players.length === 2);
    a.send('addBot', { level: 'ai' });
    await a.wait((m) => m.t === 'error' && /智谱/.test(m.d.msg));
    const cCatan = await login('C', sC, '/catan/ws');
    a.send('online');
    const ol = (await a.wait((m) => m.t === 'online' && m.d.some((u) => u.username === '小雷'))).d;
    a.send('invite', { userId: ol.find((u) => u.username === '小雷').id });
    const inv = (await cCatan.wait((m) => m.t === 'invite')).d;
    assert.strictEqual(inv.game, 'brass');
    assert.strictEqual(inv.path, '/brass/');
    cCatan.send('inviteReply', { game: 'brass', fromUser: inv.fromUser, code, accept: false });
    await a.wait((m) => m.t === 'toast' && /小雷 暂时不能加入/.test(m.d.msg));
    // 顺便开一个卡坦岛房间，重启后两边都应恢复
    cCatan.send('create', { size: 4 });
    const catanRoom = (await cCatan.wait((m) => m.t === 'room')).d.room.code;
    cCatan.send('addBot', {});
    await sleep(100);
    cCatan.send('start');
    await cCatan.wait((m) => m.t === 'room' && m.d.game);
    console.log('✓ 建房、加电脑（无 Key 时拒绝 AI）、跨游戏邀请与拒绝');

    const b = await login('B', sB);
    b.send('join', { code });
    await a.wait((m) => m.t === 'room' && a.room.players.length === 3);
    b.send('addBot', { level: 'easy' });
    await b.wait((m) => m.t === 'error' && /房主/.test(m.d.msg));
    a.send('settings', { title: '新名字' });
    await a.wait((m) => m.t === 'room' && a.room.title === '新名字');

    // ---------- 开局与非法操作 ----------
    a.send('start');
    await a.wait((m) => m.t === 'room' && m.d.game);
    await b.wait((m) => m.t === 'room' && m.d.game);
    assert.ok(a.map && a.map.links.length, '第一次完整视图带地图');
    assert.strictEqual(a.game.n, 3);
    assert.strictEqual(a.game.era, 'canal');
    for (const p of a.game.players) {
      assert.strictEqual(p.money, 17);
      if (p.id !== a.you) assert.strictEqual(p.hand, null, '看不到别人的手牌');
    }
    assert.ok(a.game.merchants.warrington && !a.game.merchants.nottingham, '3 人局开放沃灵顿、不开放诺丁汉');
    // 不是自己的回合
    const notMe = [a, b].find((c) => !myTurn(c) && c.game.turn !== c.you);
    if (notMe) {
      const card = notMe.game.players.find((p) => p.id === notMe.you).hand[0];
      notMe.send('act', { type: 'pass', card: card.id });
      await notMe.wait((m) => m.t === 'error' && /还没轮到你/.test(m.d.msg));
    }
    console.log('✓ 开局：起始资金、隐藏手牌、按人数开放商人、拒绝越权操作');

    // ---------- 按提示打到第 3 轮 ----------
    await playUntil([a, b], () => a.game.round >= 3 || a.game.era === 'rail');
    assert.ok(a.events.some((e) => e.type === 'roundEnd'), '应有轮结束事件');
    console.log(`✓ 打到第 ${a.game.round} 轮（${a.game.players.map((p) => `${p.name} £${p.money}`).join('，')}）`);

    // ---------- 服务器重启后续玩 ----------
    // 关掉连接后电脑会代管继续打，所以只比较「至少保留了之前的进度」
    const before = { round: a.game.round, era: a.game.era, rounds: a.game.history.length, logs: a.game.log[a.game.log.length - 1].id };
    a.ws.close();
    b.ws.close();
    cCatan.ws.close();
    await sleep(200);
    await stopServer();
    await startServer(ENV);
    const a2 = await login('A2', sA);
    a2.send('join', { code });
    await a2.wait((m) => m.t === 'room' && m.d.game);
    assert.ok(a2.game.history.length >= before.rounds && a2.game.log[a2.game.log.length - 1].id >= before.logs, '重启后保留了进度');
    assert.ok(a2.map, '重新连接后下发完整地图');
    const b2 = await login('B2', sB);
    b2.send('join', { code });
    await b2.wait((m) => m.t === 'room' && m.d.game);
    const c2 = await login('C2', sC, '/catan/ws');
    c2.send('join', { code: catanRoom });
    const cr = (await c2.wait((m) => m.t === 'room')).d;
    assert.ok(cr.game && cr.room.code === catanRoom, '卡坦岛房间也恢复了');
    c2.ws.close();
    console.log('✓ 重启后伯明翰与卡坦岛的对局都恢复');

    // ---------- 掉线代管 ----------
    b2.ws.close();
    await a2.wait((m) => m.t === 'room' && a2.room.players.find((p) => p.name === '小雨')?.autoBot, 15000);
    const b3 = await login('B3', sB);
    b3.send('join', { code });
    await b3.wait((m) => m.t === 'room' && b3.you && b3.room.players.find((p) => p.id === b3.you).autoBot === false);
    console.log('✓ 掉线由电脑代管，重连回到原座位');

    // ---------- 打完整局 ----------
    let sawRail = false;
    await playUntil([a2, b3], () => {
      if (a2.game.era === 'rail') sawRail = true;
      return a2.game.phase === 'ended';
    }, 240000);
    assert.ok(sawRail, '应进入铁路时代');
    assert.ok(a2.events.some((e) => e.type === 'eraEnd' && e.era === 'canal'), '运河时代结算');
    assert.ok(a2.events.some((e) => e.type === 'eraStart' && e.era === 'rail'), '铁路时代开始');
    assert.ok(a2.events.some((e) => e.type === 'win'), '有胜者');
    const g = a2.game;
    assert.ok(g.players.every((p) => p.hand === null || p.hand.length === 0), '牌都打完了');
    assert.ok(g.history.length >= 15, '两个时代的轮数');
    console.log(`✓ 打完整局：${g.players.map((p) => `${p.name} ${p.vp} 分`).join('，')}`);

    let me = null;
    for (let i = 0; i < 30; i++) {
      me = (await http('GET', '/api/brass/me', null, sA)).data;
      if (me.stats.games) break;
      await sleep(100);
    }
    assert.strictEqual(me.stats.games, 1, '战绩记录 1 局');
    assert.strictEqual(me.recent[0].players, 3);
    const lb = (await http('GET', '/api/brass/leaderboard', null, sA)).data.rows;
    assert.ok(lb.some((r) => r.username === '阿杰') && lb.some((r) => r.username === '小雨'));
    assert.strictEqual((await http('GET', '/api/catan/me', null, sA)).data.stats.games, 0, '伯明翰战绩不算进卡坦岛');
    console.log('✓ 战绩与排行榜独立记录');

    a2.send('backToLobby');
    await a2.wait((m) => m.t === 'room' && !a2.room.started);
    assert.strictEqual(a2.room.players.length, 3, '再来一局时玩家和电脑都在');
    console.log('✓ 回到房间再来一局');
    a2.ws.close();
    b3.ws.close();
    console.log('✅ 伯明翰端到端测试通过');
  } catch (e) {
    console.error('❌', e);
    process.exitCode = 1;
  } finally {
    if (srv && srv.exitCode === null) srv.kill();
    fs.rmSync(DB_DIR, { recursive: true, force: true });
  }
})();
