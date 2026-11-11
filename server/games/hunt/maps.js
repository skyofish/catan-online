'use strict';
// 雾夜追猎：三张地图的生成、碰撞、视线与寻路。
// 地图是 64×64 米的方格（每格 1 米）。格子类型：0 空地，1 高墙（挡路挡视线），2 矮障碍（挡路不挡视线），3 窗（可翻越）。
// 每张地图的布局由固定种子生成，所以每局地形一样（像真正的地图），发报机、出生点每局从候选位置里随机抽。
const W = 64;
const BLOCK = 12;
const ORG = 2;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------- 结构模板（12×12 的局部坐标，最外一圈留空当通道） ----------------
// 每个模板返回：machine（发报机候选位）、cage（铁笼候选位）
const TEMPLATES = {
  // 小屋：一圈墙，一扇窗，一个带木板的门，一个空门
  shack(b) {
    b.rect(2, 2, 9, 8);
    b.win(2, 5, 'x');
    b.win(6, 2, 'z');
    b.clear(9, 4);
    b.pal(6, 8, 'z');
    return { machine: [4, 4], cage: [10, 10] };
  },
  // L 形墙
  ell(b) {
    b.line(2, 3, 8, 3);
    b.win(5, 3, 'z');
    b.line(8, 3, 8, 8);
    b.low(8, 10);
    b.pal(8, 9, 'x');
    return { machine: [5, 6], cage: [3, 9] };
  },
  // T 形墙
  tee(b) {
    b.line(2, 5, 9, 5);
    b.win(4, 5, 'z');
    b.line(6, 5, 6, 9);
    b.pal(6, 7, 'x');
    return { machine: [3, 8], cage: [9, 2] };
  },
  // 长墙
  long(b) {
    b.line(1, 5, 10, 5);
    b.win(3, 5, 'z');
    b.pal(7, 5, 'z');
    return { machine: [5, 7], cage: [5, 2] };
  },
  // 货箱堆
  crates(b) {
    for (const [x, z] of [[3, 3], [3, 4], [4, 3], [7, 7], [8, 7], [7, 8], [3, 8], [5, 5], [5, 7]]) b.low(x, z);
    b.pal(5, 6, 'x');
    return { machine: [8, 3], cage: [2, 6] };
  },
  // 空地（几棵树）
  open(b) {
    b.low(3, 7);
    b.low(8, 3);
    return { machine: [5, 5], cage: [8, 8] };
  },
  // 树篱迷宫
  maze(b) {
    b.line(2, 2, 2, 7);
    b.line(4, 4, 9, 4);
    b.line(4, 6, 4, 9);
    b.line(6, 6, 9, 6);
    b.win(7, 6, 'z');
    b.win(2, 4, 'x');
    b.line(9, 8, 9, 9);
    b.set(6, 9, 1);
    b.pal(5, 9, 'z');
    return { machine: [6, 8], cage: [10, 2] };
  },
  // 双墙夹道
  lane(b) {
    b.line(3, 2, 3, 9);
    b.line(7, 2, 7, 9);
    b.win(3, 5, 'x');
    b.win(7, 6, 'x');
    b.low(5, 3);
    b.set(4, 8, 1);
    b.set(6, 8, 1);
    b.pal(5, 8, 'z');
    return { machine: [5, 5], cage: [9, 9] };
  },
  // 地标建筑：大屋，两个门、两扇窗、屋里一道隔墙
  big(b) {
    b.rect(1, 1, 10, 10);
    b.pal(5, 1, 'z');
    b.clear(10, 6);
    b.clear(1, 8);
    b.win(1, 4, 'x');
    b.win(7, 10, 'z');
    b.line(5, 4, 5, 7);
    b.win(5, 5, 'x');
    b.low(8, 3);
    return { machine: [3, 6], cage: null };
  },
};

const LAYOUTS = {
  circus: {
    seed: 7301,
    weights: { shack: 4, tee: 2, ell: 2, crates: 3, open: 2, long: 1, lane: 1 },
    gates: [
      { side: 'n', at: 20 },
      { side: 's', at: 42 },
    ],
    theme: 'circus',
  },
  harbor: {
    seed: 4127,
    weights: { crates: 4, long: 3, lane: 3, ell: 2, shack: 1, open: 1, tee: 1 },
    gates: [
      { side: 'w', at: 18 },
      { side: 'e', at: 44 },
    ],
    theme: 'harbor',
  },
  garden: {
    seed: 9914,
    weights: { maze: 5, ell: 2, tee: 2, open: 2, lane: 2, shack: 1 },
    gates: [
      { side: 'n', at: 46 },
      { side: 'w', at: 44 },
    ],
    theme: 'garden',
  },
};

function pickWeighted(r, weights) {
  const ks = Object.keys(weights);
  let t = r() * ks.reduce((s, k) => s + weights[k], 0);
  for (const k of ks) {
    t -= weights[k];
    if (t <= 0) return k;
  }
  return ks[0];
}

const cache = new Map();
function buildMap(key) {
  if (cache.has(key)) return cache.get(key);
  const L = LAYOUTS[key];
  if (!L) throw new Error('未知地图');
  const r = rng(L.seed);
  const grid = new Uint8Array(W * W);
  const windows = [];
  const pallets = [];
  const slots = [];
  const cages = [];
  const blocks = [];
  for (let i = 0; i < W; i++) grid[i] = grid[(W - 1) * W + i] = grid[i * W] = grid[i * W + W - 1] = 1;

  for (let bj = 0; bj < 5; bj++) {
    for (let bi = 0; bi < 5; bi++) {
      const center = bi === 2 && bj === 2;
      const corner = (bi === 0 || bi === 4) && (bj === 0 || bj === 4);
      const name = center ? 'big' : corner ? (r() < 0.5 ? 'open' : 'crates') : pickWeighted(r, L.weights);
      const rot = Math.floor(r() * 4);
      const ox = ORG + bi * BLOCK;
      const oz = ORG + bj * BLOCK;
      // 把模板的局部坐标按 rot 旋转后放到地图上
      const tf = (x, z) => {
        for (let k = 0; k < rot; k++) [x, z] = [11 - z, x];
        return [ox + x, oz + z];
      };
      const ax = (a) => (rot % 2 ? (a === 'x' ? 'z' : 'x') : a);
      const b = {
        set(x, z, v) {
          const [gx, gz] = tf(x, z);
          grid[gz * W + gx] = v;
        },
        clear(x, z) {
          b.set(x, z, 0);
        },
        low(x, z) {
          b.set(x, z, 2);
        },
        line(x1, z1, x2, z2) {
          for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) b.set(x, z, 1);
        },
        rect(x1, z1, x2, z2) {
          b.line(x1, z1, x2, z1);
          b.line(x1, z2, x2, z2);
          b.line(x1, z1, x1, z2);
          b.line(x2, z1, x2, z2);
        },
        win(x, z, a) {
          const [gx, gz] = tf(x, z);
          grid[gz * W + gx] = 3;
          windows.push({ x: gx, z: gz, axis: ax(a) });
        },
        pal(x, z, a) {
          const [gx, gz] = tf(x, z);
          grid[gz * W + gx] = 0;
          pallets.push({ x: gx, z: gz, axis: ax(a) });
        },
      };
      const res = TEMPLATES[name](b);
      const m = tf(...res.machine);
      slots.push({ x: m[0], z: m[1], block: bj * 5 + bi });
      if (res.cage) {
        const c = tf(...res.cage);
        cages.push({ x: c[0], z: c[1] });
      }
      blocks.push({ name, rot, x: ox, z: oz });
    }
  }

  // 大门：边界墙上开 3 格宽的口子（对局里先由"门"挡住，通电并开门后才能通过）
  const gates = L.gates.map((g, i) => {
    const cells = [];
    for (let d = -1; d <= 1; d++) {
      const x = g.side === 'n' || g.side === 's' ? g.at + d : g.side === 'w' ? 0 : W - 1;
      const z = g.side === 'w' || g.side === 'e' ? g.at + d : g.side === 'n' ? 0 : W - 1;
      grid[z * W + x] = 0;
      cells.push({ x, z });
    }
    const inx = g.side === 'w' ? 1 : g.side === 'e' ? -1 : 0;
    const inz = g.side === 'n' ? 1 : g.side === 's' ? -1 : 0;
    const mid = cells[1];
    // 开门的电闸在门内侧偏一格
    const panel = { x: mid.x + inx + (inz ? 2 : 0) + 0.5, z: mid.z + inz + (inx ? 2 : 0) + 0.5 };
    return { id: i, side: g.side, cells, x: mid.x + 0.5, z: mid.z + 0.5, panel };
  });

  // 出生点：四角与四边中点附近（避开会放发报机、铁笼、木板的格子）
  const avoid = new Set(slots.concat(cages, pallets).map((o) => o.z * W + o.x));
  const spawnS = [
    [5, 5], [58, 5], [5, 58], [58, 58], [30, 4], [4, 32], [59, 30], [32, 59],
  ].map(([x, z]) => freeNear(grid, x, z, avoid));
  const hatchSpots = [[14, 26], [50, 38], [26, 50], [38, 14]].map(([x, z]) => freeNear(grid, x, z, avoid));

  const map = {
    key,
    name: key,
    theme: L.theme,
    W,
    grid,
    rows: Array.from({ length: W }, (_, z) => Array.from(grid.subarray(z * W, z * W + W)).join('')),
    windows,
    pallets,
    slots,
    cages,
    gates,
    spawnS,
    hatchSpots,
    blocks,
  };
  cache.set(key, map);
  return map;
}

function freeNear(grid, x, z, avoid = new Set()) {
  for (let rad = 0; rad < 6; rad++)
    for (let dz = -rad; dz <= rad; dz++)
      for (let dx = -rad; dx <= rad; dx++) {
        const gx = x + dx;
        const gz = z + dz;
        if (gx > 0 && gz > 0 && gx < W - 1 && gz < W - 1 && grid[gz * W + gx] === 0 && !avoid.has(gz * W + gx)) return { x: gx + 0.5, z: gz + 0.5 };
      }
  return { x: x + 0.5, z: z + 0.5 };
}

// 发给客户端的地图（只含静态信息）
function publicMap(map) {
  return { key: map.key, theme: map.theme, W, rows: map.rows, windows: map.windows, pallets: map.pallets, cages: map.cages, gates: map.gates, blocks: map.blocks };
}

// ---------------- 碰撞 ----------------
// solid(cx, cz)：这一格是否挡路（静态格子 + 倒下的木板、没开的大门等动态障碍）
function hits(solid, x, z, rad) {
  const x0 = Math.floor(x - rad);
  const x1 = Math.floor(x + rad);
  const z0 = Math.floor(z - rad);
  const z1 = Math.floor(z + rad);
  for (let cz = z0; cz <= z1; cz++)
    for (let cx = x0; cx <= x1; cx++) {
      if (!solid(cx, cz)) continue;
      const nx = Math.max(cx, Math.min(x, cx + 1));
      const nz = Math.max(cz, Math.min(z, cz + 1));
      const dx = x - nx;
      const dz = z - nz;
      if (dx * dx + dz * dz < rad * rad) return true;
    }
  return false;
}

// 带滑动的移动：先整体移动，不行就分轴
function moveCircle(solid, p, dx, dz, rad) {
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.2));
  const sx = dx / steps;
  const sz = dz / steps;
  let moved = false;
  for (let i = 0; i < steps; i++) {
    if (!hits(solid, p.x + sx, p.z + sz, rad)) {
      p.x += sx;
      p.z += sz;
      moved = true;
    } else if (sx && !hits(solid, p.x + sx, p.z, rad)) {
      p.x += sx;
      moved = true;
    } else if (sz && !hits(solid, p.x, p.z + sz, rad)) {
      p.z += sz;
      moved = true;
    } else break;
  }
  return moved;
}

// 视线：只有高墙（1）挡视线
function los(grid, x1, z1, x2, z2) {
  const d = Math.hypot(x2 - x1, z2 - z1);
  const n = Math.ceil(d / 0.4);
  for (let i = 1; i < n; i++) {
    const x = x1 + ((x2 - x1) * i) / n;
    const z = z1 + ((z2 - z1) * i) / n;
    if (grid[Math.floor(z) * W + Math.floor(x)] === 1) return false;
  }
  return true;
}

// ---------------- 寻路（A*，8 方向，不穿墙角） ----------------
// cost(cx, cz)：进入这一格的额外代价；返回 Infinity 表示不可通过。窗和倒下的木板由调用方给出代价（只能沿轴穿过）。
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
function findPath(costFn, sx, sz, tx, tz, maxNodes = 5000) {
  sx = Math.floor(sx);
  sz = Math.floor(sz);
  tx = Math.floor(tx);
  tz = Math.floor(tz);
  const start = sz * W + sx;
  const goal = tz * W + tx;
  if (start === goal) return [];
  const g = new Float32Array(W * W).fill(Infinity);
  const from = new Int32Array(W * W).fill(-1);
  const closed = new Uint8Array(W * W);
  const open = [start];
  const f = new Float32Array(W * W).fill(Infinity);
  g[start] = 0;
  f[start] = Math.hypot(tx - sx, tz - sz);
  let n = 0;
  let best = start;
  let bestH = f[start];
  while (open.length && n++ < maxNodes) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (f[open[i]] < f[open[bi]]) bi = i;
    const cur = open[bi];
    open[bi] = open[open.length - 1];
    open.pop();
    if (cur === goal) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    const cx = cur % W;
    const cz = (cur / W) | 0;
    for (const [dx, dz] of DIRS) {
      const nx = cx + dx;
      const nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= W || nz >= W) continue;
      const ni = nz * W + nx;
      if (closed[ni]) continue;
      let c = costFn(nx, nz, dx, dz, cx, cz);
      if (c === Infinity && ni !== goal) continue;
      if (c === Infinity) c = 0;
      if (dx && dz) {
        // 斜走时两侧都得是普通空地
        if (costFn(cx + dx, cz, dx, 0, cx, cz) !== 0 || costFn(cx, cz + dz, 0, dz, cx, cz) !== 0 || c !== 0) continue;
      }
      const ng = g[cur] + (dx && dz ? 1.414 : 1) + c;
      if (ng < g[ni]) {
        g[ni] = ng;
        from[ni] = cur;
        const h = Math.hypot(tx - nx, tz - nz);
        f[ni] = ng + h;
        if (h < bestH) {
          bestH = h;
          best = ni;
        }
        open.push(ni);
      }
    }
  }
  let end = from[goal] >= 0 ? goal : best;
  const path = [];
  while (end !== start && end >= 0) {
    path.push({ x: (end % W) + 0.5, z: ((end / W) | 0) + 0.5 });
    end = from[end];
  }
  return path.reverse();
}

module.exports = { W, buildMap, publicMap, hits, moveCircle, los, findPath, rng, LAYOUTS };
