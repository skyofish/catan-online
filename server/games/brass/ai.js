'use strict';
// 工业革命：伯明翰的智谱 AI 玩家：与卡坦岛共用同一个智谱接口（并发、超时与用量统计都在 catan/ai.js）。
// 程序先用内置策略算出合法且排好序的候选行动（附带估值），模型只负责从前几名里挑一个，
// 顺便说一句台词。回答无效、超时或出错时由内置策略决定，对局不会卡住。
const zhipu = require('../catan/ai');
const D = require('./data');
const { scoreCandidates } = require('./bot');
const { tileName, cardName } = require('./game');

const SYSTEM = `你在玩桌游「工业革命：伯明翰」(Brass: Birmingham)，目标是两个时代结束时分数最高。只输出JSON，不要解释。
规则要点：每回合2个行动(运河时代第1轮1个)，每个行动弃1张牌。行动：建造(地点牌在该城建，产业牌在自己网络内建)、修网络(运河£3；铁路£5+1煤，两段£15+2煤+1啤酒)、开发(花铁移除产业板上低级板块)、出售(棉纺/制造/陶瓷连到收购的商人，喝啤酒，翻面)、贷款(+£30，收入降3级)、侦察、跳过。
工厂翻面后收入上升，时代结束时翻面工厂计分；线路按两端地点的图标计分。运河时代结束拆掉运河和Ⅰ级工厂。本轮花钱少的下轮先行动。
策略：前期建棉纺/制造并尽快连到商人出售换收入；缺钱时贷款；酿酒厂和煤矿要放在别人会用的地方；运河时代后期把板块升级到Ⅱ级以上；铁路时代多修线路连到高分城市；最后一两轮把钱全换成分。`;

const placeName = (id) => D.PLACE_NAME[id] || id;

function describeAction(g, pid, c) {
  const a = c.a;
  const p = g.P(pid);
  const card = a.card ? p.hand.find((x) => x.id === a.card) : null;
  const cn = card ? `弃「${cardName(card)}」` : '';
  switch (a.type) {
    case 'build':
      return `在${placeName(a.loc)}建${tileName(a.ind, g.matTop(p, a.ind))}(£${c.info ? c.info.cost : '?'})${cn}`;
    case 'network':
      return `修${g.era === 'canal' ? '运河' : '铁路'} ${a.links.map((id) => D.linkEnds(D.LINK_BY_ID[id]).map(placeName).join('-')).join('、')}${cn}`;
    case 'develop':
      return `开发 ${a.inds.map((x) => tileName(x, g.matTop(p, x))).join('、')}${cn}`;
    case 'sell':
      return `出售 ${a.sales.map((s) => placeName(s.loc)).join('、')} 的货${cn}`;
    case 'loan':
      return `贷款£30${cn}`;
    case 'scout':
      return '侦察(弃3张换万能牌)';
    default:
      return `跳过${cn}`;
  }
}

function describe(g, pid, list) {
  const p = g.P(pid);
  const others = g.players
    .filter((x) => x.id !== pid)
    .map((x) => `${x.name}:${x.vp}分 收入${g.level(x)} £${x.money}`)
    .join('；');
  const mine = [];
  g.forTiles((t, loc) => t.owner === pid && mine.push(`${placeName(loc)}${tileName(t.ind, t.lv)}${t.flipped ? '(已翻面)' : ''}`));
  const opts = list.map((c, i) => `${i}. ${describeAction(g, pid, c)} [估值${c.score.toFixed(1)}]`).join('\n');
  return `${g.era === 'canal' ? '运河' : '铁路'}时代第${g.round}轮，本时代约剩${g.roundsLeft()}轮，你还有${g.actionsLeft}个行动。
你：${p.vp}分 £${p.money} 收入等级${g.level(p)} 手牌${p.hand.length}张。你的工厂：${mine.join('、') || '无'}。
对手：${others}。
候选行动（程序估值越高越好）：
${opts}
回答{"pick":序号,"say":"不超过14个字的台词"}`;
}

async function decide(g, pid) {
  const list = scoreCandidates(g, pid, 'normal').slice(0, 6);
  if (!list.length) return null;
  const res = await zhipu.ask(describe(g, pid, list), 80, SYSTEM);
  const i = Number(res && res.pick);
  const pick = Number.isInteger(i) && list[i] ? list[i] : list[0];
  const say = String((res && res.say) || '')
    .replace(/[\u0000-\u001f<>]/g, '')
    .trim()
    .slice(0, 20);
  return { action: pick.a, say };
}

module.exports = { enabled: zhipu.enabled, decide, describe };
