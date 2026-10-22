// 地图几何：与服务器 server/games/dorm/config.js 的 roomGeom 保持一致
export const MAP = { W: 31, H: 15, lair: { cx: 3, cy: 7.5 } };
export const ROOMS = 8;
export const CELLS = 20;
export const BUILD_TYPES = ['turret', 'thunder', 'frost', 'mirror', 'repair', 'generator'];

export function roomGeom(i) {
  const top = i < 4;
  const c = i % 4;
  const x0 = 7 + c * 6;
  const doorX = x0 + 2;
  const cellXY = (idx) => {
    const r = Math.floor(idx / 5);
    const k = idx % 5;
    return { x: x0 + k, y: top ? 1 + r : 13 - r };
  };
  return {
    i,
    top,
    col: c,
    x0,
    y0: top ? 1 : 10,
    doorX,
    doorY: top ? 5 : 9,
    door: { x: doorX + 0.5, y: top ? 5.5 : 9.5 },
    atkDoor: { x: doorX + 0.5, y: top ? 6.35 : 8.65 },
    bedCells: [0, 1],
    bedRect: { x: x0, y: top ? 1 : 13, w: 2, h: 1 },
    center: { x: x0 + 2.5, y: top ? 3 : 12 },
    cellXY,
    cellCenter: (idx) => {
      const p = cellXY(idx);
      return { x: p.x + 0.5, y: p.y + 0.5 };
    },
    // 宿舍内部矩形（含床）
    rect: { x: x0, y: top ? 1 : 10, w: 5, h: 4 },
  };
}

export const GEOM = Array.from({ length: ROOMS }, (_, i) => roomGeom(i));

// 世界坐标落在哪个宿舍的哪个格子
export function hitTest(x, y) {
  for (const g of GEOM) {
    const r = g.rect;
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) {
      const k = Math.floor(x - g.x0);
      const row = g.top ? Math.floor(y) - 1 : 13 - Math.floor(y);
      const idx = row * 5 + k;
      return { room: g.i, cell: idx >= 0 && idx < CELLS ? idx : null };
    }
    // 门所在的格子也算这间宿舍
    if (Math.floor(x) === g.doorX && Math.floor(y) === g.doorY) return { room: g.i, cell: null };
  }
  return null;
}
