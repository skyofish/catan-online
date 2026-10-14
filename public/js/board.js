// 棋盘 SVG 渲染：地形、数字、港口、道路、建筑、强盗、可点击热点，以及平移/缩放。
const NS = 'http://www.w3.org/2000/svg';
export const S = 60; // 每个单位长度对应的像素

export const RES_LIST = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
export const RES_NAME = { wood: '木材', brick: '砖块', sheep: '羊毛', wheat: '小麦', ore: '矿石', any: '任意' };
export const TERRAIN_NAME = { forest: '森林', hills: '丘陵', pasture: '牧场', fields: '麦田', mountains: '山脉', desert: '沙漠' };
const PIPS = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };

export function el(tag, attrs = {}, parent = null) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (k === 'class') e.setAttribute('class', v);
    else if (k === 'style') e.setAttribute('style', v);
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v);
  }
  if (parent) parent.appendChild(e);
  return e;
}

function hexPoints(cx, cy, r) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 90);
    pts.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`);
  }
  return pts.join(' ');
}

// 可复现的伪随机数，保证每块地形的装饰在不同客户端上一致
function seeded(seed) {
  let s = seed * 9301 + 49297;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

// 判断点是否在尖顶六边形内（单位：像素）
function inHex(px, py, r) {
  const x = Math.abs(px);
  const y = Math.abs(py);
  const h = (Math.sqrt(3) / 2) * r;
  return x <= h && x * 0.5 + y * (Math.sqrt(3) / 2) <= h;
}

function scatter(rnd, n, r, minDist) {
  const pts = [];
  let guard = 0;
  while (pts.length < n && guard++ < 400) {
    const x = (rnd() * 2 - 1) * r;
    const y = (rnd() * 2 - 1) * r;
    if (!inHex(x, y, r)) continue;
    if (Math.hypot(x, y) < 22) continue; // 给数字牌留空间
    if (pts.some((p) => Math.hypot(p.x - x, p.y - y) < minDist)) continue;
    pts.push({ x, y });
  }
  return pts.sort((a, b) => a.y - b.y);
}

function drawTerrainArt(g, terrain, seed) {
  const rnd = seeded(seed + 7);
  const R = S * 0.8;
  if (terrain === 'forest') {
    for (const p of scatter(rnd, 9, R, 15)) {
      const h = 14 + rnd() * 8;
      const shade = rnd() < 0.5 ? '#1d4a24' : '#2a5f2c';
      el('rect', { x: p.x - 1.2, y: p.y, width: 2.4, height: 4, fill: '#5a3a1e' }, g);
      el('polygon', { points: `${p.x},${p.y - h} ${p.x - 7},${p.y + 1} ${p.x + 7},${p.y + 1}`, fill: shade }, g);
      el('polygon', { points: `${p.x},${p.y - h - 4} ${p.x - 5},${p.y - h * 0.4} ${p.x + 5},${p.y - h * 0.4}`, fill: '#3d7a3a' }, g);
    }
  } else if (terrain === 'pasture') {
    for (const p of scatter(rnd, 10, R, 12)) {
      el('path', { d: `M${p.x - 4},${p.y} q2,-6 3,0 q1,-7 3,0 q2,-5 3,0`, stroke: '#4f8a2b', 'stroke-width': 1.4, fill: 'none', 'stroke-linecap': 'round' }, g);
    }
    for (const p of scatter(rnd, 4, R * 0.8, 18)) {
      const s = el('g', { transform: `translate(${p.x},${p.y})`, class: 'sheep-bob', style: `animation-delay:${(rnd() * 3).toFixed(2)}s` }, g);
      el('ellipse', { cx: 0, cy: 0, rx: 6.5, ry: 4.5, fill: '#fbfbf4', stroke: '#c9c6b4', 'stroke-width': 0.6 }, s);
      el('circle', { cx: 5.5, cy: -2, r: 2.4, fill: '#3a3a3a' }, s);
      el('line', { x1: -3, y1: 4, x2: -3, y2: 7, stroke: '#3a3a3a', 'stroke-width': 1.2 }, s);
      el('line', { x1: 3, y1: 4, x2: 3, y2: 7, stroke: '#3a3a3a', 'stroke-width': 1.2 }, s);
    }
  } else if (terrain === 'fields') {
    for (let row = -3; row <= 3; row++) {
      const y = row * 11;
      el('path', { d: `M${-38 + Math.abs(row) * 6},${y} Q0,${y - 5} ${38 - Math.abs(row) * 6},${y}`, stroke: '#c1902a', 'stroke-width': 1.2, fill: 'none', opacity: 0.6 }, g);
    }
    for (const p of scatter(rnd, 7, R * 0.92, 15)) {
      const s = el('g', { transform: `translate(${p.x},${p.y})` }, g);
      for (const dx of [-3, 0, 3]) {
        el('line', { x1: dx * 0.6, y1: 6, x2: dx, y2: -6, stroke: '#9a6b16', 'stroke-width': 1 }, s);
        el('ellipse', { cx: dx, cy: -7, rx: 1.6, ry: 3.5, fill: '#f6d55c', stroke: '#b98a20', 'stroke-width': 0.5 }, s);
      }
    }
  } else if (terrain === 'hills') {
    for (const p of scatter(rnd, 4, R * 0.85, 22)) {
      el('path', { d: `M${p.x - 16},${p.y + 6} Q${p.x},${p.y - 14} ${p.x + 16},${p.y + 6} Z`, fill: '#a34a26', opacity: 0.75 }, g);
    }
    for (const p of scatter(rnd, 4, R * 0.85, 18)) {
      const s = el('g', { transform: `translate(${p.x},${p.y})` }, g);
      for (const [bx, by] of [[-6, 0], [1, 0], [-2.5, -4.5]]) el('rect', { x: bx, y: by, width: 6.5, height: 4, fill: '#d46a3a', stroke: '#7d3216', 'stroke-width': 0.7, rx: 0.5 }, s);
    }
  } else if (terrain === 'mountains') {
    for (const p of scatter(rnd, 5, R * 0.85, 20)) {
      const w = 13 + rnd() * 6;
      const h = 18 + rnd() * 8;
      el('polygon', { points: `${p.x - w},${p.y + 6} ${p.x},${p.y - h} ${p.x + w},${p.y + 6}`, fill: '#5d6470' }, g);
      el('polygon', { points: `${p.x},${p.y - h} ${p.x + w},${p.y + 6} ${p.x + w * 0.2},${p.y + 6}`, fill: '#474d57' }, g);
      el('polygon', { points: `${p.x - w * 0.32},${p.y - h * 0.55} ${p.x},${p.y - h} ${p.x + w * 0.32},${p.y - h * 0.55} ${p.x + w * 0.1},${p.y - h * 0.62} ${p.x - w * 0.08},${p.y - h * 0.5}`, fill: '#eef2f7' }, g);
    }
  } else if (terrain === 'desert') {
    for (let i = 0; i < 4; i++) {
      const y = -24 + i * 15 + rnd() * 5;
      el('path', { d: `M${-34 + rnd() * 10},${y} q14,-8 28,0 t28,0`, stroke: '#c9a45e', 'stroke-width': 1.6, fill: 'none', opacity: 0.8 }, g);
    }
    for (const p of scatter(rnd, 2, R * 0.75, 25)) {
      const c = el('g', { transform: `translate(${p.x},${p.y})`, fill: '#5f8f3a' }, g);
      el('rect', { x: -2.5, y: -12, width: 5, height: 16, rx: 2.5 }, c);
      el('path', { d: 'M-2,-2 h-5 v-6', stroke: '#5f8f3a', 'stroke-width': 3, fill: 'none', 'stroke-linecap': 'round' }, c);
      el('path', { d: 'M2,-5 h5 v-5', stroke: '#5f8f3a', 'stroke-width': 3, fill: 'none', 'stroke-linecap': 'round' }, c);
    }
  }
}

export class BoardView {
  constructor(svg, handlers) {
    this.svg = svg;
    this.handlers = handlers; // { vertex(id), edge(id), tile(id) }
    this.board = null;
    this.vb = { x: 0, y: 0, w: 100, h: 100 };
    this.home = null;
    this.layers = {};
    this.prevBuildings = {};
    this.prevRoads = {};
    this.prevRobber = null;
    this.setupPanZoom();
  }

  layer(name) {
    return this.layers[name];
  }

  setBoard(board, animateIntro = true) {
    this.board = board;
    const svg = this.svg;
    [...svg.querySelectorAll('g.layer')].forEach((n) => n.remove());
    for (const n of ['shore', 'tiles', 'ports', 'tokens', 'roads', 'buildings', 'robber', 'hot', 'fx']) this.layers[n] = el('g', { class: `layer layer-${n}` }, svg);

    const xs = board.vertices.map((v) => v.x * S);
    const ys = board.vertices.map((v) => v.y * S);
    const pad = S * 1.3;
    const minX = Math.min(...xs) - pad;
    const minY = Math.min(...ys) - pad;
    this.home = { x: minX, y: minY, w: Math.max(...xs) + pad - minX, h: Math.max(...ys) + pad - minY };
    this.fit();

    // 沙滩轮廓
    for (const t of board.tiles) el('polygon', { points: hexPoints(t.x * S, t.y * S, S * 1.13), fill: '#e7cf94', stroke: '#d8bb76', 'stroke-width': 2 }, this.layers.shore);
    for (const t of board.tiles) el('polygon', { points: hexPoints(t.x * S, t.y * S, S * 1.04), fill: '#efdcaa' }, this.layers.shore);

    const order = board.tiles.slice().sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y));
    const rank = new Map(order.map((t, i) => [t.id, i]));
    for (const t of board.tiles) {
      const delay = animateIntro ? rank.get(t.id) * 45 : 0;
      const outer = el('g', { transform: `translate(${t.x * S},${t.y * S})` }, this.layers.tiles);
      const g = el('g', { class: `tile t-${t.terrain}${animateIntro ? ' intro' : ''}`, 'data-tile': t.id, style: `animation-delay:${delay}ms` }, outer);
      el('polygon', { points: hexPoints(0, 0, S * 0.985), fill: `url(#g-${t.terrain})`, class: 'hex' }, g);
      const art = el('g', { class: 'art', 'clip-path': 'url(#hexclip)' }, g);
      drawTerrainArt(art, t.terrain, t.id + board.tiles.length * 13);
      el('polygon', { points: hexPoints(0, 0, S * 0.985), fill: 'none', stroke: 'rgba(60,40,20,.55)', 'stroke-width': 2.2, class: 'hex-edge' }, g);
      el('polygon', { points: hexPoints(0, 0, S * 0.94), fill: 'none', stroke: 'rgba(255,255,255,.18)', 'stroke-width': 1.2 }, g);
      t._g = g;
      // 数字牌
      if (t.number) {
        const tok = el('g', { transform: `translate(${t.x * S},${t.y * S})` }, this.layers.tokens);
        const inner = el('g', { class: `token${animateIntro ? ' intro' : ''}${t.number === 6 || t.number === 8 ? ' red' : ''}`, 'data-num': t.number, style: `animation-delay:${delay + 500}ms` }, tok);
        el('circle', { r: 17.5, cy: 1.5, fill: 'rgba(0,0,0,.35)' }, inner);
        el('circle', { r: 17, fill: 'url(#g-token)', stroke: '#8a6a3a', 'stroke-width': 1.2 }, inner);
        el('text', { y: 5, class: 'num', text: t.number }, inner);
        const n = PIPS[t.number];
        for (let i = 0; i < n; i++) el('circle', { cx: (i - (n - 1) / 2) * 3.6, cy: 11, r: 1.25, class: 'pip' }, inner);
        t._tok = inner;
      }
    }

    // 港口
    for (const p of board.ports) {
      const g = el('g', { class: `port${animateIntro ? ' intro' : ''}`, style: `animation-delay:${900 + p.id * 40}ms` }, this.layers.ports);
      for (const vid of p.vertices) {
        const v = board.vertices[vid];
        el('line', { x1: v.x * S, y1: v.y * S, x2: p.x * S, y2: p.y * S, stroke: '#7a5531', 'stroke-width': 4, 'stroke-linecap': 'round' }, g);
        el('line', { x1: v.x * S, y1: v.y * S, x2: p.x * S, y2: p.y * S, stroke: '#b98a55', 'stroke-width': 2, 'stroke-dasharray': '3 3' }, g);
      }
      const c = el('g', { transform: `translate(${p.x * S},${p.y * S})` }, g);
      el('circle', { r: 16, fill: '#f6ecd2', stroke: '#7a5531', 'stroke-width': 2 }, c);
      if (p.type === 'any') {
        el('text', { y: 4, class: 'port-ratio big', text: '3:1' }, c);
        el('title', { text: '港口：任意资源 3 换 1' }, c);
      } else {
        el('use', { href: `#i-${p.type}`, x: -10, y: -14, width: 20, height: 20 }, c);
        el('text', { y: 12, class: 'port-ratio', text: '2:1' }, c);
        el('title', { text: `港口：${RES_NAME[p.type]} 2 换 1` }, c);
      }
    }

    this.robberEl = el('g', { class: 'robber' }, this.layers.robber);
    const rb = el('g', { class: 'robber-body' }, this.robberEl);
    el('ellipse', { cx: 0, cy: 14, rx: 11, ry: 4, fill: 'rgba(0,0,0,.4)' }, rb);
    el('path', { d: 'M-9,13 C-10,2 -7,-4 -4,-6 A7,7 0 1 1 4,-6 C7,-4 10,2 9,13 Z', fill: '#2d2a33', stroke: '#111', 'stroke-width': 1.5 }, rb);
    el('ellipse', { cx: -2.5, cy: -12, rx: 2, ry: 3, fill: 'rgba(255,255,255,.25)' }, rb);
    this.prevBuildings = {};
    this.prevRoads = {};
    this.prevRobber = null;
  }

  // ---------- 动态内容 ----------
  update(game, opts = {}) {
    if (!this.board) return;
    const B = this.board;
    const colorOf = {};
    for (const p of game.players) colorOf[p.id] = p.color;

    const RL = this.layers.roads;
    RL.textContent = '';
    for (const [eid, owner] of Object.entries(game.roads)) {
      const e = B.edges[eid];
      const a = B.vertices[e.v[0]];
      const b = B.vertices[e.v[1]];
      const fresh = this.prevRoads[eid] === undefined && opts.animate;
      const g = el('g', { class: `road${fresh ? ' fresh' : ''}`, 'data-edge': eid }, RL);
      const x1 = a.x * S + (b.x - a.x) * S * 0.14;
      const y1 = a.y * S + (b.y - a.y) * S * 0.14;
      const x2 = b.x * S - (b.x - a.x) * S * 0.14;
      const y2 = b.y * S - (b.y - a.y) * S * 0.14;
      el('line', { x1, y1, x2, y2, stroke: 'rgba(0,0,0,.55)', 'stroke-width': 10, 'stroke-linecap': 'round' }, g);
      el('line', { x1, y1, x2, y2, stroke: colorOf[owner], 'stroke-width': 7, 'stroke-linecap': 'round', class: 'road-fill' }, g);
      el('line', { x1, y1: y1 - 1.5, x2, y2: y2 - 1.5, stroke: 'rgba(255,255,255,.35)', 'stroke-width': 1.5, 'stroke-linecap': 'round' }, g);
      if (game.longestRoad === owner) g.classList.add('longest');
    }

    const BL = this.layers.buildings;
    BL.textContent = '';
    for (const [vid, b] of Object.entries(game.buildings)) {
      const v = B.vertices[vid];
      const prev = this.prevBuildings[vid];
      const fresh = opts.animate && (!prev || prev.type !== b.type);
      const outer = el('g', { transform: `translate(${v.x * S},${v.y * S})` }, BL);
      const g = el('g', { class: `bld ${b.type}${fresh ? ' fresh' : ''}`, 'data-vertex': vid }, outer);
      const fill = colorOf[b.owner];
      if (b.type === 'settlement') {
        el('path', { d: 'M-9,10 L-9,-1 L0,-10 L9,-1 L9,10 Z', fill: 'rgba(0,0,0,.35)', transform: 'translate(1.5,2)' }, g);
        el('path', { d: 'M-9,10 L-9,-1 L0,-10 L9,-1 L9,10 Z', fill, stroke: '#1d1d1d', 'stroke-width': 1.6, 'stroke-linejoin': 'round' }, g);
        el('path', { d: 'M-9,-1 L0,-10 L9,-1', fill: 'none', stroke: 'rgba(255,255,255,.45)', 'stroke-width': 1.4 }, g);
        el('rect', { x: -2.5, y: 3, width: 5, height: 7, fill: 'rgba(0,0,0,.35)' }, g);
      } else {
        el('path', { d: 'M-14,11 L-14,-2 L-6,-2 L-6,-11 L1,-17 L8,-11 L8,-2 L14,-2 L14,11 Z', fill: 'rgba(0,0,0,.35)', transform: 'translate(1.5,2)' }, g);
        el('path', { d: 'M-14,11 L-14,-2 L-6,-2 L-6,-11 L1,-17 L8,-11 L8,-2 L14,-2 L14,11 Z', fill, stroke: '#1d1d1d', 'stroke-width': 1.6, 'stroke-linejoin': 'round' }, g);
        el('path', { d: 'M-6,-11 L1,-17 L8,-11', fill: 'none', stroke: 'rgba(255,255,255,.5)', 'stroke-width': 1.4 }, g);
        el('rect', { x: -1.5, y: -8, width: 5, height: 5, fill: 'rgba(255,240,180,.85)' }, g);
        el('rect', { x: -11, y: 2, width: 4, height: 4, fill: 'rgba(255,240,180,.85)' }, g);
        el('rect', { x: 8, y: 2, width: 4, height: 4, fill: 'rgba(255,240,180,.85)' }, g);
      }
    }

    // 强盗
    const rt = B.tiles[game.robber];
    this.robberEl.style.transform = `translate(${rt.x * S}px, ${rt.y * S + 2}px)`;
    if (this.prevRobber !== null && this.prevRobber !== game.robber && opts.animate) {
      this.robberEl.classList.remove('jump');
      void this.robberEl.getBoundingClientRect();
      this.robberEl.classList.add('jump');
    }
    for (const t of B.tiles) {
      t._g.classList.toggle('robbed', t.id === game.robber);
      if (t._tok) t._tok.classList.toggle('robbed', t.id === game.robber);
    }

    this.prevBuildings = JSON.parse(JSON.stringify(game.buildings));
    this.prevRoads = { ...game.roads };
    this.prevRobber = game.robber;
  }

  // 可点击位置
  setHotspots(kind, ids, color) {
    const H = this.layers.hot;
    H.textContent = '';
    this.svg.classList.toggle('placing', !!kind);
    if (!kind || !this.board) return;
    const B = this.board;
    if (kind === 'vertex' || kind === 'city') {
      for (const id of ids) {
        const v = B.vertices[id];
        const g = el('g', { class: 'hot hot-v', transform: `translate(${v.x * S},${v.y * S})`, tabindex: 0, role: 'button', 'aria-label': kind === 'city' ? '升级为城市' : '在此建造' }, H);
        el('circle', { r: 16, fill: 'transparent' }, g);
        el('circle', { r: kind === 'city' ? 14 : 9, class: 'ring', stroke: color, fill: kind === 'city' ? 'none' : color }, g);
        g.addEventListener('click', (ev) => this.hit(ev, () => this.handlers.vertex(id)));
        g.addEventListener('keydown', (ev) => ev.key === 'Enter' && this.handlers.vertex(id));
      }
    } else if (kind === 'edge') {
      for (const id of ids) {
        const e = B.edges[id];
        const a = B.vertices[e.v[0]];
        const b = B.vertices[e.v[1]];
        const mx = ((a.x + b.x) / 2) * S;
        const my = ((a.y + b.y) / 2) * S;
        const ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
        const g = el('g', { class: 'hot hot-e', transform: `translate(${mx},${my}) rotate(${ang})`, tabindex: 0, role: 'button', 'aria-label': '在此修路' }, H);
        el('rect', { x: -24, y: -10, width: 48, height: 20, fill: 'transparent' }, g);
        el('rect', { x: -18, y: -4, width: 36, height: 8, rx: 4, class: 'ring', fill: color, stroke: color }, g);
        g.addEventListener('click', (ev) => this.hit(ev, () => this.handlers.edge(id)));
        g.addEventListener('keydown', (ev) => ev.key === 'Enter' && this.handlers.edge(id));
      }
    } else if (kind === 'tile') {
      for (const id of ids) {
        const t = B.tiles[id];
        const g = el('g', { class: 'hot hot-t', transform: `translate(${t.x * S},${t.y * S})`, tabindex: 0, role: 'button', 'aria-label': '把强盗移到这里' }, H);
        el('polygon', { points: hexPoints(0, 0, S * 0.9), class: 'ring' }, g);
        el('circle', { r: 12, class: 'dot' }, g);
        g.addEventListener('click', (ev) => this.hit(ev, () => this.handlers.tile(id)));
        g.addEventListener('keydown', (ev) => ev.key === 'Enter' && this.handlers.tile(id));
      }
    }
  }

  hit(ev, fn) {
    if (this.dragMoved) return;
    ev.stopPropagation();
    fn();
  }

  // ---------- 坐标换算 ----------
  toScreen(x, y) {
    const pt = this.svg.createSVGPoint();
    pt.x = x;
    pt.y = y;
    const m = this.svg.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const r = pt.matrixTransform(m);
    return { x: r.x, y: r.y };
  }
  tileScreen(tid) {
    const t = this.board.tiles[tid];
    return this.toScreen(t.x * S, t.y * S);
  }
  vertexScreen(vid) {
    const v = this.board.vertices[vid];
    return this.toScreen(v.x * S, v.y * S);
  }
  edgeScreen(eid) {
    const e = this.board.edges[eid];
    const a = this.board.vertices[e.v[0]];
    const b = this.board.vertices[e.v[1]];
    return this.toScreen(((a.x + b.x) / 2) * S, ((a.y + b.y) / 2) * S);
  }

  flashNumber(num) {
    if (!this.board) return;
    for (const t of this.board.tiles) {
      if (t.number !== num) continue;
      const g = t._g;
      const cls = t.id === this.prevRobber ? 'blocked' : 'hit';
      g.classList.remove('hit', 'blocked');
      void g.getBoundingClientRect();
      g.classList.add(cls);
      if (t._tok) {
        t._tok.classList.remove('bump');
        void t._tok.getBoundingClientRect();
        t._tok.classList.add('bump');
      }
    }
  }
  shakeTile(tid) {
    const g = this.board.tiles[tid]._g;
    g.classList.remove('shake');
    void g.getBoundingClientRect();
    g.classList.add('shake');
  }

  // ---------- 平移/缩放 ----------
  applyVB() {
    const { x, y, w, h } = this.vb;
    this.svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
  }
  fit() {
    if (!this.home) return;
    const r = this.svg.getBoundingClientRect();
    const aspect = r.width && r.height ? r.width / r.height : 1;
    let { x, y, w, h } = this.home;
    if (w / h < aspect) {
      const nw = h * aspect;
      x -= (nw - w) / 2;
      w = nw;
    } else {
      const nh = w / aspect;
      y -= (nh - h) / 2;
      h = nh;
    }
    this.vb = { x, y, w, h };
    this.applyVB();
  }
  zoom(f, cx, cy) {
    const r = this.svg.getBoundingClientRect();
    const px = cx === undefined ? 0.5 : (cx - r.left) / r.width;
    const py = cy === undefined ? 0.5 : (cy - r.top) / r.height;
    const nw = Math.max(this.home.w * 0.3, Math.min(this.home.w * 2.2, this.vb.w * f));
    const real = nw / this.vb.w;
    const nh = this.vb.h * real;
    this.vb.x += (this.vb.w - nw) * px;
    this.vb.y += (this.vb.h - nh) * py;
    this.vb.w = nw;
    this.vb.h = nh;
    this.applyVB();
  }
  setupPanZoom() {
    const svg = this.svg;
    const pts = new Map();
    let last = null;
    let pinch = null;
    svg.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoom(e.deltaY > 0 ? 1.1 : 1 / 1.1, e.clientX, e.clientY);
      },
      { passive: false }
    );
    svg.addEventListener('pointerdown', (e) => {
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.dragMoved = false;
      last = { x: e.clientX, y: e.clientY };
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });
    svg.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2 && pinch) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        this.zoom(pinch / d, (a.x + b.x) / 2, (a.y + b.y) / 2);
        pinch = d;
        this.dragMoved = true;
        return;
      }
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      if (!this.dragMoved && Math.hypot(dx, dy) < 6) return;
      if (!this.dragMoved) svg.setPointerCapture(e.pointerId);
      this.dragMoved = true;
      const r = svg.getBoundingClientRect();
      this.vb.x -= (dx * this.vb.w) / r.width;
      this.vb.y -= (dy * this.vb.h) / r.height;
      last = { x: e.clientX, y: e.clientY };
      this.applyVB();
    });
    const up = (e) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      setTimeout(() => (this.dragMoved = false), 0);
    };
    svg.addEventListener('pointerup', up);
    svg.addEventListener('pointercancel', up);
    window.addEventListener('resize', () => this.fit());
  }
}
