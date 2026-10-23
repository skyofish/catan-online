// 新手教程：导师老约翰一步步带你打完第一局的前几轮。
// 服务器给教程房间准备了固定开局（你的手牌、商人），这里只负责引导：
// 遮罩 + 聚光灯指向要点的地方，气泡里讲解，可选语音朗读（智谱 GLM-TTS，没配置时用浏览器自带的中文语音）。
// 每一步要么点「下一步」，要么等你完成指定操作（根据对局状态和事件判断），走偏了也能自动接上。
import { sound } from './audio.js';
import { speaker } from './speech.js';

const LS = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};
const $ = (s, r = document) => r.querySelector(s);

export class Coach {
  constructor() {
    this.active = false;
    this.idx = 0;
    this.narrateOn = LS.get('brass.narrate', true);
    this.root = null;
    this.timer = null;
  }
  setNarrate(on) {
    this.narrateOn = on;
    LS.set('brass.narrate', on);
    if (!on) speaker.stop();
  }

  attach(S, api) {
    this.S = S;
    this.api = api;
    this.steps = buildSteps(S, api);
    const saved = sessionStorage.getItem('brass.tutorial.' + S.gameId);
    this.idx = saved ? Math.min(Number(saved) || 0, this.steps.length - 1) : 0;
    this.active = true;
    this.root = $('#coach-root');
    this.lastEvents = [];
    this.show();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.place(), 250);
  }
  stop() {
    if (!this.active) return;
    this.active = false;
    clearInterval(this.timer);
    if (this.root) this.root.innerHTML = '';
    speaker.stop();
  }

  // 对局状态变化
  onUpdate(events) {
    if (!this.active) return;
    this.lastEvents = events || [];
    // 状态刷新后再判断（让地图先画好）
    setTimeout(() => this.check(), 60);
  }
  onFlow() {
    if (!this.active) return;
    setTimeout(() => this.check(), 30);
  }

  ctx() {
    const S = this.S;
    const g = S.game;
    return {
      S,
      g,
      events: this.lastEvents,
      flow: S.flow,
      myTurn: !!(g && g.turn === S.you && g.me && g.phase !== 'ended'),
      mine: (type) => this.lastEvents.some((e) => e.type === type && e.pid === S.you),
      anyMine: () => this.lastEvents.some((e) => e.type === 'action' && e.pid === S.you),
    };
  }

  check() {
    if (!this.active) return;
    const st = this.steps[this.idx];
    if (!st) return;
    const c = this.ctx();
    if (st.done && st.done(c)) return this.go(this.idx + 1);
    // 做了别的行动：跳到这一组之后
    if (st.expect && c.anyMine() && !c.mine(st.expect)) {
      const to = this.steps.findIndex((s, i) => i > this.idx && s.id === st.after);
      this.toast('也可以！我们接着往下看。');
      return this.go(to > 0 ? to : this.idx + 1);
    }
    // 取消了面板：回到这一组的开头
    if (st.back !== undefined && !c.flow) {
      const to = this.steps.findIndex((s) => s.id === st.back);
      if (to >= 0 && to !== this.idx) return this.go(to);
    }
    this.place();
  }

  go(i) {
    this.idx = Math.max(0, Math.min(i, this.steps.length));
    sessionStorage.setItem('brass.tutorial.' + this.S.gameId, String(this.idx));
    this.lastEvents = [];
    if (this.idx >= this.steps.length) return this.finish();
    this.show();
    // 新的一步可能已经满足
    setTimeout(() => this.check(), 80);
  }

  finish() {
    this.stop();
    sessionStorage.setItem('brass.tutorial.' + this.S.gameId, String(this.steps.length));
  }

  toast(text) {
    const t = document.createElement('div');
    t.className = 'toast good';
    t.textContent = text;
    $('#toast-root').appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }

  show() {
    const st = this.steps[this.idx];
    if (!st || !this.root) return;
    const c = this.ctx();
    const text = typeof st.text === 'function' ? st.text(c) : st.text;
    this.root.innerHTML = `<div class="coach-spot" hidden></div>
      <div class="coach-bubble ${st.wait ? '' : 'waiting'}" role="dialog" aria-live="polite">
        <svg class="coach-face" viewBox="0 0 64 64" aria-hidden="true"><use href="#mentor"/></svg>
        <div class="coach-body">
          <div class="coach-step">新手教程 ${this.idx + 1} / ${this.steps.length}</div>
          <div class="coach-text">${text}</div>
          <div class="coach-btns">
            <button class="mini ghost" data-c="skip">结束教程</button>
            <button class="mini ghost" data-c="voice" title="语音讲解">${this.narrateOn ? '🔊' : '🔇'}</button>
            ${this.idx > 0 && st.wait ? '<button class="mini ghost" data-c="prev">上一步</button>' : ''}
            ${st.wait ? `<button class="mini primary" data-c="next">${this.idx === this.steps.length - 1 ? '开始自由游戏' : '下一步'}</button>` : `<span class="coach-wait">${st.waitText || '请按提示操作'}</span>`}
          </div>
        </div>
      </div>`;
    this.root.querySelector('[data-c="skip"]').onclick = () => this.finish();
    this.root.querySelector('[data-c="voice"]').onclick = (e) => {
      this.setNarrate(!this.narrateOn);
      e.target.textContent = this.narrateOn ? '🔊' : '🔇';
      if (this.narrateOn) this.say(text);
    };
    const nx = this.root.querySelector('[data-c="next"]');
    if (nx) nx.onclick = () => (sound.play('click'), this.go(this.idx + 1));
    const pv = this.root.querySelector('[data-c="prev"]');
    if (pv) pv.onclick = () => this.go(this.prevWaitStep());
    if (st.onShow) st.onShow(c);
    sound.play('coach');
    this.say(text);
    this.place();
    // 预先生成下一步的语音，翻页时不用等
    const nxt = this.steps[this.idx + 1];
    if (this.narrateOn && nxt && typeof nxt.text === 'string') speaker.prefetch(nxt.text, { role: 'mentor' });
  }
  prevWaitStep() {
    for (let i = this.idx - 1; i >= 0; i--) if (this.steps[i].wait) return i;
    return 0;
  }

  say(html) {
    if (!this.narrateOn) return;
    speaker.speak(html, { role: 'mentor', interrupt: true });
  }

  // 聚光灯与气泡位置
  place() {
    if (!this.active || !this.root) return;
    const st = this.steps[this.idx];
    const spot = this.root.querySelector('.coach-spot');
    const bub = this.root.querySelector('.coach-bubble');
    if (!spot || !bub) return;
    let el = null;
    try {
      el = st.target ? st.target(this.ctx()) : null;
    } catch {
      el = null;
    }
    const r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (!r || (!r.width && !r.height) || r.bottom < 0 || r.top > vh) {
      spot.hidden = true;
      bub.classList.add('center');
      bub.style.left = bub.style.top = '';
      return;
    }
    const pad = st.pad ?? 8;
    spot.hidden = false;
    spot.style.left = r.left - pad + 'px';
    spot.style.top = r.top - pad + 'px';
    spot.style.width = r.width + pad * 2 + 'px';
    spot.style.height = r.height + pad * 2 + 'px';
    spot.classList.toggle('dimless', !!st.noDim);
    bub.classList.remove('center');
    const bw = bub.offsetWidth;
    const bh = bub.offsetHeight;
    // 优先放在目标下方，其次上方，再其次左右
    let x = Math.min(vw - bw - 10, Math.max(10, r.left + r.width / 2 - bw / 2));
    let y;
    if (r.bottom + pad + 14 + bh < vh) y = r.bottom + pad + 14;
    else if (r.top - pad - 14 - bh > 0) y = r.top - pad - 14 - bh;
    else {
      y = Math.max(10, Math.min(vh - bh - 10, r.top + r.height / 2 - bh / 2));
      x = r.right + 16 + bw < vw ? r.right + 16 : Math.max(10, r.left - 16 - bw);
    }
    // 别挡住确认面板
    const sh = document.querySelector('#sheet');
    if (sh && !sh.hidden) {
      const sr = sh.getBoundingClientRect();
      const hit = !(x + bw < sr.left || x > sr.right || y + bh < sr.top || y > sr.bottom);
      if (hit) {
        if (sr.top - bh - 12 > 0) y = sr.top - bh - 12;
        else if (sr.left - bw - 12 > 0) x = sr.left - bw - 12;
        else y = 8;
      }
    }
    bub.style.left = x + 'px';
    bub.style.top = y + 'px';
  }
}

// ---------- 教程脚本 ----------
function buildSteps(S, api) {
  const { board } = api;
  const q = (s) => () => document.querySelector(s);
  const slot = (loc, s) => () => board.tileEls && board.tileEls[`${loc}:${s}`] ? board.tileEls[`${loc}:${s}`] : board.slotEls[`${loc}:${s}`];
  const focus = (loc, w = 560) => () => {
    const L = board.locById[loc] || board.merchById[loc];
    if (L) board.focusOn(L.x, L.y + 60, w);
  };
  const myTurn = (c) => c.myTurn;
  return [
    {
      id: 'hello',
      wait: true,
      text: '欢迎来到 1770 年的伯明翰！我是老约翰，这一局我陪你走一遍。<br>这是一个关于<b>工业革命</b>的游戏：你要在英格兰中部开工厂、修运河和铁路，把货卖到远方。',
      onShow: () => board.fit(),
    },
    {
      wait: true,
      text: '游戏分两个时代：先是<b>运河时代</b>，然后是<b>铁路时代</b>。<br>每个时代结束时，<b>翻过面的工厂</b>和<b>你修的线路</b>都会计分。两个时代后分数最高的人获胜。',
    },
    {
      wait: true,
      target: q('#era-chip'),
      text: '这里是当前时代、轮数和牌堆。每一轮每人有 <b>2 个行动</b>（运河时代第 1 轮只有 1 个）。<b>每个行动都要弃一张手牌</b>，所以牌用完，时代就结束了。',
    },
    {
      wait: true,
      target: q('#players'),
      text: '这是各位工厂主：<b>分数</b>、<b>现金 £</b> 和 <b>收入等级</b>。每轮结束时，按收入等级领钱——收入就是你的发动机。<br>本轮<b>花钱最少</b>的人，下一轮先行动。',
    },
    {
      wait: true,
      target: q('#hand'),
      text: '这是你的手牌。<b>地点牌</b>（写着城镇名）可以在那个城镇建造；<b>产业牌</b>可以在你网络内任何能放这种产业的地方建造。',
    },
    {
      wait: true,
      target: q('#btn-mat'),
      text: '「产业板」上是你还没建的工厂，每种从<b>Ⅰ级</b>开始建。点开能看到每块板块的造价、分数和收入。',
    },
    // —— 第 1 轮：建棉纺厂 ——
    {
      id: 'b1',
      target: q('[data-act="build"]'),
      text: '第一个行动：用「伯明翰」地点牌，在伯明翰建一座<b>棉纺厂</b>。先点下面的「建造」。',
      waitText: '点「建造」',
      done: (c) => c.flow && c.flow.kind === 'build',
      expect: 'build',
      after: 'b1done',
      onShow: focus('birmingham'),
    },
    {
      target: slot('birmingham', 0),
      text: '地图上发光的格子都能建。点伯明翰左上角那个<b>棉纺 / 制造</b>格子。',
      waitText: '点伯明翰的格子',
      done: (c) => c.flow && c.flow.at,
      back: 'b1',
      expect: 'build',
      after: 'b1done',
      onShow: focus('birmingham', 460),
    },
    {
      target: q('#sheet .sheet-in'),
      pad: 4,
      noDim: true,
      text: '选「棉纺厂」，用「伯明翰」这张牌。Ⅰ级棉纺厂造价 <b>£12</b>，不需要煤和铁。点「确认建造」。',
      waitText: '确认建造',
      done: (c) => c.mine('build'),
      back: 'b1',
      expect: 'build',
      after: 'b1done',
    },
    {
      id: 'b1done',
      wait: true,
      target: slot('birmingham', 0),
      text: '工厂建好了！不过它还<b>没翻面</b>：棉纺厂要把货<b>卖给商人</b>才会翻面。翻面后收入上升，时代结束时还能计分。',
    },
    {
      target: q('#players'),
      text: '现在轮到我（导师）行动了。注意看行动顺序：你这一轮花了 £12，我花得少，所以下一轮我先行动。',
      waitText: '等待导师行动…',
      done: (c) => c.myTurn && c.g.round >= 2,
    },
    // —— 第 2 轮：贷款 + 修运河 ——
    {
      id: 'loan',
      target: q('[data-act="loan"]'),
      text: '第 2 轮，你有 2 个行动。可你只剩 £5 了——先<b>贷款</b>拿 £30。代价是收入等级降 3 级。点「贷款」。',
      waitText: '点「贷款」',
      done: (c) => (c.flow && c.flow.kind === 'loan') || c.mine('loan'),
      expect: 'loan',
      after: 'net',
    },
    {
      target: q('#sheet .sheet-in'),
      pad: 4,
      noDim: true,
      text: '每个行动都要弃一张牌。贷款用不到牌面，挑一张最没用的弃掉就行（比如「炼铁厂」）。点「确认贷款」。',
      waitText: '确认贷款',
      done: (c) => c.mine('loan'),
      back: 'loan',
      expect: 'loan',
      after: 'net',
    },
    {
      id: 'net',
      target: q('[data-act="network"]'),
      text: '有钱了！第二个行动：修一段<b>运河</b>，把伯明翰连到<b>牛津</b>的商人。点「网络」。',
      waitText: '点「网络」',
      done: (c) => (c.flow && c.flow.kind === 'network') || c.mine('link'),
      expect: 'link',
      after: 'netdone',
      onShow: focus('birmingham', 700),
    },
    {
      target: () => board.routeEls['birmingham-oxford'],
      pad: 14,
      text: '发光的是能修的运河。点<b>伯明翰—牛津</b>这一段。',
      waitText: '点伯明翰—牛津运河',
      done: (c) => (c.flow && c.flow.link) || c.mine('link'),
      back: 'net',
      expect: 'link',
      after: 'netdone',
      onShow: () => board.focusOn(1110, 980, 640),
    },
    {
      target: q('#sheet .sheet-in'),
      pad: 4,
      noDim: true,
      text: '运河造价 <b>£3</b>。再弃一张牌，点「确认修建」。',
      waitText: '确认修建',
      done: (c) => c.mine('link'),
      back: 'net',
      expect: 'link',
      after: 'netdone',
    },
    {
      id: 'netdone',
      wait: true,
      target: () => board.merchEls.oxford.g,
      text: '这是<b>牛津</b>的商人：方框里的图标是他收购的货物（棉布和制成品），下面的小酒桶是商人的啤酒。现在伯明翰连到了牛津，你的棉纺厂可以把货卖过去了。',
      onShow: () => board.focusOn(1150, 1040, 660),
    },
    {
      wait: true,
      text: '顺便说一句：时代结束时，<b>每段线路</b>按两端城镇的「↔」图标计分——翻面的工厂才有图标，商人算 2 个。所以把线路修在热闹的地方很划算。',
    },
    {
      target: q('#players'),
      text: '回合结束。每轮结束按收入等级领钱：你贷了款，收入是负的，要<b>付</b>钱。等导师行动完就轮到你。',
      waitText: '等待导师行动…',
      done: (c) => c.myTurn && c.g.round >= 3,
    },
    // —— 第 3 轮：出售 + 建煤矿 ——
    {
      id: 'sell',
      target: q('[data-act="sell"]'),
      text: '现在<b>出售</b>！卖货需要啤酒，牛津商人正好有一桶。点「出售」。',
      waitText: '点「出售」',
      done: (c) => (c.flow && c.flow.kind === 'sell') || c.mine('sell'),
      expect: 'sell',
      after: 'selldone',
      onShow: focus('birmingham', 600),
    },
    {
      target: q('#sheet .sheet-in'),
      pad: 4,
      noDim: true,
      text: '你的棉纺厂已经选中（地图上打了勾）。<b>喝商人的啤酒</b>还有奖励：牛津的奖励是收入 +2。点「出售」。',
      waitText: '确认出售',
      done: (c) => c.mine('sell'),
      back: 'sell',
      expect: 'sell',
      after: 'selldone',
    },
    {
      id: 'selldone',
      wait: true,
      target: slot('birmingham', 0),
      text: '<b>翻面成功！</b>工厂翻过来后收入大涨，时代结束时这座棉纺厂会计 5 分，还给相邻线路提供 1 个图标。这就是赚分的主要方式：<b>建造 → 连到商人 → 出售翻面</b>。',
      onShow: focus('birmingham', 460),
    },
    {
      id: 'coal',
      target: q('[data-act="build"]'),
      text: '最后一个行动：用「考文垂」地点牌，在考文垂建一座<b>煤矿</b>（£5）。点「建造」。',
      waitText: '点「建造」',
      done: (c) => (c.flow && c.flow.kind === 'build') || c.mine('build'),
      expect: 'build',
      after: 'coaldone',
      onShow: focus('coventry'),
    },
    {
      target: slot('coventry', 1),
      text: '点考文垂中间那个<b>制造 / 煤矿</b>格子。',
      waitText: '点考文垂的格子',
      done: (c) => (c.flow && c.flow.at) || c.mine('build'),
      back: 'coal',
      expect: 'build',
      after: 'coaldone',
      onShow: focus('coventry', 460),
    },
    {
      target: q('#sheet .sheet-in'),
      pad: 4,
      noDim: true,
      text: '选「煤矿」，用「考文垂」这张牌，点「确认建造」。',
      waitText: '确认建造',
      done: (c) => c.mine('build'),
      back: 'coal',
      expect: 'build',
      after: 'coaldone',
    },
    {
      id: 'coaldone',
      wait: true,
      target: () => board.svg.querySelector('.market'),
      text: '煤矿上的黑色方块就是<b>煤</b>。别人建需要煤的工厂（或修铁路）时，会从<b>连通的最近煤矿</b>免费拿煤——煤被拿光，煤矿就翻面，收入归矿主。<br>没有煤矿可用时，要从右边的<b>市场</b>买，而且建造地点得连到商人。铁也一样，只是炼铁厂的铁不需要连通。',
      onShow: () => board.focusOn(1400, 600, 640),
    },
    {
      wait: true,
      text: '还有几个要点：<br>· <b>开发</b>：花铁把产业板上的低级板块移除，让高级工厂登场；<br>· <b>运河时代结束</b>会拆掉所有运河和Ⅰ级工厂，铁路时代要靠Ⅱ级以上的工厂；<br>· 右上角「?」随时查看规则，「提示」按钮会让我帮你出主意。',
      onShow: () => board.fit(),
    },
    {
      wait: true,
      target: q('.act-btn.hint-btn'),
      text: '接下来就交给你了，这一局会完整打完。拿不准的时候点「提示」。祝你成为伯明翰的工业大亨！',
    },
  ];
}
