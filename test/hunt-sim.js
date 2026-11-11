'use strict';
// 雾夜追猎模拟测试：地图连通性、规则不变量、电脑自己打完整局。加参数 balance 输出各水平的胜负分布。
const assert = require('assert');
const { HuntGame } = require('../server/games/hunt/sim');
const { botTick } = require('../server/games/hunt/bot');
const { buildMap, W, hits } = require('../server/games/hunt/maps');
const { RULES: R, SURVIVORS, HUNTERS, MAP_KEYS } = require('../server/games/hunt/data');

const SK = Object.keys(SURVIVORS);
const HK = Object.keys(HUNTERS);
function newGame(map, seed, hunterChar = HK[seed % 3], n = 4) {
  const ps = [{ id: 'h', name: '追', color: '#fff', role: 'hunter', char: hunterChar }];
  for (let i = 0; i < n; i++) ps.push({ id: 's' + i, name: '求' + i, color: '#fff', role: 'survivor', char: SK[(seed + i) % SK.length] });
  return new HuntGame({ map, seed }, ps);
}
function run(g, sLevel, hLevel, check = false) {
  const mems = new Map(g.players.map((p) => [p.id, {}]));
  const seen = {};
  let guard = 0;
  while (g.phase !== 'ended' && guard++ < 40000) {
    for (const p of g.players) botTick(g, p, p.role === 'hunter' ? hLevel : sLevel, mems.get(p.id), {});
    for (const e of g.step(R.tick)) seen[e.type] = (seen[e.type] || 0) + 1;
    if (check && guard % 7 === 0) invariants(g);
  }
  assert.strictEqual(g.phase, 'ended', '对局应在限定时间内结束');
  return seen;
}
function invariants(g) {
  for (const p of g.players) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z), '坐标应是有限数');
    assert.ok(p.x > 0 && p.z > 0 && p.x < W && p.z < W, '不能走出地图');
    if (p.role === 'survivor') assert.ok(p.hp >= 0 && p.hp <= 2);
    const free = p.st === 'ok' || p.st === 'down';
    if (free && !(p.act && p.act.type === 'vault')) assert.ok(!hits((x, z) => g.grid[z * W + x] === 1, p.x, p.z, R.radius - 0.05), `${p.id} 不能卡进墙里`);
    if (p.st === 'carried') assert.strictEqual(g.hunter.carrying, p.id);
    if (p.st === 'caged') assert.strictEqual(g.cages[p.cage].who, p.id);
  }
  for (const c of g.cages) if (c.who) assert.strictEqual(g.P(c.who).st, 'caged');
  for (const m of g.machines) assert.ok(m.p >= 0 && m.p <= 1);
  assert.ok(g.doneCount() <= R.machinesNeed || !g.powered === false);
}

// ---------- 地图 ----------
for (const k of MAP_KEYS) {
  const m = buildMap(k);
  assert.strictEqual(m.rows.length, W);
  assert.ok(m.slots.length >= R.machinesOnMap && m.cages.length >= 9 && m.pallets.length >= 12 && m.windows.length >= 12 && m.gates.length === 2, k + ' 地图元素数量');
  // 从出生点出发（窗不算路），所有发报机、铁笼、板子、窗两侧、电闸都要走得到
  const seen = new Uint8Array(W * W);
  const q = [[Math.floor(m.spawnS[0].x), Math.floor(m.spawnS[0].z)]];
  seen[q[0][1] * W + q[0][0]] = 1;
  while (q.length) {
    const [x, z] = q.pop();
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const i = (z + dz) * W + x + dx;
      if (x + dx < 0 || z + dz < 0 || x + dx >= W || z + dz >= W || seen[i] || m.grid[i]) continue;
      seen[i] = 1;
      q.push([x + dx, z + dz]);
    }
  }
  const ok = (x, z) => seen[Math.floor(z) * W + Math.floor(x)];
  for (const s of m.slots) assert.ok(ok(s.x, s.z), k + ' 发报机位置走不到');
  for (const s of m.cages) assert.ok(ok(s.x, s.z), k + ' 铁笼位置走不到');
  for (const s of m.pallets) assert.ok(ok(s.x, s.z), k + ' 木板位置走不到');
  for (const s of m.spawnS.concat(m.hatchSpots)) assert.ok(ok(s.x, s.z), k + ' 出生点走不到');
  for (const g of m.gates) assert.ok(ok(g.panel.x, g.panel.z), k + ' 电闸走不到');
  for (const w of m.windows) {
    const a = w.axis === 'x' ? [1, 0] : [0, 1];
    assert.ok(ok(w.x + a[0], w.z + a[1]) && ok(w.x - a[0], w.z - a[1]), k + ' 窗两侧应是空地');
  }
}
console.log('✓ 三张地图：元素齐全，发报机 / 铁笼 / 木板 / 窗 / 电闸全部走得到');

// ---------- 规则细节 ----------
{
  const g = newGame('circus', 5, 'reaper');
  while (g.phase === 'prep') g.step(R.tick);
  const s = g.P('s0');
  const s1 = g.P('s1');
  const h = g.hunter;
  const put = (p, o, dx = 1) => {
    p.x = o.x + dx;
    p.z = o.z;
  };
  // 修机 + 校准失败
  const m = g.machines[0];
  put(s, m);
  g.step(R.tick);
  assert.deepStrictEqual(s.hint, { type: 'decode', id: 0 });
  assert.ok(g.act('s0', { type: 'use' }).ok);
  s.autoQte = null;
  for (let i = 0; i < 20 * 20 && !s.qte; i++) g.step(R.tick);
  assert.ok(s.qte, '修机时会出现校准');
  const before = m.p;
  g.act('s0', { type: 'qte', f: (g.t - s.qte.start) / R.qteDur });
  // 故意按错（此刻指针还没到成功区）
  const ev = g.events.map((e) => e.type);
  assert.ok(ev.includes('spark') && m.p < before, '校准失败应掉进度并暴露');
  // 恐惧震慑：修机时挨打直接倒地
  put(h, s, 1.2);
  h.d = Math.atan2(s.x - h.x, s.z - h.z);
  assert.ok(g.act('h', { type: 'attack' }).ok);
  for (let i = 0; i < 12; i++) g.step(R.tick);
  assert.strictEqual(s.st, 'down', '互动中被击中直接倒地');
  // 扛人、关笼
  for (let i = 0; i < 80; i++) g.step(R.tick);
  put(h, s, 0.8);
  g.step(R.tick);
  assert.strictEqual(h.hint.type, 'pickup');
  g.act('h', { type: 'use' });
  for (let i = 0; i < 30; i++) g.step(R.tick);
  assert.strictEqual(s.st, 'carried');
  const c = g.cages[0];
  h.x = c.x + 1.2;
  h.z = c.z;
  if (hits(g.solidH, h.x, h.z, R.radius)) h.x = c.x - 1.2;
  g.step(R.tick);
  assert.strictEqual(h.hint.type, 'cage');
  g.act('h', { type: 'use' });
  for (let i = 0; i < 30; i++) g.step(R.tick);
  assert.strictEqual(s.st, 'caged');
  // 救人
  h.x = h.z = 3.5;
  s1.x = c.x;
  s1.z = c.z + 1.1;
  if (hits(g.solidS, s1.x, s1.z, R.radius)) s1.z = c.z - 1.1;
  g.step(R.tick);
  assert.strictEqual(s1.hint.type, 'rescue');
  g.act('s1', { type: 'use' });
  for (let i = 0; i < 40; i++) g.step(R.tick);
  assert.strictEqual(s.st, 'ok');
  assert.strictEqual(s.hp, 1);
  assert.strictEqual(s1.stats.rescue, 1);
  // 放板砸晕追猎者，追猎者砸板
  const pl = g.pallets[0];
  const ax = pl.axis === 'x';
  s1.x = pl.x + (ax ? 0.9 : 0);
  s1.z = pl.z + (ax ? 0 : 0.9);
  h.x = pl.x - (ax ? 0.6 : 0);
  h.z = pl.z - (ax ? 0 : 0.6);
  h.stun = 0;
  h.atk = null;
  g.step(R.tick);
  assert.strictEqual(s1.hint.type, 'drop');
  g.act('s1', { type: 'use' });
  assert.ok(h.stun > g.t && pl.st === 1, '板子砸晕追猎者');
  assert.ok(!hits(g.solidH, h.x, h.z, R.radius), '被板子推到一侧而不是卡在里面');
  for (let i = 0; i < 70; i++) g.step(R.tick);
  assert.strictEqual(h.hint.type, 'break');
  g.act('h', { type: 'use' });
  for (let i = 0; i < 45; i++) g.step(R.tick);
  assert.strictEqual(pl.st, 2);
  // 翻窗
  const w = g.map.windows[0];
  const wa = w.axis === 'x';
  s1.x = w.x + 0.5 + (wa ? 1 : 0);
  s1.z = w.z + 0.5 + (wa ? 0 : 1);
  g.step(R.tick);
  if (s1.hint && s1.hint.type === 'vault') {
    g.act('s1', { type: 'use' });
    for (let i = 0; i < 25; i++) g.step(R.tick);
    assert.ok(wa ? s1.x < w.x + 0.5 : s1.z < w.z + 0.5, '翻到窗的另一侧');
  }
  // 通电、开门、逃脱
  for (const mm of g.machines.slice(0, R.machinesNeed)) {
    mm.p = 0.999;
    put(s1, mm);
    s1.autoQte = 0;
    g.step(R.tick);
    g.act('s1', { type: 'use' });
    for (let i = 0; i < 10 && !mm.done; i++) g.step(R.tick);
    assert.ok(mm.done);
  }
  assert.ok(g.powered, '修够数量后大门通电');
  const gt = g.gates[0];
  s1.x = gt.panel.x;
  s1.z = gt.panel.z;
  g.step(R.tick);
  assert.strictEqual(s1.hint.type, 'gate');
  g.act('s1', { type: 'use' });
  for (let i = 0; i < R.gateTime * 20 + 5; i++) g.step(R.tick);
  assert.ok(gt.open);
  s1.x = gt.x;
  s1.z = gt.z;
  g.step(R.tick);
  assert.strictEqual(s1.st, 'escaped');
  assert.ok(hits(g.solidH, gt.x, gt.z, 0.1), '追猎者进不了大门');
  // 隐身对追猎者不可见
  const il = g.survivors.find((x) => x.char === 'illusion' && x.st === 'ok');
  if (il) {
    il.cd = 0;
    assert.ok(g.act(il.id, { type: 'skill' }).ok);
    assert.strictEqual(g.view('h').players.find((p) => p.id === il.id).x, null);
    assert.notStrictEqual(g.view(il.id).players.find((p) => p.id === il.id).x, null);
  }
}
console.log('✓ 规则：校准、恐惧震慑、扛人关笼、救人、放板砸晕、砸板、翻窗、通电开门逃脱、隐身视野');

// ---------- 电脑自己打完整局 ----------
const balance = process.argv.includes('balance');
const combos = balance ? [['easy', 'easy'], ['normal', 'normal'], ['hard', 'hard'], ['hard', 'easy'], ['easy', 'hard']] : [['normal', 'normal'], ['hard', 'hard'], ['easy', 'normal']];
const N = balance ? 20 : 3;
const all = {};
for (const [sl, hl] of combos) {
  const tally = { survivors: 0, draw: 0, hunter: 0, esc: 0, time: 0, done: 0 };
  for (let i = 0; i < N; i++) {
    const g = newGame(MAP_KEYS[i % 3], 1000 + i * 17 + sl.length);
    const seen = run(g, sl, hl, true);
    for (const k in seen) all[k] = (all[k] || 0) + seen[k];
    tally[g.result.winner]++;
    tally.esc += g.result.escaped;
    tally.time += g.t;
    tally.done += g.doneCount();
  }
  if (balance) console.log(`  求生者${sl} vs 追猎者${hl}: 求生者胜 ${tally.survivors} 平 ${tally.draw} 追猎者胜 ${tally.hunter}｜平均逃脱 ${(tally.esc / N).toFixed(1)} 修机 ${(tally.done / N).toFixed(1)} 时长 ${Math.round(tally.time / N)}s`);
}
if (balance) console.log('  事件统计', all);
for (const k of ['hit', 'machine', 'caged', 'vault']) assert.ok(all[k] > 0, '电脑对局里应出现事件 ' + k);
console.log('✓ 电脑对局：三张地图、各种水平都能打完整局，过程中不变量成立');
