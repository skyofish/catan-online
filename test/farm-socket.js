'use strict';
// 青野牧歌端到端测试：开农场、朋友用编号加入、走位校验、种地同步给对方、跨游戏邀请、
// 两人都睡下进入新的一天、重启服务器后存档还在、平台大厅展示、移除与删除农场。
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');

const PORT = 3995;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-test-'));
const ENV = { ...process.env, PORT, DB_PATH: path.join(DB_DIR, 'catan.db'), ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'pw' };

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
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
function client(name, p = '/farm/ws') {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}${p}`);
  const c = { ws, name, msgs: [], waiters: [], world: null, me: null, players: [], meta: null, events: [], changes: [] };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'init') {
      c.init = m.d;
      c.world = m.d.world;
      c.meta = m.d.world.meta;
      c.me = m.d.me;
    }
    if (m.t === 'tick') {
      c.players = m.d.p;
      if (m.d.meta) c.meta = m.d.meta;
      if (m.d.ev) c.events.push(...m.d.ev);
      if (m.d.ch) c.changes.push(m.d.ch);
    }
    if (m.t === 'me') c.me = m.d;
    if (m.t !== 'tick') c.msgs.push(m);
    c.waiters = c.waiters.filter((w) => !(w.pred(m) && (w.res(m), true)));
  };
  c.closed = new Promise((r) => (ws.onclose = r));
  c.open = new Promise((r) => (ws.onopen = r));
  c.send = (t, d = {}) => ws.send(JSON.stringify({ t, d }));
  c.wait = (pred, ms = 8000) =>
    new Promise((res, rej) => {
      const hit = c.msgs.find(pred);
      if (hit) return res(hit);
      c.waiters.push({ pred, res });
      setTimeout(() => rej(new Error(`${name} 等待超时`)), ms);
    });
  c.waitTick = (pred, ms = 8000) =>
    new Promise((res, rej) => {
      c.waiters.push({ pred: (m) => m.t === 'tick' && pred(m.d), res });
      setTimeout(() => rej(new Error(`${name} 等待同步超时`)), ms);
    });
  let seq = 1;
  c.act = async (d) => {
    const s = seq++;
    c.send('act', { ...d, seq: s });
    return (await c.wait((m) => m.t === 'ack' && m.d.seq === s && (c.msgs.splice(c.msgs.indexOf(m), 1), true))).d;
  };
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
const dec = (b64) => Buffer.from(b64, 'base64');

(async () => {
  console.log('青野牧歌 端到端测试');
  await startServer();
  try {
    const admin = (await http('POST', '/api/admin/login', { username: 'admin', password: 'pw' })).data.token;
    await http('POST', '/api/admin/users', { usernames: '阿禾 小麦 路人' }, admin);
    const tA = (await http('POST', '/api/login', { username: '阿禾' })).data.token;
    const tB = (await http('POST', '/api/login', { username: '小麦' })).data.token;
    const tC = (await http('POST', '/api/login', { username: '路人' })).data.token;

    // 配置接口
    const cfg = (await http('GET', '/api/farm/config', null, tA)).data;
    assert.ok(cfg.CROPS.parsnip && cfg.MAP.W === 60, '配置接口');
    const G = cfg.G;

    // 1. 开农场
    const a = await login('阿禾', tA);
    a.send('create', { name: '晴风农场' });
    await a.wait((m) => m.t === 'init');
    const code = a.init.farm.code;
    assert.match(code, /^[A-Z2-9]{5}$/);
    assert.strictEqual(a.meta.name, '晴风农场');
    assert.strictEqual(a.meta.gold, 500);
    assert.strictEqual(a.me.inv.filter(Boolean).length, 8, '起始背包 8 格');
    console.log('  ✓ 开农场，拿到地图与背包');

    // 2. 朋友用编号加入
    const b = await login('小麦', tB);
    b.send('join', { code: code.toLowerCase() });
    await b.wait((m) => m.t === 'init');
    assert.strictEqual(b.init.farm.code, code);
    await a.waitTick((d) => d.p.length === 2);
    await a.wait((m) => m.t === 'chat' && /欢迎新伙伴 小麦/.test(m.d.text));
    console.log('  ✓ 朋友加入，双方都能看到对方');

    // 3. 走位：正常走动通过，瞬移被拉回
    const sx = a.me.x;
    const sy = a.me.y;
    a.send('mv', { x: sx + 0.3, y: sy, f: 1 });
    await sleep(150);
    a.send('mv', { x: sx + 25, y: sy, f: 1 });
    const corr = await a.wait((m) => m.t === 'corr');
    assert.ok(Math.abs(corr.d.x - (sx + 0.3)) < 0.01, '拉回到上一个合法位置');
    await b.waitTick((d) => d.p.some(([id, x]) => id === String(a.init.you) && Math.abs(x - (sx + 0.3)) < 0.01));
    console.log('  ✓ 走位同步，瞬移被拉回');

    // 4. 翻地 → 对方收到地图变化
    const W = cfg.MAP.W;
    const ground = dec(a.world.ground);
    const objs = new Map(a.world.objs);
    const px = sx + 0.3;
    let target = null;
    for (const [dx, dy] of [[0, 1], [1, 1], [-1, 1], [0, 2], [1, 0], [-1, 0]]) {
      const x = Math.floor(px) + dx;
      const y = Math.floor(sy) + dy;
      const i = y * W + x;
      if ((ground[i] === G.GRASS || ground[i] === G.DIRT) && !objs.has(i) && Math.hypot(x + 0.5 - px, y + 0.5 - sy) <= cfg.PLAYER.reach) {
        target = { x, y, i };
        break;
      }
    }
    assert.ok(target, '出生点旁边有空地');
    const hoeSlot = a.me.inv.findIndex((s) => s && s.id === 'hoe');
    let r = await a.act({ type: 'use', slot: hoeSlot, x: target.x, y: target.y });
    assert.ok(r.ok, r.error);
    await b.waitTick((d) => d.ch && d.ch.g.some(([i, v]) => i === target.i && v === G.TILLED));
    await sleep(250);
    const seedSlot = a.me.inv.findIndex((s) => s && s.id === 'parsnip_seed');
    r = await a.act({ type: 'use', slot: seedSlot, x: target.x, y: target.y });
    assert.ok(r.ok, r.error);
    await b.waitTick((d) => d.ch && d.ch.o.some(([i, o]) => i === target.i && o && o.k === 'crop'));
    await sleep(250);
    r = await a.act({ type: 'use', slot: a.me.inv.findIndex((s) => s && s.id === 'can'), x: target.x, y: target.y });
    assert.ok(r.ok, r.error);
    assert.ok(a.me.energy < cfg.PLAYER.maxEnergy, '扣了体力');
    // 太远的格子不行
    await sleep(250);
    r = await a.act({ type: 'use', slot: hoeSlot, x: target.x + 8, y: target.y });
    assert.ok(!r.ok && /太远/.test(r.error));
    console.log('  ✓ 翻地、播种、浇水同步给朋友；太远的格子会被拒绝');

    // 5. 跨游戏邀请：在猛鬼宿舍页面的人也能收到
    const c = await login('路人', tC, '/dorm/ws');
    a.send('online');
    const online = await a.wait((m) => m.t === 'online');
    const cu = online.d.find((u) => u.username === '路人');
    assert.ok(cu, '在线列表里有路人');
    a.send('invite', { userId: cu.id });
    const inv = await c.wait((m) => m.t === 'invite');
    assert.strictEqual(inv.d.game, 'farm');
    assert.strictEqual(inv.d.code, code);
    c.send('inviteReply', { game: 'farm', fromUser: inv.d.fromUser, code, accept: false });
    await a.wait((m) => m.t === 'toast' && /暂时不能来/.test(m.d.msg));
    console.log('  ✓ 跨游戏邀请与婉拒');

    // 6. 平台大厅：游戏柜里有青野牧歌
    const games = (await http('GET', '/api/games', null, tA)).data.games;
    const fg = games.find((g) => g.id === 'farm');
    assert.ok(fg && fg.path === '/farm/');
    assert.strictEqual(fg.live.playing, 2);
    assert.match(fg.live.mineText, /1 座农场/);
    console.log('  ✓ 平台大厅展示农场与在线人数');

    // 7. 两人都睡下 → 新的一天
    const door = cfg.MAP.house.door;
    for (const [cl] of [[a], [b]]) {
      cl.send('mv', { x: door.x + 0.5, y: door.y + 1.2, f: 0 });
    }
    await sleep(300);
    // 走过去要几步（服务器会检查速度）
    for (const cl of [a, b]) {
      let { x, y } = cl.me;
      for (let k = 0; k < 20; k++) {
        const tx = door.x + 0.5;
        const ty = door.y + 1.4;
        const d = Math.hypot(tx - x, ty - y);
        if (d < 0.05) break;
        const st = Math.min(d, 0.5);
        x += ((tx - x) / d) * st;
        y += ((ty - y) / d) * st;
        cl.send('mv', { x, y, f: 0 });
        await sleep(130);
      }
    }
    await sleep(200);
    r = await a.act({ type: 'sleep' });
    assert.ok(r.ok, r.error);
    await sleep(200);
    assert.strictEqual(a.meta.day, 1, '还有人醒着，天没亮');
    r = await b.act({ type: 'sleep' });
    assert.ok(r.ok, r.error);
    await a.waitTick((d) => d.ev && d.ev.some((e) => e.type === 'day'));
    await a.waitTick((d) => d.meta && d.meta.day === 2);
    const watered = a.changes.some((ch) => ch.o.some(([i, o]) => i === target.i && o && o.age === 1));
    assert.ok(watered, '浇过水的防风草长了一天');
    assert.strictEqual(a.me.energy, cfg.PLAYER.maxEnergy, '睡觉回满体力');
    console.log('  ✓ 两人都睡下进入新的一天，作物生长，体力回满');

    // 8. 列表与聊天
    b.send('chat', { text: '早上好' });
    await a.wait((m) => m.t === 'chat' && m.d.text === '早上好');
    b.send('list');
    const list = await b.wait((m) => m.t === 'farms');
    assert.ok(list.d.mine.some((f) => f.code === code && f.online === 2));
    console.log('  ✓ 聊天、我的农场列表');

    // 9. 重启服务器：存档还在
    a.ws.close();
    b.ws.close();
    c.ws.close();
    await sleep(300);
    await stopServer();
    await startServer();
    const b2 = await login('小麦', tB);
    b2.send('join', { code });
    await b2.wait((m) => m.t === 'init');
    assert.strictEqual(b2.meta.day, 2, '日期保存了');
    const g2 = dec(b2.world.ground);
    assert.strictEqual(g2[target.i], G.TILLED, '翻过的地保存了');
    const crop = new Map(b2.world.objs).get(target.i);
    assert.ok(crop && crop.k === 'crop' && crop.age === 1, '作物保存了');
    assert.strictEqual(b2.meta.members.length, 2);
    console.log('  ✓ 重启服务器后农场完整恢复');

    // 10. 移除与删除
    b2.send('leave');
    await b2.wait((m) => m.t === 'left');
    b2.send('forget', { code });
    const l2 = await b2.wait((m) => m.t === 'farms' && !m.d.mine.some((f) => f.code === code));
    assert.ok(l2);
    const a2 = await login('阿禾', tA);
    a2.send('forget', { code });
    await a2.wait((m) => m.t === 'farms' && !m.d.mine.length);
    b2.send('join', { code });
    await b2.wait((m) => m.t === 'error' && /农场不存在/.test(m.d.msg));
    const board = (await http('GET', '/api/farm/leaderboard', null, tA)).data.rows;
    assert.ok(!board.some((x) => x.name === '晴风农场'));
    console.log('  ✓ 成员移除、农场主删除农场');
    a2.ws.close();
    b2.ws.close();
    console.log('全部通过');
  } finally {
    await stopServer().catch(() => {});
    fs.rmSync(DB_DIR, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  if (srv) srv.kill('SIGKILL');
  process.exit(1);
});
