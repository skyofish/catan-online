'use strict';
// 用电脑玩家自动对局，验证规则引擎在 4/6/8 人地图上都能完整跑完。
const assert = require('assert');
const { Game, sumRes } = require('../server/games/catan/game');
const { botAction } = require('../server/games/catan/bot');
const { RES, LAYOUTS } = require('../server/games/catan/board');

function invariants(g) {
  const size = g.layout.bank;
  for (const k of RES) {
    const total = g.bank[k] + g.players.reduce((s, p) => s + p.res[k], 0);
    assert.strictEqual(total, size, `资源守恒失败: ${k} ${total}`);
    assert(g.bank[k] >= 0, '银行为负');
    for (const p of g.players) assert(p.res[k] >= 0, '手牌为负');
  }
  // 距离规则
  for (const vid of Object.keys(g.buildings)) for (const a of g.board.vertices[vid].adj) assert(!g.buildings[a], '距离规则被破坏');
  for (const p of g.players) {
    const s = Object.values(g.buildings).filter((b) => b.owner === p.id && b.type === 'settlement').length;
    const c = Object.values(g.buildings).filter((b) => b.owner === p.id && b.type === 'city').length;
    const r = Object.values(g.roads).filter((o) => o === p.id).length;
    assert.strictEqual(s + p.pieces.settlement, 5);
    assert.strictEqual(c + p.pieces.city, 4);
    assert.strictEqual(r + p.pieces.road, 15);
  }
}

function run(size, nPlayers, special) {
  const players = Array.from({ length: nPlayers }, (_, i) => ({ id: 'p' + i, name: 'Bot' + i, color: '#000' }));
  const g = new Game({ size, targetVP: 10, specialBuild: special }, players);
  let steps = 0;
  const counts = {};
  while (g.phase !== 'ended' && steps < 40000) {
    steps++;
    let acted = false;
    for (const p of g.players) {
      const a = botAction(g, p.id);
      if (!a) continue;
      const r = g.act(p.id, a);
      if (!r.ok) throw new Error(`动作失败 ${JSON.stringify(a)} sub=${g.sub}: ${r.error}`);
      counts[a.type] = (counts[a.type] || 0) + 1;
      acted = true;
      break;
    }
    if (!acted) throw new Error('卡死：没有玩家可以行动 sub=' + g.sub);
    if (steps % 50 === 0) invariants(g);
    // 视图不应抛错
    if (steps % 200 === 0) for (const p of g.players) JSON.stringify(g.view(p.id, true));
  }
  invariants(g);
  assert.strictEqual(g.phase, 'ended', `${size} 人地图未在步数内结束`);
  const w = g.P(g.winner);
  return { turns: g.turnCount, steps, winner: w.name, vp: g.vp(w), counts };
}

const configs = [
  [4, 2, false], [4, 3, false], [4, 4, false],
  [6, 5, true], [6, 6, true], [6, 6, false],
  [8, 7, true], [8, 8, true], [8, 8, false],
];
let total = 0;
for (const [size, n, sp] of configs) {
  for (let k = 0; k < 4; k++) {
    const r = run(size, n, sp);
    total++;
    if (k === 0) console.log(`地图${size} 玩家${n} 特殊建造=${sp}: ${r.turns} 回合, 胜者 ${r.winner} ${r.vp} 分, 动作 ${JSON.stringify(r.counts)}`);
  }
}
// 规则单测：手动场景
{
  const g = new Game({ size: 4 }, [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  const first = g.cur().id;
  assert.strictEqual(g.act(first === 'a' ? 'b' : 'a', { type: 'settlement', vertex: 0 }).ok, false, '非当前玩家不能放置');
  assert.strictEqual(g.act(first, { type: 'roll' }).ok, false, '初始阶段不能掷骰');
  assert.ok(g.act(first, { type: 'settlement', vertex: 0 }).ok);
  assert.strictEqual(g.act(first, { type: 'road', edge: 999 }).ok, false);
  const far = g.board.edges.find((e) => !e.v.includes(0)).id;
  assert.strictEqual(g.act(first, { type: 'road', edge: far }).ok, false, '道路必须连接新村庄');
  const adj = g.board.vertices[0].adj[0];
  const second = g.players[1].id;
  g.act(first, { type: 'road', edge: g.board.vertices[0].edges[0] });
  assert.strictEqual(g.act(second, { type: 'settlement', vertex: adj }).ok, false, '距离规则');
  const v = g.view(first);
  assert.strictEqual(v.players.find((p) => p.id === second).res, null, '他人手牌应隐藏');
}
console.log(`✅ 规则引擎模拟通过：共 ${total} 局完整对局。`);
