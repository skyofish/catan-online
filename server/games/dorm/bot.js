'use strict';
// 猛鬼宿舍电脑玩家。
// 思路与卡坦岛的内置电脑相同：先列出所有可做的事并估算「每块金币的价值」，再挑最好的；
// 买不起但很值得的东西会攒钱。智谱 AI 玩家在此之上调整侧重（经济 / 防守 / 输出）。
const { GEOM, CELLS, BED, DOOR, BUILD, GHOST, BOT_LEVELS } = require('./config');
const { dist } = require('./sim');

const ENERGY_PRICE = 8; // 估价时 1 电力约等于多少金币
const costOf = (c) => (c.g || 0) + (c.e || 0) * ENERGY_PRICE;

// 选格子：输出类靠门，辅助类靠后
function pickCell(r, near) {
  const geo = GEOM[r.i];
  let best = -1;
  let bs = Infinity;
  for (let idx = 0; idx < CELLS; idx++) {
    if (r.cells[idx] || geo.bedCells.includes(idx)) continue;
    const d = dist(geo.cellCenter(idx), geo.atkDoor);
    const s = near ? d : -d;
    if (s < bs) {
      bs = s;
      best = idx;
    }
  }
  return best;
}

/**
 * 列出候选操作（包括暂时买不起的），每项带 value（越大越值）
 * focus：{ eco, def, atk } 侧重系数（AI 玩家用），默认均为 1
 */
function candidates(g, pid, focus = {}) {
  const p = g.P(pid);
  const r = g.roomOf(p);
  if (!p || !r || r.dead || !p.alive || g.phase === 'ended') return [];
  const geo = GEOM[r.i];
  const W = { eco: focus.eco || 1, def: focus.def || 1, atk: focus.atk || 1 };
  const out = [];
  const D = g.D;
  const gh = g.ghost;
  const lvNext = Math.min(GHOST.maxLv, gh.lv + 1);
  const gd = GHOST.dmg(lvNext) * g.dmgMul; // 为下一级做准备
  const remaining = g.timeLeft();
  const income = Math.max(1, g.income(p));
  const targeted = gh.target === r.i && (gh.state === 'hunt' || gh.state === 'door' || gh.state === 'bed');
  const threat = targeted ? 2 : 1;
  const wealth = income * 150;

  // 门要能扛住约 30 秒；输出要能在 30 秒内把猛鬼打回血池
  const H = gd * 30;
  const ghostHp = GHOST.hp(lvNext) * g.hpMul;
  // 接下来几次升级要用的电力；电力够用时不再造发电机
  const eRate = g.energyRate(p);
  let needE = 0;
  if (r.bed.lv < BED.income.length) needE = Math.max(needE, BED.cost[r.bed.lv - 1].e || 0);
  if (r.door.lv < DOOR.hp.length) needE = Math.max(needE, DOOR.cost[r.door.lv - 1].e || 0);
  for (const cell of r.cells) if (cell && cell.lv < BUILD[cell.type].cost.length) needE = Math.max(needE, BUILD[cell.type].cost[cell.lv].e || 0);
  if (r.bed.lv >= 4 || r.door.lv >= 4) needE = Math.max(needE, 30);
  const eShort = Math.max(0, needE * 2.5 - p.energy - eRate * 40);
  const Dneed = (ghostHp * (1 - D.retreatAt)) / 30;
  const myDps = g.dpsAt(geo.atkDoor);
  const slow = g.slowAt(geo.atkDoor);
  const doorMax = r.door.hp > 0 ? r.door.max : 0;

  const defVal = (dHP, cost) => {
    const need = Math.max(0, H * 1.5 - doorMax);
    const filled = Math.min(dHP, need) / H + (0.08 * dHP) / H;
    return (filled * wealth * threat * W.def) / cost;
  };
  const atkVal = (dDps, cost) => {
    const need = Math.max(0, Dneed * 1.5 - myDps);
    const filled = Math.min(dDps, need) / Dneed + (0.08 * dDps) / Dneed;
    return (filled * wealth * threat * W.atk) / cost;
  };

  // 床：回本越快越值
  if (r.bed.lv < BED.income.length) {
    const c = BED.cost[r.bed.lv - 1];
    const dInc = BED.income[r.bed.lv] - BED.income[r.bed.lv - 1];
    const horizon = Math.max(0, Math.min(remaining, 220) - 20);
    out.push({ a: { type: 'bed' }, c, value: ((dInc * horizon) / costOf(c)) * 0.6 * W.eco, kind: 'eco' });
  }
  // 门
  if (r.door.hp > 0 && r.door.lv < DOOR.hp.length) {
    const c = DOOR.cost[r.door.lv - 1];
    const dHP = DOOR.hp[r.door.lv] - DOOR.hp[r.door.lv - 1];
    // 门快破时升级能直接补血，更值
    const urgent = targeted && r.door.hp < r.door.max * 0.35 ? 2.5 : 1;
    out.push({ a: { type: 'door' }, c, value: defVal(dHP, costOf(c)) * urgent, kind: 'def' });
  }

  // 已有建筑升级
  let free = 0;
  for (let idx = 0; idx < CELLS; idx++) {
    if (!r.cells[idx] && !geo.bedCells.includes(idx)) free++;
    const cell = r.cells[idx];
    if (!cell) continue;
    const b = BUILD[cell.type];
    if (cell.lv >= b.cost.length) continue;
    const c = b.cost[cell.lv];
    const v = valueOf(cell.type, cell.lv, idx);
    if (v) out.push({ a: { type: 'upgrade', cell: idx }, c, value: v / costOf(c), kind: cell.type });
  }
  // 新建
  if (free > 0) {
    for (const type of Object.keys(BUILD)) {
      const near = type === 'turret' || type === 'thunder' || type === 'frost';
      const idx = pickCell(r, near);
      if (idx < 0) continue;
      const c = BUILD[type].cost[0];
      const v = valueOf(type, 0, idx);
      // 格子越来越少时，新建便宜货的价值打折
      const crowd = type === 'thunder' ? 1 : Math.min(1, 0.25 + free / 14);
      if (v) out.push({ a: { type: 'build', cell: idx, btype: type }, c, value: (v / costOf(c)) * crowd, kind: type });
    }
  }
  return out;

  // 某建筑从 lv 级到 lv+1 级的价值（未除以成本）
  function valueOf(type, lv, idx) {
    const b = BUILD[type];
    const inRange = (range) => dist(geo.cellCenter(idx), geo.atkDoor) <= range;
    switch (type) {
      case 'turret':
      case 'thunder': {
        if (!inRange(b.range)) return 0;
        const arm = GHOST.armor(lvNext) * D.armorMul;
        const d = (g.effDmg(b.dmg[lv], arm) - (lv ? g.effDmg(b.dmg[lv - 1], arm) : 0)) / b.cd;
        return atkVal(d, 1);
      }
      case 'repair': {
        const d = b.heal[lv] - (lv ? b.heal[lv - 1] : 0);
        return defVal(d * 25, 1);
      }
      case 'frost': {
        if (!inRange(b.range)) return 0;
        const s = b.slow[lv];
        if (s <= slow) return 0;
        const eq = (doorMax * (s - slow)) / (1 - s);
        return defVal(eq, 1) * 0.8;
      }
      case 'mirror': {
        const d = b.reflect[lv] - (lv ? b.reflect[lv - 1] : 0);
        return atkVal(gd * d, 1) * 0.9;
      }
      case 'generator': {
        if (!eShort) return 0;
        const d = b.energy[lv] - (lv ? b.energy[lv - 1] : 0);
        // 补上电力缺口能解锁的升级，按缺口折算价值
        return Math.min(d * 40, eShort) * ENERGY_PRICE * 1.2 * W.eco;
      }
    }
    return 0;
  }
}

const canAfford = (p, c) => p.gold >= (c.g || 0) && p.energy >= (c.e || 0);

/**
 * 给出一个动作或 null（无事可做 / 攒钱）
 * level：easy | normal | hard
 */
function botAction(g, pid, level = 'normal', focus = {}, rng = Math.random) {
  const p = g.P(pid);
  if (!p || !p.alive || g.phase === 'ended') return null;
  const L = BOT_LEVELS[level] || BOT_LEVELS.normal;

  // 选宿舍
  if (p.room === null) {
    if (g.phase !== 'prep') return null;
    const free = g.rooms.filter((r) => !r.owner);
    if (!free.length) return null;
    if (level === 'easy') return { type: 'claim', room: free[Math.floor(rng() * free.length)].i };
    // 离血池远、并且对面或隔壁有人（防御塔能互相照应）
    const owned = g.rooms.filter((r) => r.owner);
    const score = (r) => {
      const geo = GEOM[r.i];
      let s = geo.col * 1.2 + rng() * 1.5;
      for (const o of owned) {
        const og = GEOM[o.i];
        if (og.col === geo.col || Math.abs(og.col - geo.col) === 1) s += 1;
      }
      return s;
    };
    return { type: 'claim', room: free.reduce((a, b) => (score(b) > score(a) ? b : a)).i };
  }

  const list = candidates(g, pid, focus);
  if (!list.length) return null;
  const affordable = list.filter((x) => canAfford(p, x.c));

  // 菜鸟：时常乱买
  if (L.mistake && rng() < L.mistake) {
    if (!affordable.length) return null;
    return affordable[Math.floor(rng() * affordable.length)].a;
  }

  list.sort((a, b) => b.value - a.value);
  const best = list[0];
  if (canAfford(p, best.c)) return best.a;
  // 攒钱：最值得的东西很快就买得起
  const inc = Math.max(1, g.income(p));
  const er = g.energyRate(p);
  const waitG = Math.max(0, ((best.c.g || 0) - p.gold) / inc);
  const waitE = (best.c.e || 0) > p.energy ? (er > 0 ? ((best.c.e || 0) - p.energy) / er : Infinity) : 0;
  const wait = Math.max(waitG, waitE);
  const patience = level === 'hard' ? 30 : level === 'normal' ? 18 : 0;
  // 被攻击且门快坏时不攒钱
  const r = g.roomOf(p);
  const panic = g.ghost.target === r.i && r.door.hp < r.door.max * 0.5;
  if (wait < patience && !panic) return null;
  const alt = affordable.sort((a, b) => b.value - a.value)[0];
  if (alt && alt.value >= best.value * (panic ? 0.1 : 0.35)) return alt.a;
  return null;
}

module.exports = { botAction, candidates, pickCell, canAfford };
