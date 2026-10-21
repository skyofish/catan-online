'use strict';
// 地图生成：4 / 6 / 8 人版本。使用尖顶六边形，几何方式推导顶点和边。

const SQ3 = Math.sqrt(3);

const RES = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
const TERRAIN_RES = { forest: 'wood', hills: 'brick', pasture: 'sheep', fields: 'wheat', mountains: 'ore', desert: null };
const RES_TERRAIN = { wood: 'forest', brick: 'hills', sheep: 'pasture', wheat: 'fields', ore: 'mountains' };

const LAYOUTS = {
  4: {
    rows: [3, 4, 5, 4, 3],
    terrain: { forest: 4, hills: 3, pasture: 4, fields: 4, mountains: 3, desert: 1 },
    numbers: [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12],
    ports: { any: 4, wood: 1, brick: 1, sheep: 1, wheat: 1, ore: 1 },
    dev: { knight: 14, vp: 5, road: 2, plenty: 2, monopoly: 2 },
    bank: 19,
    minPlayers: 2, maxPlayers: 4,
  },
  6: {
    rows: [3, 4, 5, 6, 5, 4, 3],
    terrain: { forest: 6, hills: 5, pasture: 6, fields: 6, mountains: 5, desert: 2 },
    numbers: [2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6, 8, 8, 8, 9, 9, 9, 10, 10, 10, 11, 11, 11, 12, 12],
    ports: { any: 5, wood: 1, brick: 1, sheep: 2, wheat: 1, ore: 1 },
    dev: { knight: 20, vp: 5, road: 3, plenty: 3, monopoly: 3 },
    bank: 24,
    minPlayers: 2, maxPlayers: 6,
  },
  8: {
    rows: [3, 4, 5, 6, 7, 6, 5, 4, 3],
    terrain: { forest: 9, hills: 7, pasture: 9, fields: 8, mountains: 7, desert: 3 },
    numbers: [
      2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 5, 6, 6, 6, 6, 6,
      8, 8, 8, 8, 8, 9, 9, 9, 9, 9, 10, 10, 10, 10, 11, 11, 11, 11, 12, 12,
    ],
    ports: { any: 6, wood: 1, brick: 1, sheep: 2, wheat: 2, ore: 1 },
    dev: { knight: 26, vp: 6, road: 4, plenty: 4, monopoly: 4 },
    bank: 30,
    minPlayers: 2, maxPlayers: 8,
  },
};

function shuffle(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function expand(counts) {
  const out = [];
  for (const [k, n] of Object.entries(counts)) for (let i = 0; i < n; i++) out.push(k);
  return out;
}

const r3 = (v) => Math.round(v * 1000) / 1000;

function buildGeometry(rows) {
  const tiles = [];
  const vertices = [];
  const edges = [];
  const vMap = new Map();
  const eMap = new Map();
  const nRows = rows.length;

  rows.forEach((len, r) => {
    for (let c = 0; c < len; c++) {
      tiles.push({ id: tiles.length, x: r3((c - (len - 1) / 2) * SQ3), y: r3((r - (nRows - 1) / 2) * 1.5), row: r, col: c });
    }
  });

  for (const t of tiles) {
    t.vertices = [];
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 180) * (60 * i - 90);
      const x = r3(t.x + Math.cos(a));
      const y = r3(t.y + Math.sin(a));
      const key = `${x.toFixed(2)},${y.toFixed(2)}`;
      let v = vMap.get(key);
      if (!v) {
        v = { id: vertices.length, x, y, tiles: [], edges: [], adj: [], port: null };
        vMap.set(key, v);
        vertices.push(v);
      }
      v.tiles.push(t.id);
      t.vertices.push(v.id);
    }
    t.edges = [];
    for (let i = 0; i < 6; i++) {
      const a = t.vertices[i];
      const b = t.vertices[(i + 1) % 6];
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      let e = eMap.get(key);
      if (!e) {
        e = { id: edges.length, v: [Math.min(a, b), Math.max(a, b)], tiles: [] };
        eMap.set(key, e);
        edges.push(e);
        vertices[a].edges.push(e.id);
        vertices[b].edges.push(e.id);
        vertices[a].adj.push(b);
        vertices[b].adj.push(a);
      }
      e.tiles.push(t.id);
      t.edges.push(e.id);
    }
  }
  for (const t of tiles) {
    const set = new Set();
    for (const eid of t.edges) for (const tid of edges[eid].tiles) if (tid !== t.id) set.add(tid);
    t.neighbors = [...set];
  }
  return { tiles, vertices, edges };
}

function assignNumbers(tiles, numbers, rng) {
  const land = tiles.filter((t) => t.terrain !== 'desert');
  let best = null;
  let bestScore = Infinity;
  for (let attempt = 0; attempt < 2000; attempt++) {
    const pool = shuffle(numbers.slice(), rng);
    land.forEach((t, i) => (t.number = pool[i]));
    // 评分：相邻红色数字(6/8)严重惩罚，相邻相同数字、相邻 2/12 轻微惩罚
    let score = 0;
    for (const t of land) {
      for (const nid of t.neighbors) {
        const n = tiles[nid];
        if (!n.number || nid < t.id) continue;
        const red = (x) => x === 6 || x === 8;
        if (red(t.number) && red(n.number)) score += 100;
        if (t.number === n.number) score += 5;
        if ((t.number === 2 || t.number === 12) && (n.number === 2 || n.number === 12)) score += 3;
      }
    }
    if (score < bestScore) {
      bestScore = score;
      best = land.map((t) => t.number);
      if (score === 0) break;
    }
  }
  land.forEach((t, i) => (t.number = best[i]));
}

function assignTerrain(tiles, terrainCounts, rng) {
  // 尽量避免同类地形大面积聚集
  let best = null;
  let bestScore = Infinity;
  for (let attempt = 0; attempt < 300; attempt++) {
    const pool = shuffle(expand(terrainCounts), rng);
    let score = 0;
    tiles.forEach((t, i) => (t.terrain = pool[i]));
    for (const t of tiles) for (const nid of t.neighbors) if (nid > t.id && tiles[nid].terrain === t.terrain) score += t.terrain === 'desert' ? 4 : 1;
    if (score < bestScore) {
      bestScore = score;
      best = pool;
    }
  }
  tiles.forEach((t, i) => {
    t.terrain = best[i];
    t.resource = TERRAIN_RES[t.terrain];
    t.number = null;
  });
}

function assignPorts(geo, portCounts, rng) {
  const { edges, vertices } = geo;
  const coastal = edges.filter((e) => e.tiles.length === 1);
  // 以中心为原点，按极角排序得到海岸线顺序
  const mid = (e) => {
    const a = vertices[e.v[0]];
    const b = vertices[e.v[1]];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };
  coastal.sort((e1, e2) => {
    const m1 = mid(e1);
    const m2 = mid(e2);
    return Math.atan2(m1.y, m1.x) - Math.atan2(m2.y, m2.x);
  });
  const types = shuffle(expand(portCounts), rng);
  const n = types.length;
  const step = coastal.length / n;
  const offset = Math.floor(rng() * coastal.length);
  const ports = [];
  const usedVertices = new Set();
  for (let i = 0; i < n; i++) {
    let idx = (offset + Math.round(i * step)) % coastal.length;
    // 避免港口共享顶点
    let tries = 0;
    while (tries < coastal.length && coastal[idx].v.some((v) => usedVertices.has(v))) {
      idx = (idx + 1) % coastal.length;
      tries++;
    }
    const e = coastal[idx];
    e.v.forEach((v) => usedVertices.add(v));
    const type = types[i];
    const m = mid(e);
    const t = geo.tiles[e.tiles[0]];
    // 港口图标位置：从地块中心沿边中点向外推
    const dx = m.x - t.x;
    const dy = m.y - t.y;
    const len = Math.hypot(dx, dy);
    const px = r3(m.x + (dx / len) * 0.62);
    const py = r3(m.y + (dy / len) * 0.62);
    ports.push({ id: ports.length, edge: e.id, type, ratio: type === 'any' ? 3 : 2, vertices: e.v.slice(), x: px, y: py });
    for (const vid of e.v) vertices[vid].port = type;
  }
  return ports;
}

function generateBoard(size, rng = Math.random) {
  const layout = LAYOUTS[size];
  if (!layout) throw new Error('不支持的地图尺寸');
  const geo = buildGeometry(layout.rows);
  assignTerrain(geo.tiles, layout.terrain, rng);
  assignNumbers(geo.tiles, layout.numbers, rng);
  const ports = assignPorts(geo, layout.ports, rng);
  return {
    size,
    tiles: geo.tiles.map((t) => ({ id: t.id, x: t.x, y: t.y, terrain: t.terrain, resource: t.resource, number: t.number, vertices: t.vertices, edges: t.edges, neighbors: t.neighbors })),
    vertices: geo.vertices,
    edges: geo.edges,
    ports,
  };
}

const PIPS = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };

module.exports = { generateBoard, LAYOUTS, RES, RES_TERRAIN, TERRAIN_RES, PIPS, shuffle, expand };
