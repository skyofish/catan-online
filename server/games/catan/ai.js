'use strict';
// 智谱大模型 AI 玩家。
// 设计：程序先算好合法且排过序的候选项，模型只在关键决策上做选择（开局选点、每回合计划、强盗、交易应答），
// 其余步骤（掷骰、弃牌、修路细节）沿用内置策略。任何错误或超时都回退到内置策略，保证对局不卡住。

const { RES, PIPS } = require('./board');
const { COST, sumRes, hasRes } = require('./game');
const { vertexScore, roadScore } = require('./bot');

// 兼容两套变量名：ZHIPU_API_KEY / ZHIPU_MODEL 通用；
// 另外支持 ZHIPU_BOT_ENABLED（显式设为 false 时关闭）、ZHIPU_API_URL（完整接口地址）、ZHIPU_TIMEOUT_SECONDS
const env = (k) => (process.env[k] || '').trim();
const apiUrl = env('ZHIPU_API_URL') || (env('ZHIPU_BASE_URL') ? env('ZHIPU_BASE_URL').replace(/\/$/, '') + '/chat/completions' : 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
const CFG = {
  key: /^(0|false|off|no)$/i.test(env('ZHIPU_BOT_ENABLED')) ? '' : env('ZHIPU_API_KEY'),
  model: env('ZHIPU_MODEL') || 'glm-4.7-flash',
  url: /\/chat\/completions$/.test(apiUrl) ? apiUrl : apiUrl.replace(/\/$/, '') + '/chat/completions',
  thinking: /^(1|true|on|enabled)$/i.test(env('ZHIPU_THINKING')),
  timeout: Number(env('AI_TIMEOUT_MS')) || (Number(env('ZHIPU_TIMEOUT_SECONDS')) || 0) * 1000 || 25000,
  concurrency: Number(env('AI_CONCURRENCY')) || 3,
};

const stats = { calls: 0, errors: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, lastError: null, lastErrorAt: null };
const enabled = () => !!CFG.key;
const publicStats = () => ({ enabled: enabled(), model: CFG.model, thinking: CFG.thinking, ...stats });

const CN = { wood: '木', brick: '砖', sheep: '羊', wheat: '麦', ore: '矿' };
const FROM_CN = { 木: 'wood', 砖: 'brick', 羊: 'sheep', 麦: 'wheat', 矿: 'ore', wood: 'wood', brick: 'brick', sheep: 'sheep', wheat: 'wheat', ore: 'ore' };
const DEV_CN = { knight: '骑士', vp: '胜利点', road: '修路', plenty: '丰收', monopoly: '垄断' };

// 系统提示：规则要点 + 策略要点，保持简短（每次调用都会发送，前缀相同便于缓存）
const SYSTEM = `你是卡坦岛顶尖玩家，目标是最快达到胜利分数。只输出JSON，不要解释。
规则：路=木砖；村=木砖羊麦(1分,须连自己的路,与任何建筑隔一个路口)；城=麦2矿3(由村升级,2分)；发展卡=羊麦矿(骑士/胜利点/修路2条/丰收拿2张/垄断一种资源)，买的当回合不能用，每回合最多打1张。最长路≥5段、最大军队≥3骑士各+2分。掷7时手牌>7张弃一半。银行4:1，港口3:1或指定资源2:1。
记号：资源后的数字是点数，括号内为出现权重(6和8=5最高,2和12=1最低)；"分"是程序估算的位置价值，越高越好。
策略：开局抢高权重、资源种类多、互补的点(麦矿利于升城，木砖利于扩张)，第二个村补缺的资源或靠港口；前中期扩张抢点，之后升城与买发展卡；手牌超过7张先花掉；用强盗压领先者和高产地块；拒绝帮助接近胜利的对手；接近胜利时选最快拿分的路线。`;

// ---------------- 调用模型 ----------------
let active = 0;
const waiting = [];
async function slot(fn) {
  if (active >= CFG.concurrency) await new Promise((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    const next = waiting.shift();
    if (next) next();
  }
}

function parseJSON(text) {
  const s = String(text || '')
    .replace(/```(?:json)?/gi, '')
    .trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('模型没有返回 JSON');
  return JSON.parse(s.slice(a, b + 1));
}

// system 默认为卡坦岛的提示词；其他游戏（如猛鬼宿舍）可传入自己的提示词，共用同一套并发控制与用量统计
async function ask(user, maxTokens = 200, system = SYSTEM) {
  return slot(async () => {
    stats.calls++;
    const body = {
      model: CFG.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.3,
      max_tokens: CFG.thinking ? 4096 : maxTokens,
      response_format: { type: 'json_object' },
      thinking: { type: CFG.thinking ? 'enabled' : 'disabled' },
    };
    try {
      const res = await fetch(CFG.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CFG.key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CFG.timeout),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data.error && data.error.message) || `HTTP ${res.status}`);
      const u = data.usage || {};
      stats.promptTokens += u.prompt_tokens || 0;
      stats.completionTokens += u.completion_tokens || 0;
      stats.cachedTokens += (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0;
      const msg = data.choices && data.choices[0] && data.choices[0].message;
      return parseJSON(msg && msg.content);
    } catch (e) {
      stats.errors++;
      stats.lastError = e.name === 'TimeoutError' ? '请求超时' : e.message;
      stats.lastErrorAt = Date.now();
      throw e;
    }
  });
}

// ---------------- 状态描述（尽量短） ----------------
const resText = (r) =>
  RES.filter((k) => r[k])
    .map((k) => `${CN[k]}${r[k]}`)
    .join(' ') || '无';

function tileText(g, t) {
  if (!t.resource) return '沙漠';
  return `${CN[t.resource]}${t.number}(${PIPS[t.number]})${t.id === g.robber ? '[强盗]' : ''}`;
}

function vertexText(g, vid) {
  const v = g.board.vertices[vid];
  const tiles = v.tiles.map((id) => g.board.tiles[id]).filter((t) => t.resource);
  let s = tiles.map((t) => tileText(g, t)).join(' ') || '无产出';
  if (v.port) s += ` 港${v.port === 'any' ? '3:1' : CN[v.port] + '2:1'}`;
  return s;
}

function production(g, pid) {
  const out = { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
  for (const [vid, b] of Object.entries(g.buildings)) {
    if (b.owner !== pid) continue;
    for (const tid of g.board.vertices[vid].tiles) {
      const t = g.board.tiles[tid];
      if (!t.resource || tid === g.robber) continue;
      out[t.resource] += (PIPS[t.number] || 0) * (b.type === 'city' ? 2 : 1);
    }
  }
  return out;
}

function lack(p, cost) {
  const miss = RES.filter((k) => (cost[k] || 0) > p.res[k]).map((k) => `${CN[k]}${cost[k] - p.res[k]}`);
  return miss.length ? '缺' + miss.join('') : '够';
}

function header(g, pid) {
  const p = g.P(pid);
  const dev = {};
  for (const d of p.dev) {
    const k = DEV_CN[d.type] + (d.type !== 'vp' && d.turn >= g.turnCount ? '(新)' : '');
    dev[k] = (dev[k] || 0) + 1;
  }
  const ratios = g.ratios(pid);
  const ports = RES.filter((k) => ratios[k] < 4).map((k) => `${CN[k]}${ratios[k]}:1`);
  const lines = [
    `目标${g.targetVP}分，第${g.turnCount}回合，银行剩${resText(g.bank)}，发展卡剩${g.devDeck.length}`,
    `我:${p.name} ${g.vp(p)}分 手牌:${resText(p.res)} 发展卡:${Object.entries(dev).map(([k, n]) => k + n).join(' ') || '无'} 剩余棋子:路${p.pieces.road}村${p.pieces.settlement}城${p.pieces.city} 港:${ports.join(' ') || '无'} 产出权重:${resText(production(g, pid))} 骑士${p.knights} 路长${p.roadLen}`,
    '对手:' +
      g.players
        .filter((o) => o.id !== pid)
        .map((o) => `${o.name} ${g.vp(o, false)}分 手${sumRes(o.res)} 卡${o.dev.length} 骑${o.knights} 路${o.roadLen}${g.longestRoad === o.id ? '[最长路]' : ''}${g.largestArmy === o.id ? '[最大军队]' : ''}`)
        .join(' | '),
  ];
  return lines.join('\n');
}

const top = (list, score, n) =>
  list
    .map((x) => ({ x, s: score(x) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, n);

// ---------------- 各类决策 ----------------
async function setupSettlement(g, pid) {
  const p = g.P(pid);
  const cands = top(g.legalSettlements(pid, true), (v) => vertexScore(g, v, pid), 8);
  if (!cands.length) return null;
  const mine = Object.entries(g.buildings)
    .filter(([, b]) => b.owner === pid)
    .map(([v]) => vertexText(g, Number(v)));
  const second = mine.length > 0;
  const prompt = [
    `开局放第${second ? 2 : 1}个村庄${second ? '（它周围地块各给1张资源）' : ''}。共${g.players.length}人，你是第${g.setupIdx + 1}个放置。`,
    second ? `已有村庄:${mine.join('；')}` : '',
    '候选:',
    ...cands.map((c) => `v${c.x}:${vertexText(g, c.x)} 分${c.s.toFixed(1)}`),
    '回复{"v":编号数字}',
  ]
    .filter(Boolean)
    .join('\n');
  const r = await ask(prompt, 40);
  const v = Number(String(r.v).replace(/\D/g, ''));
  void p;
  return cands.some((c) => c.x === v) ? { type: 'settlement', vertex: v } : null;
}

function robberCandidates(g, pid) {
  const tiles = g.board.tiles.filter((t) => t.id !== g.robber);
  return top(
    tiles,
    (t) => {
      let s = 0;
      for (const vid of t.vertices) {
        const b = g.buildings[vid];
        if (!b) continue;
        if (b.owner === pid) s -= 30;
        else s += (PIPS[t.number] || 0) * (b.type === 'city' ? 2 : 1) * (1 + g.vp(g.P(b.owner), false) / 4) + (sumRes(g.P(b.owner).res) ? 1 : 0);
      }
      return s;
    },
    6
  );
}

async function robber(g, pid, mem) {
  const cands = robberCandidates(g, pid);
  const desc = (t) => {
    const hit = {};
    for (const vid of t.vertices) {
      const b = g.buildings[vid];
      if (b) hit[b.owner] = (hit[b.owner] || '') + (b.type === 'city' ? '城' : '村');
    }
    const who = Object.entries(hit).map(([o, k]) => {
      const op = g.P(o);
      return o === pid ? `我自己${k}` : `${op.name}(${g.vp(op, false)}分,手${sumRes(op.res)})${k}`;
    });
    return `t${t.id}:${tileText(g, t)} 影响:${who.join(' ') || '无人'}`;
  };
  const prompt = [header(g, pid), '移动强盗到一个地块，并从该地块旁的对手中偷1张牌。候选:', ...cands.map((c) => desc(c.x)), '回复{"t":编号数字,"s":"要偷的玩家名"}'].join('\n');
  const r = await ask(prompt, 60);
  const t = Number(String(r.t).replace(/\D/g, ''));
  if (!cands.some((c) => c.x.id === t)) return null;
  mem.stealName = typeof r.s === 'string' ? r.s : null;
  return { type: 'robber', tile: t };
}

function steal(g, pid, mem) {
  const victims = g.robberVictims(pid, g.robber);
  const want = mem.stealName && victims.find((v) => g.P(v).name === mem.stealName);
  mem.stealName = null;
  return want ? { type: 'steal', victim: want } : null;
}

async function tradeResponse(g, pid) {
  const t = g.trade;
  const p = g.P(pid);
  if (!hasRes(p.res, t.get)) return { type: 'respondTrade', id: t.id, accept: false };
  const from = g.P(t.from);
  const prompt = [header(g, pid), `${from.name}(${g.vp(from, false)}分)提议交易：你得到${resText(t.give)}，你付出${resText(t.get)}。`, `你建城市${lack(p, COST.city)}，建村庄${lack(p, COST.settlement)}，买卡${lack(p, COST.dev)}。`, '回复{"ok":true或false}'].join('\n');
  const r = await ask(prompt, 30);
  return { type: 'respondTrade', id: t.id, accept: r.ok === true || r.ok === 'true' };
}

function roadTargets(g, pid) {
  return top(g.legalRoads(pid), (e) => roadScore(g, e, pid), 5).map((c) => {
    const e = g.board.edges[c.x];
    // 指出这条路通往的最佳空位
    let best = null;
    let bs = -1;
    for (const vid of e.v) {
      const cand = g.vertexFree(vid) ? [vid] : g.board.vertices[vid].adj.filter((a) => g.vertexFree(a));
      for (const v of cand) {
        const s = vertexScore(g, v, pid);
        if (s > bs) {
          bs = s;
          best = v;
        }
      }
    }
    return `e${c.x}${best !== null ? `→v${best}(${vertexText(g, best)})` : ''}`;
  });
}

async function turnPlan(g, pid) {
  const p = g.P(pid);
  const cities = p.pieces.city ? top(g.legalCities(pid), (v) => vertexScore(g, v, null), 4) : [];
  const sets = p.pieces.settlement ? top(g.legalSettlements(pid), (v) => vertexScore(g, v, pid), 4) : [];
  const roads = p.pieces.road ? roadTargets(g, pid) : [];
  const playable = g.devPlayed ? [] : [...new Set(p.dev.filter((d) => d.type !== 'vp' && d.turn < g.turnCount).map((d) => DEV_CN[d.type]))];
  const ratios = g.ratios(pid);
  const lines = [
    header(g, pid),
    '现在是你的回合（已掷骰）。可选行动:',
    `城市:${cities.map((c) => `v${c.x}(${vertexText(g, c.x)})`).join(' ') || '无'} [${lack(p, COST.city)}]`,
    `村庄:${sets.map((c) => `v${c.x}(${vertexText(g, c.x)}) 分${c.s.toFixed(1)}`).join(' ') || '无可建位置'} [${lack(p, COST.settlement)}]`,
    `道路:${roads.join(' ') || '无'} [${lack(p, COST.road)}]`,
    `发展卡:[${lack(p, COST.dev)}]`,
    `银行兑换比例:${RES.map((k) => CN[k] + ratios[k]).join(' ')}`,
    `可打出:${playable.join(' ') || '无'}`,
    '按顺序列出本回合要做的事，资源不足的会被跳过。格式:["城",v]["村",v]["路",e]["卡"]["换",给出资源,换取资源,次数]["骑士"]["丰收",资源,资源]["垄断",资源]["修路"]，资源用木砖羊麦矿。',
    '回复{"a":[...]}，不需要写结束回合。',
  ];
  const r = await ask(lines.join('\n'), 160);
  return Array.isArray(r.a) ? r.a.slice(0, 12).map(toAction).filter(Boolean) : [];
}

const num = (x) => Number(String(x).replace(/\D/g, ''));
function toAction(a) {
  if (!Array.isArray(a) || !a.length) return null;
  const [k, x, y, z] = a;
  switch (String(k)) {
    case '城':
      return { type: 'city', vertex: num(x) };
    case '村':
      return { type: 'settlement', vertex: num(x) };
    case '路':
      return { type: 'road', edge: num(x) };
    case '卡':
      return { type: 'buyDev' };
    case '换':
      return FROM_CN[x] && FROM_CN[y] ? { type: 'bankTrade', give: FROM_CN[x], get: FROM_CN[y], times: Math.max(1, Math.min(4, Number(z) || 1)) } : null;
    case '骑士':
      return { type: 'playDev', card: 'knight' };
    case '丰收':
      return FROM_CN[x] && FROM_CN[y] ? { type: 'playDev', card: 'plenty', res1: FROM_CN[x], res2: FROM_CN[y] } : null;
    case '垄断':
      return FROM_CN[x] ? { type: 'playDev', card: 'monopoly', res1: FROM_CN[x] } : null;
    case '修路':
      return { type: 'playDev', card: 'road' };
  }
  return null;
}

// 给出下一个动作；返回 null 表示这一步交给内置策略
async function decide(g, pid, mem, onAsk = () => {}) {
  if (g.trade && g.trade.from !== pid && g.trade.responses[pid] === 'pending') {
    if (!hasRes(g.P(pid).res, g.trade.get)) return { type: 'respondTrade', id: g.trade.id, accept: false };
    onAsk();
    return tradeResponse(g, pid);
  }
  if (!g.activePlayers().includes(pid)) return null;
  if (g.phase === 'setup') {
    if (g.sub !== 'settlement') return null;
    onAsk();
    return setupSettlement(g, pid);
  }
  switch (g.sub) {
    case 'robber':
      onAsk();
      return robber(g, pid, mem);
    case 'steal':
      return steal(g, pid, mem);
    case 'main': {
      const key = `${g.turnCount}`;
      if (mem.planKey !== key) {
        mem.planKey = key;
        mem.queue = null;
        onAsk();
        mem.queue = await turnPlan(g, pid);
      }
      if (!mem.queue) return null;
      if (mem.queue.length) return mem.queue.shift();
      return { type: 'endTurn' };
    }
  }
  return null;
}

module.exports = { enabled, decide, publicStats, ask, CFG, SYSTEM };
