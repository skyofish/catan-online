'use strict';
// 猛鬼宿舍：电脑玩家对局模拟，校验规则不变量并输出各难度的胜率（用于调平衡）。
// 用法：node test/dorm-sim.js            —— 快速校验（npm test 使用）
//       node test/dorm-sim.js balance    —— 每种组合多跑几局，打印平衡报告
const assert = require('assert');
const { DormGame } = require('../server/games/dorm/sim');
const { botAction } = require('../server/games/dorm/bot');
const { DIFF_KEYS, BOT_LEVELS, CELLS, GEOM } = require('../server/games/dorm/config');

function play(diff, levels, seed = 1) {
  // 可复现的随机数
  let s = seed >>> 0 || 1;
  const rng = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const players = levels.map((lv, i) => ({ id: 'p' + i, name: 'P' + i, color: '#fff', lv }));
  const g = new DormGame({ difficulty: diff, rng }, players);
  const think = players.map(() => rng());
  const dt = 0.1;
  let steps = 0;
  while (g.phase !== 'ended' && steps < 20000) {
    for (let i = 0; i < players.length; i++) {
      think[i] -= dt;
      if (think[i] > 0) continue;
      think[i] = BOT_LEVELS[players[i].lv].think;
      // 一次思考最多做几件事
      for (let k = 0; k < 4; k++) {
        const a = botAction(g, players[i].id, players[i].lv, {}, rng);
        if (!a) break;
        const r = g.act(players[i].id, a);
        assert.ok(r.ok, `电脑的操作应合法：${JSON.stringify(a)} ${r.error}`);
      }
    }
    g.step(dt);
    steps++;
    // 不变量
    for (const p of g.players) {
      assert.ok(p.gold >= -1e-6 && p.energy >= -1e-6, '金币与电力不能为负');
      if (p.room !== null) assert.strictEqual(g.rooms[p.room].owner, p.id);
    }
    const owners = g.rooms.filter((r) => r.owner).map((r) => r.owner);
    assert.strictEqual(new Set(owners).size, owners.length, '一人只能占一间宿舍');
    for (const r of g.rooms) {
      assert.ok(r.door.hp >= 0 && r.door.hp <= r.door.max + 1e-6);
      for (const idx of GEOM[r.i].bedCells) assert.strictEqual(r.cells[idx], null, '床上不能建造');
      assert.strictEqual(r.cells.length, CELLS);
    }
    assert.ok(g.ghost.hp >= 0 && g.ghost.hp <= g.ghost.max + 1e-6);
  }
  assert.strictEqual(g.phase, 'ended', '对局应在时限内结束');
  return { win: g.result.win, reason: g.result.reason, lv: g.ghost.lv, t: Math.round(g.playT), alive: g.alivePlayers().length, n: players.length };
}

const mode = process.argv[2];
if (mode === 'balance') {
  const N = Number(process.argv[3]) || 12;
  for (const diff of DIFF_KEYS) {
    for (const bl of Object.keys(BOT_LEVELS)) {
      for (const n of [1, 4, 8]) {
        let wins = 0;
        let kills = 0;
        let alive = 0;
        let lv = 0;
        let t = 0;
        for (let i = 0; i < N; i++) {
          const r = play(diff, Array(n).fill(bl), i * 7919 + n);
          wins += r.win;
          kills += r.reason === 'ghostDead';
          alive += r.alive / r.n;
          lv += r.lv;
          t += r.t;
        }
        console.log(`${diff.padEnd(9)} ${bl.padEnd(6)} ${n}人  胜率 ${String(Math.round((wins / N) * 100)).padStart(3)}%  打死鬼 ${kills}  存活 ${Math.round((alive / N) * 100)}%  鬼等级 ${(lv / N).toFixed(1)}  时长 ${Math.round(t / N)}s`);
      }
    }
  }
} else {
  let n = 0;
  for (const diff of DIFF_KEYS) {
    for (const lv of Object.keys(BOT_LEVELS)) {
      play(diff, [lv, lv, 'hard'], 11 + n);
      n++;
    }
  }
  play('normal', Array(8).fill('normal'), 5);
  console.log(`✓ 猛鬼宿舍：${n + 1} 局电脑对局，操作均合法，金币/门/猛鬼血量不变量成立`);
}
