'use strict';
// 猛鬼宿舍的智谱 AI 玩家：与卡坦岛共用同一个智谱接口（并发、超时与用量统计都在 catan/ai.js）。
// 实时游戏不适合每一步都问模型，所以模型每隔约 20 秒定一次「侧重」（经济 / 防守 / 输出 / 均衡），
// 具体买什么、放哪里仍由内置策略按这个侧重来算；模型还会顺便说一句台词。出错或超时就保持原来的侧重。
const zhipu = require('../catan/ai');
const { BUILD, GEOM } = require('./config');
const { candidates } = require('./bot');

const SYSTEM = `你在玩塔防游戏「猛鬼宿舍」，是一名躺在宿舍床上的学生。只输出JSON，不要解释。
规则：床每秒产金币，升级床收入更高；门挡住猛鬼，门破后猛鬼攻击床，床毁即出局。宿舍里可造：桃木弩(自动射击)、天雷符(高伤慢速)、寒冰棺(减速)、照妖镜(反伤)、符水台(修门)、发电机(产电，高级升级要电)。
猛鬼每隔一段时间升级，伤害和护甲越来越高，血少时回血池回血。坚持到倒计时结束即胜利。
策略：前期先造一两个弩，然后尽快升床滚经济；被盯上时优先升门、修门；猛鬼护甲高时低级弩没用，要升级；电力不够时造发电机。
可选侧重：eco(升床攒钱) def(门/修门/减速) atk(弩/天雷/反伤) bal(均衡)。`;

const FOCUS = { eco: { eco: 1.7 }, def: { def: 1.7 }, atk: { atk: 1.7 }, bal: {} };
const KIND_CN = { eco: '升床', def: '升门', ...Object.fromEntries(Object.entries(BUILD).map(([k, b]) => [k, b.name])) };

function describe(g, pid) {
  const p = g.P(pid);
  const r = g.roomOf(p);
  const gh = g.ghost;
  const geo = GEOM[r.i];
  const others = g.players
    .filter((x) => x.id !== pid && x.alive && x.room !== null)
    .map((x) => {
      const o = g.rooms[x.room];
      return `${x.room + 1}号床${o.bed.lv}门${o.door.lv}`;
    })
    .join('，');
  const top = candidates(g, pid)
    .sort((a, b) => b.value - a.value)
    .slice(0, 5)
    .map((c) => `${KIND_CN[c.kind] || c.kind}(${c.c.g || 0}金${c.c.e ? '+' + c.c.e + '电' : ''})`)
    .join('、');
  const target = gh.target === r.i ? '正在打你' : gh.state === 'heal' ? '在血池回血' : gh.state === 'retreat' ? '正逃回血池' : gh.target === null ? '游荡' : `在打${gh.target + 1}号房`;
  return `剩余${Math.round(g.timeLeft())}秒。猛鬼${gh.lv}级 血${Math.round((gh.hp / gh.max) * 100)}% 每击${g.ghostDmg()} 护甲${Math.round(g.armor())}，${target}。
你：${r.i + 1}号房 金币${Math.floor(p.gold)} 电${Math.floor(p.energy)} 床${r.bed.lv}级(每秒${g.income(p)}) 门${r.door.lv}级 ${Math.round(r.door.hp)}/${r.door.max} 门口火力${Math.round(g.dpsAt(geo.atkDoor))}/秒 空格${r.cells.filter((c, i) => !c && !geo.bedCells.includes(i)).length}。
队友：${others || '无'}。程序推荐：${top || '无'}。
回答{"focus":"eco|def|atk|bal","say":"不超过14个字的台词"}`;
}

async function strategy(g, pid) {
  const res = await zhipu.ask(describe(g, pid), 80, SYSTEM);
  const focus = FOCUS[res && res.focus] ? res.focus : 'bal';
  const say = String((res && res.say) || '')
    .replace(/[\u0000-\u001f<>]/g, '')
    .trim()
    .slice(0, 20);
  return { focus, weights: FOCUS[focus], say };
}

module.exports = { enabled: zhipu.enabled, strategy, FOCUS, describe };
