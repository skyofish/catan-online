// 屏幕层特效：飞行的煤块 / 铁块 / 啤酒桶 / 金币 / 货箱 / 卡牌，横幅、时代切换的过场、彩带。
const layer = () => document.getElementById('fx-layer');
const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const ICON = {
  coal: '<svg viewBox="0 0 20 20"><use href="#i-cube-coal"/></svg>',
  iron: '<svg viewBox="0 0 20 20"><use href="#i-cube-iron"/></svg>',
  beer: '<svg viewBox="0 0 20 20"><use href="#i-beer"/></svg>',
  coin: '<svg viewBox="0 0 20 20"><use href="#i-coin"/></svg>',
  vp: '<svg viewBox="0 0 20 20"><use href="#i-vp"/></svg>',
  card: '<svg viewBox="0 0 20 20"><use href="#i-card"/></svg>',
  crate: '<svg viewBox="0 0 24 24"><use href="#a-sell"/></svg>',
};
export const indIcon = (ind) => `<svg viewBox="0 0 32 32"><use href="#i-${ind}"/></svg>`;

// 沿抛物线从 a 飞到 b
export function fly(kind, a, b, { delay = 0, dur = 750, size = 26, arc = 0.35, html = null, cls = '' } = {}) {
  if (!a || !b) return;
  const el = document.createElement('div');
  el.className = `fly ${cls}`;
  el.style.width = el.style.height = size + 'px';
  el.innerHTML = html || ICON[kind] || indIcon(kind);
  el.style.left = a.x - size / 2 + 'px';
  el.style.top = a.y - size / 2 + 'px';
  el.style.opacity = '0';
  layer().appendChild(el);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lift = -Math.max(40, Math.hypot(dx, dy) * arc);
  setTimeout(() => {
    if (reduce()) {
      el.remove();
      return;
    }
    const anim = el.animate(
      [
        { transform: 'translate(0,0) scale(.6) rotate(0deg)', opacity: 0 },
        { transform: `translate(${dx * 0.5}px, ${dy * 0.5 + lift}px) scale(1.15) rotate(${(Math.random() - 0.5) * 60}deg)`, opacity: 1, offset: 0.5 },
        { transform: `translate(${dx}px, ${dy}px) scale(.85) rotate(0deg)`, opacity: 1 },
      ],
      { duration: dur, easing: 'cubic-bezier(.35,.1,.3,1)', fill: 'forwards' }
    );
    anim.onfinish = () => {
      el.animate([{ opacity: 1, transform: `translate(${dx}px, ${dy}px) scale(.85)` }, { opacity: 0, transform: `translate(${dx}px, ${dy}px) scale(.3)` }], { duration: 180, fill: 'forwards' }).onfinish = () => el.remove();
    };
  }, delay);
}

export function coins(a, b, n = 5, opts = {}) {
  for (let i = 0; i < Math.min(n, 10); i++) fly('coin', a, b, { delay: (opts.delay || 0) + i * 70, dur: 650 + Math.random() * 200, size: 22 });
}

export function floatText(p, text, color = '#fff', { delay = 0, size = 18, cls = '' } = {}) {
  if (!p) return;
  setTimeout(() => {
    const el = document.createElement('div');
    el.className = `float-text ${cls}`;
    el.textContent = text;
    el.style.left = p.x + 'px';
    el.style.top = p.y + 'px';
    el.style.color = color;
    el.style.fontSize = size + 'px';
    layer().appendChild(el);
    setTimeout(() => el.remove(), 1700);
  }, delay);
}

export function burst(p, color = '#f5d26b', n = 14, { spread = 60, size = 6, dur = 700 } = {}) {
  if (!p || reduce()) return;
  for (let i = 0; i < n; i++) {
    const el = document.createElement('i');
    el.className = 'spark';
    el.style.left = p.x + 'px';
    el.style.top = p.y + 'px';
    el.style.width = el.style.height = size * (0.6 + Math.random() * 0.8) + 'px';
    el.style.background = color;
    layer().appendChild(el);
    const a = Math.random() * Math.PI * 2;
    const r = spread * (0.5 + Math.random() * 0.7);
    el.animate([{ transform: 'translate(-50%,-50%) scale(1)', opacity: 1 }, { transform: `translate(calc(-50% + ${Math.cos(a) * r}px), calc(-50% + ${Math.sin(a) * r}px)) scale(.2)`, opacity: 0 }], { duration: dur * (0.7 + Math.random() * 0.6), easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'forwards' }).onfinish = () => el.remove();
  }
}

// 横幅
export function banner(title, sub = '', color = '#c8963e', { big = false, dur = 1900 } = {}) {
  const el = document.createElement('div');
  el.className = `banner ${big ? 'big' : ''}`;
  el.style.setProperty('--bc', color);
  el.innerHTML = `<b>${title}</b>${sub ? `<small>${sub}</small>` : ''}`;
  layer().appendChild(el);
  setTimeout(() => el.classList.add('out'), dur);
  setTimeout(() => el.remove(), dur + 500);
}

// 时代切换过场：大字标题 + 一列蒸汽火车（或运河船）横穿屏幕
export function eraCinematic(title, sub, era = 'rail') {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = `era-cine ${era}`;
    el.innerHTML = `<div class="ec-sky"></div>
      <div class="ec-title"><small>${era === 'rail' ? '1830 — 1870' : '1770 — 1830'}</small><b>${title}</b><span>${sub}</span></div>
      <div class="ec-ground"></div>
      <div class="ec-runner">${
        era === 'rail'
          ? `<svg viewBox="0 0 220 70"><g transform="translate(220 0) scale(-1 1)"><g fill="#1a110d"><rect x="20" y="22" width="80" height="28" rx="3"/><rect x="86" y="8" width="26" height="42" rx="2"/><rect x="34" y="6" width="12" height="18"/><path d="M8 50h108l6 6H2z"/><rect x="128" y="24" width="84" height="26" rx="3"/></g><g fill="#2d221c"><circle cx="36" cy="56" r="10"/><circle cx="62" cy="56" r="10"/><circle cx="96" cy="58" r="8"/><circle cx="150" cy="58" r="7"/><circle cx="192" cy="58" r="7"/></g><g fill="#ffcf6b"><rect x="92" y="14" width="14" height="10" rx="1"/><rect x="140" y="30" width="12" height="8"/><rect x="160" y="30" width="12" height="8"/><rect x="180" y="30" width="12" height="8"/></g></g></svg>`
          : `<svg viewBox="0 0 220 70"><path d="M10 44h190l-14 14H24z" fill="#5a3418"/><rect x="40" y="26" width="100" height="18" rx="2" fill="#7a2f22"/><rect x="146" y="20" width="8" height="24" fill="#3a2a1a"/><path d="M0 64c20-6 40-6 60 0s40 6 60 0 40-6 60 0 30 6 40 0" stroke="#9cc6e8" stroke-width="3" fill="none"/></svg>`
      }</div>
      <div class="ec-steam"></div>`;
    layer().appendChild(el);
    if (era === 'rail' && !reduce()) {
      const st = el.querySelector('.ec-steam');
      for (let i = 0; i < 18; i++) {
        const p = document.createElement('i');
        p.style.animationDelay = i * 0.12 + 's';
        st.appendChild(p);
      }
    }
    const total = reduce() ? 1500 : 3600;
    setTimeout(() => el.classList.add('out'), total);
    setTimeout(() => {
      el.remove();
      resolve();
    }, total + 600);
  });
}

export function shake(elm = document.getElementById('board-wrap'), cls = 'shake') {
  if (!elm || reduce()) return;
  elm.classList.remove(cls);
  void elm.offsetWidth;
  elm.classList.add(cls);
  setTimeout(() => elm.classList.remove(cls), 600);
}

export function confetti(colors) {
  if (reduce()) return;
  const root = layer();
  for (let i = 0; i < 140; i++) {
    const el = document.createElement('i');
    el.className = 'confetti';
    el.style.left = Math.random() * 100 + 'vw';
    el.style.background = colors[i % colors.length];
    el.style.width = 6 + Math.random() * 6 + 'px';
    el.style.height = 8 + Math.random() * 10 + 'px';
    root.appendChild(el);
    const dur = 2400 + Math.random() * 2000;
    el.animate(
      [
        { transform: `translate(0, -20px) rotate(0deg)`, opacity: 1 },
        { transform: `translate(${(Math.random() - 0.5) * 300}px, ${window.innerHeight + 40}px) rotate(${Math.random() * 1080}deg)`, opacity: 0.9 },
      ],
      { duration: dur, delay: Math.random() * 800, easing: 'cubic-bezier(.2,.6,.4,1)', fill: 'forwards' }
    ).onfinish = () => el.remove();
  }
}

// 烟花（胜利）
export function fireworks(colors, n = 6) {
  if (reduce()) return;
  for (let k = 0; k < n; k++) {
    setTimeout(() => {
      const p = { x: window.innerWidth * (0.2 + Math.random() * 0.6), y: window.innerHeight * (0.15 + Math.random() * 0.35) };
      burst(p, colors[k % colors.length], 26, { spread: 120, size: 6, dur: 1200 });
      burst(p, '#fff3c4', 10, { spread: 60, size: 4, dur: 900 });
    }, k * 380);
  }
}

export function pulse(elm, cls = 'pulse') {
  if (!elm) return;
  elm.classList.remove(cls);
  void elm.offsetWidth;
  elm.classList.add(cls);
  setTimeout(() => elm.classList.remove(cls), 1200);
}

export function center(elm) {
  if (!elm) return null;
  const r = elm.getBoundingClientRect();
  if (!r.width && !r.height) return null;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
