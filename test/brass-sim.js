'use strict';
// 工业革命：伯明翰 —— 电脑对局：2 / 3 / 4 人各跑若干局，校验规则不变量并输出分数概况。
// 加参数 stats 打印更详细的统计。
const assert = require('assert');
const { BrassGame } = require('../server/games/brass/game');
const { botAction } = require('../server/games/brass/bot');
const D = require('../server/games/brass/data');

const VERBOSE = process.argv.includes('stats');

function totalCards(n) {
  let c = 0;
  for (const l of D.LOCS) {
    if (l.region === 'teal' && n < 4) continue;
    if (l.region === 'blue' && n < 3) continue;
    c += l.cards;
  }
  for (const v of Object.values(D.INDUSTRY_CARDS)) c += v[n];
  return c;
}

function invariants(g) {
  assert(g.market.coal >= 0 && g.market.coal <= D.MARKET.coal.prices.length, '煤市场越界');
  assert(g.market.iron >= 0 && g.market.iron <= D.MARKET.iron.prices.length, '铁市场越界');
  const cards = g.deck.length + g.burned.length + g.players.reduce((s, p) => s + p.discard.length + p.hand.filter((c) => c.k === 'loc' || c.k === 'ind').length, 0);
  assert.strictEqual(cards, totalCards(g.n), '牌数不守恒');
  const wildsHeld = g.players.reduce((s, p) => s + p.hand.filter((c) => c.k === 'wloc').length, 0);
  assert.strictEqual(wildsHeld + g.wilds.wloc, 4, '万能地点牌不守恒');
  for (const p of g.players) {
    assert(p.money >= 0, `${p.name} 钱为负`);
    assert(p.hand.length <= 8, '手牌超过 8 张');
    assert(p.incomePos >= 0 && p.incomePos <= 99, '收入越界');
    const links = Object.values(g.links).filter((o) => o === p.id).length;
    assert(links <= 14 - p.linksLeft, '线路数量不对');
  }
  // 运河时代每个地点每人最多 1 座
  if (g.era === 'canal') {
    for (const [loc, row] of Object.entries(g.board)) {
      const owners = row.filter(Boolean).map((t) => t.owner);
      assert.strictEqual(new Set(owners).size, owners.length, `运河时代 ${loc} 有人建了两座`);
    }
  }
  // 线路只能建在当前时代允许的位置
  for (const id of Object.keys(g.links)) assert(g.era === 'canal' ? D.LINK_BY_ID[id].canal : D.LINK_BY_ID[id].rail, '线路类型不对');
  g.forTiles((t) => {
    assert(t.res >= 0, '方块为负');
    if (t.flipped) assert.strictEqual(t.res, 0);
  });
}

function run(n, levels, intro = false) {
  const players = Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'Bot' + i, color: '#000' }));
  const g = new BrassGame({ intro }, players);
  const counts = {};
  let steps = 0;
  const t0 = Date.now();
  while (g.phase !== 'ended') {
    assert(steps++ < 400, '对局没有结束');
    const pid = g.cur().id;
    const lvl = levels[g.pIdx(pid)];
    const a = botAction(g, pid, lvl);
    assert(a, '电脑没有行动');
    const r = g.act(pid, a);
    if (!r.ok) throw new Error(`动作失败 ${JSON.stringify(a)}: ${r.error}`);
    counts[a.type] = (counts[a.type] || 0) + 1;
    invariants(g);
  }
  const ms = Date.now() - t0;
  return { g, counts, ms, steps };
}

const summary = [];
for (const n of [2, 3, 4]) {
  for (let k = 0; k < 3; k++) {
    const levels = Array.from({ length: n }, (_, i) => (i === 0 ? 'hard' : i === 1 ? 'normal' : 'easy'));
    const { g, counts, ms, steps } = run(n, levels);
    const vps = g.players.map((p) => `${p.id}(${levels[g.pIdx(p.id)]})=${p.vp}`).join(' ');
    summary.push(`${n} 人 #${k + 1}：${steps} 步 ${ms}ms  ${vps}  ${JSON.stringify(counts)}`);
  }
}
{
  const { g, steps } = run(2, ['normal', 'normal'], true);
  assert.strictEqual(g.era, 'canal', '入门短局不应进入铁路时代');
  summary.push(`入门短局：${steps} 步，${g.players.map((p) => p.vp).join(' / ')}`);
}
// 失败的操作不改变状态
{
  const g = new BrassGame({}, [
    { id: 'a', name: 'A', color: '#000' },
    { id: 'b', name: 'B', color: '#111' },
  ]);
  const before = JSON.stringify(g.toJSON());
  const r = g.act(g.cur().id, { type: 'build', card: g.cur().hand[0].id, loc: 'birmingham', slot: 99, ind: 'cotton' });
  assert(!r.ok);
  assert.strictEqual(JSON.stringify(g.toJSON()), before, '失败的操作改变了状态');
  const other = g.players.find((p) => p.id !== g.cur().id);
  assert(!g.act(other.id, { type: 'pass', card: other.hand[0].id }).ok, '不是自己的回合也能行动');
}
console.log(summary.join('\n'));
console.log('✅ 伯明翰规则模拟通过');
