'use strict';
// 雾夜追猎的智谱 AI 玩家：与卡坦岛共用同一个智谱接口（并发、超时与用量统计都在 catan/ai.js）。
// 实时游戏不适合每一步都问模型：模型每隔约 20 秒按局势定一次"侧重"并说一句台词，
// 走位、翻窗、放板、出刀这些细节由内置的"大神"电脑按这个侧重来执行。出错或超时就保持原来的侧重。
const zhipu = require('../catan/ai');
const { RULES: R, SURVIVORS, HUNTERS } = require('./data');

const SYSTEM = `你在玩非对称对抗游戏「雾夜追猎」：1名追猎者对4名求生者。只输出JSON，不要解释。
求生者：修好5台发报机给大门通电，再去电闸开门逃走；被打两下会倒地，被关进铁笼后要队友来救，笼中时间满了就淘汰（第二次进笼从一半开始，第三次直接淘汰）。3人以上逃脱求生者胜，2人平局。
追猎者：打倒求生者、扛起来关进铁笼直到淘汰。
求生者可选侧重：decode(专心修机，少管别的) rescue(优先救笼里的人) heal(优先治疗队友) safe(离追猎者更远，稳一点)。
追猎者可选侧重：chase(追最近或受伤的人) decoder(优先打正在修机的人) guard(关人后在铁笼附近守着)。`;

const S_FOCUS = ['decode', 'rescue', 'heal', 'safe'];
const H_FOCUS = ['chase', 'decoder', 'guard'];
const ST = { ok: '正常', down: '倒地', carried: '被扛着', caged: '在笼中', escaped: '已逃脱', dead: '已淘汰' };

function describe(g, pid) {
  const p = g.P(pid);
  const h = g.hunter;
  const d = (a, b) => Math.round(Math.hypot(a.x - b.x, a.z - b.z));
  const ms = g.machines.filter((m) => !m.done).map((m) => Math.round(m.p * 100) + '%').join(' ');
  const team = g.survivors
    .map((s) => `${SURVIVORS[s.char].short}${s === p ? '(你)' : ''}:${ST[s.st]}${s.st === 'ok' && s.hp === 1 ? '受伤' : ''}${s.st === 'caged' ? `笼${Math.round((s.cageT / R.cageTime) * 100)}%` : ''}${p.role === 'hunter' || s === p ? '' : `距你${d(p, s)}米`}`)
    .join('，');
  const head = `已过${Math.round(g.t)}秒。还需修${Math.max(0, R.machinesNeed - g.doneCount())}台，未修好的进度：${ms || '无'}。${g.powered ? '大门已通电！' : ''}${g.hatch.open ? '地窖已开。' : ''}`;
  if (p.role === 'hunter') return `${head}\n你是追猎者「${HUNTERS[p.char].name}」。求生者：${team}。\n回答{"focus":"chase|decoder|guard","say":"不超过14个字的台词"}`;
  return `${head}\n你是求生者「${SURVIVORS[p.char].short}」(${SURVIVORS[p.char].tag})，${ST[p.st]}${p.hp === 1 ? '受伤' : ''}。追猎者距你${h ? d(p, h) : '?'}米${h && h.carrying ? '，正扛着人' : ''}。队伍：${team}。\n回答{"focus":"decode|rescue|heal|safe","say":"不超过14个字的台词"}`;
}

async function strategy(g, pid) {
  const p = g.P(pid);
  const res = await zhipu.ask(describe(g, pid), 80, SYSTEM);
  const list = p.role === 'hunter' ? H_FOCUS : S_FOCUS;
  const focus = list.includes(res && res.focus) ? res.focus : list[0];
  const say = String((res && res.say) || '')
    .replace(/[\u0000-\u001f<>]/g, '')
    .trim()
    .slice(0, 20);
  return { focus, weights: { [focus]: 1 }, say };
}

module.exports = { enabled: zhipu.enabled, strategy, describe };
