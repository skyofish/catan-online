'use strict';
// 工业革命：伯明翰 —— 静态数据：地图（城镇、产业格、商人、线路）、产业板块数值、牌堆构成。
// 坐标用于前端绘制（画布 1600 × 1200），服务器会把整份数据随第一次完整视图下发。

const IND = ['cotton', 'goods', 'pottery', 'brewery', 'coal', 'iron'];
const IND_NAME = { cotton: '棉纺厂', goods: '制造厂', pottery: '陶瓷厂', brewery: '酿酒厂', coal: '煤矿', iron: '炼铁厂' };

// 产业板块（每位玩家一套，按等级从低到高叠放在产业板上）
// cost 金钱；coal / iron 建造时消耗；beer 出售时需要的啤酒；vp 翻面后每个时代结算的分数；
// income 翻面时收入轨前进的格数；links 翻面后为相邻线路提供的分数图标；
// res 煤矿 / 炼铁厂建造时放上的方块数；canal 仅运河时代可建（铁路时代必须先开发掉）；
// nodev 灯泡标记：不能通过开发移除
const T = (count, cost, coal, iron, beer, vp, income, links, extra = {}) => ({ count, cost, coal, iron, beer, vp, income, links, ...extra });
const TILES = {
  cotton: {
    1: T(3, 12, 0, 0, 1, 5, 5, 1, { canal: true }),
    2: T(2, 14, 1, 0, 1, 5, 4, 2),
    3: T(3, 16, 1, 1, 1, 9, 3, 1),
    4: T(3, 18, 1, 1, 1, 12, 2, 1),
  },
  goods: {
    1: T(1, 8, 1, 0, 1, 3, 5, 2, { canal: true }),
    2: T(2, 10, 0, 1, 1, 5, 1, 1),
    3: T(1, 12, 2, 0, 0, 4, 4, 0),
    4: T(1, 8, 0, 1, 1, 3, 6, 1),
    5: T(2, 16, 1, 0, 2, 8, 2, 2),
    6: T(1, 20, 0, 0, 1, 7, 6, 1),
    7: T(1, 16, 1, 1, 0, 9, 4, 0),
    8: T(2, 20, 0, 2, 1, 11, 1, 1),
  },
  pottery: {
    1: T(1, 17, 0, 1, 1, 10, 5, 1, { canal: true, nodev: true }),
    2: T(1, 0, 1, 0, 1, 1, 1, 1),
    3: T(1, 22, 2, 0, 2, 11, 5, 1, { nodev: true }),
    4: T(1, 0, 1, 0, 1, 1, 1, 1),
    5: T(1, 24, 2, 0, 2, 20, 5, 1),
  },
  brewery: {
    1: T(2, 5, 0, 1, 0, 4, 4, 2, { canal: true }),
    2: T(2, 7, 0, 1, 0, 5, 5, 2),
    3: T(2, 9, 0, 1, 0, 7, 5, 2),
    4: T(1, 9, 0, 1, 0, 10, 5, 2),
  },
  coal: {
    1: T(1, 5, 0, 0, 0, 1, 4, 2, { canal: true, res: 2 }),
    2: T(2, 7, 0, 0, 0, 2, 7, 1, { res: 3 }),
    3: T(2, 8, 0, 1, 0, 3, 6, 1, { res: 4 }),
    4: T(2, 10, 0, 1, 0, 4, 5, 1, { res: 5 }),
  },
  iron: {
    1: T(1, 5, 1, 0, 0, 3, 3, 1, { canal: true, res: 4 }),
    2: T(1, 7, 1, 0, 0, 5, 3, 1, { res: 4 }),
    3: T(1, 9, 1, 0, 0, 7, 2, 1, { res: 5 }),
    4: T(1, 12, 1, 0, 0, 9, 1, 1, { res: 6 }),
  },
};
// 产业板上的叠放顺序
function matStacks() {
  const out = {};
  for (const ind of IND) {
    out[ind] = [];
    for (const [lv, t] of Object.entries(TILES[ind])) for (let i = 0; i < t.count; i++) out[ind].push(Number(lv));
  }
  return out;
}

// 城镇：region 决定地点牌在几人局中使用（teal 仅 4 人；blue 3–4 人；其余都用；farm 没有地点牌）
// slots：每个产业格可以建的产业（两个图标的格子任选其一）
const LOCS = [
  { id: 'leek', name: '利克', region: 'blue', x: 690, y: 110, cards: 2, slots: [['cotton', 'goods'], ['cotton', 'coal']] },
  { id: 'stoke', name: '斯托克', region: 'blue', x: 410, y: 210, cards: 3, slots: [['cotton', 'goods'], ['pottery', 'iron'], ['goods']] },
  { id: 'belper', name: '贝尔珀', region: 'teal', x: 1080, y: 105, cards: 2, slots: [['cotton', 'goods'], ['coal'], ['pottery']] },
  { id: 'derby', name: '德比', region: 'teal', x: 1250, y: 235, cards: 3, slots: [['cotton', 'brewery'], ['cotton', 'goods'], ['iron']] },
  { id: 'stone', name: '斯通', region: 'blue', x: 400, y: 350, cards: 2, slots: [['cotton', 'brewery'], ['goods', 'coal']] },
  { id: 'uttoxeter', name: '阿特克西特', region: 'blue', x: 830, y: 280, cards: 2, slots: [['goods', 'brewery'], ['cotton', 'brewery']] },
  { id: 'stafford', name: '斯塔福德', region: 'red', x: 500, y: 470, cards: 2, slots: [['goods', 'brewery'], ['pottery']] },
  { id: 'burton', name: '伯顿', region: 'red', x: 1080, y: 400, cards: 2, slots: [['goods', 'coal'], ['brewery']] },
  { id: 'cannock', name: '坎诺克', region: 'red', x: 800, y: 520, cards: 2, slots: [['goods', 'coal'], ['coal']] },
  { id: 'tamworth', name: '塔姆沃思', region: 'red', x: 1190, y: 570, cards: 1, slots: [['cotton', 'coal'], ['cotton', 'coal']] },
  { id: 'walsall', name: '沃尔索尔', region: 'red', x: 880, y: 670, cards: 1, slots: [['iron', 'goods'], ['goods', 'brewery']] },
  { id: 'farm1', name: '北郊酒坊', region: 'farm', x: 610, y: 560, cards: 0, slots: [['brewery']] },
  { id: 'coalbrookdale', name: '科尔布鲁克代尔', region: 'yellow', x: 260, y: 720, cards: 3, slots: [['iron', 'brewery'], ['iron'], ['coal']] },
  { id: 'wolverhampton', name: '伍尔弗汉普顿', region: 'yellow', x: 570, y: 720, cards: 2, slots: [['goods'], ['goods', 'coal']] },
  { id: 'dudley', name: '达德利', region: 'yellow', x: 590, y: 860, cards: 2, slots: [['coal'], ['iron']] },
  { id: 'kidderminster', name: '基德明斯特', region: 'yellow', x: 320, y: 930, cards: 2, slots: [['cotton', 'coal'], ['cotton']] },
  { id: 'worcester', name: '伍斯特', region: 'yellow', x: 520, y: 1040, cards: 2, slots: [['cotton'], ['cotton']] },
  { id: 'farm2', name: '南郊酒坊', region: 'farm', x: 150, y: 1030, cards: 0, slots: [['brewery']] },
  { id: 'birmingham', name: '伯明翰', region: 'purple', x: 960, y: 850, cards: 3, slots: [['cotton', 'goods'], ['goods'], ['iron'], ['goods']] },
  { id: 'nuneaton', name: '纳尼顿', region: 'purple', x: 1370, y: 700, cards: 1, slots: [['goods', 'brewery'], ['cotton', 'coal']] },
  { id: 'coventry', name: '考文垂', region: 'purple', x: 1360, y: 880, cards: 3, slots: [['pottery'], ['goods', 'coal'], ['iron', 'goods']] },
  { id: 'redditch', name: '雷迪奇', region: 'purple', x: 920, y: 1010, cards: 1, slots: [['goods', 'coal'], ['iron']] },
];

// 商人：minPlayers 几人局起使用；bonus 喝掉商人的啤酒出售时获得的奖励
const MERCHANTS = [
  { id: 'warrington', name: '沃灵顿', x: 150, y: 120, slots: 2, minPlayers: 3, bonus: { money: 5 }, bonusText: '£5' },
  { id: 'nottingham', name: '诺丁汉', x: 1470, y: 130, slots: 2, minPlayers: 4, bonus: { vp: 3 }, bonusText: '3 分' },
  { id: 'shrewsbury', name: '什鲁斯伯里', x: 100, y: 600, slots: 1, minPlayers: 2, bonus: { vp: 4 }, bonusText: '4 分' },
  { id: 'gloucester', name: '格洛斯特', x: 340, y: 1120, slots: 2, minPlayers: 2, bonus: { develop: 1 }, bonusText: '免费开发' },
  { id: 'oxford', name: '牛津', x: 1260, y: 1100, slots: 2, minPlayers: 2, bonus: { income: 2 }, bonusText: '收入 +2' },
];
// 商人板块：all = 三种商品都收；blank = 不收货（但仍是商人，可买煤）
const MERCHANT_TILES = { 2: ['cotton', 'goods', 'pottery', 'all', 'blank'], 3: ['goods', 'blank'], 4: ['cotton', 'blank'] };

// 线路：canal 运河时代可建，rail 铁路时代可建；bend 让线路略微弯曲（绘制用）
const L = (a, b, canal, rail, bend = 0) => ({ id: `${a}-${b}`, a, b, canal, rail, bend });
const LINKS = [
  L('warrington', 'stoke', 1, 1),
  L('stoke', 'leek', 1, 1, 0.08),
  L('leek', 'belper', 0, 1),
  L('belper', 'derby', 1, 1),
  L('derby', 'nottingham', 1, 1),
  L('derby', 'uttoxeter', 0, 1, -0.06),
  L('derby', 'burton', 1, 1),
  L('stoke', 'stone', 1, 1),
  L('stone', 'uttoxeter', 0, 1, 0.06),
  L('stone', 'stafford', 1, 1),
  L('stone', 'burton', 1, 1, 0.1),
  L('stafford', 'cannock', 1, 1),
  L('farm1', 'cannock', 1, 1),
  L('cannock', 'walsall', 1, 1),
  L('cannock', 'burton', 0, 1, -0.05),
  L('cannock', 'wolverhampton', 1, 1),
  L('burton', 'tamworth', 1, 1),
  L('burton', 'walsall', 1, 0, 0.12),
  L('tamworth', 'walsall', 1, 1),
  L('tamworth', 'nuneaton', 1, 1),
  L('tamworth', 'birmingham', 1, 1, 0.05),
  L('nuneaton', 'birmingham', 0, 1, -0.08),
  L('nuneaton', 'coventry', 1, 1),
  L('coventry', 'birmingham', 1, 1),
  L('birmingham', 'oxford', 1, 1, 0.06),
  L('birmingham', 'walsall', 1, 1),
  L('birmingham', 'dudley', 1, 1),
  L('birmingham', 'worcester', 1, 1, -0.06),
  L('birmingham', 'redditch', 0, 1),
  L('redditch', 'oxford', 1, 1),
  L('redditch', 'gloucester', 1, 1, 0.06),
  L('worcester', 'gloucester', 1, 1),
  L('worcester', 'farm2', 1, 1),
  L('kidderminster', 'farm2', 1, 1),
  L('kidderminster', 'dudley', 1, 1),
  L('kidderminster', 'coalbrookdale', 1, 1),
  L('coalbrookdale', 'shrewsbury', 1, 1),
  L('coalbrookdale', 'wolverhampton', 1, 1),
  L('wolverhampton', 'dudley', 1, 1),
  L('wolverhampton', 'walsall', 1, 1),
].map((l) => ({ ...l, canal: !!l.canal, rail: !!l.rail }));

// 行业牌数量：cg = 棉纺厂 / 制造厂 两用牌
const INDUSTRY_CARDS = {
  iron: { 2: 2, 3: 3, 4: 4 },
  coal: { 2: 2, 3: 2, 4: 3 },
  brewery: { 2: 3, 3: 4, 4: 5 },
  pottery: { 2: 2, 3: 2, 4: 3 },
  cg: { 2: 4, 3: 7, 4: 8 },
};
const CARD_IND = { iron: ['iron'], coal: ['coal'], brewery: ['brewery'], pottery: ['pottery'], cg: ['cotton', 'goods'] };
const CARD_IND_NAME = { iron: '炼铁厂', coal: '煤矿', brewery: '酿酒厂', pottery: '陶瓷厂', cg: '棉纺 / 制造' };

// 市场：每个价格两个空位，从贵到便宜依次放满；买走最便宜的方块，卖出时放进最贵的空位
const COAL_PRICES = [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7];
const IRON_PRICES = [1, 1, 2, 2, 3, 3, 4, 4, 5, 5];
const MARKET = {
  coal: { prices: COAL_PRICES, empty: 8, start: 13 },
  iron: { prices: IRON_PRICES, empty: 6, start: 8 },
};

const START_MONEY = 17;
const START_INCOME_POS = 10;
const HAND = 8;
const LINK_TILES = 14;

// 收入轨：位置 0–99 对应收入等级 -10…30
function incomeLevel(pos) {
  if (pos <= 10) return pos - 10;
  if (pos <= 30) return Math.ceil((pos - 10) / 2);
  if (pos <= 60) return 10 + Math.ceil((pos - 30) / 3);
  return Math.min(30, 20 + Math.ceil((pos - 60) / 4));
}
function topOfLevel(lv) {
  if (lv <= 0) return lv + 10;
  if (lv <= 10) return 10 + 2 * lv;
  if (lv <= 20) return 30 + 3 * (lv - 10);
  return Math.min(99, 60 + 4 * (lv - 20));
}

const LOC_BY_ID = Object.fromEntries(LOCS.map((l) => [l.id, l]));
const MERCHANT_BY_ID = Object.fromEntries(MERCHANTS.map((m) => [m.id, m]));
const LINK_BY_ID = Object.fromEntries(LINKS.map((l) => [l.id, l]));
const PLACE_NAME = { ...Object.fromEntries(LOCS.map((l) => [l.id, l.name])), ...Object.fromEntries(MERCHANTS.map((m) => [m.id, m.name])) };

// 前端绘制用的整份地图
function publicMap() {
  return { width: 1600, height: 1200, locs: LOCS, merchants: MERCHANTS, links: LINKS, tiles: TILES, coalPrices: COAL_PRICES, ironPrices: IRON_PRICES };
}

module.exports = {
  IND,
  IND_NAME,
  TILES,
  matStacks,
  LOCS,
  MERCHANTS,
  MERCHANT_TILES,
  LINKS,
  INDUSTRY_CARDS,
  CARD_IND,
  CARD_IND_NAME,
  MARKET,
  START_MONEY,
  START_INCOME_POS,
  HAND,
  LINK_TILES,
  incomeLevel,
  topOfLevel,
  LOC_BY_ID,
  MERCHANT_BY_ID,
  LINK_BY_ID,
  PLACE_NAME,
  publicMap,
};
