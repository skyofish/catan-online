'use strict';
// 猛鬼宿舍：每局随机生成的宿舍楼，以及通用的格子寻路。
//
// 布局：左边是猛鬼的血池，右边是宿舍楼入口（玩家开局集合的地方），中间一条 3 格宽的走廊，
// 走廊上下各 4 间宿舍。每间宿舍的宽度、进深、门的位置、床的位置都随机；
// 有的宿舍缺一个角（L 形），有的摆着衣柜书桌（不能建造）。生成时检查：
//   - 可用面积在 MAPGEN.area 范围内，可建造的格子不少于 MAPGEN.minCells
//   - 从门口能走到每一块地面和床边（家具、床不会把屋子隔断）
//
// 地块字符：# 墙  . 走廊  L 血池  E 入口  r 宿舍地面  D 门  B 床  F 家具
const { MAPGEN, ROOMS } = require('./config');

const DIRS4 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const DIRS8 = [...DIRS4, [1, 1], [1, -1], [-1, 1], [-1, -1]];
const FURNITURE = ['wardrobe', 'desk', 'shelf'];

const ri = (rng, a, b) => a + Math.floor(rng() * (b - a + 1));
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

// ---------------- 单间宿舍 ----------------
// 在局部坐标里生成：x 0..w-1，y 0..d-1，y = d-1 是靠走廊的一排（门在它外面）
function makeRoomLocal(rng) {
  for (let tries = 0; tries < 200; tries++) {
    const w = ri(rng, MAPGEN.roomW[0], MAPGEN.roomW[1]);
    const d = ri(rng, MAPGEN.roomD[0], MAPGEN.roomD[1]);
    if (w * d < MAPGEN.area[0] || w * d > MAPGEN.area[1] + 8) continue;
    const g = Array.from({ length: d }, () => new Array(w).fill('r'));
    // 缺角：后排的一个角变成墙
    if (w >= 4 && d >= 4 && rng() < 0.45) {
      const nw = ri(rng, 1, Math.max(1, Math.floor(w / 2)));
      const nd = ri(rng, 1, Math.max(1, Math.floor(d / 2) - 0));
      const left = rng() < 0.5;
      for (let y = 0; y < nd; y++) for (let x = 0; x < nw; x++) g[y][left ? x : w - 1 - x] = '#';
    }
    const floor = () => g.flat().filter((c) => c === 'r').length;
    if (floor() < MAPGEN.area[0] || floor() > MAPGEN.area[1]) continue;
    const doorX = ri(rng, 0, w - 1);
    const inside = { x: doorX, y: d - 1 };
    if (g[inside.y][inside.x] !== 'r') continue;
    const isWall = (x, y) => x < 0 || y < 0 || x >= w || y >= d || g[y][x] === '#';
    const dist = bfsLocal(g, inside);
    // 床：两格，横放或竖放，靠墙，离门越远越好
    const beds = [];
    for (let y = 0; y < d; y++) {
      for (let x = 0; x < w; x++) {
        for (const [dx, dy] of [
          [1, 0],
          [0, 1],
        ]) {
          const x2 = x + dx;
          const y2 = y + dy;
          if (isWall(x, y) || isWall(x2, y2) || g[y][x] !== 'r' || g[y2][x2] !== 'r') continue;
          if ((x === inside.x && y === inside.y) || (x2 === inside.x && y2 === inside.y)) continue;
          // 床头那一格要贴墙
          const wallsA = DIRS4.filter(([a, b]) => isWall(x + a, y + b)).length;
          const wallsB = DIRS4.filter(([a, b]) => isWall(x2 + a, y2 + b)).length;
          if (!wallsA && !wallsB) continue;
          const dd = Math.min(dist[y][x], dist[y2][x2]);
          if (dd < 2) continue;
          beds.push({ x, y, x2, y2, horiz: dx === 1, head: wallsA >= wallsB ? 0 : 1, score: dd + rng() * 1.5 });
        }
      }
    }
    if (!beds.length) continue;
    beds.sort((a, b) => b.score - a.score);
    const bed = beds[Math.min(beds.length - 1, Math.floor(rng() * 2))];
    g[bed.y][bed.x] = 'B';
    g[bed.y2][bed.x2] = 'B';
    // 家具：0–2 件靠墙摆放
    const furniture = [];
    const nF = rng() < 0.3 ? 0 : rng() < 0.6 ? 1 : 2;
    for (let k = 0; k < nF; k++) {
      const spots = [];
      for (let y = 0; y < d; y++)
        for (let x = 0; x < w; x++) {
          if (g[y][x] !== 'r' || (x === inside.x && y >= d - 2 && Math.abs(x - inside.x) <= 0)) continue;
          if (Math.abs(x - inside.x) <= 1 && y === d - 1) continue;
          if (DIRS4.some(([a, b]) => isWall(x + a, y + b))) spots.push({ x, y });
        }
      if (!spots.length) break;
      const s = pick(rng, spots);
      g[s.y][s.x] = 'F';
      if (!connected(g, inside)) {
        g[s.y][s.x] = 'r';
        continue;
      }
      furniture.push({ x: s.x, y: s.y, kind: pick(rng, FURNITURE) });
    }
    if (!connected(g, inside)) continue;
    // 床边可以站人（猛鬼攻击床、玩家上床）的地面
    const dist2 = bfsLocal(g, inside);
    let front = null;
    for (const [bx, by] of [
      [bed.x, bed.y],
      [bed.x2, bed.y2],
    ]) {
      for (const [a, b] of DIRS4) {
        const x = bx + a;
        const y = by + b;
        if (isWall(x, y) || g[y][x] !== 'r') continue;
        if (!front || dist2[y][x] < dist2[front.y][front.x]) front = { x, y };
      }
    }
    if (!front) continue;
    const cells = g.flat().filter((c) => c === 'r').length;
    if (cells < MAPGEN.minCells) continue;
    return { w, d, g, doorX, bed, front, furniture };
  }
  throw new Error('宿舍生成失败');
}

function bfsLocal(g, start) {
  const d = g.length;
  const w = g[0].length;
  const dist = Array.from({ length: d }, () => new Array(w).fill(Infinity));
  dist[start.y][start.x] = 0;
  const q = [start];
  while (q.length) {
    const p = q.shift();
    for (const [a, b] of DIRS4) {
      const x = p.x + a;
      const y = p.y + b;
      if (x < 0 || y < 0 || x >= w || y >= d || g[y][x] !== 'r' || dist[y][x] !== Infinity) continue;
      dist[y][x] = dist[p.y][p.x] + 1;
      q.push({ x, y });
    }
  }
  return dist;
}

// 所有地面都能从门口走到，床至少有一格挨着能走到的地面
function connected(g, inside) {
  const dist = bfsLocal(g, inside);
  for (let y = 0; y < g.length; y++) for (let x = 0; x < g[0].length; x++) if (g[y][x] === 'r' && dist[y][x] === Infinity) return false;
  for (let y = 0; y < g.length; y++)
    for (let x = 0; x < g[0].length; x++) {
      if (g[y][x] !== 'B') continue;
      if (!DIRS4.some(([a, b]) => dist[y + b] && dist[y + b][x + a] < Infinity)) return false;
    }
  return true;
}

// ---------------- 整栋楼 ----------------
function generateMap(rng = Math.random) {
  const half = ROOMS / 2;
  const tops = Array.from({ length: half }, () => makeRoomLocal(rng));
  const bots = Array.from({ length: half }, () => makeRoomLocal(rng));
  const topDepth = Math.max(...tops.map((r) => r.d));
  const botDepth = Math.max(...bots.map((r) => r.d));
  const hy = topDepth + 2; // 走廊第一行
  const hb = hy + MAPGEN.hallH; // 下排宿舍的门所在的墙
  const H = hb + botDepth + 2;
  const x0 = MAPGEN.lairW + 1;
  const rowW = (list) => list.reduce((s, r) => s + r.w + 1, 0);
  const hallEnd = x0 + Math.max(rowW(tops), rowW(bots)); // 走廊结束、入口开始的 x
  const W = hallEnd + MAPGEN.entranceW + 1;
  const T = Array.from({ length: H }, () => new Array(W).fill('#'));
  const set = (x, y, c) => (T[y][x] = c);

  // 血池
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < MAPGEN.lairW; x++) set(x, y, 'L');
  // 走廊（从血池一直通到入口）
  for (let y = hy; y < hy + MAPGEN.hallH; y++) for (let x = MAPGEN.lairW; x < hallEnd; x++) set(x, y, '.');
  // 入口：比走廊高一些的门厅
  for (let y = hy - 1; y <= hy + MAPGEN.hallH; y++) for (let x = hallEnd; x < W - 1; x++) set(x, y, 'E');

  const rooms = [];
  const place = (list, top) => {
    let cx = x0;
    for (const L of list) {
      const i = rooms.length;
      // 局部 y=d-1 靠走廊：上排宿舍朝下开门，下排宿舍朝上开门（翻转）
      const toWorld = (lx, ly) => (top ? { x: cx + lx, y: hy - 1 - (L.d - ly) } : { x: cx + lx, y: hb + (L.d - ly) });
      const cells = [];
      const furniture = [];
      for (let ly = 0; ly < L.d; ly++)
        for (let lx = 0; lx < L.w; lx++) {
          const c = L.g[ly][lx];
          const p = toWorld(lx, ly);
          if (c === '#') continue;
          set(p.x, p.y, c);
          if (c === 'r') cells.push([p.x, p.y]);
        }
      for (const f of L.furniture) {
        const p = toWorld(f.x, f.y);
        furniture.push([p.x, p.y, f.kind]);
      }
      const door = { x: cx + L.doorX, y: top ? hy - 1 : hb };
      set(door.x, door.y, 'D');
      const b1 = toWorld(L.bed.x, L.bed.y);
      const b2 = toWorld(L.bed.x2, L.bed.y2);
      const front = toWorld(L.front.x, L.front.y);
      const head = L.bed.head === 0 ? b1 : b2;
      const outside = { x: door.x, y: top ? hy : hy + MAPGEN.hallH - 1 };
      const inside = { x: door.x, y: top ? hy - 2 : hb + 1 };
      cells.sort((a, b) => Math.abs(a[0] - door.x) + Math.abs(a[1] - door.y) - (Math.abs(b[0] - door.x) + Math.abs(b[1] - door.y)) || a[1] - b[1] || a[0] - b[0]);
      const floorAll = [...cells, [b1.x, b1.y], [b2.x, b2.y], ...furniture.map((f) => [f[0], f[1]])];
      const center = {
        x: floorAll.reduce((s, c) => s + c[0] + 0.5, 0) / floorAll.length,
        y: floorAll.reduce((s, c) => s + c[1] + 0.5, 0) / floorAll.length,
      };
      rooms.push({
        i,
        top,
        rect: { x: cx, y: top ? hy - 1 - L.d : hb + 1, w: L.w, h: L.d },
        door,
        outside,
        inside,
        // 猛鬼砸门时站的位置：门外那格，稍微贴近门
        atkDoor: { x: door.x + 0.5, y: top ? hy + 0.35 : hy + MAPGEN.hallH - 0.35 },
        hallPt: { x: door.x + 0.5, y: hy + MAPGEN.hallH / 2 },
        bed: { tiles: [[b1.x, b1.y], [b2.x, b2.y]], head: [head.x, head.y], x: Math.min(b1.x, b2.x), y: Math.min(b1.y, b2.y), w: b1.x === b2.x ? 1 : 2, h: b1.x === b2.x ? 2 : 1, cx: (b1.x + b2.x) / 2 + 0.5, cy: (b1.y + b2.y) / 2 + 0.5 },
        front: [front.x, front.y],
        atkBed: { x: front.x + 0.5, y: front.y + 0.5 },
        cells,
        furniture,
        center,
      });
      cx += L.w + 1;
    }
  };
  place(tops, true);
  place(bots, false);

  return {
    W,
    H,
    tiles: T.map((r) => r.join('')),
    hall: { y: hy, h: MAPGEN.hallH, x0: MAPGEN.lairW, x1: hallEnd },
    lair: { x: 1, y: 1, w: MAPGEN.lairW - 1, h: H - 2, cx: MAPGEN.lairW / 2, cy: hy + MAPGEN.hallH / 2 },
    entrance: { x: hallEnd, y: hy - 1, w: MAPGEN.entranceW, h: MAPGEN.hallH + 2, cx: hallEnd + MAPGEN.entranceW / 2, cy: hy + MAPGEN.hallH / 2 },
    rooms,
  };
}

// ---------------- 寻路 ----------------
// passable(x, y) 判断格子能否通过；返回从 from（坐标）到 to（格子）的路径点（格子中心），已拉直
function findPath(map, from, to, passable) {
  const W = map.W;
  const sx = Math.floor(from.x);
  const sy = Math.floor(from.y);
  const key = (x, y) => y * W + x;
  if (sx === to.x && sy === to.y) return [{ x: to.x + 0.5, y: to.y + 0.5 }];
  const prev = new Map([[key(sx, sy), -1]]);
  const q = [[sx, sy]];
  let found = false;
  while (q.length) {
    const [x, y] = q.shift();
    if (x === to.x && y === to.y) {
      found = true;
      break;
    }
    for (const [a, b] of DIRS8) {
      const nx = x + a;
      const ny = y + b;
      if (nx < 0 || ny < 0 || nx >= W || ny >= map.H || prev.has(key(nx, ny))) continue;
      const isTarget = nx === to.x && ny === to.y;
      if (!isTarget && !passable(nx, ny)) continue;
      // 斜着走不能穿墙角
      if (a && b && (!passable(x + a, y) || !passable(x, y + b))) continue;
      prev.set(key(nx, ny), key(x, y));
      q.push([nx, ny]);
    }
  }
  if (!found) return null;
  const pts = [];
  for (let k = key(to.x, to.y); k !== -1 && k !== key(sx, sy); k = prev.get(k)) pts.push({ x: (k % W) + 0.5, y: Math.floor(k / W) + 0.5 });
  pts.reverse();
  // 拉直：能直线走到就跳过中间的点
  const out = [];
  let cur = { x: from.x, y: from.y };
  let i = 0;
  while (i < pts.length) {
    let j = pts.length - 1;
    while (j > i && !lineClear(cur, pts[j], passable, to)) j--;
    out.push(pts[j]);
    cur = pts[j];
    i = j + 1;
  }
  return out;
}

function lineClear(a, b, passable, to) {
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.ceil(d / 0.2);
  for (let k = 1; k < n; k++) {
    const t = k / n;
    // 身体有一点宽度：检查两侧
    for (const off of [-0.3, 0.3]) {
      const nx = -(b.y - a.y) / (d || 1);
      const ny = (b.x - a.x) / (d || 1);
      const x = Math.floor(a.x + (b.x - a.x) * t + nx * off);
      const y = Math.floor(a.y + (b.y - a.y) * t + ny * off);
      if (to && x === to.x && y === to.y) continue;
      if (!passable(x, y)) return false;
    }
  }
  return true;
}

module.exports = { generateMap, findPath, makeRoomLocal };
