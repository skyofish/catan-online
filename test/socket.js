'use strict';
// 联机冒烟测试：启动服务器，两个 WebSocket 客户端建房、加入、加电脑、开局、交易、断线重连。
// 需要 Node 22+（内置 WebSocket 客户端）。
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');

const PORT = 3999;
const URL = `ws://127.0.0.1:${PORT}/ws`;

function client(name, token) {
  const ws = new WebSocket(URL);
  const c = { ws, name, state: null, msgs: [], waiters: [], token };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'hello') c.token = m.d.token;
    if (m.t === 'room') c.state = m.d;
    c.msgs.push(m);
    c.waiters = c.waiters.filter((w) => !(w.pred(m) && (w.res(m), true)));
  };
  c.send = (t, d = {}) => ws.send(JSON.stringify({ t, d }));
  c.wait = (pred, ms = 5000) =>
    new Promise((res, rej) => {
      const hit = c.msgs.find(pred);
      if (hit) return res(hit);
      const w = { pred, res };
      c.waiters.push(w);
      setTimeout(() => rej(new Error(`${name} 等待超时`)), ms);
    });
  c.open = new Promise((r) => (ws.onopen = r));
  c.next = (pred, ms) => {
    c.msgs = [];
    return c.wait(pred, ms);
  };
  return c;
}

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT, BOT_DELAY_MS: '30' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((r) => srv.stdout.once('data', r));
  try {
    const a = client('A');
    await a.open;
    a.send('hello', {});
    await a.wait((m) => m.t === 'hello');
    a.send('create', { name: '甲', size: 6 });
    const r1 = await a.wait((m) => m.t === 'room');
    const code = r1.d.room.code;
    assert.strictEqual(r1.d.room.size, 6);
    assert.strictEqual(r1.d.room.specialBuild, true, '6 人默认开启特殊建造');

    const b = client('B');
    await b.open;
    b.send('hello', {});
    await b.wait((m) => m.t === 'hello');
    b.send('join', { code, name: '乙' });
    await b.wait((m) => m.t === 'room' && m.d.room.players.length === 2);
    b.send('start');
    await b.wait((m) => m.t === 'error' && /房主/.test(m.d.msg));
    a.send('addBot');
    a.send('addBot');
    await a.wait((m) => m.t === 'room' && m.d.room.players.length === 4);
    a.send('start');
    const g = await a.wait((m) => m.t === 'room' && m.d.game);
    assert.ok(g.d.game.board, '首次状态应包含棋盘');
    assert.strictEqual(g.d.game.board.tiles.length, 30);
    const bg = await b.wait((m) => m.t === 'room' && m.d.game);
    // 他人手牌隐藏
    const aId = g.d.you;
    assert.strictEqual(bg.d.game.players.find((p) => p.id === aId).res, null);

    // 双方真人按顺序完成初始放置（电脑由服务器自动操作）
    const humans = { [a.state.you]: a, [b.state.you]: b };
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const st = a.state.game;
      if (st.phase === 'play') break;
      const who = st.active[0];
      const c = humans[who];
      if (c && c.state.game.turn === who && c.state.game.me) {
        const gm = c.state.game;
        const before = gm.log.length;
        if (gm.sub === 'settlement') c.send('act', { type: 'settlement', vertex: gm.me.legal.settlements[0] });
        else c.send('act', { type: 'road', edge: gm.me.legal.roads[0] });
        await c.wait((m) => m.t === 'room' && m.d.game.log.length > before).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.strictEqual(a.state.game.phase, 'play', '初始放置应完成');
    console.log('✓ 初始放置完成');

    // 非当前玩家操作应被拒绝
    const notTurn = a.state.game.turn === a.state.you ? b : a;
    notTurn.msgs = [];
    notTurn.send('act', { type: 'roll' });
    await notTurn.wait((m) => m.t === 'error');
    console.log('✓ 非当前玩家无法操作');

    // 聊天
    a.send('chat', { text: '大家好' });
    await b.wait((m) => m.t === 'chat' && m.d.text === '大家好');
    console.log('✓ 聊天广播');

    // 断线重连：B 关闭连接后用同一 token 重新连接
    const tokenB = b.token;
    const youB = b.state.you;
    b.ws.close();
    await new Promise((r) => setTimeout(r, 200));
    const b2 = client('B2');
    await b2.open;
    b2.send('hello', { token: tokenB });
    await b2.wait((m) => m.t === 'hello');
    b2.send('join', { code });
    const rj = await b2.wait((m) => m.t === 'room' && m.d.game);
    assert.strictEqual(rj.d.you, youB, '重连应恢复原玩家身份');
    assert.ok(rj.d.game.board, '重连后应重新下发棋盘');
    console.log('✓ 断线重连恢复身份');

    // 观战者
    const s = client('S');
    await s.open;
    s.send('hello', {});
    await s.wait((m) => m.t === 'hello');
    s.send('join', { code, name: '路人' });
    const sv = await s.wait((m) => m.t === 'room' && m.d.game);
    assert.strictEqual(sv.d.you, null);
    assert.ok(sv.d.game.players.every((p) => p.res === null), '观战者看不到任何手牌');
    console.log('✓ 观战模式');

    // 房间列表
    s.send('list');
    const list = await s.wait((m) => m.t === 'rooms');
    assert.ok(list.d.some((r) => r.code === code));
    console.log('✓ 房间列表');

    a.ws.close();
    b2.ws.close();
    s.ws.close();
    console.log('✅ 联机冒烟测试通过');
  } catch (e) {
    console.error('❌', e);
    process.exitCode = 1;
  } finally {
    srv.kill();
  }
})();
