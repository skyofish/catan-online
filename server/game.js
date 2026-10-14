'use strict';
// 卡坦岛规则引擎（服务器权威）。所有操作通过 act(pid, action) 进入，返回 { ok, error, events }。

const { generateBoard, LAYOUTS, RES, shuffle, expand } = require('./board');

const COST = {
  road: { wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
  city: { wheat: 2, ore: 3 },
  dev: { sheep: 1, wheat: 1, ore: 1 },
};
const PIECES = { road: 15, settlement: 5, city: 4 };
const RES_NAME = { wood: '木材', brick: '砖块', sheep: '羊毛', wheat: '小麦', ore: '矿石' };
const DEV_NAME = { knight: '骑士', vp: '胜利点', road: '道路建设', plenty: '丰收之年', monopoly: '垄断' };

const emptyRes = () => ({ wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 });
const sumRes = (r) => RES.reduce((s, k) => s + (r[k] || 0), 0);
const cleanRes = (r) => {
  const out = emptyRes();
  if (!r || typeof r !== 'object') return out;
  for (const k of RES) {
    const n = Math.floor(Number(r[k]) || 0);
    out[k] = Math.max(0, Math.min(n, 99));
  }
  return out;
};
const hasRes = (have, need) => RES.every((k) => (have[k] || 0) >= (need[k] || 0));
const resText = (r) =>
  RES.filter((k) => r[k])
    .map((k) => `${r[k]}${RES_NAME[k]}`)
    .join('、') || '无';

class Game {
  constructor(opts, players, rng = Math.random) {
    this.rng = rng;
    this.size = opts.size;
    this.layout = LAYOUTS[this.size];
    this.targetVP = opts.targetVP || 10;
    this.specialBuild = !!opts.specialBuild;
    // 可传入大厅里预览过的地图；否则现场生成
    this.board = opts.board && opts.board.size === this.size ? opts.board : generateBoard(this.size, rng);
    this.buildings = {}; // vertexId -> { owner, type }
    this.roads = {}; // edgeId -> owner
    this.robber = this.board.tiles.find((t) => t.terrain === 'desert').id;
    this.bank = {};
    for (const k of RES) this.bank[k] = this.layout.bank;
    this.devDeck = shuffle(expand(this.layout.dev), rng);
    this.players = shuffle(players.slice(), rng).map((p, i) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      seat: i,
      res: emptyRes(),
      dev: [], // { type, turn }
      knights: 0,
      pieces: { ...PIECES },
      roadLen: 0,
      stats: { rolled: 0, gained: 0, stolen: 0, traded: 0, built: 0 },
    }));
    const n = this.players.length;
    this.setupOrder = [...Array(n).keys(), ...[...Array(n).keys()].reverse()];
    this.setupIdx = 0;
    this.phase = 'setup';
    this.sub = 'settlement';
    this.turn = this.setupOrder[0];
    this.turnCount = 0;
    this.lastSettlement = null;
    this.dice = null;
    this.discardPending = {};
    this.afterRobber = 'main';
    this.devPlayed = false;
    this.freeRoads = 0;
    this.longestRoad = null; // pid
    this.largestArmy = null; // pid
    this.trade = null;
    this.tradeSeq = 0;
    this.special = null; // { queue: [idx], i }
    this.winner = null;
    this.log = [];
    this.logSeq = 0;
    this.rollHistory = Array(13).fill(0);
    this.startedAt = Date.now();
    this.addLog(`游戏开始！${this.size} 人地图，目标 ${this.targetVP} 分。`);
    this.addLog(`初始放置：${this.cur().name} 先放村庄。`);
  }

  // ---------- 工具 ----------
  cur() {
    return this.players[this.turn];
  }
  pIdx(pid) {
    return this.players.findIndex((p) => p.id === pid);
  }
  P(pid) {
    return this.players.find((p) => p.id === pid);
  }
  addLog(text, pid = null) {
    this.log.push({ id: ++this.logSeq, text, pid, t: Date.now() });
    if (this.log.length > 200) this.log.shift();
  }
  vp(p, hidden = true) {
    let v = 0;
    for (const b of Object.values(this.buildings)) if (b.owner === p.id) v += b.type === 'city' ? 2 : 1;
    if (this.longestRoad === p.id) v += 2;
    if (this.largestArmy === p.id) v += 2;
    if (hidden) v += p.dev.filter((d) => d.type === 'vp').length;
    return v;
  }
  activePlayers() {
    if (this.phase === 'ended') return [];
    if (this.sub === 'discard') return Object.keys(this.discardPending);
    if (this.sub === 'special') return [this.players[this.special.queue[this.special.i]].id];
    return [this.cur().id];
  }

  // ---------- 合法位置 ----------
  vertexFree(vid) {
    if (this.buildings[vid]) return false;
    return this.board.vertices[vid].adj.every((a) => !this.buildings[a]);
  }
  legalSettlements(pid, setup = false) {
    const out = [];
    for (const v of this.board.vertices) {
      if (!this.vertexFree(v.id)) continue;
      if (!setup && !v.edges.some((e) => this.roads[e] === pid)) continue;
      out.push(v.id);
    }
    return out;
  }
  legalRoads(pid) {
    const out = [];
    if (this.phase === 'setup') {
      const v = this.board.vertices[this.lastSettlement];
      if (!v) return out;
      for (const e of v.edges) if (this.roads[e] === undefined) out.push(e);
      return out;
    }
    for (const e of this.board.edges) {
      if (this.roads[e.id] !== undefined) continue;
      if (this.roadConnects(pid, e)) out.push(e.id);
    }
    return out;
  }
  roadConnects(pid, e) {
    for (const vid of e.v) {
      const b = this.buildings[vid];
      if (b && b.owner === pid) return true;
      if (b && b.owner !== pid) continue; // 被对手建筑阻断
      for (const oe of this.board.vertices[vid].edges) if (oe !== e.id && this.roads[oe] === pid) return true;
    }
    return false;
  }
  legalCities(pid) {
    return Object.entries(this.buildings)
      .filter(([, b]) => b.owner === pid && b.type === 'settlement')
      .map(([v]) => Number(v));
  }
  ratios(pid) {
    const r = { wood: 4, brick: 4, sheep: 4, wheat: 4, ore: 4 };
    for (const port of this.board.ports) {
      if (!port.vertices.some((v) => this.buildings[v] && this.buildings[v].owner === pid)) continue;
      if (port.type === 'any') for (const k of RES) r[k] = Math.min(r[k], 3);
      else r[port.type] = 2;
    }
    return r;
  }
  robberVictims(pid, tileId) {
    const set = new Set();
    for (const vid of this.board.tiles[tileId].vertices) {
      const b = this.buildings[vid];
      if (b && b.owner !== pid && sumRes(this.P(b.owner).res) > 0) set.add(b.owner);
    }
    return [...set];
  }

  // ---------- 最长道路 / 最大军队 ----------
  roadLength(pid) {
    const edges = Object.keys(this.roads)
      .filter((e) => this.roads[e] === pid)
      .map(Number);
    if (!edges.length) return 0;
    const V = this.board.vertices;
    const E = this.board.edges;
    const blocked = (vid) => this.buildings[vid] && this.buildings[vid].owner !== pid;
    const used = new Set();
    const walk = (vid, start) => {
      let best = used.size;
      if (!start && blocked(vid)) return best;
      for (const eid of V[vid].edges) {
        if (this.roads[eid] !== pid || used.has(eid)) continue;
        used.add(eid);
        const e = E[eid];
        const nxt = e.v[0] === vid ? e.v[1] : e.v[0];
        best = Math.max(best, walk(nxt, false));
        used.delete(eid);
      }
      return best;
    };
    const starts = new Set();
    for (const eid of edges) E[eid].v.forEach((v) => starts.add(v));
    let best = 0;
    for (const v of starts) best = Math.max(best, walk(v, true));
    return best;
  }
  updateLongestRoad(events) {
    for (const p of this.players) p.roadLen = this.roadLength(p.id);
    const prev = this.longestRoad;
    const max = Math.max(...this.players.map((p) => p.roadLen));
    let holder = prev;
    if (prev !== null) {
      const hp = this.P(prev);
      if (hp.roadLen < 5 || hp.roadLen < max) holder = null;
    }
    if (holder === null && max >= 5) {
      const tops = this.players.filter((p) => p.roadLen === max);
      if (tops.length === 1) holder = tops[0].id;
    }
    if (holder !== prev) {
      this.longestRoad = holder;
      if (holder !== null) {
        this.addLog(`🛣️ ${this.P(holder).name} 获得「最长道路」（${max} 段）！`, holder);
        events.push({ type: 'award', award: 'road', pid: holder, from: prev });
      } else {
        this.addLog(`「最长道路」暂时无人持有。`);
        events.push({ type: 'award', award: 'road', pid: null, from: prev });
      }
    }
  }
  updateLargestArmy(p, events) {
    if (p.knights < 3) return;
    const holder = this.largestArmy;
    if (holder === p.id) return;
    if (holder === null || p.knights > this.P(holder).knights) {
      this.largestArmy = p.id;
      this.addLog(`⚔️ ${p.name} 获得「最大军队」（${p.knights} 名骑士）！`, p.id);
      events.push({ type: 'award', award: 'army', pid: p.id, from: holder });
    }
  }

  checkWin(events) {
    if (this.phase === 'ended') return;
    const p = this.cur();
    if (this.vp(p) >= this.targetVP) {
      this.phase = 'ended';
      this.sub = 'ended';
      this.winner = p.id;
      this.trade = null;
      this.endedAt = Date.now();
      this.addLog(`🏆 ${p.name} 以 ${this.vp(p)} 分赢得了胜利！`, p.id);
      events.push({ type: 'win', pid: p.id });
    }
  }

  // ---------- 资源 ----------
  pay(p, cost) {
    for (const k of RES) {
      p.res[k] -= cost[k] || 0;
      this.bank[k] += cost[k] || 0;
    }
  }
  produce(sum, events) {
    const want = {}; // res -> [{pid, n, tile}]
    for (const t of this.board.tiles) {
      if (t.number !== sum || t.id === this.robber) continue;
      for (const vid of t.vertices) {
        const b = this.buildings[vid];
        if (!b) continue;
        (want[t.resource] = want[t.resource] || []).push({ pid: b.owner, n: b.type === 'city' ? 2 : 1, tile: t.id });
      }
    }
    const gains = [];
    const short = [];
    for (const [res, list] of Object.entries(want)) {
      const total = list.reduce((s, x) => s + x.n, 0);
      const owners = new Set(list.map((x) => x.pid));
      if (total <= this.bank[res]) {
        for (const x of list) gains.push({ ...x, res });
      } else if (owners.size === 1) {
        let left = this.bank[res];
        for (const x of list) {
          const n = Math.min(x.n, left);
          left -= n;
          if (n) gains.push({ ...x, n, res });
        }
        short.push(res);
      } else short.push(res);
    }
    const perPlayer = {};
    for (const g of gains) {
      const p = this.P(g.pid);
      p.res[g.res] += g.n;
      p.stats.gained += g.n;
      this.bank[g.res] -= g.n;
      perPlayer[g.pid] = perPlayer[g.pid] || emptyRes();
      perPlayer[g.pid][g.res] += g.n;
    }
    for (const [pid, r] of Object.entries(perPlayer)) this.addLog(`${this.P(pid).name} 获得 ${resText(r)}`, pid);
    if (short.length) this.addLog(`银行资源不足：${short.map((k) => RES_NAME[k]).join('、')} 本轮不发放。`);
    if (!gains.length) this.addLog(`没有人获得资源。`);
    events.push({ type: 'produce', gains, number: sum });
  }

  // ---------- 回合推进 ----------
  startTurn(events) {
    this.turnCount++;
    this.sub = 'roll';
    this.dice = null;
    this.devPlayed = false;
    this.trade = null;
    this.special = null;
    this.addLog(`—— 第 ${this.turnCount} 回合：${this.cur().name} ——`, this.cur().id);
    events.push({ type: 'turn', pid: this.cur().id });
    this.checkWin(events);
  }
  finishTurn(events) {
    const n = this.players.length;
    if (this.specialBuild && n > 1) {
      const queue = [];
      for (let k = 1; k < n; k++) queue.push((this.turn + k) % n);
      this.special = { queue, i: 0 };
      this.sub = 'special';
      this.trade = null;
      this.addLog(`特殊建造阶段：${this.players[queue[0]].name} 可以建造。`);
      events.push({ type: 'special', pid: this.players[queue[0]].id });
      return;
    }
    this.turn = (this.turn + 1) % n;
    this.startTurn(events);
  }

  // ---------- 动作入口 ----------
  act(pid, a) {
    const events = [];
    try {
      if (!a || typeof a.type !== 'string') throw new Error('无效操作');
      if (this.phase === 'ended') throw new Error('游戏已结束');
      const p = this.P(pid);
      if (!p) throw new Error('你不是本局玩家');
      const fn = this['do_' + a.type];
      if (!fn) throw new Error('未知操作');
      fn.call(this, p, a, events);
      return { ok: true, events };
    } catch (err) {
      return { ok: false, error: err.message, events: [] };
    }
  }

  requireTurn(p, ...subs) {
    if (this.cur().id !== p.id) throw new Error('还没轮到你');
    if (subs.length && !subs.includes(this.sub)) throw new Error('当前阶段不能这样做');
  }

  // 初始放置 / 建造
  do_settlement(p, a, events) {
    const vid = Number(a.vertex);
    const v = this.board.vertices[vid];
    if (!v) throw new Error('无效位置');
    if (this.phase === 'setup') {
      this.requireTurn(p, 'settlement');
      if (!this.vertexFree(vid)) throw new Error('该位置不可建造（距离规则）');
      this.buildings[vid] = { owner: p.id, type: 'settlement' };
      p.pieces.settlement--;
      this.lastSettlement = vid;
      this.sub = 'road';
      const second = this.setupIdx >= this.players.length;
      const got = emptyRes();
      if (second) {
        for (const tid of v.tiles) {
          const t = this.board.tiles[tid];
          if (t.resource && this.bank[t.resource] > 0) {
            got[t.resource]++;
            p.res[t.resource]++;
            this.bank[t.resource]--;
          }
        }
      }
      this.addLog(`${p.name} 放置了村庄${second ? `，获得 ${resText(got)}` : ''}`, p.id);
      events.push({ type: 'build', kind: 'settlement', pid: p.id, vertex: vid });
      if (second && sumRes(got)) events.push({ type: 'produce', gains: v.tiles.filter((t) => this.board.tiles[t].resource).map((t) => ({ pid: p.id, tile: t, res: this.board.tiles[t].resource, n: 1 })), number: null });
      return;
    }
    this.requireBuilder(p);
    if (p.pieces.settlement <= 0) throw new Error('村庄已用完');
    if (!hasRes(p.res, COST.settlement)) throw new Error('资源不足');
    if (!this.legalSettlements(p.id).includes(vid)) throw new Error('该位置不可建造');
    this.pay(p, COST.settlement);
    this.buildings[vid] = { owner: p.id, type: 'settlement' };
    p.pieces.settlement--;
    p.stats.built++;
    this.addLog(`${p.name} 建造了村庄`, p.id);
    events.push({ type: 'build', kind: 'settlement', pid: p.id, vertex: vid });
    this.updateLongestRoad(events); // 可能截断他人道路
    this.checkWin(events);
  }

  do_road(p, a, events) {
    const eid = Number(a.edge);
    if (!this.board.edges[eid]) throw new Error('无效位置');
    if (this.phase === 'setup') {
      this.requireTurn(p, 'road');
      if (!this.legalRoads(p.id).includes(eid)) throw new Error('道路必须连接刚放置的村庄');
      this.roads[eid] = p.id;
      p.pieces.road--;
      events.push({ type: 'build', kind: 'road', pid: p.id, edge: eid });
      this.addLog(`${p.name} 放置了道路`, p.id);
      this.setupIdx++;
      if (this.setupIdx >= this.setupOrder.length) {
        this.phase = 'play';
        this.turn = 0;
        this.addLog(`初始放置完成，正式开始！`);
        this.startTurn(events);
      } else {
        this.turn = this.setupOrder[this.setupIdx];
        this.sub = 'settlement';
        events.push({ type: 'turn', pid: this.cur().id, setup: true });
      }
      return;
    }
    if (this.sub === 'roadBuilding') {
      this.requireTurn(p, 'roadBuilding');
      if (!this.legalRoads(p.id).includes(eid)) throw new Error('该位置不可建造');
      this.roads[eid] = p.id;
      p.pieces.road--;
      p.stats.built++;
      this.freeRoads--;
      events.push({ type: 'build', kind: 'road', pid: p.id, edge: eid });
      this.addLog(`${p.name} 免费建造了道路`, p.id);
      this.updateLongestRoad(events);
      if (this.freeRoads <= 0 || p.pieces.road <= 0 || !this.legalRoads(p.id).length) {
        this.freeRoads = 0;
        this.sub = this.afterRobber;
      }
      this.checkWin(events);
      return;
    }
    this.requireBuilder(p);
    if (p.pieces.road <= 0) throw new Error('道路已用完');
    if (!hasRes(p.res, COST.road)) throw new Error('资源不足');
    if (!this.legalRoads(p.id).includes(eid)) throw new Error('该位置不可建造');
    this.pay(p, COST.road);
    this.roads[eid] = p.id;
    p.pieces.road--;
    p.stats.built++;
    this.addLog(`${p.name} 建造了道路`, p.id);
    events.push({ type: 'build', kind: 'road', pid: p.id, edge: eid });
    this.updateLongestRoad(events);
    this.checkWin(events);
  }

  do_city(p, a, events) {
    const vid = Number(a.vertex);
    this.requireBuilder(p);
    const b = this.buildings[vid];
    if (!b || b.owner !== p.id || b.type !== 'settlement') throw new Error('只能将自己的村庄升级为城市');
    if (p.pieces.city <= 0) throw new Error('城市已用完');
    if (!hasRes(p.res, COST.city)) throw new Error('资源不足');
    this.pay(p, COST.city);
    b.type = 'city';
    p.pieces.city--;
    p.pieces.settlement++;
    p.stats.built++;
    this.addLog(`${p.name} 将村庄升级为城市`, p.id);
    events.push({ type: 'build', kind: 'city', pid: p.id, vertex: vid });
    this.checkWin(events);
  }

  do_buyDev(p, a, events) {
    this.requireBuilder(p);
    if (!this.devDeck.length) throw new Error('发展卡已售罄');
    if (!hasRes(p.res, COST.dev)) throw new Error('资源不足');
    this.pay(p, COST.dev);
    const type = this.devDeck.pop();
    p.dev.push({ type, turn: this.turnCount });
    this.addLog(`${p.name} 购买了一张发展卡`, p.id);
    events.push({ type: 'buyDev', pid: p.id, card: type, private: [p.id] });
    this.checkWin(events);
  }

  requireBuilder(p) {
    if (this.phase !== 'play') throw new Error('当前阶段不能建造');
    if (this.sub === 'special') {
      const sp = this.players[this.special.queue[this.special.i]];
      if (sp.id !== p.id) throw new Error('还没轮到你');
      return;
    }
    this.requireTurn(p, 'main');
  }

  do_endSpecial(p, a, events) {
    if (this.sub !== 'special') throw new Error('当前不是特殊建造阶段');
    const sp = this.players[this.special.queue[this.special.i]];
    if (sp.id !== p.id) throw new Error('还没轮到你');
    this.special.i++;
    if (this.special.i >= this.special.queue.length) {
      this.turn = (this.turn + 1) % this.players.length;
      this.startTurn(events);
    } else {
      const nx = this.players[this.special.queue[this.special.i]];
      events.push({ type: 'special', pid: nx.id });
    }
  }

  // 掷骰
  do_roll(p, a, events) {
    this.requireTurn(p, 'roll');
    const d1 = 1 + Math.floor(this.rng() * 6);
    const d2 = 1 + Math.floor(this.rng() * 6);
    const sum = d1 + d2;
    this.dice = [d1, d2];
    this.rollHistory[sum]++;
    p.stats.rolled++;
    this.addLog(`🎲 ${p.name} 掷出了 ${sum}（${d1}+${d2}）`, p.id);
    events.push({ type: 'roll', pid: p.id, dice: [d1, d2] });
    if (sum === 7) {
      this.discardPending = {};
      for (const pl of this.players) {
        const n = sumRes(pl.res);
        if (n > 7) this.discardPending[pl.id] = Math.floor(n / 2);
      }
      events.push({ type: 'seven', pid: p.id });
      this.afterRobber = 'main';
      if (Object.keys(this.discardPending).length) {
        this.sub = 'discard';
        this.addLog(`强盗出没！手牌超过 7 张的玩家需弃掉一半。`);
      } else {
        this.sub = 'robber';
        this.addLog(`强盗出没！${p.name} 移动强盗。`);
      }
      return;
    }
    this.produce(sum, events);
    this.sub = 'main';
  }

  do_discard(p, a, events) {
    if (this.sub !== 'discard') throw new Error('当前不需要弃牌');
    const need = this.discardPending[p.id];
    if (!need) throw new Error('你不需要弃牌');
    const r = cleanRes(a.res);
    if (sumRes(r) !== need) throw new Error(`需要弃掉 ${need} 张`);
    if (!hasRes(p.res, r)) throw new Error('手牌不足');
    this.pay(p, r);
    delete this.discardPending[p.id];
    this.addLog(`${p.name} 弃掉了 ${need} 张牌`, p.id);
    events.push({ type: 'discard', pid: p.id, n: need });
    if (!Object.keys(this.discardPending).length) {
      this.sub = 'robber';
      this.addLog(`${this.cur().name} 移动强盗。`);
    }
  }

  do_robber(p, a, events) {
    this.requireTurn(p, 'robber');
    const tid = Number(a.tile);
    if (!this.board.tiles[tid]) throw new Error('无效地块');
    if (tid === this.robber) throw new Error('强盗必须移到其他地块');
    const from = this.robber;
    this.robber = tid;
    this.addLog(`${p.name} 将强盗移到了新地块`, p.id);
    events.push({ type: 'robber', pid: p.id, tile: tid, from });
    const victims = this.robberVictims(p.id, tid);
    if (!victims.length) this.sub = this.afterRobber;
    else if (victims.length === 1) this.stealFrom(p, this.P(victims[0]), events);
    else this.sub = 'steal';
  }

  do_steal(p, a, events) {
    this.requireTurn(p, 'steal');
    if (!this.robberVictims(p.id, this.robber).includes(a.victim)) throw new Error('不能偷取该玩家');
    this.stealFrom(p, this.P(a.victim), events);
  }

  stealFrom(p, v, events) {
    const pool = [];
    for (const k of RES) for (let i = 0; i < v.res[k]; i++) pool.push(k);
    if (pool.length) {
      const r = pool[Math.floor(this.rng() * pool.length)];
      v.res[r]--;
      p.res[r]++;
      p.stats.stolen++;
      this.addLog(`${p.name} 从 ${v.name} 那里偷走了一张牌`, p.id);
      events.push({ type: 'steal', pid: p.id, victim: v.id, res: r, private: [p.id, v.id] });
    }
    this.sub = this.afterRobber;
  }

  // 发展卡
  do_playDev(p, a, events) {
    if (this.cur().id !== p.id) throw new Error('还没轮到你');
    if (!['roll', 'main'].includes(this.sub)) throw new Error('当前阶段不能打出发展卡');
    if (this.devPlayed) throw new Error('每回合只能打出一张发展卡');
    const card = a.card;
    if (card === 'vp') throw new Error('胜利点卡无需打出');
    const idx = p.dev.findIndex((d) => d.type === card && d.turn < this.turnCount);
    if (idx < 0) throw new Error(p.dev.some((d) => d.type === card) ? '本回合购买的卡不能立即使用' : '你没有这张卡');

    if (card === 'plenty') {
      const r1 = a.res1;
      const r2 = a.res2;
      if (!RES.includes(r1) || !RES.includes(r2)) throw new Error('请选择两种资源');
      const need = emptyRes();
      need[r1]++;
      need[r2]++;
      if (!hasRes(this.bank, need)) throw new Error('银行资源不足');
      p.dev.splice(idx, 1);
      for (const k of RES) {
        p.res[k] += need[k];
        this.bank[k] -= need[k];
      }
      this.devPlayed = true;
      this.addLog(`${p.name} 打出「丰收之年」，获得 ${resText(need)}`, p.id);
      events.push({ type: 'playDev', pid: p.id, card });
      events.push({ type: 'bankGive', pid: p.id, res: need });
    } else if (card === 'monopoly') {
      const r = a.res1;
      if (!RES.includes(r)) throw new Error('请选择一种资源');
      p.dev.splice(idx, 1);
      let total = 0;
      const from = [];
      for (const o of this.players) {
        if (o.id === p.id || !o.res[r]) continue;
        from.push({ pid: o.id, n: o.res[r] });
        total += o.res[r];
        o.res[r] = 0;
      }
      p.res[r] += total;
      this.devPlayed = true;
      this.addLog(`${p.name} 打出「垄断」，收走了所有 ${RES_NAME[r]}（共 ${total} 张）`, p.id);
      events.push({ type: 'playDev', pid: p.id, card });
      events.push({ type: 'monopoly', pid: p.id, res: r, from });
    } else if (card === 'road') {
      p.dev.splice(idx, 1);
      this.devPlayed = true;
      this.afterRobber = this.sub;
      this.freeRoads = Math.min(2, p.pieces.road);
      this.addLog(`${p.name} 打出「道路建设」`, p.id);
      events.push({ type: 'playDev', pid: p.id, card });
      if (this.freeRoads > 0 && this.legalRoads(p.id).length) this.sub = 'roadBuilding';
      else this.freeRoads = 0;
    } else if (card === 'knight') {
      p.dev.splice(idx, 1);
      this.devPlayed = true;
      p.knights++;
      this.afterRobber = this.sub;
      this.sub = 'robber';
      this.addLog(`${p.name} 打出「骑士」`, p.id);
      events.push({ type: 'playDev', pid: p.id, card });
      this.updateLargestArmy(p, events);
      this.checkWin(events);
    } else throw new Error('未知发展卡');
  }

  do_skipRoads(p, a, events) {
    this.requireTurn(p, 'roadBuilding');
    this.freeRoads = 0;
    this.sub = this.afterRobber;
  }

  // 交易
  do_bankTrade(p, a, events) {
    this.requireTurn(p, 'main');
    const give = a.give;
    const get = a.get;
    const times = Math.max(1, Math.min(10, Math.floor(Number(a.times) || 1)));
    if (!RES.includes(give) || !RES.includes(get) || give === get) throw new Error('无效交易');
    const ratio = this.ratios(p.id)[give];
    if (p.res[give] < ratio * times) throw new Error('资源不足');
    if (this.bank[get] < times) throw new Error('银行该资源不足');
    p.res[give] -= ratio * times;
    this.bank[give] += ratio * times;
    p.res[get] += times;
    this.bank[get] -= times;
    p.stats.traded++;
    this.addLog(`${p.name} 与银行交易：${ratio * times}${RES_NAME[give]} → ${times}${RES_NAME[get]}`, p.id);
    events.push({ type: 'bankTrade', pid: p.id, give: { [give]: ratio * times }, get: { [get]: times } });
  }

  do_proposeTrade(p, a, events) {
    this.requireTurn(p, 'main');
    const give = cleanRes(a.give);
    const get = cleanRes(a.get);
    if (!sumRes(give) || !sumRes(get)) throw new Error('交易双方都需要至少一张牌');
    if (RES.some((k) => give[k] && get[k])) throw new Error('不能用同种资源交换');
    if (!hasRes(p.res, give)) throw new Error('你的资源不足');
    const responses = {};
    for (const o of this.players) if (o.id !== p.id) responses[o.id] = 'pending';
    this.trade = { id: ++this.tradeSeq, from: p.id, give, get, responses };
    this.addLog(`${p.name} 发起交易：给出 ${resText(give)}，换取 ${resText(get)}`, p.id);
    events.push({ type: 'tradeOffer', pid: p.id });
  }

  do_respondTrade(p, a, events) {
    const t = this.trade;
    if (!t || t.id !== a.id) throw new Error('交易已失效');
    if (t.from === p.id) throw new Error('不能回应自己的交易');
    if (a.accept && !hasRes(p.res, t.get)) throw new Error('你的资源不足以接受');
    t.responses[p.id] = a.accept ? 'accept' : 'reject';
    events.push({ type: 'tradeResponse', pid: p.id, accept: !!a.accept });
  }

  do_confirmTrade(p, a, events) {
    this.requireTurn(p, 'main');
    const t = this.trade;
    if (!t || t.id !== a.id) throw new Error('交易已失效');
    const o = this.P(a.with);
    if (!o || t.responses[o.id] !== 'accept') throw new Error('对方尚未接受');
    if (!hasRes(p.res, t.give)) throw new Error('你的资源不足');
    if (!hasRes(o.res, t.get)) throw new Error('对方资源不足');
    for (const k of RES) {
      p.res[k] += t.get[k] - t.give[k];
      o.res[k] += t.give[k] - t.get[k];
    }
    p.stats.traded++;
    o.stats.traded++;
    this.trade = null;
    this.addLog(`🤝 ${p.name} 与 ${o.name} 完成交易：${resText(t.give)} ⇄ ${resText(t.get)}`, p.id);
    events.push({ type: 'trade', pid: p.id, with: o.id, give: t.give, get: t.get });
  }

  do_cancelTrade(p, a, events) {
    if (!this.trade || this.trade.from !== p.id) throw new Error('没有可取消的交易');
    this.trade = null;
    events.push({ type: 'tradeCancel', pid: p.id });
  }

  do_endTurn(p, a, events) {
    this.requireTurn(p, 'main');
    this.trade = null;
    this.addLog(`${p.name} 结束了回合`, p.id);
    this.finishTurn(events);
  }

  // ---------- 序列化（持久化到数据库） ----------
  toJSON() {
    const out = {};
    for (const [k, v] of Object.entries(this)) if (k !== 'rng' && k !== 'layout') out[k] = v;
    return out;
  }
  static fromJSON(data, rng = Math.random) {
    const g = Object.create(Game.prototype);
    Object.assign(g, data);
    g.rng = rng;
    g.layout = LAYOUTS[g.size];
    return g;
  }

  // ---------- 视图（按玩家隐藏信息） ----------
  view(pid, full = false) {
    const me = this.P(pid);
    const ended = this.phase === 'ended';
    const v = {
      size: this.size,
      targetVP: this.targetVP,
      specialBuild: this.specialBuild,
      phase: this.phase,
      sub: this.sub,
      turn: this.cur().id,
      turnCount: this.turnCount,
      dice: this.dice,
      robber: this.robber,
      buildings: this.buildings,
      roads: this.roads,
      bank: this.bank,
      devLeft: this.devDeck.length,
      longestRoad: this.longestRoad,
      largestArmy: this.largestArmy,
      discardPending: this.discardPending,
      freeRoads: this.freeRoads,
      devPlayed: this.devPlayed,
      trade: this.trade,
      special: this.special ? this.players[this.special.queue[this.special.i]].id : null,
      winner: this.winner,
      active: this.activePlayers(),
      rollHistory: this.rollHistory,
      setupRound: this.phase === 'setup' ? (this.setupIdx >= this.players.length ? 2 : 1) : 0,
      log: this.log.slice(-80),
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        resCount: sumRes(p.res),
        devCount: p.dev.length,
        knights: p.knights,
        pieces: p.pieces,
        roadLen: p.roadLen,
        vp: p.id === pid || ended ? this.vp(p) : this.vp(p, false),
        res: p.id === pid || ended ? p.res : null,
        dev: p.id === pid || ended ? p.dev : null,
        stats: ended ? p.stats : null,
      })),
    };
    if (full) v.board = this.board;
    if (me && !ended) {
      v.me = {
        ratios: this.ratios(pid),
        legal: {
          settlements: this.legalSettlements(pid, this.phase === 'setup'),
          roads: this.legalRoads(pid),
          cities: this.legalCities(pid),
        },
      };
    }
    return v;
  }
}

module.exports = { Game, COST, RES_NAME, DEV_NAME, sumRes, emptyRes, hasRes };
