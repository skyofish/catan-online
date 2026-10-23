'use strict';
// 工业革命：伯明翰 —— 规则引擎（服务器权威）。
// 所有操作通过 act(pid, action) 进入，返回 { ok, error, events }；失败的操作不会改变任何状态。
// 一个「行动」就是一次完整的请求（例如「用这张牌在这个格子建造」），
// 煤 / 铁 / 啤酒的来源按规则自动选择（最近的煤矿、自己的工厂优先），事件里带着来源方便前端做动画。

const D = require('./data');
const { TILES, IND, IND_NAME, LOC_BY_ID, MERCHANT_BY_ID, LINK_BY_ID, PLACE_NAME, CARD_IND, CARD_IND_NAME } = D;

const SELLABLE = new Set(['cotton', 'goods', 'pottery']);
const ACCEPTS = { cotton: ['cotton', 'all'], goods: ['goods', 'all'], pottery: ['pottery', 'all'] };
const ROMAN = ['', 'Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', 'Ⅵ', 'Ⅶ', 'Ⅷ'];

const cardName = (c) => (c.k === 'loc' ? PLACE_NAME[c.v] : c.k === 'ind' ? CARD_IND_NAME[c.v] : c.k === 'wloc' ? '万能地点' : '万能产业');
const tileName = (ind, lv) => `${ROMAN[lv]}级${IND_NAME[ind]}`;

class BrassGame {
  /**
   * @param {object} opts { intro: 只玩运河时代的入门短局, tutorial: 新手教程的固定开局 }
   * @param {Array} players [{ id, name, color }]
   * @param {number} seed 随机种子（洗牌、商人板块）
   */
  constructor(opts, players, seed) {
    this.seed = Number.isFinite(seed) ? seed >>> 0 : (Math.random() * 2 ** 32) >>> 0;
    this.n = players.length;
    if (this.n < 2 || this.n > 4) throw new Error('需要 2–4 名玩家');
    this.intro = !!opts.intro;
    this.tutorial = opts.tutorial || null;
    const order = this.tutorial ? players.slice() : this.shuffle(players.slice());
    this.players = order.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      money: D.START_MONEY,
      incomePos: D.START_INCOME_POS,
      vp: 0,
      hand: [],
      discard: [],
      mat: D.matStacks(),
      linksLeft: D.LINK_TILES,
      spent: 0,
      stats: { built: 0, flipped: 0, links: 0, sold: 0, loans: 0, vpLinks: 0, vpTiles: 0, developed: 0 },
    }));
    this.order = this.players.map((p) => p.id);
    this.board = {};
    for (const l of D.LOCS) this.board[l.id] = l.slots.map(() => null);
    this.links = {};
    this.market = { coal: D.MARKET.coal.start, iron: D.MARKET.iron.start };
    this.wilds = { wloc: 4, wind: 4 };
    this.cardSeq = 0;
    this.setupMerchants();
    this.deck = this.makeDeck();
    this.burned = [];
    this.era = 'canal';
    this.round = 1;
    this.turnIdx = 0;
    this.actionsLeft = 1;
    this.phase = 'play';
    this.winner = null;
    this.log = [];
    this.logSeq = 0;
    this.history = []; // 每轮结束时各玩家分数（结算画面的折线图）
    this.startedAt = Date.now();
    this.endedAt = null;
    for (const p of this.players) this.draw(p);
    // 运河时代开局：每人从牌堆顶面朝下放一张牌作为弃牌（不参与本时代）
    for (let i = 0; i < this.n; i++) this.burned.push(this.deck.pop());
    this.addLog(`游戏开始！${this.n} 人局${this.intro ? '（入门短局：只玩运河时代）' : ''}。运河时代第 1 轮，每人只有 1 个行动。`);
    this.addLog(`${this.cur().name} 先行动。`);
  }

  // ---------- 随机数（可序列化的种子，便于续玩与教程复现） ----------
  rand() {
    let t = (this.seed = (this.seed + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ---------- 开局 ----------
  setupMerchants() {
    const pool = [];
    for (const k of [2, 3, 4]) if (k <= this.n) pool.push(...D.MERCHANT_TILES[k]);
    const tiles = this.tutorial && this.tutorial.merchants ? null : this.shuffle(pool);
    this.merchants = {};
    let i = 0;
    for (const m of D.MERCHANTS) {
      if (m.minPlayers > this.n) continue;
      const fixed = this.tutorial && this.tutorial.merchants && this.tutorial.merchants[m.id];
      this.merchants[m.id] = Array.from({ length: m.slots }, (_, k) => {
        const type = fixed ? fixed[k] : tiles[i++];
        return { type, beer: type === 'blank' ? 0 : 1 };
      });
    }
  }

  makeDeck() {
    const cards = [];
    for (const l of D.LOCS) {
      if (l.region === 'teal' && this.n < 4) continue;
      if (l.region === 'blue' && this.n < 3) continue;
      for (let i = 0; i < l.cards; i++) cards.push({ id: 'c' + this.cardSeq++, k: 'loc', v: l.id });
    }
    for (const [ind, counts] of Object.entries(D.INDUSTRY_CARDS)) for (let i = 0; i < counts[this.n]; i++) cards.push({ id: 'c' + this.cardSeq++, k: 'ind', v: ind });
    this.shuffle(cards);
    // 教程：指定的牌放在牌堆顶（按发牌顺序）
    const top = this.tutorial && this.tutorial.deckTop;
    if (top) {
      const head = [];
      for (const key of top) {
        const [k, v] = key.split(':');
        const i = cards.findIndex((c) => c.k === k && c.v === v);
        if (i >= 0) head.push(cards.splice(i, 1)[0]);
      }
      // 牌堆顶在数组末尾（pop 抽牌）
      return cards.concat(head.reverse());
    }
    return cards;
  }

  draw(p) {
    while (p.hand.length < D.HAND && this.deck.length) p.hand.push(this.deck.pop());
  }

  // ---------- 工具 ----------
  P(pid) {
    return this.players.find((p) => p.id === pid);
  }
  pIdx(pid) {
    return this.players.findIndex((p) => p.id === pid);
  }
  cur() {
    return this.P(this.order[this.turnIdx]);
  }
  level(p) {
    return D.incomeLevel(p.incomePos);
  }
  addLog(text, pid = null) {
    this.log.push({ id: ++this.logSeq, text, pid, t: Date.now() });
    if (this.log.length > 250) this.log.shift();
  }
  isMerchant(id) {
    return !!MERCHANT_BY_ID[id];
  }
  roundsLeft() {
    const cards = this.deck.length + this.players.reduce((s, p) => s + p.hand.length, 0);
    return Math.ceil(cards / (2 * this.n));
  }
  activePlayers() {
    return this.phase === 'ended' ? [] : [this.order[this.turnIdx]];
  }

  forTiles(cb) {
    for (const [loc, slots] of Object.entries(this.board)) slots.forEach((t, s) => t && cb(t, loc, s));
  }
  // 地点上的「线路分数图标」：翻面产业的 links 之和；商人固定 2 个
  linkIcons(loc) {
    if (this.isMerchant(loc)) return this.merchants[loc] ? 2 : 0;
    let n = 0;
    for (const t of this.board[loc]) if (t && t.flipped) n += TILES[t.ind][t.lv].links;
    return n;
  }

  // ---------- 连通性 ----------
  adjacency(extra = []) {
    const adj = new Map();
    const add = (a, b) => {
      if (!adj.has(a)) adj.set(a, []);
      adj.get(a).push(b);
    };
    for (const id of Object.keys(this.links).concat(extra)) {
      const l = LINK_BY_ID[id];
      add(l.a, l.b);
      add(l.b, l.a);
    }
    return adj;
  }
  // 从若干地点出发，沿已建线路（任何玩家的）的最短距离
  distances(starts, extra = []) {
    const adj = this.adjacency(extra);
    const dist = new Map(starts.map((s) => [s, 0]));
    const q = starts.slice();
    while (q.length) {
      const x = q.shift();
      for (const y of adj.get(x) || []) {
        if (dist.has(y)) continue;
        dist.set(y, dist.get(x) + 1);
        q.push(y);
      }
    }
    return dist;
  }
  merchantConnected(dist) {
    for (const m of Object.keys(this.merchants)) if (dist.has(m)) return true;
    return false;
  }
  // 你的网络：有你产业的地点，以及你的线路两端。场上什么都没有时返回 null（任何地方都算）
  network(pid) {
    const set = new Set();
    this.forTiles((t, loc) => t.owner === pid && set.add(loc));
    for (const [id, o] of Object.entries(this.links)) {
      if (o !== pid) continue;
      set.add(LINK_BY_ID[id].a);
      set.add(LINK_BY_ID[id].b);
    }
    return set.size ? set : null;
  }

  // ---------- 资源来源 ----------
  newPlan() {
    return { money: 0, taken: {}, market: { coal: 0, iron: 0 }, coal: [], iron: [], beer: [], merchantBeer: null };
  }
  available(t, loc, s, plan) {
    return t.res - (plan.taken[`${loc}:${s}`] || 0);
  }
  marketCost(res, count, already = 0) {
    const M = D.MARKET[res];
    let c = this.market[res] - already;
    let total = 0;
    for (let i = 0; i < count; i++) {
      if (c > 0) {
        total += M.prices[M.prices.length - c];
        c--;
      } else total += M.empty;
    }
    return total;
  }
  // 煤：取最近的、连通的未翻面煤矿（同样近时优先自己的）；不够时若连通商人可从市场买
  planCoal(n, pid, starts, extra, plan) {
    if (!n) return true;
    const dist = this.distances(starts, extra);
    const cands = [];
    this.forTiles((t, loc, s) => {
      if (t.ind !== 'coal' || t.flipped || !dist.has(loc)) return;
      cands.push({ t, loc, s, d: dist.get(loc), own: t.owner === pid ? 0 : 1 });
    });
    cands.sort((a, b) => a.d - b.d || a.own - b.own);
    let need = n;
    for (const c of cands) {
      if (!need) break;
      const take = Math.min(need, this.available(c.t, c.loc, c.s, plan));
      if (take <= 0) continue;
      plan.taken[`${c.loc}:${c.s}`] = (plan.taken[`${c.loc}:${c.s}`] || 0) + take;
      plan.coal.push({ loc: c.loc, slot: c.s, n: take, owner: c.t.owner });
      need -= take;
    }
    if (need) {
      if (!this.merchantConnected(dist)) return false;
      plan.money += this.marketCost('coal', need, plan.market.coal);
      plan.market.coal += need;
      plan.coal.push({ market: true, n: need });
    }
    return true;
  }
  // 铁：任何未翻面的炼铁厂都可以用（不需要连通，优先自己的），不够从市场买
  planIron(n, pid, plan) {
    if (!n) return true;
    const cands = [];
    this.forTiles((t, loc, s) => t.ind === 'iron' && !t.flipped && cands.push({ t, loc, s, own: t.owner === pid ? 0 : 1 }));
    cands.sort((a, b) => a.own - b.own);
    let need = n;
    for (const c of cands) {
      if (!need) break;
      const take = Math.min(need, this.available(c.t, c.loc, c.s, plan));
      if (take <= 0) continue;
      plan.taken[`${c.loc}:${c.s}`] = (plan.taken[`${c.loc}:${c.s}`] || 0) + take;
      plan.iron.push({ loc: c.loc, slot: c.s, n: take, owner: c.t.owner });
      need -= take;
    }
    if (need) {
      plan.money += this.marketCost('iron', need, plan.market.iron);
      plan.market.iron += need;
      plan.iron.push({ market: true, n: need });
    }
    return true;
  }
  // 啤酒：出售时可先用该商人的啤酒（有奖励），再用自己的酿酒厂（不需要连通），最后用连通的别人的酿酒厂
  planBeer(n, pid, starts, extra, plan, merchant = null) {
    if (!n) return true;
    let need = n;
    if (merchant) {
      const ms = this.merchants[merchant.id][merchant.i];
      const key = `${merchant.id}:${merchant.i}`;
      if (ms.beer > 0 && !(plan.taken[key] > 0)) {
        plan.taken[key] = 1;
        plan.merchantBeer = merchant;
        plan.beer.push({ merchant: merchant.id, slot: merchant.i, n: 1 });
        need--;
      }
    }
    if (!need) return true;
    const dist = this.distances(starts, extra);
    const cands = [];
    this.forTiles((t, loc, s) => {
      if (t.ind !== 'brewery' || t.flipped) return;
      if (t.owner === pid) cands.push({ t, loc, s, k: 0, d: 0 });
      else if (dist.has(loc)) cands.push({ t, loc, s, k: 1, d: dist.get(loc) });
    });
    cands.sort((a, b) => a.k - b.k || a.d - b.d);
    for (const c of cands) {
      if (!need) break;
      const take = Math.min(need, this.available(c.t, c.loc, c.s, plan));
      if (take <= 0) continue;
      plan.taken[`${c.loc}:${c.s}`] = (plan.taken[`${c.loc}:${c.s}`] || 0) + take;
      plan.beer.push({ loc: c.loc, slot: c.s, n: take, owner: c.t.owner });
      need -= take;
    }
    return need === 0;
  }

  // 执行计划：扣钱、拿走方块与啤酒（拿空的工厂翻面）、从市场买
  commit(p, plan, events) {
    p.money -= plan.money;
    p.spent += plan.money;
    // 市场空了以后按固定高价从公共供应买，不会变成负数
    this.market.coal = Math.max(0, this.market.coal - plan.market.coal);
    this.market.iron = Math.max(0, this.market.iron - plan.market.iron);
    for (const [key, n] of Object.entries(plan.taken)) {
      const [loc, s] = key.split(':');
      if (this.isMerchant(loc)) {
        this.merchants[loc][Number(s)].beer -= n;
        continue;
      }
      const t = this.board[loc][Number(s)];
      t.res -= n;
      if (t.res <= 0 && !t.flipped) this.flip(loc, Number(s), events);
    }
  }

  flip(loc, s, events) {
    const t = this.board[loc][s];
    t.flipped = true;
    t.res = 0;
    const o = this.P(t.owner);
    const inc = TILES[t.ind][t.lv].income;
    const before = this.level(o);
    o.incomePos = Math.min(99, o.incomePos + inc);
    o.stats.flipped++;
    events.push({ type: 'flip', loc, slot: s, pid: o.id, ind: t.ind, lv: t.lv, income: inc, level: this.level(o), before });
    this.addLog(`🔄 ${o.name} 在${PLACE_NAME[loc]}的${tileName(t.ind, t.lv)}翻面，收入前进 ${inc} 格`, o.id);
  }

  // ---------- 建造 ----------
  totalCubes(ind) {
    let n = this.market[ind];
    this.forTiles((t) => t.ind === ind && !t.flipped && (n += t.res));
    return n;
  }
  matTop(p, ind) {
    return p.mat[ind].length ? p.mat[ind][0] : null;
  }
  cardAllows(card, loc, ind, net) {
    const inNet = !net || net.has(loc);
    if (card.k === 'loc') return card.v === loc;
    if (card.k === 'wloc') return true;
    if (card.k === 'ind') return CARD_IND[card.v].includes(ind) && inNet;
    if (card.k === 'wind') return inNet;
    return false;
  }
  slotsFor(p, loc, ind) {
    const L = LOC_BY_ID[loc];
    if (!L) return [];
    const lv = this.matTop(p, ind);
    if (!lv) return [];
    if (this.era === 'rail' && TILES[ind][lv].canal) return [];
    const row = this.board[loc];
    const mine = row.filter((t) => t && t.owner === p.id).length;
    const singleFree = L.slots.some((sl, s) => sl.length === 1 && sl[0] === ind && !row[s]);
    const out = [];
    L.slots.forEach((sl, s) => {
      if (!sl.includes(ind)) return;
      const ex = row[s];
      if (!ex) {
        if (sl.length > 1 && singleFree) return;
        if (this.era === 'canal' && mine > 0) return;
        out.push(s);
        return;
      }
      // 覆盖建造：同一种产业、更高等级
      if (ex.ind !== ind || lv <= ex.lv) return;
      if (ex.owner !== p.id && !((ind === 'coal' || ind === 'iron') && this.totalCubes(ind) === 0)) return;
      if (this.era === 'canal' && mine - (ex.owner === p.id ? 1 : 0) > 0) return;
      out.push(s);
    });
    return out;
  }
  planBuild(p, loc, slot, ind) {
    const lv = this.matTop(p, ind);
    const T = TILES[ind][lv];
    const plan = this.newPlan();
    plan.money = T.cost;
    // 覆盖自己的工厂时，旧板块上的方块不能拿来用
    const ex = this.board[loc][slot];
    if (ex) plan.taken[`${loc}:${slot}`] = ex.res;
    if (!this.planCoal(T.coal, p.id, [loc], [], plan)) return { error: '没有连通的煤矿，也没有连到商人从市场买煤' };
    this.planIron(T.iron, p.id, plan);
    if (ex) delete plan.taken[`${loc}:${slot}`];
    if (plan.money > p.money) return { error: `钱不够（需要 £${plan.money}）`, plan };
    return { plan };
  }

  buildOptions(p) {
    const net = this.network(p.id);
    const out = [];
    for (const L of D.LOCS) {
      const inds = [...new Set(L.slots.flat())];
      for (const ind of inds) {
        const cards = p.hand.filter((c) => this.cardAllows(c, L.id, ind, net)).map((c) => c.id);
        if (!cards.length) continue;
        for (const s of this.slotsFor(p, L.id, ind)) {
          const r = this.planBuild(p, L.id, s, ind);
          const lv = this.matTop(p, ind);
          out.push({
            loc: L.id,
            slot: s,
            ind,
            lv,
            cards,
            ok: !r.error,
            why: r.error || null,
            cost: r.plan ? r.plan.money : null,
            coal: r.plan ? r.plan.coal : null,
            iron: r.plan ? r.plan.iron : null,
            over: !!this.board[L.id][s],
          });
        }
      }
    }
    return out;
  }

  do_build(p, a, events) {
    const card = this.takeCardCheck(p, a.card);
    const loc = String(a.loc);
    const slot = Number(a.slot);
    const ind = String(a.ind);
    if (!LOC_BY_ID[loc]) throw new Error('无效地点');
    if (!IND.includes(ind)) throw new Error('无效产业');
    if (!this.cardAllows(card, loc, ind, this.network(p.id))) throw new Error(card.k === 'loc' || card.k === 'wloc' ? '这张牌不能在这里建造' : '该地点不在你的网络中');
    if (!this.slotsFor(p, loc, ind).includes(slot)) {
      const lv = this.matTop(p, ind);
      if (!lv) throw new Error(`${IND_NAME[ind]}已经全部建完`);
      if (this.era === 'rail' && TILES[ind][lv].canal) throw new Error(`Ⅰ级${IND_NAME[ind]}只能在运河时代建造，请先开发掉`);
      throw new Error('这个格子不能建造');
    }
    const r = this.planBuild(p, loc, slot, ind);
    if (r.error) throw new Error(r.error);
    const lv = p.mat[ind].shift();
    const T = TILES[ind][lv];
    const old = this.board[loc][slot];
    const after = [];
    this.commit(p, r.plan, after);
    const tile = { owner: p.id, ind, lv, flipped: false, res: 0 };
    if (ind === 'coal' || ind === 'iron') tile.res = T.res;
    if (ind === 'brewery') tile.res = this.era === 'canal' ? 1 : 2;
    this.board[loc][slot] = tile;
    p.stats.built++;
    this.useCard(p, card, events);
    events.push({ type: 'build', pid: p.id, loc, slot, ind, lv, cost: r.plan.money, coal: r.plan.coal, iron: r.plan.iron, over: old ? { owner: old.owner, lv: old.lv } : null });
    events.push(...after);
    this.addLog(`🏭 ${p.name} 在${PLACE_NAME[loc]}建造了${tileName(ind, lv)}${old ? (old.owner === p.id ? '（覆盖自己的旧厂）' : `（覆盖了 ${this.P(old.owner).name} 的工厂）`) : ''}，花费 £${r.plan.money}`, p.id);
    // 煤矿连通商人 / 炼铁厂：立即把方块卖给市场
    if (ind === 'iron' || (ind === 'coal' && this.merchantConnected(this.distances([loc])))) this.sellToMarket(p, loc, slot, events);
    if (tile.res <= 0 && (ind === 'coal' || ind === 'iron')) this.flip(loc, slot, events);
  }

  sellToMarket(p, loc, slot, events) {
    const t = this.board[loc][slot];
    const M = D.MARKET[t.ind];
    let n = 0;
    let money = 0;
    while (t.res > 0 && this.market[t.ind] < M.prices.length) {
      money += M.prices[M.prices.length - this.market[t.ind] - 1];
      this.market[t.ind]++;
      t.res--;
      n++;
    }
    if (!n) return;
    p.money += money;
    events.push({ type: 'market', pid: p.id, res: t.ind, loc, slot, n, money });
    this.addLog(`💰 ${p.name} 把 ${n} 块${t.ind === 'coal' ? '煤' : '铁'}卖给市场，收入 £${money}`, p.id);
  }

  // ---------- 修建网络 ----------
  linkAllowed(id) {
    const l = LINK_BY_ID[id];
    if (!l || this.links[id]) return false;
    return this.era === 'canal' ? l.canal : l.rail;
  }
  linkAdjacent(id, net, extra = []) {
    if (!net) return true;
    const l = LINK_BY_ID[id];
    if (net.has(l.a) || net.has(l.b)) return true;
    return extra.some((e) => {
      const x = LINK_BY_ID[e];
      return [x.a, x.b].includes(l.a) || [x.a, x.b].includes(l.b);
    });
  }
  planLinks(p, ids) {
    const plan = this.newPlan();
    if (this.era === 'canal') {
      if (ids.length !== 1) return { error: '运河时代每次只能修 1 段运河' };
      plan.money = 3;
    } else {
      if (ids.length === 1) plan.money = 5;
      else if (ids.length === 2) plan.money = 15;
      else return { error: '铁路一次修 1 或 2 段' };
    }
    if (p.linksLeft < ids.length) return { error: '线路板块不够了' };
    if (new Set(ids).size !== ids.length) return { error: '不能重复' };
    const net = this.network(p.id);
    const extra = [];
    for (const id of ids) {
      if (!this.linkAllowed(id)) return { error: this.era === 'canal' ? '这里不能修运河' : '这里不能修铁路' };
      if (!this.linkAdjacent(id, net, extra)) return { error: '线路必须连接你的网络' };
      extra.push(id);
      if (this.era === 'rail') {
        const l = LINK_BY_ID[id];
        if (!this.planCoal(1, p.id, [l.a, l.b], extra, plan)) return { error: '修铁路需要 1 块煤：没有连通的煤矿，也连不到商人' };
      }
    }
    if (ids.length === 2) {
      const ends = [...new Set(ids.flatMap((id) => [LINK_BY_ID[id].a, LINK_BY_ID[id].b]))];
      if (!this.planBeer(1, p.id, ends, extra, plan)) return { error: '一次修两段铁路还需要 1 桶啤酒' };
    }
    if (plan.money > p.money) return { error: `钱不够（需要 £${plan.money}）`, plan };
    return { plan };
  }
  linkOptions(p) {
    if (p.linksLeft <= 0) return { single: [], pairs: {} };
    const net = this.network(p.id);
    const single = [];
    for (const l of D.LINKS) {
      if (!this.linkAllowed(l.id) || !this.linkAdjacent(l.id, net)) continue;
      const r = this.planLinks(p, [l.id]);
      single.push({ id: l.id, ok: !r.error, why: r.error || null, cost: r.plan ? r.plan.money : null, coal: r.plan ? r.plan.coal : null });
    }
    const pairs = {};
    if (this.era === 'rail' && p.linksLeft >= 2 && p.money >= 15) {
      for (const a of single) {
        if (!a.ok) continue;
        for (const l of D.LINKS) {
          if (l.id === a.id || !this.linkAllowed(l.id)) continue;
          if (!this.linkAdjacent(l.id, net, [a.id])) continue;
          const r = this.planLinks(p, [a.id, l.id]);
          if (!r.error) (pairs[a.id] = pairs[a.id] || []).push({ id: l.id, cost: r.plan.money });
        }
      }
    }
    return { single, pairs };
  }
  do_network(p, a, events) {
    const card = this.takeCardCheck(p, a.card);
    const ids = Array.isArray(a.links) ? a.links.map(String) : [];
    if (!ids.length) throw new Error('请选择线路');
    const r = this.planLinks(p, ids);
    if (r.error) throw new Error(r.error);
    const after = [];
    this.commit(p, r.plan, after);
    for (const id of ids) this.links[id] = p.id;
    p.linksLeft -= ids.length;
    p.stats.links += ids.length;
    this.useCard(p, card, events);
    events.push({ type: 'link', pid: p.id, links: ids, era: this.era, cost: r.plan.money, coal: r.plan.coal, beer: r.plan.beer });
    events.push(...after);
    const names = ids.map((id) => `${PLACE_NAME[LINK_BY_ID[id].a]}—${PLACE_NAME[LINK_BY_ID[id].b]}`).join('、');
    this.addLog(`${this.era === 'canal' ? '🚣' : '🚂'} ${p.name} 修建了${this.era === 'canal' ? '运河' : '铁路'}：${names}，花费 £${r.plan.money}`, p.id);
  }

  // ---------- 开发 ----------
  developOptions(p) {
    return IND.map((ind) => {
      const lv = this.matTop(p, ind);
      return { ind, lv, ok: !!lv && !TILES[ind][lv].nodev, why: !lv ? '已用完' : TILES[ind][lv].nodev ? '灯泡板块不能开发' : null };
    });
  }
  do_develop(p, a, events) {
    const card = this.takeCardCheck(p, a.card);
    const inds = Array.isArray(a.inds) ? a.inds.map(String) : [];
    if (inds.length < 1 || inds.length > 2) throw new Error('开发 1 或 2 个板块');
    const plan = this.newPlan();
    this.planIron(inds.length, p.id, plan);
    if (plan.money > p.money) throw new Error(`钱不够（买铁需要 £${plan.money}）`);
    const removed = [];
    for (const ind of inds) {
      if (!IND.includes(ind)) throw new Error('无效产业');
      const lv = this.matTop(p, ind);
      if (!lv) throw new Error(`${IND_NAME[ind]}已经没有板块`);
      if (TILES[ind][lv].nodev) throw new Error(`${tileName(ind, lv)}有灯泡标记，不能开发`);
      p.mat[ind].shift();
      removed.push({ ind, lv });
    }
    this.commit(p, plan, events);
    p.stats.developed += removed.length;
    this.useCard(p, card, events);
    events.push({ type: 'develop', pid: p.id, removed, iron: plan.iron, cost: plan.money });
    this.addLog(`🔧 ${p.name} 开发了 ${removed.map((x) => tileName(x.ind, x.lv)).join('、')}${plan.money ? `，买铁花费 £${plan.money}` : ''}`, p.id);
  }

  // ---------- 出售 ----------
  merchantsFor(loc, ind, extra = []) {
    const dist = this.distances([loc], extra);
    const out = [];
    for (const [id, slots] of Object.entries(this.merchants)) {
      if (!dist.has(id)) continue;
      slots.forEach((ms, i) => {
        if (ACCEPTS[ind].includes(ms.type)) out.push({ id, i, beer: ms.beer, d: dist.get(id) });
      });
    }
    return out;
  }
  planSale(p, loc, slot, choice, plan) {
    const t = this.board[loc] && this.board[loc][slot];
    if (!t || t.owner !== p.id) return { error: '这不是你的工厂' };
    if (t.flipped) return { error: '已经翻面了' };
    if (!SELLABLE.has(t.ind)) return { error: '只有棉纺厂、制造厂、陶瓷厂可以出售' };
    let ms = this.merchantsFor(loc, t.ind);
    if (!ms.length) return { error: '没有连通到收购这种商品的商人' };
    if (choice) {
      ms = ms.filter((m) => m.id === choice.id && m.i === Number(choice.i));
      if (!ms.length) return { error: '这个商人不收这种商品或没有连通' };
    }
    const need = TILES[t.ind][t.lv].beer;
    // 优先选有啤酒的商人（喝商人的啤酒有奖励）
    ms.sort((a, b) => (b.beer > 0) - (a.beer > 0) || a.d - b.d);
    for (const m of ms) {
      const trial = JSON.parse(JSON.stringify(plan));
      if (this.planBeer(need, p.id, [loc], [], trial, need ? m : null)) {
        Object.assign(plan, trial);
        return { merchant: m, need };
      }
    }
    return { error: `啤酒不够（需要 ${need} 桶）` };
  }
  sellOptions(p) {
    const out = [];
    this.forTiles((t, loc, s) => {
      if (t.owner !== p.id || t.flipped || !SELLABLE.has(t.ind)) return;
      const r = this.planSale(p, loc, s, null, this.newPlan());
      out.push({ loc, slot: s, ind: t.ind, lv: t.lv, beer: TILES[t.ind][t.lv].beer, ok: !r.error, why: r.error || null, merchants: this.merchantsFor(loc, t.ind).map((m) => ({ id: m.id, i: m.i, beer: m.beer })) });
    });
    return out;
  }
  do_sell(p, a, events) {
    const card = this.takeCardCheck(p, a.card);
    const sales = Array.isArray(a.sales) ? a.sales.slice(0, 12) : [];
    if (!sales.length) throw new Error('请选择要出售的工厂');
    const seen = new Set();
    let n = 0;
    for (const s of sales) {
      const loc = String(s.loc);
      const slot = Number(s.slot);
      if (seen.has(`${loc}:${slot}`)) continue;
      seen.add(`${loc}:${slot}`);
      const plan = this.newPlan();
      const r = this.planSale(p, loc, slot, s.merchant || null, plan);
      if (r.error) throw new Error(`${PLACE_NAME[loc] || '?'}：${r.error}`);
      const t = this.board[loc][slot];
      const after = [];
      this.commit(p, plan, after);
      const m = r.merchant;
      let bonus = null;
      if (plan.merchantBeer) bonus = this.merchantBonus(p, m.id, a.devFree, after);
      events.push({ type: 'sell', pid: p.id, loc, slot, ind: t.ind, merchant: m.id, mi: m.i, beer: plan.beer, bonus });
      events.push(...after);
      this.addLog(`📦 ${p.name} 把${PLACE_NAME[loc]}的${tileName(t.ind, t.lv)}的货卖给${PLACE_NAME[m.id]}${bonus ? `，喝到商人的啤酒：${bonus.text}` : ''}`, p.id);
      this.flip(loc, slot, events);
      p.stats.sold++;
      n++;
    }
    if (!n) throw new Error('请选择要出售的工厂');
    this.useCard(p, card, events);
  }
  merchantBonus(p, mid, devFree, events) {
    const b = MERCHANT_BY_ID[mid].bonus;
    if (b.money) {
      p.money += b.money;
      return { money: b.money, text: `获得 £${b.money}` };
    }
    if (b.vp) {
      p.vp += b.vp;
      return { vp: b.vp, text: `获得 ${b.vp} 分` };
    }
    if (b.income) {
      p.incomePos = Math.min(99, p.incomePos + b.income);
      return { income: b.income, text: `收入前进 ${b.income} 格` };
    }
    if (b.develop) {
      // 免费开发一个板块：指定的或自动挑一个
      let ind = devFree && IND.includes(devFree) ? devFree : null;
      const ok = (x) => {
        const lv = this.matTop(p, x);
        return lv && !TILES[x][lv].nodev;
      };
      if (!ind || !ok(ind)) {
        const pref = ['goods', 'cotton', 'coal', 'iron', 'brewery', 'pottery'];
        ind = pref.filter(ok).sort((x, y) => this.matTop(p, x) - this.matTop(p, y) || pref.indexOf(x) - pref.indexOf(y))[0] || null;
      }
      if (!ind) return { text: '没有可开发的板块' };
      const lv = p.mat[ind].shift();
      p.stats.developed++;
      events.push({ type: 'develop', pid: p.id, removed: [{ ind, lv }], iron: [], cost: 0, free: true });
      return { develop: { ind, lv }, text: `免费开发了${tileName(ind, lv)}` };
    }
    return null;
  }

  // ---------- 贷款 / 侦察 / 跳过 ----------
  loanCheck(p) {
    if (this.level(p) - 3 < -10) return '收入等级不能低于 -10';
    if (this.era === 'rail' && !this.deck.length) return '铁路时代牌堆抽完后不能再贷款';
    return null;
  }
  do_loan(p, a, events) {
    const card = this.takeCardCheck(p, a.card);
    const why = this.loanCheck(p);
    if (why) throw new Error(why);
    const before = this.level(p);
    p.money += 30;
    p.incomePos = D.topOfLevel(before - 3);
    p.stats.loans++;
    this.useCard(p, card, events);
    events.push({ type: 'loan', pid: p.id, level: this.level(p), before });
    this.addLog(`🏦 ${p.name} 向银行贷款 £30，收入等级 ${before} → ${this.level(p)}`, p.id);
  }
  scoutCheck(p) {
    if (p.hand.some((c) => c.k === 'wloc' || c.k === 'wind')) return '手里已有万能牌时不能侦察';
    if (!this.wilds.wloc || !this.wilds.wind) return '万能牌已经被拿完了';
    if (p.hand.length < 3) return '侦察需要弃 3 张牌';
    return null;
  }
  do_scout(p, a, events) {
    const why = this.scoutCheck(p);
    if (why) throw new Error(why);
    const ids = Array.isArray(a.cards) ? a.cards.map(String) : [];
    if (new Set(ids).size !== 3) throw new Error('请选择 3 张不同的牌');
    const cards = ids.map((id) => this.takeCardCheck(p, id));
    for (const c of cards) this.useCard(p, c, events, true);
    this.wilds.wloc--;
    this.wilds.wind--;
    p.hand.push({ id: 'w' + this.cardSeq++, k: 'wloc' }, { id: 'w' + this.cardSeq++, k: 'wind' });
    events.push({ type: 'scout', pid: p.id, cards });
    this.addLog(`🔭 ${p.name} 派人侦察，弃 3 张牌换来万能地点牌和万能产业牌`, p.id);
  }
  do_pass(p, a, events) {
    const card = this.takeCardCheck(p, a.card);
    this.useCard(p, card, events);
    events.push({ type: 'pass', pid: p.id });
    this.addLog(`⏭ ${p.name} 跳过（弃 1 张牌）`, p.id);
  }

  takeCardCheck(p, id) {
    const c = p.hand.find((x) => x.id === id);
    if (!c) throw new Error('请选择一张手牌');
    return c;
  }
  useCard(p, card, events, silent = false) {
    const i = p.hand.indexOf(card);
    if (i >= 0) p.hand.splice(i, 1);
    if (card.k === 'wloc' || card.k === 'wind') this.wilds[card.k]++;
    else p.discard.push(card);
    if (!silent) events.push({ type: 'discard', pid: p.id, card });
  }

  // ---------- 回合流程 ----------
  act(pid, a) {
    const events = [];
    if (!a || typeof a.type !== 'string') return { ok: false, error: '无效操作', events };
    if (this.phase === 'ended') return { ok: false, error: '游戏已结束', events };
    const p = this.P(pid);
    if (!p) return { ok: false, error: '你不是本局玩家', events };
    if (this.cur().id !== pid) return { ok: false, error: '还没轮到你', events };
    const fn = this['do_' + a.type];
    if (!fn || !['build', 'network', 'develop', 'sell', 'loan', 'scout', 'pass'].includes(a.type)) return { ok: false, error: '未知操作', events };
    // 失败时整体回滚
    const snap = JSON.stringify(this.toJSON());
    try {
      fn.call(this, p, a, events);
      events.push({ type: 'action', pid, action: a.type });
      this.actionsLeft--;
      if (this.actionsLeft <= 0 || !p.hand.length) this.endTurn(events);
      return { ok: true, events };
    } catch (err) {
      Object.assign(this, JSON.parse(snap));
      return { ok: false, error: err.message, events: [] };
    }
  }

  endTurn(events) {
    const p = this.cur();
    this.draw(p);
    this.turnIdx++;
    this.startTurn(events);
  }

  startTurn(events) {
    while (this.turnIdx < this.order.length && !this.cur().hand.length) this.turnIdx++;
    if (this.turnIdx >= this.order.length) return this.endRound(events);
    this.actionsLeft = this.era === 'canal' && this.round === 1 ? 1 : 2;
    events.push({ type: 'turn', pid: this.cur().id, actions: this.actionsLeft });
  }

  endRound(events) {
    const final = !this.deck.length && this.players.every((p) => !p.hand.length);
    const lastOfGame = final && (this.era === 'rail' || this.intro);
    // 新的行动顺序：本轮花钱最少的先行动（同样多时保持原顺序）
    const prev = this.order.slice();
    this.order.sort((a, b) => this.P(a).spent - this.P(b).spent || prev.indexOf(a) - prev.indexOf(b));
    const spent = Object.fromEntries(this.players.map((p) => [p.id, p.spent]));
    const income = [];
    if (!lastOfGame) for (const p of this.players) income.push(this.collectIncome(p, events));
    for (const p of this.players) p.spent = 0;
    events.push({ type: 'roundEnd', era: this.era, round: this.round, order: this.order.slice(), prevOrder: prev, spent, income });
    this.addLog(`—— ${this.era === 'canal' ? '运河' : '铁路'}时代第 ${this.round} 轮结束。新顺序：${this.order.map((id) => this.P(id).name).join(' → ')} ——`);
    this.history.push(Object.fromEntries(this.players.map((p) => [p.id, p.vp])));
    if (final) return this.endEra(events);
    this.round++;
    this.turnIdx = 0;
    this.startTurn(events);
  }

  collectIncome(p, events) {
    const lv = this.level(p);
    if (lv >= 0) {
      p.money += lv;
      return { pid: p.id, amount: lv };
    }
    const owe = -lv;
    if (p.money >= owe) {
      p.money -= owe;
      return { pid: p.id, amount: lv };
    }
    // 钱不够：卖掉自己的工厂（返还一半造价），还不够就扣分
    let short = owe - p.money;
    p.money = 0;
    const removed = [];
    const mine = [];
    this.forTiles((t, loc, s) => t.owner === p.id && mine.push({ t, loc, s }));
    mine.sort((a, b) => a.t.flipped - b.t.flipped || TILES[a.t.ind][a.t.lv].vp - TILES[b.t.ind][b.t.lv].vp);
    for (const m of mine) {
      if (short <= 0) break;
      const half = Math.floor(TILES[m.t.ind][m.t.lv].cost / 2);
      if (!half) continue;
      this.board[m.loc][m.s] = null;
      removed.push({ loc: m.loc, slot: m.s, ind: m.t.ind, lv: m.t.lv, money: half });
      short -= half;
    }
    if (short < 0) p.money = -short;
    let vpLost = 0;
    if (short > 0) {
      vpLost = Math.min(p.vp, short);
      p.vp -= vpLost;
    }
    events.push({ type: 'shortfall', pid: p.id, removed, vpLost });
    this.addLog(`⚠️ ${p.name} 付不起收入 £${owe}${removed.length ? `，卖掉了 ${removed.length} 座工厂` : ''}${vpLost ? `，扣 ${vpLost} 分` : ''}`, p.id);
    return { pid: p.id, amount: lv, short: true };
  }

  endEra(events) {
    const era = this.era;
    // 1) 线路计分
    const links = [];
    for (const [id, owner] of Object.entries(this.links)) {
      const l = LINK_BY_ID[id];
      const vp = this.linkIcons(l.a) + this.linkIcons(l.b);
      const p = this.P(owner);
      p.vp += vp;
      p.stats.vpLinks += vp;
      links.push({ id, pid: owner, vp });
    }
    // 2) 翻面产业计分
    const tiles = [];
    this.forTiles((t, loc, s) => {
      if (!t.flipped) return;
      const vp = TILES[t.ind][t.lv].vp;
      const p = this.P(t.owner);
      p.vp += vp;
      p.stats.vpTiles += vp;
      tiles.push({ loc, slot: s, pid: t.owner, vp });
    });
    const totals = Object.fromEntries(this.players.map((p) => [p.id, p.vp]));
    events.push({ type: 'eraEnd', era, links, tiles, totals });
    this.addLog(`🏁 ${era === 'canal' ? '运河' : '铁路'}时代结束！线路与翻面的工厂计分：${this.players.map((p) => `${p.name} ${p.vp} 分`).join('，')}`);

    if (era === 'canal' && !this.intro) {
      // 进入铁路时代：拆掉所有运河与Ⅰ级工厂，商人补满啤酒，全部牌重新洗成牌堆
      this.links = {};
      this.forTiles((t, loc, s) => t.lv === 1 && (this.board[loc][s] = null));
      for (const slots of Object.values(this.merchants)) for (const ms of slots) ms.beer = ms.type === 'blank' ? 0 : 1;
      const all = this.burned.slice();
      for (const p of this.players) {
        all.push(...p.discard, ...p.hand.filter((c) => c.k === 'loc' || c.k === 'ind'));
        for (const c of p.hand) if (c.k === 'wloc' || c.k === 'wind') this.wilds[c.k]++;
        p.discard = [];
        p.hand = [];
      }
      this.burned = [];
      this.deck = this.shuffle(all);
      for (const p of this.players) this.draw(p);
      this.era = 'rail';
      this.round = 1;
      this.turnIdx = 0;
      events.push({ type: 'eraStart', era: 'rail' });
      this.addLog('🚂 铁路时代开始！运河和Ⅰ级工厂已拆除，每轮 2 个行动。');
      this.startTurn(events);
      return;
    }
    if (this.intro) {
      // 入门短局的额外计分：每 £4 得 1 分（最多 15）、收入等级、Ⅱ级以上翻面工厂再计一次
      for (const p of this.players) {
        const money = Math.min(15, Math.floor(p.money / 4));
        const inc = this.level(p);
        let again = 0;
        this.forTiles((t) => t.owner === p.id && t.flipped && t.lv >= 2 && (again += TILES[t.ind][t.lv].vp));
        p.vp = Math.max(0, p.vp + money + inc + again);
      }
      events.push({ type: 'introScore', totals: Object.fromEntries(this.players.map((p) => [p.id, p.vp])) });
    }
    this.finish(events);
  }

  ranking() {
    return this.players.slice().sort((a, b) => b.vp - a.vp || this.level(b) - this.level(a) || b.money - a.money);
  }
  finish(events) {
    this.phase = 'ended';
    this.endedAt = Date.now();
    const r = this.ranking();
    this.winner = r[0].id;
    events.push({ type: 'win', pid: this.winner });
    this.addLog(`🏆 ${r[0].name} 以 ${r[0].vp} 分获胜！`, r[0].id);
  }

  // ---------- 序列化 ----------
  toJSON() {
    const out = {};
    for (const [k, v] of Object.entries(this)) out[k] = v;
    return out;
  }
  static fromJSON(data) {
    const g = Object.create(BrassGame.prototype);
    Object.assign(g, JSON.parse(JSON.stringify(data)));
    return g;
  }
  clone() {
    return BrassGame.fromJSON(this.toJSON());
  }

  // ---------- 视图（隐藏别人的手牌） ----------
  view(pid, full = false) {
    const ended = this.phase === 'ended';
    const me = this.P(pid);
    const v = {
      n: this.n,
      intro: this.intro,
      tutorial: !!this.tutorial,
      era: this.era,
      round: this.round,
      roundsLeft: this.roundsLeft(),
      phase: this.phase,
      order: this.order,
      turn: ended ? null : this.cur().id,
      actionsLeft: this.actionsLeft,
      deck: this.deck.length,
      wilds: this.wilds,
      market: this.market,
      merchants: this.merchants,
      board: this.board,
      links: this.links,
      winner: this.winner,
      history: this.history,
      log: this.log.slice(-90),
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        money: p.money,
        incomePos: p.incomePos,
        income: this.level(p),
        vp: p.vp,
        spent: p.spent,
        handCount: p.hand.length,
        hand: p.id === pid ? p.hand : null,
        discardTop: p.discard.length ? p.discard[p.discard.length - 1] : null,
        mat: p.mat,
        linksLeft: p.linksLeft,
        stats: p.stats,
      })),
    };
    if (full) v.map = D.publicMap();
    if (me && !ended && this.cur().id === pid) {
      v.me = {
        build: this.buildOptions(me),
        links: this.linkOptions(me),
        develop: this.developOptions(me),
        sell: this.sellOptions(me),
        loan: this.loanCheck(me),
        scout: this.scoutCheck(me),
      };
    }
    return v;
  }
}

module.exports = { BrassGame, SELLABLE, ACCEPTS, ROMAN, cardName, tileName };
