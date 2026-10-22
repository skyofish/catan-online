'use strict';
// 猛鬼宿舍：地图、建筑、难度等全部数值配置。前端通过 /api/dorm/config 读取同一份数据。

// ---------------- 地图（单位：格） ----------------
// 左侧是猛鬼的血池，中间一条走廊，上下各 4 间宿舍。每间宿舍内部 5×4 格，门朝走廊。
const MAP = {
  W: 31,
  H: 15,
  lair: { x: 0, y: 0, w: 6, h: 15, cx: 3, cy: 7.5 },
  hall: { x: 6, y: 6, w: 25, h: 3, cy: 7.5 },
  roomW: 5,
  roomH: 4,
};

// 第 i 间宿舍的几何信息。cell 编号 = r * 5 + k，r=0 是靠后墙的一排（床在这一排），r=3 挨着门
function roomGeom(i) {
  const top = i < 4;
  const c = i % 4;
  const x0 = 7 + c * 6;
  const doorX = x0 + 2;
  const cellXY = (idx) => {
    const r = Math.floor(idx / 5);
    const k = idx % 5;
    return { x: x0 + k, y: top ? 1 + r : 13 - r };
  };
  return {
    i,
    top,
    col: c,
    x0,
    y0: top ? 1 : 10,
    doorX,
    door: { x: doorX + 0.5, y: top ? 5.5 : 9.5 },
    // 猛鬼砸门时站的位置（走廊一侧）
    atkDoor: { x: doorX + 0.5, y: top ? 6.35 : 8.65 },
    // 走廊中线上对着门的位置
    hallPt: { x: doorX + 0.5, y: 7.5 },
    // 床在后排左侧两格（cell 0、1）；猛鬼攻击床时站在床前
    bedCells: [0, 1],
    bed: { x: x0 + 1, y: top ? 1.5 : 13.5 },
    atkBed: { x: x0 + 1.1, y: top ? 2.55 : 12.45 },
    cellXY,
    cellCenter: (idx) => {
      const p = cellXY(idx);
      return { x: p.x + 0.5, y: p.y + 0.5 };
    },
  };
}
const ROOMS = 8;
const CELLS = 20;
const GEOM = Array.from({ length: ROOMS }, (_, i) => roomGeom(i));

// ---------------- 床与门 ----------------
// cost[i]：从 i+1 级升到 i+2 级的花费
const BED = {
  name: '床',
  income: [3, 5, 8, 12, 18, 26, 37, 52, 72, 100], // 每秒金币
  hp: [500, 700, 950, 1250, 1650, 2200, 2900, 3800, 5000, 6500],
  cost: [
    { g: 25 }, { g: 60 }, { g: 140 }, { g: 300 }, { g: 600, e: 20 },
    { g: 1150, e: 50 }, { g: 2200, e: 120 }, { g: 4000, e: 260 }, { g: 7000, e: 500 },
  ],
};
const DOOR = {
  name: '门',
  hp: [500, 900, 1600, 2700, 4500, 7500, 12000, 19000, 30000, 48000],
  cost: [
    { g: 30 }, { g: 80 }, { g: 180 }, { g: 380, e: 10 }, { g: 750, e: 30 },
    { g: 1500, e: 80 }, { g: 2800, e: 180 }, { g: 5200, e: 360 }, { g: 9000, e: 700 },
  ],
};

// ---------------- 建筑 ----------------
// cost[i]：建造（i=0）或升到 i+1 级的花费
const BUILD = {
  turret: {
    name: '桃木弩',
    desc: '自动射击范围内的猛鬼',
    range: 4.6,
    cd: 0.8,
    dmg: [10, 22, 45, 85, 150, 260, 430, 700],
    cost: [{ g: 15 }, { g: 30 }, { g: 70 }, { g: 160 }, { g: 380, e: 10 }, { g: 850, e: 30 }, { g: 1800, e: 80 }, { g: 3600, e: 180 }],
  },
  thunder: {
    name: '天雷符',
    desc: '蓄力后降下天雷，单发伤害极高',
    range: 5.2,
    cd: 3.5,
    dmg: [220, 480, 1050, 2300, 4800],
    cost: [{ g: 150, e: 10 }, { g: 400, e: 30 }, { g: 1000, e: 80 }, { g: 2400, e: 180 }, { g: 5000, e: 400 }],
  },
  frost: {
    name: '寒冰棺',
    desc: '让范围内的猛鬼动作变慢',
    range: 4.2,
    slow: [0.2, 0.3, 0.4, 0.5],
    cost: [{ g: 60 }, { g: 200, e: 10 }, { g: 600, e: 40 }, { g: 1600, e: 120 }],
  },
  mirror: {
    name: '照妖镜',
    desc: '猛鬼砸本房门时，反弹部分伤害',
    reflect: [0.2, 0.3, 0.45, 0.6],
    cost: [{ g: 100 }, { g: 300, e: 20 }, { g: 900, e: 60 }, { g: 2400, e: 160 }],
  },
  repair: {
    name: '符水台',
    desc: '持续修复本房的门',
    heal: [8, 18, 40, 85, 170],
    cost: [{ g: 40 }, { g: 120 }, { g: 350, e: 15 }, { g: 900, e: 50 }, { g: 2200, e: 140 }],
  },
  generator: {
    name: '发电机',
    desc: '产出电力，高级升级需要电力',
    energy: [1, 2.2, 4, 7, 11],
    cost: [{ g: 25 }, { g: 80 }, { g: 220 }, { g: 600 }, { g: 1500 }],
  },
};
const BUILD_TYPES = Object.keys(BUILD);
const SELL_RATE = 0.5;

// ---------------- 猛鬼 ----------------
const GHOST = {
  maxLv: 20,
  hp: (lv) => Math.round(1200 * Math.pow(1.33, lv - 1)),
  dmg: (lv) => Math.round(25 * Math.pow(1.28, lv - 1)),
  hitEvery: 1.0,
  speed: (lv) => 3 + Math.min(1.5, lv * 0.08),
  retreatSpeed: 1.4,
  // 护甲：每发防御塔伤害先减去护甲（至少保留 20%），低级炮台堆数量不划算
  armor: (lv) => 2 + 2.5 * lv,
  healAfterKill: 0.2,
  // 人越多猛鬼越肉：血量乘以 1 + perPlayer × (人数 - 1)
  perPlayer: 0.2,
  // 人少时猛鬼伤害打折（单人 / 双人）
  dmgByPlayers: [0.75, 0.88, 1],
};

// ---------------- 难度 ----------------
// smart：猛鬼选择目标的聪明程度 0–3；scream：鬼哭（让目标房间的防御停摆）间隔，0 表示不会
const DIFFICULTY = {
  easy: { name: '简单', armorMul: 0.5, hpMul: 0.75, dmgMul: 0.7, levelEvery: 55, duration: 360, prep: 30, retreatAt: 0.4, healRate: 0.06, smart: 0, scream: 0, startGold: 40 },
  normal: { name: '普通', armorMul: 1, hpMul: 1, dmgMul: 1, levelEvery: 45, duration: 480, prep: 25, retreatAt: 0.35, healRate: 0.07, smart: 1, scream: 0, startGold: 30 },
  hard: { name: '困难', armorMul: 1.2, hpMul: 1.2, dmgMul: 1.2, levelEvery: 42, duration: 540, prep: 20, retreatAt: 0.3, healRate: 0.08, smart: 2, scream: 30, startGold: 30 },
  nightmare: { name: '噩梦', armorMul: 1.6, hpMul: 1.4, dmgMul: 1.35, levelEvery: 37, duration: 570, prep: 18, retreatAt: 0.25, healRate: 0.1, smart: 3, scream: 22, startGold: 30 },
};
const DIFF_KEYS = Object.keys(DIFFICULTY);

// ---------------- 电脑玩家 ----------------
const BOT_LEVELS = {
  easy: { name: '菜鸟', think: 2.6, mistake: 0.35 },
  normal: { name: '老手', think: 1.4, mistake: 0.1 },
  hard: { name: '大神', think: 0.7, mistake: 0 },
};

function publicConfig() {
  return { MAP, ROOMS, CELLS, BED, DOOR, BUILD, SELL_RATE, DIFFICULTY, BOT_LEVELS, GHOST: { maxLv: GHOST.maxLv } };
}

module.exports = { MAP, ROOMS, CELLS, GEOM, BED, DOOR, BUILD, BUILD_TYPES, SELL_RATE, GHOST, DIFFICULTY, DIFF_KEYS, BOT_LEVELS, roomGeom, publicConfig };
