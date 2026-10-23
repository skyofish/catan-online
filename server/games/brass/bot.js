'use strict';
// 工业革命：伯明翰 —— 内置电脑玩家。
// 思路：列出当前所有合法行动（建造、修线路、开发、出售、贷款、侦察、跳过），
// 在副本上逐个试走一步，用「局面估值」比较前后差值，挑最好的。估值把金钱、收入、
// 已得分、预计能拿到的分（工厂翻面概率 × 分数、线路两端的图标）折算成同一个尺度。
// 三档难度：easy 随机性大、只看一部分行动；normal；hard 估值更细（会考虑对手收益）。

const D = require('./data');
const { BrassGame, SELLABLE, ACCEPTS } = require('./game');
const { TILES, IND, LINK_BY_ID } = D;

const RAIL_ROUNDS = { 2: 10, 3: 9, 4: 8 };

// 游戏剩余的「收入次数」（估算）
function roundsLeftGame(g) {
  const era = g.roundsLeft();
  if (g.era === 'canal' && !g.intro) return era + RAIL_ROUNDS[g.n];
  return era;
}

// 一个地点的线路图标（只算翻面的；未翻面的打个折，因为以后可能翻面）
function iconsAt(g, loc, pendingWeight = 0.45) {
  if (g.isMerchant(loc)) return g.merchants[loc] ? 2 : 0;
  let n = 0;
  for (const t of g.board[loc]) {
    if (!t) continue;
    const links = TILES[t.ind][t.lv].links;
    n += t.flipped ? links : links * pendingWeight;
  }
  return n;
}

// 未翻面工厂最终能翻面的概率
function flipChance(g, t, loc, pid) {
  if (t.flipped) return 1;
  const left = g.roundsLeft();
  const late = left <= 1 ? 0.3 : left <= 2 ? 0.65 : 1;
  if (SELLABLE.has(t.ind)) {
    const dist = g.distances([loc]);
    let conn = 0;
    let beerHere = false;
    for (const [id, slots] of Object.entries(g.merchants)) {
      if (!slots.some((m) => ACCEPTS[t.ind].includes(m.type))) continue;
      if (dist.has(id)) {
        conn = 2;
        if (slots.some((m) => ACCEPTS[t.ind].includes(m.type) && m.beer > 0)) beerHere = true;
      }
    }
    if (!conn) {
      // 再修一段就能连到商人
      for (const l of D.LINKS) {
        if (g.links[l.id] || !(g.era === 'canal' ? l.canal : l.rail)) continue;
        const other = dist.has(l.a) ? l.b : dist.has(l.b) ? l.a : null;
        if (other && g.merchants[other] && g.merchants[other].some((m) => ACCEPTS[t.ind].includes(m.type))) conn = 1;
      }
    }
    const need = TILES[t.ind][t.lv].beer;
    let beer = beerHere ? 1 : 0;
    g.forTiles((b, bl) => b.ind === 'brewery' && !b.flipped && (b.owner === pid || dist.has(bl)) && (beer += b.res));
    const beerOk = need === 0 || beer >= need;
    const base = conn === 2 ? 0.55 : conn === 1 ? 0.4 : 0.22;
    return Math.min(0.92, base + (beerOk ? 0.18 : 0)) * late;
  }
  // 煤 / 铁 / 啤酒：要靠别人（或自己）消耗
  const total = t.ind === 'brewery' ? (g.era === 'canal' ? 1 : 2) : TILES[t.ind][t.lv].res;
  const used = 1 - t.res / Math.max(1, total);
  const base = t.ind === 'brewery' ? 0.3 : 0.38;
  return Math.min(0.95, (base + used * 0.55) * late);
}

// 手上的钱：越缺钱，每一镑越值钱
function moneyValue(m) {
  return 0.55 * Math.min(m, 20) + 0.3 * Math.min(Math.max(m - 20, 0), 30) + 0.08 * Math.max(m - 50, 0);
}

function evaluate(g, pid, level = 'normal') {
  const p = g.P(pid);
  if (!p) return 0;
  const R = roundsLeftGame(g);
  // 越接近终局，钱越不值钱（只用于平局比较）
  const late = g.phase === 'ended' ? 0.004 : R > 6 ? 1 : R > 3 ? 0.75 : R > 1 ? 0.45 : 0.12;
  const iv = 0.16; // 每级收入每轮的价值
  let v = p.vp;
  const canalOpen = g.era === 'canal' && !g.intro && g.phase !== 'ended';
  // 工厂
  g.forTiles((t, loc) => {
    if (t.owner !== pid) return;
    const T = TILES[t.ind][t.lv];
    const ch = flipChance(g, t, loc, pid);
    const survives = canalOpen && t.lv >= 2 ? 1.85 : 1;
    v += T.vp * ch * survives;
    if (!t.flipped) v += ((T.income * ch) / 2.4) * iv * Math.max(0, R - 1);
  });
  // 线路：两端的图标
  for (const [id, o] of Object.entries(g.links)) {
    if (o !== pid) continue;
    const l = LINK_BY_ID[id];
    v += iconsAt(g, l.a) + iconsAt(g, l.b);
  }
  // 收入与金钱（钱多了边际价值递减）
  const lvl = g.level(p);
  if (g.phase !== 'ended') v += lvl * iv * Math.max(0, R - 1);
  v += moneyValue(p.money) * late;
  if (g.phase === 'ended') return v;
  // 产业板：铁路时代被「仅运河」板块卡住的产业要扣分
  for (const ind of IND) {
    const lv = g.matTop(p, ind);
    if (!lv) continue;
    const T = TILES[ind][lv];
    if (T.canal && !T.nodev && (g.era === 'rail' || g.roundsLeft() <= 2)) v -= g.era === 'rail' ? 0.9 : 0.4;
    v += T.vp * 0.03;
  }
  // 网络的潜力：覆盖的地点、能连到的商人
  const net = g.network(pid);
  if (net) {
    v += net.size * 0.12;
    const dist = g.distances([...net]);
    for (const m of Object.keys(g.merchants)) if (dist.has(m)) v += 0.35;
  }
  if (level === 'hard') {
    // 对手越好，自己越差：扣掉对手估值的一小部分（只看已得分与收入）
    for (const o of g.players) if (o.id !== pid) v -= (o.vp + g.level(o) * iv * Math.max(0, R - 1)) * 0.05;
  }
  return v;
}

// 手牌价值：越有用越不想弃
function cardKeep(g, p, card) {
  if (card.k === 'wloc' || card.k === 'wind') return 4;
  const net = g.network(p.id);
  if (card.k === 'loc') {
    const L = D.LOC_BY_ID[card.v];
    let n = 0;
    L.slots.forEach((sl, s) => {
      if (g.board[card.v][s]) return;
      if (sl.some((ind) => g.matTop(p, ind))) n++;
    });
    return n ? 1.2 + n * 0.5 + (net && net.has(card.v) ? 0.3 : 0) : 0.2;
  }
  let n = 0;
  const inds = D.CARD_IND[card.v];
  for (const L of D.LOCS) {
    if (net && !net.has(L.id)) continue;
    L.slots.forEach((sl, s) => !g.board[L.id][s] && sl.some((i) => inds.includes(i)) && n++);
  }
  return 0.6 + Math.min(n, 4) * 0.35;
}
const cheapest = (g, p, ids) => ids.map((id) => p.hand.find((c) => c.id === id)).filter(Boolean).sort((a, b) => cardKeep(g, p, a) - cardKeep(g, p, b))[0];

// 所有候选行动（每个目标挑一张最不值钱的牌）
function candidates(g, pid, level = 'normal', avoid = null) {
  const p = g.P(pid);
  let out = [];
  const all = p.hand.map((c) => c.id);
  const anyCard = cheapest(g, p, all);
  for (const o of g.buildOptions(p)) {
    if (!o.ok) continue;
    const c = cheapest(g, p, o.cards);
    out.push({ a: { type: 'build', card: c.id, loc: o.loc, slot: o.slot, ind: o.ind }, card: c, info: o });
  }
  const lo = g.linkOptions(p);
  for (const o of lo.single) if (o.ok) out.push({ a: { type: 'network', card: anyCard.id, links: [o.id] }, card: anyCard, info: o });
  let pairs = 0;
  for (const [a, list] of Object.entries(lo.pairs)) {
    for (const b of list) {
      if (pairs++ > 60) break;
      out.push({ a: { type: 'network', card: anyCard.id, links: [a, b.id] }, card: anyCard, info: { cost: b.cost } });
    }
  }
  const dev = g.developOptions(p).filter((o) => o.ok);
  for (const o of dev) out.push({ a: { type: 'develop', card: anyCard.id, inds: [o.ind] }, card: anyCard });
  for (let i = 0; i < dev.length; i++) {
    for (let j = i; j < dev.length; j++) {
      const x = dev[i].ind;
      const y = dev[j].ind;
      if (x === y) {
        const second = p.mat[x][1];
        if (!second || TILES[x][second].nodev) continue;
      }
      out.push({ a: { type: 'develop', card: anyCard.id, inds: [x, y] }, card: anyCard });
    }
  }
  const sells = g.sellOptions(p).filter((o) => o.ok);
  if (sells.length) {
    out.push({ a: { type: 'sell', card: anyCard.id, sales: sells.map((s) => ({ loc: s.loc, slot: s.slot })) }, card: anyCard });
    if (sells.length > 1) for (const s of sells) out.push({ a: { type: 'sell', card: anyCard.id, sales: [{ loc: s.loc, slot: s.slot }] }, card: anyCard });
  }
  if (!g.loanCheck(p)) out.push({ a: { type: 'loan', card: anyCard.id }, card: anyCard });
  if (!g.scoutCheck(p)) {
    const three = p.hand.slice().sort((a, b) => cardKeep(g, p, a) - cardKeep(g, p, b)).slice(0, 3);
    out.push({ a: { type: 'scout', cards: three.map((c) => c.id) }, cards: three });
  }
  out.push({ a: { type: 'pass', card: anyCard.id }, card: anyCard });
  // 教程：电脑不去碰新手要用的地方
  if (avoid && avoid.length) {
    const bad = new Set(avoid);
    const touches = (c) => (c.a.loc && bad.has(c.a.loc)) || (c.a.links || []).some((id) => bad.has(LINK_BY_ID[id].a) || bad.has(LINK_BY_ID[id].b));
    out = out.filter((c) => !touches(c));
  }
  if (level === 'easy') {
    // 菜鸟：只看到一部分选项
    return out.filter((c, i) => c.a.type === 'pass' || i % 2 === 0 || Math.random() < 0.4);
  }
  return out;
}

// 给候选打分：副本上执行，比较估值变化，再减去弃牌的价值
function scoreCandidates(g, pid, level = 'normal', avoid = null) {
  const p = g.P(pid);
  const base = JSON.stringify({ ...g.toJSON(), log: [], history: [] });
  const before = evaluate(g, pid, level);
  const scored = [];
  for (const c of candidates(g, pid, level, avoid)) {
    const sim = BrassGame.fromJSON(JSON.parse(base));
    const r = sim.act(pid, c.a);
    if (!r.ok) continue;
    let s = evaluate(sim, pid, level) - before;
    if (c.card) s -= cardKeep(g, p, c.card) * 0.35;
    if (c.cards) s -= c.cards.reduce((x, k) => x + cardKeep(g, p, k), 0) * 0.35 - 0.9;
    if (c.a.type === 'pass') s -= 0.6;
    scored.push({ ...c, score: s, events: r.events });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function botAction(g, pid, level = 'normal', opts = {}) {
  if (g.phase === 'ended' || g.cur().id !== pid) return null;
  const avoid = !opts.noAvoid && g.tutorial && g.tutorial.avoid && g.round + (g.era === 'rail' ? 10 : 0) <= (g.tutorial.avoidRounds || 3) ? g.tutorial.avoid : null;
  const list = scoreCandidates(g, pid, level, avoid);
  if (!list.length) {
    const p = g.P(pid);
    return p.hand.length ? { type: 'pass', card: p.hand[0].id } : null;
  }
  if (level === 'easy') {
    const top = list.slice(0, 4);
    return top[Math.floor(Math.random() * top.length)].a;
  }
  // 普通：在几乎一样好的选项之间随机一点，避免每局都一样
  const best = list[0].score;
  const near = list.filter((c) => c.score >= best - (level === 'hard' ? 0.05 : 0.35)).slice(0, 3);
  return near[Math.floor(Math.random() * near.length)].a;
}

module.exports = { botAction, scoreCandidates, evaluate, cardKeep, candidates };
