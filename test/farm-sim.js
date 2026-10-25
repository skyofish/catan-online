'use strict';
// 青野牧歌模拟测试：开荒、种地、浇水、过夜生长、收获、出货结算、季节更替、动物、钓鱼、祭坛、累倒、存档往返。
const assert = require('assert');
const { FarmWorld, invCount, invAdd, idx, W } = require('../server/games/farm/world');
const D = require('../server/games/farm/data');

const G = D.G;
let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('  ✓', name);
}

function fresh(seed = 7) {
  const w = new FarmWorld({ seed, name: '测试农场' });
  w.addMember('1', '阿禾', '#e8604c');
  w.join('1');
  w.rng = (() => {
    let s = 12345;
    return () => ((s = (s * 16807) % 2147483647) / 2147483647);
  })();
  return w;
}
const me = (w) => w.members['1'];
const slotOf = (w, id) => me(w).inv.findIndex((s) => s && s.id === id);
const at = (w, x, y) => Object.assign(me(w), { x: x + 0.5, y: y + 0.5 });
// 在出生点附近找一块空草地
function freeGrass(w, n = 1) {
  const out = [];
  for (let y = 10; y < 30 && out.length < n; y++) for (let x = 9; x < 30 && out.length < n; x++) {
    const i = idx(x, y);
    if (w.ground[i] === G.GRASS && w.freeTile(i)) out.push([x, y]);
  }
  return out;
}
const use = (w, id, x, y) => {
  w.online.get('1').lastUse = -1e9;
  return w.act('1', { type: 'use', slot: slotOf(w, id), x, y });
};

console.log('青野牧歌 模拟测试');

test('地图：出生点、门口可走，边缘是山崖，有池塘和石柱', () => {
  const w = fresh();
  assert.ok(w.walkable(D.MAP.start.x, D.MAP.start.y));
  assert.ok(w.walkable(D.MAP.house.door.x + 0.5, D.MAP.house.door.y + 0.5));
  assert.strictEqual(w.ground[idx(0, 0)], G.CLIFF);
  assert.strictEqual(w.ground[idx(Math.floor(D.MAP.pond.cx), Math.floor(D.MAP.pond.cy))], G.WATER);
  const pillars = [...w.objs.values()].filter((o) => o.k === 'pillar');
  assert.strictEqual(pillars.length, D.BUNDLES.length);
  // 同一个种子生成同样的地图
  const w2 = new FarmWorld({ seed: 7 });
  assert.deepStrictEqual([...w2.ground], [...w.ground]);
  assert.strictEqual(w2.objs.size, w.objs.size);
});

test('起始背包：6 件工具 + 防风草种子 + 面包', () => {
  const w = fresh();
  for (const t of ['hoe', 'can', 'axe', 'pick', 'scythe', 'rod']) assert.strictEqual(invCount(me(w).inv, t), 1);
  assert.strictEqual(invCount(me(w).inv, 'parsnip_seed'), 12);
  w.addMember('2', '小麦', '#3f8fd8');
  assert.strictEqual(invCount(w.members['2'].inv, 'parsnip_seed'), 6);
});

test('走位检查：瞬移和穿墙会被拉回', () => {
  const w = fresh();
  w.t = 1;
  const r = w.move('1', { x: me(w).x + 20, y: me(w).y, f: 1 });
  assert.ok(!r.ok && r.corr);
  w.t = 2;
  const r2 = w.move('1', { x: D.MAP.house.x + 1.5, y: D.MAP.house.y + 1.5, f: 0 });
  assert.ok(!r2.ok, '不能走进房子');
  w.t = 3;
  const r3 = w.move('1', { x: me(w).x + 0.4, y: me(w).y, f: 1 });
  assert.ok(r3.ok);
});

test('翻地、播种、浇水、过 4 天收获防风草，出货结算', () => {
  const w = fresh();
  const [[x, y]] = freeGrass(w);
  at(w, x, y - 1);
  assert.ok(use(w, 'hoe', x, y).ok);
  assert.strictEqual(w.ground[idx(x, y)], G.TILLED);
  assert.ok(use(w, 'parsnip_seed', x, y).ok);
  assert.strictEqual(w.objs.get(idx(x, y)).c, 'parsnip');
  const e0 = me(w).energy;
  for (let d = 0; d < 4; d++) {
    w.weather = 'sun';
    at(w, x, y - 1);
    assert.ok(use(w, 'can', x, y).ok, '浇水');
    w.newDay([]);
  }
  const crop = w.objs.get(idx(x, y));
  assert.ok(crop.ready, '4 天后成熟');
  at(w, x, y - 1);
  assert.ok(w.act('1', { type: 'interact', x, y }).ok);
  assert.strictEqual(invCount(me(w).inv, 'parsnip'), 1);
  assert.ok(!w.objs.has(idx(x, y)));
  // 出货
  at(w, D.MAP.bin.x, D.MAP.bin.y + 1);
  const g0 = w.gold;
  assert.ok(w.act('1', { type: 'ship', slot: slotOf(w, 'parsnip') }).ok);
  assert.strictEqual(w.bin.length, 1);
  w.newDay([]);
  assert.strictEqual(w.gold, g0 + D.CROPS.parsnip.price);
  assert.strictEqual(w.stats.earned, D.CROPS.parsnip.price);
});

test('没浇水不长；下雨自动浇水；洒水器每天浇周围 8 格', () => {
  const w = fresh();
  const [[x, y]] = freeGrass(w);
  at(w, x, y - 1);
  use(w, 'hoe', x, y);
  use(w, 'parsnip_seed', x, y);
  w.weather = 'sun';
  w.tomorrow = 'sun';
  w.newDay([]);
  assert.strictEqual(w.objs.get(idx(x, y)).age, 0, '没浇水不长');
  w.weather = 'rain';
  w.newDay([]);
  assert.strictEqual(w.objs.get(idx(x, y)).age, 1, '下雨天也算浇过水');
  // 洒水器
  const tiles = freeGrass(w, 30).filter(([a, b]) => a > x + 3 || b > y + 3);
  const [sx, sy] = tiles.find(([a, b]) => [[1, 0], [0, 1]].every(([dx, dy]) => w.freeTile(idx(a + dx, b + dy)) && w.ground[idx(a + dx, b + dy)] === G.GRASS));
  invAdd(me(w).inv, 'sprinkler', 1);
  at(w, sx, sy - 1);
  assert.ok(use(w, 'sprinkler', sx, sy).ok);
  at(w, sx + 1, sy - 1);
  use(w, 'hoe', sx + 1, sy);
  at(w, sx - 1, sy + 1);
  use(w, 'hoe', sx, sy + 1);
  w.weather = 'sun';
  w.tomorrow = 'sun';
  w.newDay([]);
  assert.strictEqual(w.wet[idx(sx + 1, sy)], 1);
  assert.strictEqual(w.wet[idx(sx, sy + 1)], 1);
  // 镐子收回洒水器
  at(w, sx, sy - 1);
  assert.ok(use(w, 'pick', sx, sy).ok);
  assert.strictEqual(invCount(me(w).inv, 'sprinkler'), 1);
});

test('不合季节不能种；换季后作物枯死；草莓收获后会再长', () => {
  const w = fresh();
  const tiles = freeGrass(w, 3);
  const [x, y] = tiles[0];
  const [x2, y2] = tiles[1];
  invAdd(me(w).inv, 'tomato_seed', 1);
  invAdd(me(w).inv, 'strawberry_seed', 1);
  at(w, x, y - 1);
  use(w, 'hoe', x, y);
  const r = use(w, 'tomato_seed', x, y);
  assert.ok(!r.ok && /夏/.test(r.error));
  assert.ok(use(w, 'strawberry_seed', x, y).ok);
  for (let d = 0; d < D.CROPS.strawberry.days; d++) {
    w.setWet(idx(x, y), 1);
    w.weather = 'sun';
    w.newDay([]);
  }
  at(w, x, y - 1);
  assert.ok(w.act('1', { type: 'interact', x, y }).ok);
  const o = w.objs.get(idx(x, y));
  assert.ok(o && !o.ready && o.age === D.CROPS.strawberry.days - D.CROPS.strawberry.regrow, '草莓留在地里再长');
  // 换季
  at(w, x2, y2 - 1);
  use(w, 'hoe', x2, y2);
  use(w, 'parsnip_seed', x2, y2);
  w.day = D.TIME.daysPerSeason;
  w.newDay([]);
  assert.strictEqual(w.season, 1);
  assert.ok(w.objs.get(idx(x2, y2)).dead, '春天的作物夏天枯死');
  assert.ok(w.objs.get(idx(x, y)).dead);
  assert.strictEqual(w.weather, 'sun', '换季第一天是晴天');
  at(w, x2, y2 - 1);
  assert.ok(use(w, 'scythe', x2, y2).ok, '镰刀清掉枯死的作物');
  assert.ok(!w.objs.has(idx(x2, y2)));
});

test('砍树、敲石头、割草：得到材料，扣体力', () => {
  const w = fresh();
  let tree = null;
  let rock = null;
  let weed = null;
  for (const [i, o] of w.objs) {
    const x = i % W;
    const y = Math.floor(i / W);
    const standable = [[0, 1], [0, -1], [1, 0], [-1, 0]].find(([dx, dy]) => w.walkable(x + dx + 0.5, y + dy + 0.5));
    if (!standable) continue;
    const pos = [x, y, x + standable[0], y + standable[1]];
    if (!tree && o.k === 'tree' && o.s === 2) tree = pos;
    if (!rock && o.k === 'rock' && !o.big) rock = pos;
    if (!weed && o.k === 'weed') weed = pos;
  }
  const e0 = me(w).energy;
  at(w, tree[2], tree[3]);
  for (let k = 0; k < 10; k++) assert.ok(use(w, 'axe', tree[0], tree[1]).ok);
  assert.strictEqual(w.objs.get(idx(tree[0], tree[1])).k, 'stump');
  for (let k = 0; k < 4; k++) use(w, 'axe', tree[0], tree[1]);
  assert.ok(!w.objs.has(idx(tree[0], tree[1])));
  assert.ok(invCount(me(w).inv, 'wood') >= 10);
  at(w, rock[2], rock[3]);
  assert.ok(use(w, 'pick', rock[0], rock[1]).ok);
  assert.ok(invCount(me(w).inv, 'stone') >= 1);
  at(w, weed[2], weed[3]);
  assert.ok(use(w, 'scythe', weed[0], weed[1]).ok);
  assert.ok(!w.objs.has(idx(weed[0], weed[1])));
  assert.strictEqual(me(w).energy, e0 - 15 * 2, '斧头 14 下 + 镐 1 下，各 2 点体力；镰刀不费体力');
});

test('体力耗尽不能用工具；吃东西回体力', () => {
  const w = fresh();
  const [[x, y]] = freeGrass(w);
  at(w, x, y - 1);
  me(w).energy = 1;
  const r = use(w, 'hoe', x, y);
  assert.ok(!r.ok && /累/.test(r.error));
  assert.ok(w.act('1', { type: 'eat', slot: slotOf(w, 'bread') }).ok);
  assert.strictEqual(me(w).energy, 61);
});

test('商店：营业时间、季节种子、钱不够', () => {
  const w = fresh();
  at(w, D.MAP.shop.front.x, D.MAP.shop.front.y + 1);
  w.time = 6 * 60;
  assert.ok(!w.act('1', { type: 'buy', id: 'potato_seed', n: 1 }).ok, '还没开门');
  w.time = 9 * 60;
  const g0 = w.gold;
  assert.ok(w.act('1', { type: 'buy', id: 'potato_seed', n: 2 }).ok);
  assert.strictEqual(w.gold, g0 - 100);
  assert.ok(!w.act('1', { type: 'buy', id: 'melon_seed', n: 1 }).ok, '春天不卖西瓜种子');
  w.gold = 10;
  assert.ok(!w.act('1', { type: 'buy', id: 'cauliflower_seed', n: 1 }).ok);
});

test('盖鸡舍（次日完工）、买鸡、喂养、摸摸、捡蛋', () => {
  const w = fresh();
  at(w, D.MAP.shop.front.x, D.MAP.shop.front.y + 1);
  w.time = 9 * 60;
  w.gold = 10000;
  assert.ok(!w.act('1', { type: 'buy', id: 'coop' }).ok, '材料不够');
  invAdd(me(w).inv, 'wood', 100);
  invAdd(me(w).inv, 'stone', 40);
  assert.ok(!w.act('1', { type: 'buy', id: 'chicken' }).ok, '没有鸡舍');
  assert.ok(w.act('1', { type: 'buy', id: 'coop' }).ok);
  assert.strictEqual(invCount(me(w).inv, 'wood'), 20);
  assert.ok(w.buildings.coop.pending);
  w.weather = 'sun';
  w.tomorrow = 'sun';
  w.newDay([]);
  assert.ok(w.buildings.coop.built);
  at(w, D.MAP.shop.front.x, D.MAP.shop.front.y + 1);
  w.time = 9 * 60;
  assert.ok(w.act('1', { type: 'buy', id: 'chicken' }).ok);
  assert.strictEqual(w.animals.length, 1);
  const an = w.animals[0];
  // 晴天自己吃草，第二天下蛋
  w.weather = 'sun';
  w.tomorrow = 'sun';
  w.newDay([]);
  assert.ok(an.ready);
  Object.assign(me(w), { x: an.x + 0.5, y: an.y });
  assert.ok(w.act('1', { type: 'pet', id: an.id }).ok);
  assert.strictEqual(invCount(me(w).inv, 'egg'), 1);
  assert.ok(an.petted);
  // 冬天要吃干草，没有就饿着
  w.season = 3;
  w.hay = 0;
  w.weather = 'snow';
  const fr = an.fr;
  w.newDay([]);
  assert.ok(!an.ready && an.fr < fr, '没干草饿了一天');
  w.hay = 3;
  w.newDay([]);
  assert.ok(an.ready && w.hay === 2, '吃了一份干草');
  // 动物在屋里：点门照顾
  an.inside = true;
  const dd = D.MAP.coop.door;
  at(w, dd.x, dd.y + 1);
  assert.ok(w.act('1', { type: 'barn', id: 'coop' }).ok);
  assert.strictEqual(invCount(me(w).inv, 'egg'), 2);
});

test('钓鱼：抛竿、咬钩、提竿、过小游戏得到鱼', () => {
  const w = fresh();
  // 找一块挨着岸边的水
  let spot = null;
  for (let y = 0; y < D.MAP.H && !spot; y++) for (let x = 0; x < W && !spot; x++) {
    if (w.ground[idx(x, y)] !== G.WATER) continue;
    if (w.walkable(x + 0.5, y + 2.5)) spot = [x, y];
  }
  assert.ok(spot);
  Object.assign(me(w), { x: spot[0] + 0.5, y: spot[1] + 2.5 });
  w.online.get('1').lastUse = -1e9;
  assert.ok(w.act('1', { type: 'use', slot: slotOf(w, 'rod'), x: spot[0], y: spot[1] }).ok);
  assert.ok(!w.act('1', { type: 'hook' }).ok, '还没咬钩就拉');
  w.online.get('1').lastUse = -1e9;
  w.act('1', { type: 'use', slot: slotOf(w, 'rod'), x: spot[0], y: spot[1] });
  let ev = [];
  for (let k = 0; k < 100 && !ev.some((e) => e.type === 'bite'); k++) ev = w.step(0.1);
  assert.ok(ev.some((e) => e.type === 'bite'));
  const h = w.act('1', { type: 'hook' });
  assert.ok(h.ok && D.FISH[h.fish]);
  assert.ok(!w.act('1', { type: 'reel', ok: true }).ok, '小游戏太快不算');
  for (let k = 0; k < 12; k++) w.step(0.1);
  assert.ok(w.act('1', { type: 'reel', ok: true }).ok);
  assert.strictEqual(invCount(me(w).inv, h.fish), 1);
  assert.strictEqual(w.stats.fish, 1);
});

test('古代祭坛：交齐供品得奖励，全部交齐体力上限提高', () => {
  const w = fresh();
  Object.assign(me(w), { x: D.MAP.shrine.cx, y: D.MAP.shrine.cy + 3 });
  const b = D.BUNDLES[0];
  for (const [id, n] of Object.entries(b.need)) invAdd(me(w).inv, id, n);
  const g0 = w.gold;
  assert.ok(w.act('1', { type: 'donate', bundle: b.id }).ok);
  assert.ok(w.bundleDone[b.id]);
  assert.strictEqual(w.gold, g0 + b.reward.gold);
  assert.strictEqual(invCount(me(w).inv, 'sprinkler'), b.reward.sprinkler);
  for (const bb of D.BUNDLES.slice(1)) {
    for (const [id, n] of Object.entries(bb.need)) invAdd(me(w).inv, id, n);
    assert.ok(w.act('1', { type: 'donate', bundle: bb.id }).ok);
  }
  assert.ok(w.shrineAwake());
  assert.strictEqual(w.maxEnergy(), D.PLAYER.maxEnergy + D.SHRINE_BONUS_ENERGY);
});

test('时钟：所有在线的人都睡下就进入新的一天；凌晨 2 点没睡的累倒', () => {
  const w = fresh();
  w.addMember('2', '小麦');
  w.join('2');
  const d0 = w.day;
  at(w, D.MAP.house.door.x, D.MAP.house.door.y);
  assert.ok(w.act('1', { type: 'sleep' }).ok);
  assert.strictEqual(w.day, d0, '还有人醒着');
  Object.assign(w.members['2'], { x: D.MAP.house.door.x + 0.5, y: D.MAP.house.door.y + 0.5 });
  assert.ok(w.act('2', { type: 'sleep' }).ok);
  assert.strictEqual(w.day, d0 + 1);
  assert.strictEqual(w.time, D.TIME.start);
  // 累倒
  w.step(0);
  w.time = D.TIME.end - 10;
  me(w).energy = 5;
  const ev = w.step(D.TIME.realSecPer10Min + 0.01);
  const day = ev.find((e) => e.type === 'day');
  assert.ok(day && day.passedOut.length === 2);
  assert.strictEqual(me(w).energy, Math.round(D.PLAYER.maxEnergy * 0.6));
  // 没人在线时钟不走
  w.leave('1');
  w.leave('2');
  const t0 = w.time;
  w.step(60);
  assert.strictEqual(w.time, t0);
});

test('背包满了：收获的东西掉在地上，可以捡起来', () => {
  const w = fresh();
  const inv = me(w).inv;
  for (let i = 0; i < inv.length; i++) if (!inv[i]) inv[i] = { id: 'fiber', n: 999 };
  const [[x, y]] = freeGrass(w);
  at(w, x, y);
  w.give('1', 'wood', 5);
  const drop = [...w.objs.entries()].find(([, o]) => o.k === 'drop');
  assert.ok(drop && drop[1].n === 5);
  inv[inv.length - 1] = null;
  const dx = drop[0] % W;
  const dy = Math.floor(drop[0] / W);
  at(w, dx, dy);
  assert.ok(w.act('1', { type: 'interact', x: dx, y: dy }).ok);
  assert.strictEqual(invCount(inv, 'wood'), 5);
});

test('存档往返：地图、作物、动物、成员、钱都一样', () => {
  const w = fresh();
  const [[x, y]] = freeGrass(w);
  at(w, x, y - 1);
  use(w, 'hoe', x, y);
  use(w, 'parsnip_seed', x, y);
  w.gold = 1234;
  w.buildings.coop.built = true;
  w.animals.push({ id: 9, kind: 'chicken', name: '团子', house: 'coop', fr: 300, since: 0, ready: true, petted: false, inside: false, x: 45, y: 24, tx: 45, ty: 24, f: 2, wait: 0 });
  const json = JSON.parse(JSON.stringify(w.toJSON()));
  const w2 = FarmWorld.fromJSON(json);
  assert.deepStrictEqual([...w2.ground], [...w.ground]);
  assert.deepStrictEqual(w2.objs.get(idx(x, y)), w.objs.get(idx(x, y)));
  assert.strictEqual(w2.gold, 1234);
  assert.strictEqual(w2.animals[0].name, '团子');
  assert.deepStrictEqual(w2.members['1'].inv, w.members['1'].inv);
  assert.strictEqual(w2.online.size, 0);
  // 视图能序列化
  assert.ok(JSON.stringify(w2.fullView()).length < 120000);
});

test('长期运行：随机操作 3 个季节，不变量保持', () => {
  const w = fresh(99);
  for (let d = 0; d < 84; d++) {
    for (let k = 0; k < 60; k++) {
      const x = 8 + Math.floor(w.rng() * 30);
      const y = 9 + Math.floor(w.rng() * 26);
      if (!w.walkable(x + 0.5, y - 0.5)) continue;
      at(w, x, y - 1);
      me(w).energy = 270;
      const tools = ['hoe', 'can', 'axe', 'pick', 'scythe', 'parsnip_seed'];
      const t = tools[Math.floor(w.rng() * tools.length)];
      if (slotOf(w, t) < 0) continue;
      use(w, t, x, y);
      w.act('1', { type: 'interact', x, y });
    }
    w.step(1);
    w.newDay([]);
    for (const [i, o] of w.objs) {
      assert.ok(i >= 0 && i < W * D.MAP.H);
      if (o.k === 'crop') assert.strictEqual(w.ground[i], G.TILLED, '作物一定在耕地上');
    }
    for (const s of me(w).inv) if (s) assert.ok(s.n > 0 && s.n <= 999);
  }
  assert.strictEqual(w.season, 3);
  assert.ok(w.objs.size > 100, '野外会长回来');
});

console.log(`全部通过（${passed} 项）`);
