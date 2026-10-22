'use strict';
// 猛鬼宿舍电脑玩家。
// 思路与卡坦岛的内置电脑相同：先列出所有可做的事并估算「每块金币的价值」，再挑最好的；
// 买不起但很值得的东西会攒钱。智谱 AI 玩家在此之上调整侧重（经济 / 防守 / 输出）。
// 开局时像真人一样从入口走进一间宿舍、躺到床上。
const { BED, DOOR, BUILD, GHOST, BOT_LEVELS, ATTACKERS, PROPS } = require('./config');
const { dist } = require('./sim');

const ENERGY_PRICE = 8; // 估价时 1 电力约等于多少金币
const costOf = (c) => (c.g || 0) + (c.e || 0) * ENERGY_PRICE;
const NEAR_DOOR = new Set(['turret', 'thunder', 'frost', 'sword', 'talisman', 'bell', 'trap']);

// 选格子：输出类靠门，辅助类靠后；引魂灯放在攻击建筑最多的地方
function pickCell(g, r, type) {
  const geo = g.geo[r.i];
  let best = -1;
  let bs = Infinity;
  for (let idx = 0; idx < r.cells.length; idx++) {
    if (r.cells[idx]) continue;
    const d = dist(g.cellCenter(r.i, idx), geo.atkDoor);
    let s;
    if (type === 'lantern') {
      const [x, y] = geo.cells[idx];
      let n = 0;
      geo.cells.forEach(([cx, cy], k) => {
        const c = r.cells[k];
        if (c && ATTACKERS.includes(c.type) && Math.abs(cx - x) <= 1 && Math.abs(cy - y) <= 1) n++;
      });
      s = -n * 10 + d * 0.1;
    } else s = NEAR_DOOR.has(type) ? d : -d;
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
  const geo = g.geo[r.i];
  const W = { eco: focus.eco || 1, def: focus.def || 1, atk: focus.atk || 1 };
  const out = [];
  const D = g.D;
  const gh = g.ghost;
  const lvNext = Math.min(GHOST.maxLv, gh.lv + 1);
  const gd = GHOST.dmg(lvNext) * g.dmgMul;
  const armor = GHOST.armor(lvNext) * D.armorMul;
  const remaining = g.timeLeft();
  const income = Math.max(1, g.income(p));
  const targeted = gh.target === r.i && (gh.state === 'hunt' || gh.state === 'door' || gh.state === 'bed');
  const threat = targeted ? 2 : 1;
  const wealth = income * 150;

  const H = gd * 30;
  const ghostHp = GHOST.hp(lvNext) * g.hpMul;
  const Dneed = (ghostHp * (1 - D.retreatAt)) / 30;
  const myDps = g.dpsAt(geo.atkDoor);
  const slow = g.slowAt(geo.atkDoor);
  const doorMax = r.door.hp > 0 ? r.door.max : 0;
  const eRate = g.energyRate(p);
  let needE = 0;
  if (r.bed.lv < BED.income.length) needE = Math.max(needE, BED.cost[r.bed.lv - 1].e || 0);
  if (r.door.lv < DOOR.hp.length) needE = Math.max(needE, DOOR.cost[r.door.lv - 1].e || 0);
  for (const cell of r.cells) if (cell && BUILD[cell.type] && cell.lv < BUILD[cell.type].cost.length) needE = Math.max(needE, BUILD[cell.type].cost[cell.lv].e || 0);
  if (r.bed.lv >= 4 || r.door.lv >= 4) needE = Math.max(needE, 30);
  const eShort = Math.max(0, needE * 2.5 - p.energy - eRate * 40);

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
  const ecoVal = (dInc, cost) => {
    const horizon = Math.max(0, Math.min(remaining, 220) - 20);
    return ((dInc * horizon) / cost) * 0.6 * W.eco;
  };

  // 储物柜：先搜
  r.cells.forEach((c, idx) => {
    if (c && c.type === 'chest') out.push({ a: { type: 'open', cell: idx }, c: {}, value: 1e6, kind: 'eco' });
  });
  if (r.bed.lv < BED.income.length) {
    const c = BED.cost[r.bed.lv - 1];
    out.push({ a: { type: 'bed' }, c, value: ecoVal(BED.income[r.bed.lv] - BED.income[r.bed.lv - 1], costOf(c)), kind: 'eco' });
  }
  if (r.door.hp > 0 && r.door.lv < DOOR.hp.length) {
    const c = DOOR.cost[r.door.lv - 1];
    const dHP = DOOR.hp[r.door.lv] - DOOR.hp[r.door.lv - 1];
    const urgent = targeted && r.door.hp < r.door.max * 0.35 ? 2.5 : 1;
    out.push({ a: { type: 'door' }, c, value: defVal(dHP, costOf(c)) * urgent, kind: 'def' });
  }

  let free = 0;
  for (let idx = 0; idx < r.cells.length; idx++) {
    const cell = r.cells[idx];
    if (!cell) {
      free++;
      continue;
    }
    if (cell.type === 'chest') continue;
    const b = BUILD[cell.type];
    if (cell.lv >= b.cost.length) continue;
    const c = b.cost[cell.lv];
    const v = valueOf(cell.type, cell.lv, idx);
    if (v) out.push({ a: { type: 'upgrade', cell: idx }, c, value: v / costOf(c), kind: cell.type });
  }
  if (free > 0) {
    for (const type of Object.keys(BUILD)) {
      const idx = pickCell(g, r, type);
      if (idx < 0) continue;
      const c = BUILD[type].cost[0];
      const v = valueOf(type, 0, idx);
      const crowd = type === 'thunder' ? 1 : Math.min(1, 0.25 + free / 14);
      // 同一种东西摆太多，边际收益递减（也让电脑的宿舍更多样）
      const same = r.cells.filter((x) => x && x.type === type).length;
      const dim = 1 / (1 + same * (type === 'repair' || type === 'cat' || type === 'generator' ? 0.45 : 0.12));
      if (v) out.push({ a: { type: 'build', cell: idx, btype: type }, c, value: (v / costOf(c)) * crowd * dim, kind: type });
    }
  }
  return out;

  // 某建筑从 lv 级到 lv+1 级的价值（未除以成本）
  function valueOf(type, lv, idx) {
    const b = BUILD[type];
    const from = g.cellCenter(r.i, idx);
    const inRange = (range, pt = geo.atkDoor) => dist(from, pt) <= range;
    const boost = 1 + g.boostOf(r.i, idx);
    const dd = (arr) => (g.effDmg(arr[lv] * boost, armor) - (lv ? g.effDmg(arr[lv - 1] * boost, armor) : 0)) / b.cd;
    switch (type) {
      case 'turret':
      case 'thunder':
      case 'sword':
        if (!inRange(b.range)) return inRange(b.range, geo.atkBed) ? atkVal(dd(b.dmg), 1) * 0.2 : 0;
        return atkVal(dd(b.dmg), 1);
      case 'talisman': {
        if (!inRange(b.range)) return 0;
        return atkVal(dd(b.dmg) + (b.burn[lv] - (lv ? b.burn[lv - 1] : 0)) * boost, 1);
      }
      case 'trap':
        if (inRange(b.range)) return atkVal(dd(b.dmg), 1) * 0.9;
        return inRange(b.range, geo.atkBed) ? atkVal(dd(b.dmg), 1) * 0.15 : 0;
      case 'bell': {
        if (!inRange(b.range)) return 0;
        const frac = b.stun[lv] / (b.cd[lv] + 2.5) - (lv ? b.stun[lv - 1] / (b.cd[lv - 1] + 2.5) : 0);
        return defVal(doorMax * frac * 1.5, 1) * 0.8;
      }
      case 'lantern': {
        const [x, y] = geo.cells[idx];
        let nd = 0;
        geo.cells.forEach(([cx, cy], k) => {
          if (k !== idx && Math.abs(cx - x) <= 1 && Math.abs(cy - y) <= 1) nd += g.cellDps(r.i, k, geo.atkDoor) / boost;
        });
        const d = b.boost[lv] - (lv ? b.boost[lv - 1] : 0);
        return nd ? atkVal(nd * d, 1) : 0;
      }
      case 'cat':
        return ecoVal(b.gold[lv] - (lv ? b.gold[lv - 1] : 0), 1) * 0.9;
      case 'altar': {
        const d = (b.heal[lv] - (lv ? b.heal[lv - 1] : 0)) * 20 + BED.hp[r.bed.lv - 1] * (b.bedHp[lv] - (lv ? b.bedHp[lv - 1] : 0));
        return defVal(d, 1) * 0.35;
      }
      case 'repair':
        return defVal((b.heal[lv] - (lv ? b.heal[lv - 1] : 0)) * 25, 1);
      case 'frost': {
        if (!inRange(b.range)) return 0;
        const s = b.slow[lv];
        if (s <= slow) return 0;
        return defVal((doorMax * (s - slow)) / (1 - s), 1) * 0.8;
      }
      case 'mirror':
        return atkVal(gd * (b.reflect[lv] - (lv ? b.reflect[lv - 1] : 0)), 1) * 0.9;
      case 'generator': {
        if (!eShort) return 0;
        const d = b.energy[lv] - (lv ? b.energy[lv - 1] : 0);
        return Math.min(d * 40, eShort) * ENERGY_PRICE * 1.2 * W.eco;
      }
    }
    return 0;
  }
}

const canAfford = (p, c) => p.gold >= (c.g || 0) && p.energy >= (c.e || 0);

// 估一间宿舍的好坏：可建格子多、初始道具好、离血池远、离自己近
function roomScore(g, r, p, level, rng) {
  const geo = g.geo[r.i];
  if (level === 'easy') return rng();
  let s = geo.cells.length * 0.25;
  for (const c of r.cells) {
    if (!c) continue;
    if (c.type === 'chest') s += ((c.loot.g || 0) + (c.loot.e || 0) * ENERGY_PRICE) / 40;
    else s += (BUILD[c.type].cost[0].g || 0) / 25;
  }
  s += ((geo.door.x - g.map.hall.x0) / (g.map.hall.x1 - g.map.hall.x0)) * 3;
  s -= dist(p, geo.center) / 12;
  return s + rng() * 1.2;
}

/**
 * 给出一个动作或 null（无事可做 / 攒钱 / 正在走路）
 * level：easy | normal | hard
 */
function botAction(g, pid, level = 'normal', focus = {}, rng = Math.random) {
  const p = g.P(pid);
  if (!p || !p.alive || g.phase === 'ended') return null;
  const L = BOT_LEVELS[level] || BOT_LEVELS.normal;

  // 开局：挑一间空宿舍走过去躺下
  if (p.state !== 'bed') {
    if (g.phase !== 'prep') return null;
    if (p.state === 'walk' && p.goalBed !== null && !g.rooms[p.goalBed].owner) return null;
    const free = g.rooms.filter((r) => !r.owner && !g.players.some((o) => o !== p && o.goalBed === r.i));
    const list = free.length ? free : g.rooms.filter((r) => !r.owner);
    if (!list.length) return null;
    const best = list.reduce((a, b) => (roomScore(g, b, p, level, rng) > roomScore(g, a, p, level, rng) ? b : a));
    const [hx, hy] = g.geo[best.i].bed.head;
    return { type: 'move', x: hx, y: hy };
  }

  const list = candidates(g, pid, focus);
  if (!list.length) return null;
  const affordable = list.filter((x) => canAfford(p, x.c));

  if (L.mistake && rng() < L.mistake) {
    if (!affordable.length) return null;
    return affordable[Math.floor(rng() * affordable.length)].a;
  }

  list.sort((a, b) => b.value - a.value);
  const best = list[0];
  if (canAfford(p, best.c)) return best.a;
  const inc = Math.max(1, g.income(p));
  const er = g.energyRate(p);
  const waitG = Math.max(0, ((best.c.g || 0) - p.gold) / inc);
  const waitE = (best.c.e || 0) > p.energy ? (er > 0 ? ((best.c.e || 0) - p.energy) / er : Infinity) : 0;
  const wait = Math.max(waitG, waitE);
  const patience = level === 'hard' ? 30 : level === 'normal' ? 18 : 0;
  const r = g.roomOf(p);
  const panic = g.ghost.target === r.i && r.door.hp < r.door.max * 0.5;
  if (wait < patience && !panic) return null;
  const alt = affordable.sort((a, b) => b.value - a.value)[0];
  if (alt && alt.value >= best.value * (panic ? 0.1 : 0.35)) return alt.a;
  return null;
}

void PROPS;
module.exports = { botAction, candidates, pickCell, canAfford };
