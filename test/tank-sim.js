'use strict';
const assert = require('node:assert/strict');
const { COLS, ROWS, BASE, ENTRY, DOCKS, TILE, MAPS } = require('../server/games/tank/maps');
const { TankMatch, STEP, WAVE_COUNT } = require('../server/games/tank/sim');
const { createPrediction } = require('../public/tank/js/prediction.mjs');

const seats = Array.from({ length: 4 }, (_, i) => ({ id: i + 1, color: '#45d7bb' }));
const middle = (c) => (c + 0.5) * TILE;
const flat = (x, y) => y * COLS + x;

for (const key of Object.keys(MAPS)) {
  const g = new TankMatch(key, seats);
  assert.equal(g.grid.length, COLS * ROWS);
  assert.equal(g.grid[flat(BASE.x, BASE.y)], 0);
  for (const x of DOCKS) assert.equal(g.grid[flat(x, 12)], 0);
  for (const x of ENTRY) {
    assert.equal(g.grid[flat(x, 0)], 0);
    assert.notEqual(g.route[flat(x, 0)], -1);
  }
  assert.ok(g.queue.length > new TankMatch(key, seats.slice(0, 1)).queue.length);
  for (let i = 0; i < 50 / STEP && !g.result; i++) g.step();
  assert.deepEqual(g.result, { won: false, reason: 'core', kills: 0, wave: 1 }, `${key} 的敌军应能抵达并摧毁信标`);
}

{
  const g = new TankMatch('depot', seats);
  const [pilot, teammate] = g.players;
  const straight = (x, y, dir, enemy = false) => {
    g.fire({ x, y, dir, damage: 0, score: 0, kills: 0 }, enemy);
    for (let i = 0; i < 12 && g.shots.length; i++) g.step();
  };
  const crate = flat(7, 2);
  for (const hp of [1, 0]) {
    straight(middle(7), middle(1), 2);
    assert.equal(g.grid[crate], hp);
  }
  assert.equal(g.revision, 3);
  straight(middle(4), middle(1), 2);
  assert.equal(g.grid[flat(4, 2)], -1);

  straight(teammate.x, teammate.y + 40, 0);
  assert.equal(teammate.hp, 3, '友军炮火不能伤害队友');
  teammate.shield = 100;
  straight(teammate.x, teammate.y + 30, 0, true);
  assert.equal(teammate.hp, 3, '复活护盾应拦截炮弹');
  teammate.shield = 0;
  for (let hit = 0; hit < 3; hit++) straight(teammate.x, teammate.y + 30, 0, true);
  assert.equal(teammate.hp, 0);
  assert.equal(teammate.lives, 2);
  for (let i = 0; i < 3 / STEP; i++) g.step();
  assert.equal(teammate.hp, 3);
  assert.ok(teammate.shield > 0);
  const before = pilot.x;
  g.setInput(pilot.id, { dir: 3, fire: false });
  g.step();
  assert.ok(pilot.x < before);
}

{
  const g = new TankMatch('depot', seats.slice(0, 1));
  const [p] = g.players;
  p.x = middle(2);
  p.y = middle(4);
  p.dir = 0;
  g.core.hp = 5;
  const ph = { id: 'test-enemy', type: 'scout', x: p.x, y: p.y - TILE, dir: 2, hp: 1, cooldown: 20, target: null };
  for (let wave = 1; wave <= WAVE_COUNT; wave++) {
    assert.equal(g.wave, wave);
    assert.equal(g.phase, 'ready');
    while (g.phase === 'ready') g.step();
    g.queue.length = 0;
    g.enemies.push({ ...ph });
    g.setInput(p.id, { dir: -1, fire: true });
    for (let i = 0; i < 40 && g.phase === 'wave'; i++) g.step();
    g.setInput(p.id, { dir: -1, fire: false });
    assert.equal(p.kills, wave);
  }
  assert.deepEqual(g.result, { won: true, reason: 'cleared', kills: 3, wave: 3 });
  assert.equal(g.core.hp, 9, '波次间应修复信标');
  assert.equal(p.score, 330);
}

{
  const g = new TankMatch('depot', seats.slice(0, 1));
  const p = g.snapshot().players[0];
  const prediction = createPrediction();
  prediction.setLatency(160);
  prediction.receive(p, g.arena, 1000);
  prediction.input(3, 1, 1010);
  assert.ok(prediction.pose(1026).x < p.x, '移动应在服务器确认之前出现');
  assert.equal(prediction.pose(1026).dir, 3);
  prediction.input(-1, 2, 1050);
  assert.equal(prediction.pose(1080).x, prediction.pose(1050).x, '松开键后立即停止');
  prediction.receive({ ...p, inputSeq: 2, x: p.x - 7 }, g.arena, 1090);
  assert.equal(prediction.pose(1200).x, p.x - 7, '以服务器确认位置为准');
  assert.equal(prediction.pose(1500), null, '长时间缺少状态时停止预演');

  g.grid[flat(7, 12)] = -1;
  prediction.reset();
  prediction.receive(p, g.arena, 2000);
  prediction.input(3, 1, 2000);
  assert.ok(prediction.pose(2120).x >= 8 * TILE + 15, '预演不得穿过掩体');
}

console.log('✅ 坦克大战规则模拟通过（三张图、障碍物、友军、复活、波次胜负和移动预演）');
