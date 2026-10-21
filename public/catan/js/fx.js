// 动画效果：飞牌、骰子、横幅、粒子、彩带等。
const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const layer = () => document.getElementById('fx-layer');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export function cardHTML(kind, extraClass = '') {
  if (kind === 'back') return `<div class="card back ${extraClass}"><span>?</span></div>`;
  if (kind.startsWith('dev:')) {
    const t = kind.slice(4);
    return `<div class="card dev dev-${t} ${extraClass}"><svg viewBox="0 0 32 32"><use href="#d-${t}"/></svg></div>`;
  }
  return `<div class="card res res-${kind} ${extraClass}"><svg viewBox="0 0 32 32"><use href="#i-${kind}"/></svg></div>`;
}

function make(html) {
  const d = document.createElement('div');
  d.innerHTML = html.trim();
  const n = d.firstChild;
  layer().appendChild(n);
  return n;
}

// 卡牌沿弧线从 a 飞到 b
export function flyCard(kind, a, b, { delay = 0, dur = 750, scale = 0.9 } = {}) {
  if (!a || !b) return Promise.resolve();
  const n = make(cardHTML(kind, 'flying'));
  const w = 38;
  const h = 52;
  const midX = (a.x + b.x) / 2 + (Math.random() - 0.5) * 60;
  const midY = Math.min(a.y, b.y) - 80 - Math.random() * 40;
  const rot = (Math.random() - 0.5) * 50;
  n.style.left = `${-w / 2}px`;
  n.style.top = `${-h / 2}px`;
  n.style.opacity = 0;
  const anim = n.animate(
    [
      { transform: `translate(${a.x}px,${a.y}px) scale(.3) rotate(0deg)`, opacity: 0 },
      { transform: `translate(${a.x}px,${a.y - 20}px) scale(${scale * 1.15}) rotate(${rot / 3}deg)`, opacity: 1, offset: 0.18 },
      { transform: `translate(${midX}px,${midY}px) scale(${scale}) rotate(${rot}deg)`, opacity: 1, offset: 0.55 },
      { transform: `translate(${b.x}px,${b.y}px) scale(.45) rotate(${rot * 1.5}deg)`, opacity: 0.2 },
    ],
    { duration: reduce ? 1 : dur, delay, easing: 'cubic-bezier(.45,.05,.4,1)', fill: 'forwards' }
  );
  return anim.finished.then(() => n.remove()).catch(() => n.remove());
}

export function floatText(p, text, color = '#fff', { delay = 0, size = 18 } = {}) {
  if (!p) return;
  const n = make(`<div class="float-text" style="color:${color};font-size:${size}px">${text}</div>`);
  n.animate(
    [
      { transform: `translate(${p.x}px,${p.y}px) translate(-50%,-50%) scale(.6)`, opacity: 0 },
      { transform: `translate(${p.x}px,${p.y - 20}px) translate(-50%,-50%) scale(1.1)`, opacity: 1, offset: 0.2 },
      { transform: `translate(${p.x}px,${p.y - 60}px) translate(-50%,-50%) scale(1)`, opacity: 0 },
    ],
    { duration: 1400, delay, easing: 'ease-out', fill: 'forwards' }
  ).finished.then(() => n.remove());
}

// 粒子迸发（建造时的木屑/尘土，城市的金光）
export function burst(p, color = '#f5d26b', n = 14, { spread = 60, size = 6, dur = 700 } = {}) {
  if (!p || reduce) return;
  for (let i = 0; i < n; i++) {
    const a = (Math.PI * 2 * i) / n + Math.random() * 0.5;
    const d = spread * (0.5 + Math.random() * 0.7);
    const s = size * (0.5 + Math.random());
    const node = make(`<div class="particle" style="width:${s}px;height:${s}px;background:${color}"></div>`);
    node
      .animate(
        [
          { transform: `translate(${p.x}px,${p.y}px) scale(1)`, opacity: 1 },
          { transform: `translate(${p.x + Math.cos(a) * d}px,${p.y + Math.sin(a) * d + 20}px) scale(.2)`, opacity: 0 },
        ],
        { duration: dur * (0.7 + Math.random() * 0.6), easing: 'cubic-bezier(.2,.7,.4,1)', fill: 'forwards' }
      )
      .finished.then(() => node.remove());
  }
}

export function ripple(p, color = '#fff') {
  if (!p) return;
  const n = make(`<div class="ripple" style="border-color:${color}"></div>`);
  n.style.left = `${p.x}px`;
  n.style.top = `${p.y}px`;
  setTimeout(() => n.remove(), 900);
}

// 3D 骰子
const FACE_ROT = { 1: [0, 0], 2: [-90, 0], 3: [0, -90], 4: [0, 90], 5: [90, 0], 6: [0, 180] };
function dieHTML() {
  const pip = (n) => `<i class="p${n}"></i>`;
  const faces = {
    1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9],
  };
  return `<div class="die">${Object.entries(faces)
    .map(([f, ps]) => `<div class="face f${f}">${ps.map(pip).join('')}</div>`)
    .join('')}</div>`;
}

export async function rollDice(d1, d2, anchor, onLand) {
  const box = make(`<div class="dice-stage">${dieHTML()}${dieHTML()}</div>`);
  box.style.left = `${anchor.x}px`;
  box.style.top = `${anchor.y}px`;
  const dice = box.querySelectorAll('.die');
  const vals = [d1, d2];
  dice.forEach((d, i) => {
    d.style.transition = 'none';
    d.style.transform = `rotateX(${Math.random() * 360}deg) rotateY(${Math.random() * 360}deg)`;
  });
  box.animate(
    [
      { transform: 'translate(-50%,-50%) translate(140px,120px) scale(.5)', opacity: 0 },
      { transform: 'translate(-50%,-50%) translate(-10px,-30px) scale(1.1)', opacity: 1, offset: 0.45 },
      { transform: 'translate(-50%,-50%) translate(0,0) scale(1)', opacity: 1, offset: 0.7 },
      { transform: 'translate(-50%,-50%) translate(0,-8px) scale(1)', opacity: 1, offset: 0.82 },
      { transform: 'translate(-50%,-50%) translate(0,0) scale(1)', opacity: 1 },
    ],
    { duration: reduce ? 1 : 1000, easing: 'ease-out', fill: 'forwards' }
  );
  await wait(30);
  dice.forEach((d, i) => {
    const [rx, ry] = FACE_ROT[vals[i]];
    d.style.transition = reduce ? 'none' : 'transform 1.05s cubic-bezier(.2,.75,.25,1)';
    d.style.transform = `rotateX(${rx + 720 + (i ? 360 : 0)}deg) rotateY(${ry + 720}deg)`;
  });
  await wait(reduce ? 50 : 1080);
  box.classList.add('landed', d1 + d2 === 7 ? 'seven' : 'normal');
  if (onLand) onLand();
  await wait(1100);
  box.animate([{ opacity: 1 }, { opacity: 0, transform: 'translate(-50%,-50%) scale(.6)' }], { duration: 350, fill: 'forwards' }).finished.then(() => box.remove());
}

export function banner(title, sub = '', color = '#e0a93b', { big = false } = {}) {
  const n = make(`<div class="banner ${big ? 'big' : ''}" style="--c:${color}"><b></b><span></span></div>`);
  n.querySelector('b').textContent = title;
  n.querySelector('span').textContent = sub;
  setTimeout(() => n.remove(), big ? 2300 : 1800);
}

export function showcase(cardType, title, sub) {
  const n = make(`<div class="showcase"><div class="sc-inner">${cardHTML('dev:' + cardType, 'huge')}<b></b><span></span></div></div>`);
  n.querySelector('b').textContent = title;
  n.querySelector('span').textContent = sub;
  setTimeout(() => n.remove(), 2100);
}

export function shake(elm = document.getElementById('board-wrap')) {
  if (reduce || !elm) return;
  elm.animate(
    [
      { transform: 'translate(0,0)' },
      { transform: 'translate(-6px,3px)' },
      { transform: 'translate(5px,-4px)' },
      { transform: 'translate(-4px,-2px)' },
      { transform: 'translate(3px,3px)' },
      { transform: 'translate(0,0)' },
    ],
    { duration: 450 }
  );
}

export function confetti(colors = ['#e53935', '#1e88e5', '#fb8c00', '#43a047', '#f5d26b', '#8e24aa']) {
  if (reduce) return;
  const c = document.createElement('canvas');
  c.className = 'confetti';
  c.width = innerWidth;
  c.height = innerHeight;
  document.body.appendChild(c);
  const ctx = c.getContext('2d');
  const parts = Array.from({ length: 220 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 200,
    y: innerHeight * 0.45,
    vx: (Math.random() - 0.5) * 18,
    vy: -Math.random() * 18 - 6,
    r: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    w: 6 + Math.random() * 6,
    h: 8 + Math.random() * 8,
    col: colors[Math.floor(Math.random() * colors.length)],
  }));
  let frames = 0;
  const tick = () => {
    ctx.clearRect(0, 0, c.width, c.height);
    for (const p of parts) {
      p.vy += 0.35;
      p.vx *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      p.r += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.fillStyle = p.col;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2)));
      ctx.restore();
    }
    if (++frames < 260) requestAnimationFrame(tick);
    else c.remove();
  };
  tick();
}

export function pulse(elm, cls = 'pulse') {
  if (!elm) return;
  elm.classList.remove(cls);
  void elm.offsetWidth;
  elm.classList.add(cls);
}

export function center(elm) {
  if (!elm) return null;
  const r = elm.getBoundingClientRect();
  if (!r.width && !r.height) return null;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

export { wait };
