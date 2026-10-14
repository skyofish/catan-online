'use strict';
// 简单电脑玩家：给出一个动作（或 null 表示无事可做）。

const { RES, PIPS } = require('./board');
const { COST, sumRes, hasRes } = require('./game');

function vertexScore(g, vid, pid) {
  const v = g.board.vertices[vid];
  let s = 0;
  const seen = new Set();
  for (const tid of v.tiles) {
    const t = g.board.tiles[tid];
    if (!t.resource) continue;
    const pips = PIPS[t.number] || 0;
    s += pips * (tid === g.robber ? 0.3 : 1);
    if (!seen.has(t.resource)) s += 1.2;
    seen.add(t.resource);
    if (t.resource === 'ore' || t.resource === 'wheat') s += pips * 0.12;
  }
  if (v.port) s += v.port === 'any' ? 1 : 0.8;
  // 补足自己缺少的资源种类
  if (pid) {
    const owned = new Set();
    for (const [ov, b] of Object.entries(g.buildings)) {
      if (b.owner !== pid) continue;
      for (const tid of g.board.vertices[ov].tiles) owned.add(g.board.tiles[tid].resource);
    }
    for (const r of seen) if (!owned.has(r)) s += 1.5;
  }
  return s;
}

function pickBest(list, score) {
  let best = null;
  let bs = -Infinity;
  for (const x of list) {
    const s = score(x) + Math.random() * 0.01;
    if (s > bs) {
      bs = s;
      best = x;
    }
  }
  return best;
}

// 道路朝向最佳空闲村庄位置
function roadScore(g, eid, pid) {
  const e = g.board.edges[eid];
  let best = 0;
  for (const vid of e.v) {
    if (g.vertexFree(vid)) best = Math.max(best, vertexScore(g, vid, pid) + 3);
    for (const a of g.board.vertices[vid].adj) if (g.vertexFree(a)) best = Math.max(best, vertexScore(g, a, pid));
  }
  return best;
}

function need(p, cost) {
  const out = {};
  for (const k of RES) if ((cost[k] || 0) > p.res[k]) out[k] = cost[k] - p.res[k];
  return out;
}

function botAction(g, pid) {
  const p = g.P(pid);
  if (!p || g.phase === 'ended') return null;

  // 回应他人交易（任何阶段）
  if (g.trade && g.trade.from !== pid && g.trade.responses[pid] === 'pending') {
    const t = g.trade;
    let accept = false;
    if (hasRes(p.res, t.get)) {
      const after = { ...p.res };
      for (const k of RES) after[k] += t.give[k] - t.get[k];
      const gain = sumRes(t.give) - sumRes(t.get);
      const goal = p.pieces.city > 0 && g.legalCities(pid).length ? COST.city : COST.settlement;
      const before = sumRes(need(p, goal));
      const afterN = RES.reduce((s, k) => s + Math.max(0, (goal[k] || 0) - after[k]), 0);
      const leaderVP = g.vp(g.P(t.from), false);
      accept = (afterN < before || gain > 0) && leaderVP < g.targetVP - 2;
    }
    return { type: 'respondTrade', id: t.id, accept };
  }

  const active = g.activePlayers();
  if (!active.includes(pid)) return null;

  if (g.phase === 'setup') {
    if (g.sub === 'settlement') {
      const list = g.legalSettlements(pid, true);
      return { type: 'settlement', vertex: pickBest(list, (v) => vertexScore(g, v, pid)) };
    }
    const list = g.legalRoads(pid);
    return { type: 'road', edge: pickBest(list, (e) => roadScore(g, e, pid)) };
  }

  switch (g.sub) {
    case 'discard': {
      let n = g.discardPending[pid];
      const res = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
      const have = { ...p.res };
      while (n > 0) {
        const k = RES.reduce((a, b) => (have[a] >= have[b] ? a : b));
        have[k]--;
        res[k]++;
        n--;
      }
      return { type: 'discard', res };
    }
    case 'roll': {
      const knight = p.dev.find((d) => d.type === 'knight' && d.turn < g.turnCount);
      const robberOnMe = g.board.tiles[g.robber].vertices.some((v) => g.buildings[v] && g.buildings[v].owner === pid);
      if (knight && !g.devPlayed && (robberOnMe || p.knights >= 2)) return { type: 'playDev', card: 'knight' };
      return { type: 'roll' };
    }
    case 'robber': {
      const tiles = g.board.tiles.filter((t) => t.id !== g.robber);
      const tile = pickBest(tiles, (t) => {
        let s = 0;
        for (const vid of t.vertices) {
          const b = g.buildings[vid];
          if (!b) continue;
          if (b.owner === pid) s -= 20;
          else s += (PIPS[t.number] || 0) * (b.type === 'city' ? 2 : 1) * (1 + g.vp(g.P(b.owner), false) / 5) + (sumRes(g.P(b.owner).res) ? 1 : 0);
        }
        return s;
      });
      return { type: 'robber', tile: tile.id };
    }
    case 'steal': {
      const vs = g.robberVictims(pid, g.robber);
      return { type: 'steal', victim: pickBest(vs, (v) => sumRes(g.P(v).res)) };
    }
    case 'roadBuilding': {
      const list = g.legalRoads(pid);
      if (!list.length) return { type: 'skipRoads' };
      return { type: 'road', edge: pickBest(list, (e) => roadScore(g, e, pid)) };
    }
    case 'special':
    case 'main':
      return mainAction(g, p, g.sub === 'special');
  }
  return null;
}

function mainAction(g, p, special) {
  const pid = p.id;
  const key = `${g.turnCount}:${pid}`;
  if (!g._botActs || g._botActs.key !== key) g._botActs = { key, n: 0 };
  g._botActs.n++;
  const tooMany = g._botActs.n > 25;

  if (!tooMany) {
    // 打出发展卡
    if (!special && !g.devPlayed) {
      const usable = (t) => p.dev.find((d) => d.type === t && d.turn < g.turnCount);
      if (usable('road') && p.pieces.road >= 2 && g.legalRoads(pid).length) return { type: 'playDev', card: 'road' };
      if (usable('plenty')) {
        const goal = g.legalCities(pid).length && p.pieces.city ? COST.city : COST.settlement;
        const n = need(p, goal);
        const ks = Object.keys(n);
        if (ks.length && sumRes(n) <= 2) {
          const r1 = ks[0];
          const r2 = n[r1] >= 2 ? r1 : ks[1] || r1;
          if (g.bank[r1] > 1 && g.bank[r2] > 1) return { type: 'playDev', card: 'plenty', res1: r1, res2: r2 };
        }
      }
      if (usable('monopoly')) {
        let best = null;
        let bn = 3;
        for (const k of RES) {
          const n = g.players.reduce((s, o) => s + (o.id === pid ? 0 : o.res[k]), 0);
          if (n > bn) {
            bn = n;
            best = k;
          }
        }
        if (best) return { type: 'playDev', card: 'monopoly', res1: best };
      }
      if (usable('knight') && g.board.tiles[g.robber].vertices.some((v) => g.buildings[v] && g.buildings[v].owner === pid)) return { type: 'playDev', card: 'knight' };
    }
    // 建造
    const cities = g.legalCities(pid);
    if (cities.length && p.pieces.city > 0 && hasRes(p.res, COST.city)) {
      return { type: 'city', vertex: pickBest(cities, (v) => vertexScore(g, v, null)) };
    }
    const sets = g.legalSettlements(pid);
    if (sets.length && p.pieces.settlement > 0 && hasRes(p.res, COST.settlement)) {
      return { type: 'settlement', vertex: pickBest(sets, (v) => vertexScore(g, v, pid)) };
    }
    const roads = g.legalRoads(pid);
    const wantRoad = !sets.length || p.roadLen < 5 || g.longestRoad !== pid;
    if (roads.length && p.pieces.road > 0 && wantRoad && hasRes(p.res, COST.road) && (!sets.length || sumRes(p.res) > 6)) {
      return { type: 'road', edge: pickBest(roads, (e) => roadScore(g, e, pid)) };
    }
    if (g.devDeck.length && hasRes(p.res, COST.dev) && (!cities.length || p.res.ore > 3)) return { type: 'buyDev' };

    // 银行交易
    if (!special) {
      const goal = cities.length && p.pieces.city ? COST.city : sets.length && p.pieces.settlement ? COST.settlement : COST.road;
      const n = need(p, goal);
      const want = Object.keys(n)[0];
      if (want) {
        const ratios = g.ratios(pid);
        for (const k of RES) {
          const spare = p.res[k] - (goal[k] || 0);
          if (k !== want && spare >= ratios[k] && g.bank[want] > 0) return { type: 'bankTrade', give: k, get: want, times: 1 };
        }
      }
      // 手牌过多时购买发展卡/交易防止被强盗
      if (sumRes(p.res) > 7 && roads.length && p.pieces.road > 0 && hasRes(p.res, COST.road)) {
        return { type: 'road', edge: pickBest(roads, (e) => roadScore(g, e, pid)) };
      }
    }
  }
  if (g.trade && g.trade.from === pid) return { type: 'cancelTrade' };
  return special ? { type: 'endSpecial' } : { type: 'endTurn' };
}

module.exports = { botAction };
