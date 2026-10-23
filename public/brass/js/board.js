// 伯明翰地图：SVG 绘制（羊皮纸底图、河流、城镇、产业格、商人、线路、市场），平移缩放与可点击的热点。
const NS = 'http://www.w3.org/2000/svg';
export const IND_NAME = { cotton: '棉纺厂', goods: '制造厂', pottery: '陶瓷厂', brewery: '酿酒厂', coal: '煤矿', iron: '炼铁厂' };
export const ROMAN = ['', 'Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', 'Ⅵ', 'Ⅶ', 'Ⅷ'];
export const REGION_COLOR = { blue: '#4a7fa8', teal: '#2f8f88', red: '#b04a3a', yellow: '#b8901f', purple: '#7d4f95', farm: '#6d8b3a' };
export const MERCHANT_TYPE = { cotton: '棉布', goods: '制成品', pottery: '陶瓷', all: '全收', blank: '不收货' };

const S = 46; // 产业格边长
const GAP = 6;

function el(tag, attrs = {}, parent = null) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}
const use = (id, x, y, w, h, parent, extra = {}) => el('use', { href: `#${id}`, x, y, width: w, height: h, ...extra }, parent);

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255;
  let g = (n >> 8) & 255;
  let b = n & 255;
  if (f >= 0) {
    r += (255 - r) * f;
    g += (255 - g) * f;
    b += (255 - b) * f;
  } else {
    r *= 1 + f;
    g *= 1 + f;
    b *= 1 + f;
  }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

export class BoardView {
  constructor(svg, handlers = {}) {
    this.svg = svg;
    this.handlers = handlers;
    this.map = null;
    this.home = null;
    this.hot = null;
    this.dragMoved = false;
    this.setupPanZoom();
  }

  // ---------- 静态底图 ----------
  setMap(map) {
    this.map = map;
    this.locById = Object.fromEntries(map.locs.map((l) => [l.id, l]));
    this.merchById = Object.fromEntries(map.merchants.map((m) => [m.id, m]));
    this.linkById = Object.fromEntries(map.links.map((l) => [l.id, l]));
    const svg = this.svg;
    svg.innerHTML = '';
    this.home = { x: -10, y: -10, w: map.width + 20, h: map.height + 20 };
    const defs = el('defs', {}, svg);
    defs.innerHTML = `
      <radialGradient id="paper" cx=".5" cy=".45" r=".75"><stop offset="0" stop-color="#f1e6c6"/><stop offset=".7" stop-color="#e2cf9f"/><stop offset="1" stop-color="#c9ad73"/></radialGradient>
      <radialGradient id="vignette" cx=".5" cy=".5" r=".72"><stop offset=".62" stop-color="#3a2410" stop-opacity="0"/><stop offset="1" stop-color="#3a2410" stop-opacity=".45"/></radialGradient>
      <filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" seed="7" result="n"/><feColorMatrix in="n" type="matrix" values="0 0 0 0 .35  0 0 0 0 .24  0 0 0 0 .12  0 0 0 .55 0"/></filter>
      <filter id="blotch" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".008" numOctaves="3" seed="3" result="n"/><feColorMatrix in="n" type="matrix" values="0 0 0 0 .45  0 0 0 0 .3  0 0 0 0 .12  0 0 0 .9 -.35"/></filter>
      <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="3" stdDeviation="2.5" flood-color="#2a1608" flood-opacity=".45"/></filter>
      <filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3"/></filter>
      <linearGradient id="water" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4f8fc0"/><stop offset="1" stop-color="#2d6597"/></linearGradient>
      <linearGradient id="flipface" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4a3020"/><stop offset="1" stop-color="#26170d"/></linearGradient>
      <pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(35)"><path d="M0 0V8" stroke="#8a6a3c" stroke-width="1" opacity=".35"/></pattern>`;

    // 底纸
    const bg = el('g', { class: 'bg' }, svg);
    el('rect', { x: -10, y: -10, width: map.width + 20, height: map.height + 20, fill: 'url(#paper)' }, bg);
    el('rect', { x: -10, y: -10, width: map.width + 20, height: map.height + 20, filter: 'url(#blotch)', opacity: 0.55 }, bg);
    el('rect', { x: -10, y: -10, width: map.width + 20, height: map.height + 20, filter: 'url(#grain)', opacity: 0.5 }, bg);
    this.drawDecor(bg);
    el('rect', { x: -10, y: -10, width: map.width + 20, height: map.height + 20, fill: 'url(#vignette)', 'pointer-events': 'none' }, bg);
    // 边框
    el('rect', { x: 6, y: 6, width: map.width - 12, height: map.height - 12, fill: 'none', stroke: '#5a3b1c', 'stroke-width': 3, rx: 6 }, bg);
    el('rect', { x: 14, y: 14, width: map.width - 28, height: map.height - 28, fill: 'none', stroke: '#8a6236', 'stroke-width': 1.2, rx: 4 }, bg);
    for (const [cx, cy] of [
      [14, 14],
      [map.width - 14, 14],
      [14, map.height - 14],
      [map.width - 14, map.height - 14],
    ])
      el('path', { d: `M${cx - 9} ${cy}L${cx} ${cy - 9}L${cx + 9} ${cy}L${cx} ${cy + 9}Z`, fill: '#8a6236' }, bg);

    // 线路（可建的路线）
    this.gRoutes = el('g', { class: 'routes' }, svg);
    for (const l of map.links) this.drawRoute(l);
    this.gLinks = el('g', { class: 'built-links' }, svg);
    this.gHotLinks = el('g', { class: 'hot-links' }, svg);
    // 城镇、商人
    this.gLocs = el('g', { class: 'locs' }, svg);
    for (const l of map.locs) this.drawLoc(l);
    this.gMerch = el('g', { class: 'merchants' }, svg);
    for (const m of map.merchants) this.drawMerchant(m);
    this.drawMarket(svg);
    this.gTiles = el('g', { class: 'tiles' }, svg);
    this.gHot = el('g', { class: 'hots' }, svg);
    this.gFx = el('g', { class: 'mapfx', 'pointer-events': 'none' }, svg);
    this.fit();
  }

  drawDecor(g) {
    // 河流
    const rivers = [
      { d: 'M300 150 C360 300 520 430 760 425 S1050 380 1150 335 S1400 250 1600 262', name: '特伦特河', at: [930, 398], rot: -9 },
      { d: 'M0 520 C130 600 180 700 262 800 S390 960 425 1030 S420 1140 330 1200', name: '塞文河', at: [215, 820], rot: 58 },
      { d: 'M760 1200 C830 1120 980 1085 1100 1045 S1300 960 1420 960', name: '埃文河', at: [1090, 1070], rot: -16 },
    ];
    for (const r of rivers) {
      el('path', { d: r.d, fill: 'none', stroke: '#9cbccb', 'stroke-width': 14, opacity: 0.35, 'stroke-linecap': 'round' }, g);
      el('path', { d: r.d, fill: 'none', stroke: '#7ea6bb', 'stroke-width': 4, opacity: 0.6, 'stroke-linecap': 'round' }, g);
      const t = el('text', { x: r.at[0], y: r.at[1], class: 'river-name', transform: `rotate(${r.rot} ${r.at[0]} ${r.at[1]})` }, g);
      t.textContent = r.name;
    }
    // 丘陵与田野
    const hills = [
      [250, 470], [300, 495], [205, 500], [1500, 770], [1545, 795], [700, 1150], [752, 1170], [1110, 190], [1160, 172], [1450, 1150], [1000, 640], [1040, 660],
    ];
    for (const [x, y] of hills) el('path', { d: `M${x - 18} ${y}q18 -22 36 0`, fill: 'none', stroke: '#8a6a3c', 'stroke-width': 1.6, opacity: 0.55 }, g);
    for (const [x, y, w, h] of [
      [640, 400, 90, 40],
      [1270, 470, 80, 36],
      [770, 940, 70, 40],
      [160, 860, 60, 36],
      [1140, 1160, 90, 34],
    ])
      el('ellipse', { cx: x, cy: y, rx: w / 2, ry: h / 2, fill: 'url(#hatch)', opacity: 0.7 }, g);
    // 森林（小树）
    for (const [x, y] of [
      [700, 445], [722, 433], [678, 433], [180, 680], [200, 696], [1480, 650], [1500, 666], [1100, 950], [1120, 966], [690, 600], [712, 614],
    ]) {
      el('circle', { cx: x, cy: y, r: 7, fill: '#7d8a4a', opacity: 0.55 }, g);
      el('path', { d: `M${x} ${y + 6}v6`, stroke: '#6b4a2a', 'stroke-width': 1.4, opacity: 0.6 }, g);
    }
    // 标题框
    const c = el('g', { class: 'cartouche', transform: 'translate(140 340)' }, g);
    el('rect', { x: -88, y: -78, width: 176, height: 150, rx: 10, fill: '#efe2bf', stroke: '#5a3b1c', 'stroke-width': 2.5, filter: 'url(#shadow)' }, c);
    el('rect', { x: -80, y: -70, width: 160, height: 134, rx: 6, fill: 'none', stroke: '#8a6236', 'stroke-width': 1 }, c);
    const t1 = el('text', { x: 0, y: -34, class: 'carto-cn' }, c);
    t1.textContent = '伯明翰';
    const t2 = el('text', { x: 0, y: -8, class: 'carto-en' }, c);
    t2.textContent = 'BIRMINGHAM';
    el('path', { d: 'M-60 6H60', stroke: '#8a6236', 'stroke-width': 1 }, c);
    const t3 = el('text', { x: 0, y: 30, class: 'carto-year' }, c);
    t3.textContent = '1770 — 1870';
    const t4 = el('text', { x: 0, y: 52, class: 'carto-sub' }, c);
    t4.textContent = '英格兰中部工业区';
    // 指南针
    const cp = el('g', { transform: 'translate(1500 975)', opacity: 0.75 }, g);
    el('circle', { r: 46, fill: 'none', stroke: '#6b4a2a', 'stroke-width': 1.5 }, cp);
    el('circle', { r: 38, fill: 'none', stroke: '#6b4a2a', 'stroke-width': 0.8 }, cp);
    el('path', { d: 'M0 -44L8 0L0 44L-8 0Z', fill: '#6b4a2a' }, cp);
    el('path', { d: 'M-44 0L0 -7L44 0L0 7Z', fill: '#a07a4a' }, cp);
    el('path', { d: 'M0 -44L8 0H-8Z', fill: '#b8322a' }, cp);
    const n = el('text', { x: 0, y: -52, class: 'compass-n' }, cp);
    n.textContent = '北';
  }

  // 线路几何：二次贝塞尔
  endPos(id) {
    const l = this.locById[id] || this.merchById[id];
    return { x: l.x, y: l.y };
  }
  linkGeom(l) {
    const a = this.endPos(l.a);
    const b = this.endPos(l.b);
    // 经过中途地点的线路（基德明斯特—南郊酒坊—伍斯特）：折线，标记放在第一段中间
    if (l.via) {
      const v = this.endPos(l.via);
      return { a, b, c: v, d: `M${a.x} ${a.y}L${v.x} ${v.y}L${b.x} ${b.y}`, mid: { x: (a.x + v.x) / 2, y: (a.y + v.y) / 2 } };
    }
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const c = { x: (a.x + b.x) / 2 - (dy / len) * len * (l.bend || 0), y: (a.y + b.y) / 2 + (dx / len) * len * (l.bend || 0) };
    return { a, b, c, d: `M${a.x} ${a.y}Q${c.x} ${c.y} ${b.x} ${b.y}`, mid: { x: (a.x + 2 * c.x + b.x) / 4, y: (a.y + 2 * c.y + b.y) / 4 } };
  }
  drawRoute(l) {
    const g = el('g', { class: `route ${l.canal ? 'can-canal' : ''} ${l.rail ? 'can-rail' : ''}`, 'data-link': l.id }, this.gRoutes);
    const geo = this.linkGeom(l);
    if (l.canal) el('path', { d: geo.d, class: 'r-canal' }, g);
    if (l.rail) {
      el('path', { d: geo.d, class: 'r-rail-ties' }, g);
      el('path', { d: geo.d, class: 'r-rail' }, g);
      el('path', { d: geo.d, class: 'r-rail-gap' }, g);
    }
    // 路线类型小标记
    const m = el('g', { class: 'route-mark', transform: `translate(${geo.mid.x} ${geo.mid.y})` }, g);
    el('circle', { r: 9, class: 'rm-bg' }, m);
    if (l.canal && l.rail) {
      use('i-boat', -8, -9, 9, 9, m, { class: 'rm-boat' });
      use('i-train', -1, -1, 9, 9, m, { class: 'rm-train' });
    } else if (l.canal) use('i-boat', -6.5, -6.5, 13, 13, m, { class: 'rm-boat' });
    else use('i-train', -6.5, -6.5, 13, 13, m, { class: 'rm-train' });
    this.routeEls = this.routeEls || {};
    this.routeEls[l.id] = g;
  }

  // 产业格位置（相对于城镇中心）
  slotOffsets(n) {
    if (n === 4)
      return [
        [-(S + GAP) / 2, -(S + GAP) / 2],
        [(S + GAP) / 2, -(S + GAP) / 2],
        [-(S + GAP) / 2, (S + GAP) / 2],
        [(S + GAP) / 2, (S + GAP) / 2],
      ];
    const w = n * S + (n - 1) * GAP;
    return Array.from({ length: n }, (_, i) => [-w / 2 + S / 2 + i * (S + GAP), 0]);
  }
  slotPos(loc, s) {
    const L = this.locById[loc];
    const o = this.slotOffsets(L.slots.length)[s];
    return { x: L.x + o[0], y: L.y + o[1] };
  }
  drawLoc(L) {
    const n = L.slots.length;
    const rows = n === 4 ? 2 : 1;
    const cols = n === 4 ? 2 : n;
    const w = cols * S + (cols - 1) * GAP + 14;
    const h = rows * S + (rows - 1) * GAP + 14;
    const g = el('g', { class: `loc region-${L.region}`, 'data-loc': L.id, transform: `translate(${L.x} ${L.y})` }, this.gLocs);
    el('rect', { x: -w / 2, y: -h / 2, width: w, height: h, rx: 10, class: 'loc-plate', filter: 'url(#shadow)', style: `--rc:${REGION_COLOR[L.region]}` }, g);
    // 名字飘带
    const ty = -h / 2 - 12;
    const tw = Math.max(56, L.name.length * 16 + 20);
    const rb = el('g', { class: 'ribbon', transform: `translate(0 ${ty})` }, g);
    el('path', { d: `M${-tw / 2 - 8} -9 L${-tw / 2} 0 L${-tw / 2 - 8} 9 H${tw / 2 + 8} L${tw / 2} 0 L${tw / 2 + 8} -9Z`, fill: shade(REGION_COLOR[L.region], -0.35) }, rb);
    el('rect', { x: -tw / 2, y: -11, width: tw, height: 22, rx: 3, fill: REGION_COLOR[L.region], stroke: shade(REGION_COLOR[L.region], -0.45), 'stroke-width': 1.2 }, rb);
    const t = el('text', { x: 0, y: 5.5, class: 'loc-name' }, rb);
    t.textContent = L.name;
    if (L.region === 'blue' || L.region === 'teal') {
      const tag = el('text', { x: tw / 2 + 14, y: 4, class: 'loc-tag' }, rb);
      tag.textContent = L.region === 'teal' ? '4人' : '3+';
    }
    // 空产业格
    this.slotEls = this.slotEls || {};
    const offs = this.slotOffsets(n);
    L.slots.forEach((inds, s) => {
      const sg = el('g', { class: 'slot', 'data-loc': L.id, 'data-slot': s, transform: `translate(${offs[s][0]} ${offs[s][1]})` }, g);
      el('rect', { x: -S / 2, y: -S / 2, width: S, height: S, rx: 7, class: 'slot-bg' }, sg);
      if (inds.length === 1) use(`i-${inds[0]}`, -14, -14, 28, 28, sg, { class: 'slot-ico' });
      else {
        el('path', { d: `M${S / 2 - 4} ${-S / 2 + 4}L${-S / 2 + 4} ${S / 2 - 4}`, class: 'slot-split' }, sg);
        use(`i-${inds[0]}`, -S / 2 + 3, -S / 2 + 3, 21, 21, sg, { class: 'slot-ico' });
        use(`i-${inds[1]}`, S / 2 - 24, S / 2 - 24, 21, 21, sg, { class: 'slot-ico' });
      }
      this.slotEls[`${L.id}:${s}`] = sg;
    });
  }

  drawMerchant(M) {
    const g = el('g', { class: 'merchant', 'data-m': M.id, transform: `translate(${M.x} ${M.y})` }, this.gMerch);
    const w = M.slots * 44 + 24;
    el('rect', { x: -w / 2, y: -40, width: w, height: 92, rx: 8, class: 'm-plate', filter: 'url(#shadow)' }, g);
    // 仓库屋顶
    el('path', { d: `M${-w / 2 - 6} -40 L0 -64 L${w / 2 + 6} -40Z`, class: 'm-roof' }, g);
    const t = el('text', { x: 0, y: -46, class: 'm-name' }, g);
    t.textContent = M.name;
    const slots = el('g', { class: 'm-slots' }, g);
    this.merchEls = this.merchEls || {};
    this.merchEls[M.id] = { g, slots, w };
    const b = el('text', { x: 0, y: 46, class: 'm-bonus' }, g);
    b.textContent = `🍺 ${M.bonusText}`;
  }
  merchSlotPos(id, i) {
    const M = this.merchById[id];
    return { x: M.x - (M.slots - 1) * 22 + i * 44, y: M.y - 8 };
  }

  drawMarket(svg) {
    const MX = 1500;
    const MY = 470;
    const g = el('g', { class: 'market', transform: `translate(${MX} ${MY})` }, svg);
    el('rect', { x: -86, y: -112, width: 172, height: 262, rx: 10, class: 'mk-plate', filter: 'url(#shadow)' }, g);
    const t = el('text', { x: 0, y: -90, class: 'mk-title' }, g);
    t.textContent = '市场';
    this.marketEls = {};
    const col = (res, x, prices, label) => {
      const cg = el('g', { transform: `translate(${x} -72)` }, g);
      const lt = el('text', { x: 0, y: 6, class: 'mk-label' }, cg);
      lt.textContent = label;
      const cells = [];
      const rows = prices.length / 2;
      for (let r = 0; r < rows; r++) {
        const price = prices[r * 2];
        const y = 16 + r * 26;
        const pt = el('text', { x: -30, y: y + 15, class: 'mk-price' }, cg);
        pt.textContent = `£${price}`;
        for (let k = 0; k < 2; k++) {
          const cx = -14 + k * 22;
          el('rect', { x: cx - 9, y, width: 20, height: 20, rx: 3, class: 'mk-cell' }, cg);
          const cube = use(`i-cube-${res}`, cx - 8, y + 1, 18, 18, cg, { class: 'mk-cube' });
          cells.push({ cube, idx: r * 2 + k, x: MX + x + cx + 1, y: MY - 72 + y + 10 });
        }
      }
      this.marketEls[res] = { cells, g: cg };
    };
    col('coal', -36, this.map.coalPrices, '煤');
    col('iron', 46, this.map.ironPrices, '铁');
    const e1 = el('text', { x: -36, y: 140, class: 'mk-empty' }, g);
    e1.textContent = '空 £8';
    const e2 = el('text', { x: 46, y: 88, class: 'mk-empty' }, g);
    e2.textContent = '空 £6';
  }
  marketPos(res, count) {
    // 市场里最便宜的那块（被买走的）位置；count 为当前方块数
    const m = this.marketEls[res];
    const N = m.cells.length;
    const idx = Math.max(0, Math.min(N - 1, N - Math.max(1, count)));
    const c = m.cells[idx];
    return { x: c.x, y: c.y };
  }

  // ---------- 状态刷新 ----------
  update(g, { me = null, colors = {} } = {}) {
    if (!this.map) return;
    this.game = g;
    this.colors = colors;
    // 当前时代可建的路线高亮
    this.svg.classList.toggle('era-canal', g.era === 'canal');
    this.svg.classList.toggle('era-rail', g.era === 'rail');
    // 已建线路
    this.gLinks.innerHTML = '';
    for (const [id, owner] of Object.entries(g.links)) this.drawBuiltLink(id, owner, g.era);
    for (const [id, r] of Object.entries(this.routeEls)) r.classList.toggle('taken', !!g.links[id]);
    // 商人
    for (const M of this.map.merchants) {
      const st = g.merchants[M.id];
      const { g: mg, slots } = this.merchEls[M.id];
      mg.classList.toggle('inactive', !st);
      slots.innerHTML = '';
      for (let i = 0; i < M.slots; i++) {
        const p = this.merchSlotPos(M.id, i);
        const sx = p.x - M.x;
        const sy = p.y - M.y;
        const sg = el('g', { transform: `translate(${sx} ${sy})`, class: 'm-slot', 'data-m': M.id, 'data-i': i }, slots);
        el('rect', { x: -19, y: -19, width: 38, height: 38, rx: 6, class: 'm-slot-bg' }, sg);
        if (!st) {
          const tx = el('text', { x: 0, y: 5, class: 'm-off' }, sg);
          tx.textContent = '—';
          continue;
        }
        const type = st[i].type;
        if (type === 'all') {
          use('i-cotton', -17, -17, 16, 16, sg);
          use('i-goods', 1, -17, 16, 16, sg);
          use('i-pottery', -8, 0, 16, 16, sg);
        } else if (type === 'blank') {
          const tx = el('text', { x: 0, y: 5, class: 'm-off' }, sg);
          tx.textContent = '✕';
        } else use(`i-${type}`, -15, -15, 30, 30, sg);
        if (st[i].beer > 0) use('i-beer', -10, 19, 20, 20, sg, { class: 'm-beer' });
      }
    }
    // 市场方块
    for (const res of ['coal', 'iron']) {
      const m = this.marketEls[res];
      const N = m.cells.length;
      for (const c of m.cells) c.cube.style.display = c.idx >= N - g.market[res] ? '' : 'none';
    }
    // 工厂板块
    this.gTiles.innerHTML = '';
    this.tileEls = {};
    for (const [loc, row] of Object.entries(g.board)) {
      row.forEach((t, s) => {
        const sl = this.slotEls[`${loc}:${s}`];
        if (sl) sl.classList.toggle('filled', !!t);
        if (t) this.drawTile(loc, s, t, colors[t.owner] || '#888', t.owner === me);
      });
    }
    if (this.hot) this.renderHot();
  }

  drawBuiltLink(id, owner, era) {
    const l = this.linkById[id];
    const geo = this.linkGeom(l);
    const col = (this.colors && this.colors[owner]) || '#888';
    const g = el('g', { class: `blink ${era}`, 'data-link': id }, this.gLinks);
    if (era === 'canal') {
      el('path', { d: geo.d, class: 'bl-canal-bank' }, g);
      el('path', { d: geo.d, class: 'bl-canal' }, g);
      el('path', { d: geo.d, class: 'bl-canal-shine' }, g);
    } else {
      el('path', { d: geo.d, class: 'bl-rail-bed' }, g);
      el('path', { d: geo.d, class: 'bl-rail-ties' }, g);
      el('path', { d: geo.d, class: 'bl-rail' }, g);
      el('path', { d: geo.d, class: 'bl-rail-gap' }, g);
    }
    const m = el('g', { class: 'bl-mark', transform: `translate(${geo.mid.x} ${geo.mid.y})` }, g);
    el('circle', { r: 13, fill: col, stroke: '#1c120a', 'stroke-width': 2 }, m);
    use(era === 'canal' ? 'i-boat' : 'i-train', -8, -8, 16, 16, m, { class: 'bl-ico', style: `color:${isLight(col) ? '#1c120a' : '#fff8e6'}` });
  }

  drawTile(loc, s, t, color, mine) {
    const p = this.slotPos(loc, s);
    const T = this.map.tiles[t.ind][t.lv];
    const outer = el('g', { class: 'tile-pos', transform: `translate(${p.x} ${p.y})`, 'data-loc': loc, 'data-slot': s }, this.gTiles);
    const g = el('g', { class: `tile ${t.flipped ? 'flipped' : ''} ${mine ? 'mine' : ''} ind-${t.ind}` }, outer);
    if (!t.flipped) {
      el('rect', { x: -S / 2, y: -S / 2, width: S, height: S, rx: 7, fill: color, stroke: '#1c120a', 'stroke-width': 1.6, class: 't-body' }, g);
      el('rect', { x: -S / 2 + 2, y: -S / 2 + 2, width: S - 4, height: S / 2 - 4, rx: 5, fill: '#fff', opacity: 0.18 }, g);
      el('rect', { x: -S / 2 + 5, y: -S / 2 + 4, width: S - 10, height: 25, rx: 5, fill: '#f3e9cf', stroke: shade(color, -0.4), 'stroke-width': 1 }, g);
      use(`i-${t.ind}`, -11, -S / 2 + 4.5, 22, 22, g);
      const lv = el('text', { x: -S / 2 + 7, y: S / 2 - 5, class: `t-lv ${isLight(color) ? 'dark' : ''}` }, g);
      lv.textContent = ROMAN[t.lv];
      // 方块 / 啤酒
      const res = t.res || 0;
      if (res > 0) {
        const icon = t.ind === 'coal' ? 'i-cube-coal' : t.ind === 'iron' ? 'i-cube-iron' : 'i-beer';
        if (res <= 3) for (let i = 0; i < res; i++) use(icon, S / 2 - 13 - i * 9, S / 2 - 15, 12, 12, g, { class: 'res' });
        else {
          use(icon, S / 2 - 26, S / 2 - 15, 12, 12, g, { class: 'res' });
          const n = el('text', { x: S / 2 - 6, y: S / 2 - 5, class: `t-n ${isLight(color) ? 'dark' : ''}` }, g);
          n.textContent = '×' + res;
        }
      }
      // 烟囱冒烟
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const sm = el('g', { class: 'smoke' }, outer);
        for (let i = 0; i < 2; i++) el('circle', { cx: S / 2 - 8, cy: -S / 2 - 2, r: 4 + i, class: 'puff', style: `animation-delay:${(Math.random() * 4).toFixed(2)}s` }, sm);
      }
    } else {
      el('rect', { x: -S / 2, y: -S / 2, width: S, height: S, rx: 7, fill: 'url(#flipface)', stroke: color, 'stroke-width': 3.2, class: 't-body' }, g);
      el('rect', { x: -S / 2 + 4, y: -S / 2 + 4, width: S - 8, height: S - 8, rx: 5, fill: 'none', stroke: '#c8963e', 'stroke-width': 0.8, opacity: 0.8 }, g);
      use(`i-${t.ind}`, -S / 2 + 4, -S / 2 + 4, 15, 15, g, { opacity: 0.9 });
      const v = el('text', { x: 2, y: 10, class: 't-vp' }, g);
      v.textContent = T.vp;
      if (T.links) {
        const lk = el('text', { x: -S / 2 + 6, y: S / 2 - 5, class: 't-links' }, g);
        lk.textContent = '↔' + T.links;
      }
      const lv = el('text', { x: S / 2 - 6, y: S / 2 - 5, class: 't-lv2' }, g);
      lv.textContent = ROMAN[t.lv];
    }
    this.tileEls[`${loc}:${s}`] = outer;
  }

  // ---------- 热点 ----------
  // hot = { kind: 'slot' | 'link' | 'tile', items: [...], color, picked: Set }
  setHot(hot) {
    this.hot = hot && hot.items && hot.items.length ? hot : null;
    this.renderHot();
  }
  renderHot() {
    this.gHot.innerHTML = '';
    this.gHotLinks.innerHTML = '';
    this.svg.classList.toggle('picking', !!this.hot);
    const h = this.hot;
    if (!h) return;
    const color = h.color || '#ffd36b';
    if (h.kind === 'slot' || h.kind === 'tile') {
      for (const it of h.items) {
        const p = this.slotPos(it.loc, it.slot);
        const key = `${it.loc}:${it.slot}`;
        const picked = h.picked && h.picked.has(key);
        const g = el('g', { class: `hot ${picked ? 'picked' : ''} ${it.dim ? 'dim' : ''}`, transform: `translate(${p.x} ${p.y})`, style: `--hc:${color}`, 'data-key': key }, this.gHot);
        el('rect', { x: -S / 2 - 5, y: -S / 2 - 5, width: S + 10, height: S + 10, rx: 10, class: 'hot-ring' }, g);
        el('rect', { x: -S / 2 - 8, y: -S / 2 - 8, width: S + 16, height: S + 16, rx: 12, class: 'hot-hit' }, g);
        if (picked) {
          el('circle', { cx: S / 2, cy: -S / 2, r: 9, fill: '#3d7a4a', stroke: '#fff', 'stroke-width': 2 }, g);
          el('path', { d: `M${S / 2 - 4} ${-S / 2}l3 3 5-6`, stroke: '#fff', 'stroke-width': 2, fill: 'none' }, g);
        }
        g.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.dragMoved) return;
          h.onPick && h.onPick(it);
        });
      }
    } else if (h.kind === 'link') {
      for (const it of h.items) {
        const l = this.linkById[it.id];
        const geo = this.linkGeom(l);
        const picked = h.picked && h.picked.has(it.id);
        const g = el('g', { class: `hot-link ${picked ? 'picked' : ''}`, style: `--hc:${color}` }, this.gHotLinks);
        el('path', { d: geo.d, class: 'hl-glow' }, g);
        el('path', { d: geo.d, class: 'hl-line' }, g);
        el('path', { d: geo.d, class: 'hl-hit' }, g);
        const m = el('g', { transform: `translate(${geo.mid.x} ${geo.mid.y})`, class: 'hl-mark' }, g);
        el('circle', { r: 15, class: 'hl-dot' }, m);
        const tx = el('text', { y: 5, class: 'hl-cost' }, m);
        tx.textContent = it.label || '';
        g.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.dragMoved) return;
          h.onPick && h.onPick(it);
        });
      }
    }
  }

  // ---------- 坐标换算 ----------
  toScreen(x, y) {
    const m = this.svg.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
  }
  slotScreen(loc, s) {
    if (this.merchById[loc]) return this.toScreen(this.merchSlotPos(loc, s || 0).x, this.merchSlotPos(loc, s || 0).y);
    const p = this.slotPos(loc, s);
    return this.toScreen(p.x, p.y);
  }
  locScreen(loc) {
    const p = this.endPos(loc);
    return this.toScreen(p.x, p.y);
  }
  linkScreen(id) {
    const g = this.linkGeom(this.linkById[id]);
    return this.toScreen(g.mid.x, g.mid.y);
  }
  marketScreen(res, count) {
    const p = this.marketPos(res, count);
    return this.toScreen(p.x, p.y);
  }
  scale() {
    const m = this.svg.getScreenCTM();
    return m ? m.a : 1;
  }

  // ---------- 地图内动画 ----------
  animTile(loc, s, cls) {
    const t = this.tileEls && this.tileEls[`${loc}:${s}`];
    if (!t) return;
    const inner = t.querySelector('.tile');
    inner.classList.remove(cls);
    void inner.getBoundingClientRect();
    inner.classList.add(cls);
  }
  dropTile(loc, s) {
    this.animTile(loc, s, 'drop');
    const p = this.slotPos(loc, s);
    this.dust(p.x, p.y + S / 2);
  }
  flipTile(loc, s) {
    this.animTile(loc, s, 'flipping');
    const p = this.slotPos(loc, s);
    this.sparkle(p.x, p.y, '#ffd36b');
  }
  // 运河 / 铁路：沿路线「画」出来，铁路上跑一列小火车
  drawLinkAnim(id, era) {
    const g = this.gLinks.querySelector(`[data-link="${id}"]`);
    if (!g) return;
    const geo = this.linkGeom(this.linkById[id]);
    for (const p of g.querySelectorAll('path')) {
      const len = p.getTotalLength();
      p.style.setProperty('--len', len);
      p.classList.add('drawing');
    }
    const mark = g.querySelector('.bl-mark');
    if (mark) {
      mark.classList.add('pop');
    }
    const path = el('path', { d: geo.d, fill: 'none', stroke: 'none' }, this.gFx);
    const len = path.getTotalLength();
    const icon = use(era === 'canal' ? 'i-boat' : 'i-train', -12, -12, 24, 24, this.gFx, { class: 'runner', style: 'color:#1c120a' });
    const t0 = performance.now();
    const dur = 1100;
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - k, 2);
      const pt = path.getPointAtLength(len * e);
      icon.setAttribute('x', pt.x - 12);
      icon.setAttribute('y', pt.y - 12);
      if (era === 'rail' && Math.random() < 0.35) this.steam(pt.x, pt.y - 10);
      if (era === 'canal' && Math.random() < 0.25) this.ripple(pt.x, pt.y, '#9cc6e8');
      if (k < 1) requestAnimationFrame(step);
      else {
        icon.remove();
        path.remove();
      }
    };
    requestAnimationFrame(step);
  }
  glowLink(id, text) {
    const geo = this.linkGeom(this.linkById[id]);
    const p = el('path', { d: geo.d, class: 'fx-linkglow' }, this.gFx);
    setTimeout(() => p.remove(), 1400);
    if (text) this.mapText(geo.mid.x, geo.mid.y - 18, text, '#ffe08a');
  }
  glowTile(loc, s, text) {
    const p = this.slotPos(loc, s);
    const r = el('rect', { x: p.x - S / 2 - 6, y: p.y - S / 2 - 6, width: S + 12, height: S + 12, rx: 10, class: 'fx-tileglow' }, this.gFx);
    setTimeout(() => r.remove(), 1400);
    if (text) this.mapText(p.x, p.y - S / 2 - 10, text, '#ffe08a');
  }
  crumble(loc, s) {
    const t = this.tileEls && this.tileEls[`${loc}:${s}`];
    if (t) t.classList.add('crumble');
    const p = this.slotPos(loc, s);
    this.dust(p.x, p.y, 14);
  }
  fadeLinks() {
    for (const g of this.gLinks.children) g.classList.add('fade-out');
  }
  mapText(x, y, text, color = '#fff') {
    const t = el('text', { x, y, class: 'fx-maptext', fill: color }, this.gFx);
    t.textContent = text;
    setTimeout(() => t.remove(), 1600);
  }
  dust(x, y, n = 9) {
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * 2 * i) / n + Math.random() * 0.4;
      const c = el('circle', { cx: x, cy: y, r: 3 + Math.random() * 4, class: 'fx-dust', style: `--dx:${Math.cos(a) * (18 + Math.random() * 18)}px;--dy:${Math.sin(a) * 10 - 6}px` }, this.gFx);
      setTimeout(() => c.remove(), 900);
    }
  }
  steam(x, y) {
    const c = el('circle', { cx: x, cy: y, r: 5 + Math.random() * 4, class: 'fx-steam' }, this.gFx);
    setTimeout(() => c.remove(), 1300);
  }
  ripple(x, y, color) {
    const c = el('circle', { cx: x, cy: y, r: 4, class: 'fx-ripple', stroke: color }, this.gFx);
    setTimeout(() => c.remove(), 900);
  }
  sparkle(x, y, color) {
    for (let i = 0; i < 14; i++) {
      const a = (Math.PI * 2 * i) / 14;
      const c = el('circle', { cx: x, cy: y, r: 2.5, fill: color, class: 'fx-spark', style: `--dx:${Math.cos(a) * 44}px;--dy:${Math.sin(a) * 44}px` }, this.gFx);
      setTimeout(() => c.remove(), 900);
    }
  }
  focusOn(x, y, w = 520) {
    // 平滑移动视角到某处（教程用）
    const r = this.svg.getBoundingClientRect();
    const aspect = r.width && r.height ? r.width / r.height : 1;
    // 不要放得太大（大屏幕上最多 1.1 倍）
    if (r.width / w > 1.1) w = r.width / 1.1;
    const h = w / aspect;
    const from = { ...this.vb };
    this.userZoomed = true;
    const to = { x: x - w / 2, y: y - h / 2, w, h };
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / 600);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      this.vb = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, w: from.w + (to.w - from.w) * e, h: from.h + (to.h - from.h) * e };
      this.applyVB();
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ---------- 平移/缩放 ----------
  applyVB() {
    const { x, y, w, h } = this.vb;
    this.lastW = this.svg.getBoundingClientRect().width;
    this.svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
  }
  // contain：整张地图；cover：铺满（小屏幕默认，地图更大，拖动查看）
  fit(mode) {
    if (!this.home) return;
    const r = this.svg.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.fitMode = mode || this.fitMode || (Math.min(r.width, r.height) < 560 ? 'cover' : 'contain');
    const aspect = r.width / r.height;
    let { x, y, w, h } = this.home;
    const wider = w / h < aspect;
    if (wider === (this.fitMode === 'contain')) {
      const nw = h * aspect;
      x -= (nw - w) / 2;
      w = nw;
    } else {
      const nh = w / aspect;
      y -= (nh - h) / 2;
      h = nh;
    }
    this.vb = { x, y, w, h };
    this.userZoomed = false;
    this.applyVB();
  }
  toggleFit() {
    this.fit(this.fitMode === 'contain' ? 'cover' : 'contain');
  }
  // 画布尺寸变化：没手动缩放过就重新适配，否则保持中心和比例
  resized() {
    const r = this.svg.getBoundingClientRect();
    if (!r.width || !r.height || !this.vb) return;
    if (!this.userZoomed) return this.fit();
    const cx = this.vb.x + this.vb.w / 2;
    const cy = this.vb.y + this.vb.h / 2;
    const scale = this.lastW ? this.vb.w / this.lastW : this.vb.w / r.width;
    this.vb.w = r.width * scale;
    this.vb.h = r.height * scale;
    this.vb.x = cx - this.vb.w / 2;
    this.vb.y = cy - this.vb.h / 2;
    this.applyVB();
  }
  zoom(f, cx, cy) {
    if (!this.vb) return;
    this.userZoomed = true;
    const r = this.svg.getBoundingClientRect();
    const px = cx === undefined ? 0.5 : (cx - r.left) / r.width;
    const py = cy === undefined ? 0.5 : (cy - r.top) / r.height;
    const maxW = Math.max(this.home.w, this.home.h * (r.width / Math.max(1, r.height))) * 1.4;
    const nw = Math.max(220, Math.min(maxW, this.vb.w * f));
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
      if (!pts.has(e.pointerId) || !this.vb) return;
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
      this.userZoomed = true;
      this.applyVB();
    });
    const up = (e) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      setTimeout(() => (this.dragMoved = false), 0);
    };
    svg.addEventListener('pointerup', up);
    svg.addEventListener('pointercancel', up);
    if (window.ResizeObserver) {
      new ResizeObserver(() => {
        this.resized();
        this.lastW = this.svg.getBoundingClientRect().width;
      }).observe(svg);
    } else window.addEventListener('resize', () => this.fit());
    // 点击空白处 / 城镇 / 工厂：显示信息
    svg.addEventListener('click', (e) => {
      if (this.dragMoved) return;
      const t = e.target.closest('.tile-pos, .slot, .merchant, .route');
      if (this.handlers.inspect) this.handlers.inspect(t, e);
    });
  }
}

export function isLight(hex) {
  if (!hex || hex[0] !== '#') return false;
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return r * 0.299 + g * 0.587 + b * 0.114 > 170;
}
