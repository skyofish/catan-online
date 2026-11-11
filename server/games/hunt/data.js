'use strict';
// 雾夜追猎：全部数值与角色设定。角色、地图均为原创设计。

const RULES = {
  tick: 0.05,
  machinesOnMap: 7, // 场上的发报机数量
  machinesNeed: 5, // 需要修好的数量
  decodeTime: 60, // 单人修好一台需要的秒数
  decodeTeam: [1, 1, 0.9, 0.8, 0.7], // 多人同修时每人的效率（按人数）
  qteEvery: [7, 13], // 校准出现的间隔
  qteDur: 1.6,
  qteFail: 0.08, // 校准失败损失的进度
  healTime: 14,
  healDownTime: 12,
  rescueTime: 1.3,
  gateTime: 16,
  cageTime: 70, // 笼中总时长；第二次进笼从一半开始，第三次直接淘汰
  struggleTime: 18,
  bleedTime: 150,
  maxTime: 780,
  survivorSpeed: 3.9,
  hunterSpeed: 4.65,
  carrySpeed: 4.0,
  crawlSpeed: 0.55,
  hitBoost: [2.2, 1.45], // 受击后加速 [秒, 倍率]
  attackWind: 0.32,
  attackRange: 2.3,
  attackCone: 0.95, // 弧度
  hitRecover: 2.6,
  missRecover: 1.0,
  palletStun: 3.2,
  breakTime: 1.9,
  vaultS: 0.85,
  vaultH: 1.7,
  pickupTime: 1.1,
  cagePutTime: 1.0,
  terror: 17, // 心跳半径
  prep: 5,
  radius: 0.32,
};

// 求生者
const SURVIVORS = {
  tinker: {
    name: '发条匠 · 柯蕾',
    short: '发条匠',
    tag: '修机位',
    desc: '钟表铺的学徒，随身带着一串齿轮。',
    passive: '修发报机速度 +20%，校准的成功区更宽。',
    skill: { name: '上紧发条', desc: '10 秒内修机速度再 +60%。', cd: 55 },
    color: '#c9a25a',
    look: { coat: '#6b4a2e', accent: '#c9a25a', hair: '#3a2a22', skin: '#e9d2b8', hat: 'goggles' },
  },
  nurse: {
    name: '夜巡护士 · 艾琳',
    short: '夜巡护士',
    tag: '治疗位',
    desc: '提着一盏小灯巡夜的护士，口袋里总有绷带。',
    passive: '治疗队友速度 +50%。',
    skill: { name: '自我包扎', desc: '受伤时原地包扎 10 秒恢复健康（移动会打断）。', cd: 40 },
    color: '#9fc7c9',
    look: { coat: '#dfe6e4', accent: '#8a3b3b', hair: '#7a4a2e', skin: '#f0dcc8', hat: 'cap' },
  },
  runner: {
    name: '信差 · 雷欧',
    short: '信差',
    tag: '牵制位',
    desc: '跑遍全城的邮差，没有他翻不过的窗。',
    passive: '翻窗、翻板速度 +25%。',
    skill: { name: '全力冲刺', desc: '3 秒内移动速度 +50%。', cd: 35 },
    color: '#d9794a',
    look: { coat: '#3f5a78', accent: '#d9794a', hair: '#2a2420', skin: '#e3c4a4', hat: 'flat' },
  },
  guard: {
    name: '守夜人 · 布鲁诺',
    short: '守夜人',
    tag: '救人位',
    desc: '提着信号枪的老守夜人，从不丢下同伴。',
    passive: '把队友救出铁笼的速度 +40%。',
    skill: { name: '信号弹', desc: '朝前方打出强光，6 米内正对的追猎者眩晕 2.2 秒；若他正扛着人，会把人放下。', cd: 50 },
    color: '#7d8a5a',
    look: { coat: '#4a5238', accent: '#b8a35a', hair: '#8a8a8a', skin: '#d8b898', hat: 'lantern' },
  },
  illusion: {
    name: '戏法师 · 希尔',
    short: '戏法师',
    tag: '辅助位',
    desc: '巡回剧团的魔术师，最擅长的一招是"消失"。',
    passive: '被击中后的加速时间更长。',
    skill: { name: '障眼法', desc: '隐身 4 秒并加速 15%，原地留下一个假人迷惑追猎者。', cd: 50 },
    color: '#8a6fc0',
    look: { coat: '#3a2a52', accent: '#c94a6a', hair: '#1c1a24', skin: '#ecd8c6', hat: 'top' },
  },
  scout: {
    name: '探路人 · 诺亚',
    short: '探路人',
    tag: '侦察位',
    desc: '带着一只铜哨的向导，雾里也认得路。',
    passive: '能更早听到心跳（感知范围 +40%）。',
    skill: { name: '铜哨', desc: '8 秒内让所有队友隔墙看见追猎者的位置。', cd: 40 },
    color: '#5aa07a',
    look: { coat: '#2f5a48', accent: '#d8c27a', hair: '#5a3a22', skin: '#dcbc9c', hat: 'hood' },
  },
};

// 追猎者
const HUNTERS = {
  reaper: {
    name: '拾穗者',
    tag: '追击型',
    desc: '麦田里站了一百年的稻草人，某个雾夜自己走了下来。',
    passive: '出刀后的擦刀时间缩短 15%。',
    skill: { name: '扑袭', desc: '向前猛冲约 9 米，撞到求生者视为一次命中。', cd: 16 },
    color: '#c9903a',
    look: { body: '#5a4426', accent: '#c9903a', eye: '#ffb030', kind: 'scarecrow' },
  },
  weaver: {
    name: '织巢夫人',
    tag: '控场型',
    desc: '阁楼里的裁缝，丝线一直连到每一扇门。',
    passive: '踩中丝网的求生者会暴露位置 5 秒。',
    skill: { name: '布网', desc: '在脚下布一张丝网（最多 6 张）。求生者踩中会被减速 45%，持续 3.5 秒。', cd: 9 },
    color: '#b05a7a',
    look: { body: '#2a2030', accent: '#b05a7a', eye: '#ff5a8a', kind: 'weaver' },
  },
  phantom: {
    name: '雾中客',
    tag: '传送型',
    desc: '戴着白面具的高个子绅士，没有人见过他走路。',
    passive: '移动速度 +3%。',
    skill: { name: '雾行', desc: '化作一团雾，1.5 秒后出现在进度最高（或刚被修过）的发报机旁。', cd: 45 },
    color: '#7a9ac0',
    look: { body: '#1c2430', accent: '#7a9ac0', eye: '#9ad8ff', kind: 'phantom' },
  },
};

const MAP_KEYS = ['circus', 'harbor', 'garden'];
const MAP_INFO = {
  circus: { name: '月光马戏团', desc: '散场多年的马戏团，大篷还亮着一盏灯。帐篷多、板子多，适合绕圈。' },
  harbor: { name: '灰雾船坞', desc: '堆满货箱的旧码头。长墙和货箱夹出很多窄道，视野差。' },
  garden: { name: '荆棘温室', desc: '疗养院后面的花园迷宫。树篱弯弯绕绕，窗多板少。' },
};

// 电脑水平：反应、失误率、视野、是否会用技能
const BOT_LEVELS = {
  easy: { name: '菜鸟', think: 0.5, qteFail: 0.3, sight: 11, hunterSpeed: 0.88, atkDelay: 0.55, skill: 0.25, pallet: 0.35, flee: 9 },
  normal: { name: '老手', think: 0.3, qteFail: 0.12, sight: 15, hunterSpeed: 0.93, atkDelay: 0.3, skill: 0.7, pallet: 0.75, flee: 11 },
  hard: { name: '大神', think: 0.18, qteFail: 0.04, sight: 18, hunterSpeed: 0.95, atkDelay: 0.18, skill: 1, pallet: 0.95, flee: 11 },
};

function publicConfig() {
  return { RULES, SURVIVORS, HUNTERS, MAP_KEYS, MAP_INFO, BOT_LEVELS: Object.fromEntries(Object.entries(BOT_LEVELS).map(([k, v]) => [k, { name: v.name }])) };
}

module.exports = { RULES, SURVIVORS, HUNTERS, MAP_KEYS, MAP_INFO, BOT_LEVELS, publicConfig };
