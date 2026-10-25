'use strict';
// 青野牧歌：全部数值与物品配置。前端通过 /api/farm/config 读取同一份数据。

// ---------------- 时间 ----------------
// 一天从 6:00 到次日 2:00（游戏内 1200 分钟）。每 10 分钟现实 7 秒，一天约 14 分钟。
const TIME = {
  start: 6 * 60,
  end: 26 * 60, // 凌晨 2 点没睡的人会累倒
  realSecPer10Min: 7,
  daysPerSeason: 28,
};
const SEASONS = [
  { id: 'spring', name: '春', rain: 0.2 },
  { id: 'summer', name: '夏', rain: 0.14 },
  { id: 'autumn', name: '秋', rain: 0.2 },
  { id: 'winter', name: '冬', rain: 0.28 }, // 冬天下的是雪
];

// ---------------- 玩家 ----------------
const PLAYER = {
  speed: 4.4, // 格/秒
  reach: 2.1, // 能碰到的距离（格）
  maxEnergy: 270,
  invSize: 24,
  hotbar: 8,
  canMax: 40, // 水壶容量
  useCooldownMs: 220,
};
const ENERGY_COST = { hoe: 2, can: 1, axe: 2, pick: 2, scythe: 0, rod: 3 };

// ---------------- 物品 ----------------
// kind: tool 工具 / seed 种子 / crop 作物 / forage 野外采集 / fish 鱼 / animal 畜产品 / res 材料 / place 可放置 / food 食物
// price: 放进出货箱的卖价；buy: 商店买价；energy: 可以吃，吃了回复体力
const ITEMS = {
  hoe: { name: '锄头', kind: 'tool', icon: '⛏' },
  can: { name: '水壶', kind: 'tool', icon: '🚿' },
  axe: { name: '斧头', kind: 'tool', icon: '🪓' },
  pick: { name: '镐子', kind: 'tool', icon: '⚒' },
  scythe: { name: '镰刀', kind: 'tool', icon: '🌾' },
  rod: { name: '钓竿', kind: 'tool', icon: '🎣' },

  wood: { name: '木材', kind: 'res', icon: '🪵', price: 2 },
  stone: { name: '石头', kind: 'res', icon: '🪨', price: 2 },
  fiber: { name: '纤维', kind: 'res', icon: '🌿', price: 1 },
  ore: { name: '古代矿石', kind: 'res', icon: '💠', price: 25 },
  hay: { name: '干草', kind: 'res', icon: '🌾', price: 0, buy: 50 },

  sprinkler: { name: '洒水器', kind: 'place', icon: '⛲', price: 50, desc: '每天早上给周围 8 格浇水' },
  campfire: { name: '营火', kind: 'place', icon: '🔥', price: 10, desc: '夜里发光的营火，坐在旁边很舒服' },
  path: { name: '石板路', kind: 'place', icon: '⬜', price: 1, desc: '铺在地上的石板路' },
  scarecrow: { name: '稻草人', kind: 'place', icon: '🎃', price: 20, desc: '守望田野的稻草人' },

  bento: { name: '便当', kind: 'food', icon: '🍱', buy: 150, price: 50, energy: 120 },
  bread: { name: '烤面包', kind: 'food', icon: '🍞', buy: 80, price: 25, energy: 60 },

  egg: { name: '鸡蛋', kind: 'animal', icon: '🥚', price: 50, energy: 25 },
  milk: { name: '牛奶', kind: 'animal', icon: '🥛', price: 125, energy: 38 },
  wool: { name: '羊毛', kind: 'animal', icon: '🧶', price: 340 },
};

// 作物：days 成熟天数；regrow 收获后再长几天又能收；yield 一次收几个；look 给前端画模型
const CROPS = {
  parsnip: { name: '防风草', season: ['spring'], seed: 20, price: 35, days: 4, energy: 25, look: { type: 'root', color: '#f2e2b0', leaf: '#5aa84a' } },
  potato: { name: '土豆', season: ['spring'], seed: 50, price: 80, days: 6, energy: 25, look: { type: 'root', color: '#c49a5c', leaf: '#4f9a44' } },
  cauliflower: { name: '花椰菜', season: ['spring'], seed: 80, price: 175, days: 12, energy: 75, look: { type: 'big', color: '#f4f0dc', leaf: '#6ab55a' } },
  strawberry: { name: '草莓', season: ['spring'], seed: 100, price: 120, days: 8, regrow: 4, energy: 50, look: { type: 'bush', color: '#e8384a', leaf: '#4a9e48' } },
  tomato: { name: '番茄', season: ['summer'], seed: 50, price: 60, days: 11, regrow: 4, energy: 20, look: { type: 'vine', color: '#e6402e', leaf: '#3f9140' } },
  blueberry: { name: '蓝莓', season: ['summer'], seed: 80, price: 50, days: 13, regrow: 4, yield: 3, energy: 25, look: { type: 'bush', color: '#4a6fe0', leaf: '#3c8a4a' } },
  melon: { name: '西瓜', season: ['summer'], seed: 80, price: 250, days: 12, energy: 113, look: { type: 'big', color: '#4f9a3a', leaf: '#66b04a', stripe: '#2f6a28' } },
  pepper: { name: '辣椒', season: ['summer'], seed: 40, price: 40, days: 5, regrow: 3, energy: 13, look: { type: 'vine', color: '#d8261c', leaf: '#4a9a3c' } },
  pumpkin: { name: '南瓜', season: ['autumn'], seed: 100, price: 320, days: 13, energy: 0, look: { type: 'big', color: '#ec8a24', leaf: '#5a9a3c' } },
  cranberry: { name: '蔓越莓', season: ['autumn'], seed: 240, price: 75, days: 7, regrow: 5, yield: 2, energy: 38, look: { type: 'bush', color: '#b81e3a', leaf: '#6a8a3a' } },
  eggplant: { name: '茄子', season: ['autumn'], seed: 20, price: 60, days: 5, regrow: 5, energy: 20, look: { type: 'vine', color: '#6a2a8a', leaf: '#4a8a3c' } },
  snowlotus: { name: '雪莲', season: ['winter'], seed: 70, price: 160, days: 9, energy: 40, look: { type: 'flower', color: '#e8f4ff', leaf: '#7ab0a0' } },
};
for (const [id, c] of Object.entries(CROPS)) {
  ITEMS[id] = { name: c.name, kind: 'crop', icon: '', crop: id, price: c.price, energy: c.energy || undefined };
  ITEMS[id + '_seed'] = { name: c.name + '种子', kind: 'seed', icon: '🌱', crop: id, buy: c.seed, price: Math.floor(c.seed / 2) };
}
const CROP_ICONS = { parsnip: '🥕', potato: '🥔', cauliflower: '🥦', strawberry: '🍓', tomato: '🍅', blueberry: '🫐', melon: '🍉', pepper: '🌶', pumpkin: '🎃', cranberry: '🍒', eggplant: '🍆', snowlotus: '🪷' };
for (const [id, ic] of Object.entries(CROP_ICONS)) ITEMS[id].icon = ic;

// 野外采集：每天早上在树林、池塘边刷新
const FORAGE = {
  leek: { name: '野葱', season: ['spring'], price: 60, energy: 40, icon: '🧅', color: '#d8e8c0' },
  daffodil: { name: '黄水仙', season: ['spring'], price: 30, icon: '🌼', color: '#f6d84a' },
  dandelion: { name: '蒲公英', season: ['spring'], price: 40, energy: 25, icon: '🌻', color: '#f4e070' },
  sweetpea: { name: '香豌豆花', season: ['summer'], price: 50, icon: '🌸', color: '#e888c8' },
  grape: { name: '野葡萄', season: ['summer'], price: 80, energy: 38, icon: '🍇', color: '#7a4ab8' },
  plum: { name: '野李', season: ['autumn'], price: 80, energy: 30, icon: '🫒', color: '#8a3a6a' },
  hazelnut: { name: '榛子', season: ['autumn'], price: 90, energy: 30, icon: '🌰', color: '#a8743a' },
  mushroom: { name: '林间蘑菇', season: ['spring', 'autumn'], price: 40, energy: 38, icon: '🍄', color: '#d8503a' },
  winterroot: { name: '冬根', season: ['winter'], price: 70, energy: 25, icon: '🫚', color: '#b88a5a' },
  crystalfruit: { name: '水晶果', season: ['winter'], price: 150, energy: 63, icon: '💎', color: '#a8e0ff' },
  shell: { name: '贝壳', season: ['spring', 'summer', 'autumn', 'winter'], price: 35, icon: '🐚', color: '#f4d8c8', shore: true },
};
for (const [id, f] of Object.entries(FORAGE)) ITEMS[id] = { name: f.name, kind: 'forage', icon: f.icon, price: f.price, energy: f.energy };

// 鱼：diff 1–5 越高越难钓；night 只在晚上 8 点后上钩；rain 只在雨天
const FISH = {
  carp: { name: '鲤鱼', season: ['spring', 'summer', 'autumn', 'winter'], price: 30, diff: 1, w: 10, energy: 13 },
  sunfish: { name: '太阳鱼', season: ['spring', 'summer'], price: 30, diff: 1, w: 8, energy: 13 },
  bass: { name: '大口鲈鱼', season: ['spring', 'summer', 'autumn', 'winter'], price: 60, diff: 2, w: 6, energy: 25 },
  catfish: { name: '鲶鱼', season: ['spring', 'autumn'], price: 200, diff: 4, w: 3, rain: true, energy: 50 },
  salmon: { name: '鲑鱼', season: ['autumn'], price: 75, diff: 3, w: 6, energy: 38 },
  pike: { name: '狗鱼', season: ['summer', 'winter'], price: 100, diff: 3, w: 4, energy: 38 },
  icecod: { name: '冰鳕', season: ['winter'], price: 120, diff: 3, w: 5, energy: 38 },
  glowtrout: { name: '辉光鳟', season: ['spring', 'summer', 'autumn', 'winter'], price: 400, diff: 5, w: 1.2, night: true, energy: 63 },
};
for (const [id, f] of Object.entries(FISH)) ITEMS[id] = { name: f.name, kind: 'fish', icon: id === 'glowtrout' ? '✨' : '🐟', price: f.price, energy: f.energy, diff: f.diff };

// ---------------- 动物 ----------------
// every: 几天产一次；不是冬天、不下雨时动物自己去草地吃草，否则每只每天要吃 1 份干草
const ANIMALS = {
  chicken: { name: '鸡', house: 'coop', buy: 600, product: 'egg', every: 1, color: '#f8f4ec' },
  cow: { name: '奶牛', house: 'barn', buy: 1500, product: 'milk', every: 1, color: '#f4f0e8' },
  sheep: { name: '绵羊', house: 'barn', buy: 2500, product: 'wool', every: 3, color: '#f0ece0' },
};
const ANIMAL_NAMES = ['团子', '豆豆', '雪球', '奶糖', '布丁', '小麦', '花卷', '年糕', '芝麻', '可可', '栗子', '麻薯'];

// ---------------- 建筑 ----------------
const BUILDINGS = {
  coop: { name: '鸡舍', cost: { gold: 1500, wood: 80, stone: 30 }, cap: 4, desc: '可以养 4 只鸡' },
  barn: { name: '畜棚', cost: { gold: 3000, wood: 150, stone: 60 }, cap: 4, desc: '可以养 4 头奶牛或绵羊' },
};

// ---------------- 制作 ----------------
const RECIPES = {
  sprinkler: { in: { ore: 2, stone: 10 }, out: 1 },
  campfire: { in: { wood: 10, stone: 5 }, out: 1 },
  path: { in: { stone: 1 }, out: 2 },
  scarecrow: { in: { wood: 20, fiber: 10 }, out: 1 },
};

// ---------------- 古代祭坛 ----------------
// 交齐一组供品就能唤醒一根石柱；全部唤醒后祭坛亮起，所有人体力上限提高
const BUNDLES = [
  { id: 'spring', name: '春之供奉', need: { parsnip: 5, potato: 5, cauliflower: 1 }, reward: { gold: 600, sprinkler: 2 } },
  { id: 'summer', name: '夏之供奉', need: { tomato: 5, blueberry: 6, melon: 1 }, reward: { gold: 900, sprinkler: 3 } },
  { id: 'autumn', name: '秋之供奉', need: { pumpkin: 1, cranberry: 4, eggplant: 5 }, reward: { gold: 1200, sprinkler: 4 } },
  { id: 'river', name: '渔人供奉', need: { carp: 2, bass: 1, sunfish: 1 }, reward: { gold: 500, bento: 3 } },
  { id: 'ranch', name: '牧场供奉', need: { egg: 5, milk: 3, wool: 1 }, reward: { gold: 1500, hay: 20 } },
  { id: 'wild', name: '山野供奉', need: { leek: 1, dandelion: 1, mushroom: 2, hazelnut: 1, wood: 50 }, reward: { gold: 800, campfire: 2 } },
];
const SHRINE_BONUS_ENERGY = 60;

// ---------------- 商店 ----------------
// 行商阿青的摊位：卖当季种子、干草、食物、动物与建筑
const SHOP_HOURS = [7 * 60, 22 * 60];
function shopStock(season) {
  const list = [];
  for (const [id, c] of Object.entries(CROPS)) if (c.season.includes(season)) list.push({ id: id + '_seed', price: c.seed });
  list.push({ id: 'hay', price: ITEMS.hay.buy }, { id: 'bread', price: ITEMS.bread.buy }, { id: 'bento', price: ITEMS.bento.buy });
  return list;
}

// ---------------- 地图 ----------------
// 地图坐标：x 向右、y 向下，每格 1 米。地面类型：
const G = { GRASS: 0, DIRT: 1, TILLED: 2, WATER: 3, CLIFF: 4, SAND: 5, STONE: 6, FENCE: 7, PATH: 8 };
const MAP = {
  W: 60,
  H: 46,
  house: { x: 9, y: 4, w: 5, h: 4, door: { x: 11, y: 8 } },
  bin: { x: 15, y: 7, w: 2, h: 1 },
  shop: { x: 29, y: 4, w: 4, h: 2, front: { x: 30, y: 6 } },
  shrine: { cx: 51.5, cy: 8.5, r: 4.6, altar: { x: 51, y: 8, w: 2, h: 2 } },
  pasture: { x: 39, y: 17, w: 18, h: 12, gate: [22, 23] },
  coop: { x: 41, y: 18, w: 4, h: 3, door: { x: 42, y: 21 } },
  barn: { x: 48, y: 18, w: 6, h: 4, door: { x: 50, y: 22 } },
  pond: { cx: 44, cy: 36, rx: 7, ry: 4.6 },
  field: { x: 8, y: 11, w: 27, h: 24 },
  start: { x: 11.5, y: 9.5 },
};

function publicConfig() {
  return { TIME, SEASONS, PLAYER, ENERGY_COST, ITEMS, CROPS, FORAGE, FISH, ANIMALS, BUILDINGS, RECIPES, BUNDLES, SHOP_HOURS, MAP, G, SHRINE_BONUS_ENERGY };
}

module.exports = { TIME, SEASONS, PLAYER, ENERGY_COST, ITEMS, CROPS, FORAGE, FISH, ANIMALS, ANIMAL_NAMES, BUILDINGS, RECIPES, BUNDLES, SHRINE_BONUS_ENERGY, SHOP_HOURS, shopStock, MAP, G, publicConfig };
