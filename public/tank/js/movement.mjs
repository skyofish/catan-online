// 客户端预演与服务端结算共用这套移动和碰撞逻辑。
export const DIRECTIONS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
export const STEP = 1 / 40;
export const SHOT_COOLDOWN = 0.29;
const RADIUS = 15;
const SPEED = 185;

export function blocked({ cols, rows, tile, grid, core }, x, y) {
  if (x - RADIUS < 0 || x + RADIUS >= cols * tile || y - RADIUS < 0 || y + RADIUS >= rows * tile) return true;
  const left = Math.floor((x - RADIUS) / tile);
  const right = Math.floor((x + RADIUS) / tile);
  const top = Math.floor((y - RADIUS) / tile) * cols;
  const bottom = Math.floor((y + RADIUS) / tile) * cols;
  return grid[top + left] !== 0 || grid[top + right] !== 0 ||
    grid[bottom + left] !== 0 || grid[bottom + right] !== 0 ||
    (Math.abs(x - core.x) < 35 && Math.abs(y - core.y) < 35);
}

export function move(tank, arena, x, y) {
  if (blocked(arena, x, y)) return false;
  tank.x = x;
  tank.y = y;
  return true;
}

export function drive(tank, arena, dir, dt) {
  if (dir < 0) return;
  tank.dir = dir;
  const [dx, dy] = DIRECTIONS[dir];
  const amount = SPEED * dt;
  if (move(tank, arena, tank.x + dx * amount, tank.y + dy * amount)) return;
  // 进窄巷时把车身轻推向当前格中心。
  const coord = dx ? tank.y : tank.x;
  const offset = (Math.floor(coord / arena.tile) + 0.5) * arena.tile - coord;
  const nudge = Math.sign(offset) * Math.min(Math.abs(offset), amount);
  move(tank, arena, tank.x + dy * nudge, tank.y + dx * nudge);
}
