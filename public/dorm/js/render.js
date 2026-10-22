// 画布渲染：随机生成的宿舍楼俯视图、走动的学生、猛鬼、建筑、各种攻击与交互动画，以及「熄灯」光照。
// 竖屏时把地图转置（走廊变成竖的），保证手机上格子足够大。
import { drawBuilding, drawGhost, drawBed, drawAvatar, drawFurniture, rr } from './sprites.js';

const TILE_PX = 40; // 静态底图的分辨率（每格像素）
const RANGE = { turret: 4.6, thunder: 5.2, frost: 4.2, sword: 2.4, talisman: 4.4, bell: 3.8, trap: 1.8 };
const ATTACKERS = new Set(['turret', 'thunder', 'sword', 'talisman', 'trap']);
const PASS = new Set(['.', 'L', 'E', 'r']);
const FLOORS = [
  ['#3a2a1e', '#2f2218', 'plank'], // 深色木地板
  ['#4a2a20', '#3a2018', 'plank'], // 红木地板
  ['#2e3236', '#25292c', 'tile'], // 灰瓷砖
  ['#3a4026', '#2f341e', 'tatami'], // 发霉的榻榻米
  ['#34302a', '#1e1c1a', 'checker'], // 老式地胶
];

function mulberry(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const easeOutBack = (p) => {
  const c = 1.7;
  return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2);
};

export class Stage {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.dark = document.createElement('canvas');
    this.dctx = this.dark.getContext('2d');
    this.dpr = 1;
    this.cw = 0;
    this.ch = 0;
    this.T = false;
    this.s = 30;
    this.cam = { x: 10, y: 8 };
    this.target = null;
    this.insets = { top: 70, bottom: 90, left: 8, right: 8 };
    this.map = null;
    this.g = null;
    this.rooms = [];
    this.players = new Map();
    this.me = null;
    this.ghostPos = null;
    this.ghostAttack = 0;
    this.ghostHurt = 0;
    this.selected = null;
    this.preview = null;
    this.marker = null; // 走路目标
    this.fx = { bolts: [], parts: [], texts: [], rings: [], flash: [], decals: [], marks: [], shake: 0 };
    this.anim = { pop: new Map(), fire: new Map(), ring: new Map(), snap: new Map(), claim: new Map(), doorShake: new Map(), upgrade: new Map(), chest: [] };
    this.aim = new Map();
    this.charge = new Map();
    this.ambient = new Map();
    this.avatars = new Map();
    this.prevCells = [];
    this.onTap = null;
    this.focusMode = 'all';
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.bindInput();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.last = performance.now();
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = (now) => {
      if (!this.running) return;
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      if (this.map) this.frame(now / 1000, dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  stop() {
    this.running = false;
  }

  // ---------------- 地图 ----------------
  setMap(map) {
    this.map = map;
    this.W = map.W;
    this.H = map.H;
    this.tileRoom = map.tiles.map((row) => new Array(row.length).fill(-1));
    this.cellAt = new Map();
    for (const g of map.rooms) {
      g.cells.forEach(([x, y], idx) => {
        this.tileRoom[y][x] = g.i;
        this.cellAt.set(`${x},${y}`, idx);
      });
      for (const [x, y] of g.bed.tiles) this.tileRoom[y][x] = g.i;
      for (const [x, y] of g.furniture) this.tileRoom[y][x] = g.i;
      this.tileRoom[g.door.y][g.door.x] = g.i;
      const [hx, hy] = g.bed.head;
      g.bed.side = g.bed.w === 2 ? (hx === g.bed.x ? 'l' : 'r') : hy === g.bed.y ? 't' : 'b';
      g.cellC = g.cells.map(([x, y]) => ({ x: x + 0.5, y: y + 0.5 }));
    }
    this.seed = map.W * 131 + map.H * 17 + map.rooms.reduce((s, r) => s + r.door.x * 7 + r.cells.length, 0);
    this.staticLayer = this.buildStatic();
    this.prevCells = [];
    this.avatars.clear();
    this.ghostPos = null;
    this.focusMode = 'me';
    this.userFocused = false;
    this.resize();
  }

  tile(x, y) {
    const row = this.map.tiles[y];
    return row ? row[x] || '#' : '#';
  }

  hitTest(wx, wy) {
    if (!this.map) return null;
    const x = Math.floor(wx);
    const y = Math.floor(wy);
    const c = this.tile(x, y);
    const room = this.tileRoom[y] ? this.tileRoom[y][x] : -1;
    if (c === 'B') return { kind: 'bed', room, x, y };
    if (c === 'D') return { kind: 'door', room, x, y };
    if (this.cellAt.has(`${x},${y}`)) return { kind: 'cell', room, cell: this.cellAt.get(`${x},${y}`), x, y };
    if (PASS.has(c)) return { kind: 'floor', room: room >= 0 ? room : null, x, y };
    if (c === 'F') return { kind: 'furniture', room, x, y };
    return null;
  }

  buildStatic() {
    const map = this.map;
    const c = document.createElement('canvas');
    c.width = map.W * TILE_PX;
    c.height = map.H * TILE_PX;
    const ctx = c.getContext('2d');
    const rnd = mulberry(this.seed);
    ctx.scale(TILE_PX, TILE_PX);
    ctx.fillStyle = '#030203';
    ctx.fillRect(0, 0, map.W, map.H);
    const floorOf = map.rooms.map((r) => FLOORS[(r.i * 7 + this.seed) % FLOORS.length]);
    const T = (x, y) => this.tile(x, y);
    for (let y = 0; y < map.H; y++) {
      for (let x = 0; x < map.W; x++) {
        const t = T(x, y);
        if (t === 'L') {
          ctx.fillStyle = `rgb(${22 + rnd() * 6},${10 + rnd() * 4},${11 + rnd() * 4})`;
          ctx.fillRect(x, y, 1, 1);
        } else if (t === '.' || t === 'E') {
          const odd = (x + y) % 2;
          const v = t === 'E' ? (odd ? 34 : 29) : odd ? 26 : 21;
          ctx.fillStyle = `rgb(${v + rnd() * 4},${v + 3 + rnd() * 4},${v + 1 + rnd() * 3})`;
          ctx.fillRect(x, y, 1, 1);
          ctx.strokeStyle = 'rgba(0,0,0,0.5)';
          ctx.lineWidth = 0.03;
          ctx.strokeRect(x + 0.015, y + 0.015, 0.97, 0.97);
        } else if (t === 'r' || t === 'B' || t === 'F' || t === 'D') {
          const ri = this.tileRoom[y][x];
          const [c1, c2, kind] = ri >= 0 ? floorOf[ri] : FLOORS[0];
          if (t === 'D') {
            ctx.fillStyle = '#1a1416';
            ctx.fillRect(x, y, 1, 1);
            continue;
          }
          ctx.fillStyle = c1;
          ctx.fillRect(x, y, 1, 1);
          ctx.fillStyle = c2;
          if (kind === 'plank') {
            for (let k = 0; k < 2; k++) {
              ctx.globalAlpha = 0.5 + rnd() * 0.5;
              ctx.fillRect(x, y + k * 0.5 + 0.47, 1, 0.03);
              ctx.fillRect(x + ((k + x) % 2 ? 0.3 : 0.75), y + k * 0.5, 0.025, 0.5);
              ctx.globalAlpha = 0.15 * rnd();
              ctx.fillRect(x, y + k * 0.5, 1, 0.47);
            }
            ctx.globalAlpha = 1;
          } else if (kind === 'tile') {
            ctx.fillRect(x, y, 1, 0.03);
            ctx.fillRect(x, y, 0.03, 1);
            ctx.fillRect(x + 0.5, y, 0.02, 1);
            ctx.fillRect(x, y + 0.5, 1, 0.02);
          } else if (kind === 'tatami') {
            ctx.fillRect(x, y, 1, 0.05);
            for (let k = 0; k < 6; k++) {
              ctx.globalAlpha = 0.3;
              ctx.fillRect(x + 0.08, y + 0.12 + k * 0.14, 0.84, 0.02);
            }
            ctx.globalAlpha = 1;
          } else if ((x + y) % 2) ctx.fillRect(x, y, 1, 1);
          // 霉斑
          if (rnd() < 0.08) {
            ctx.fillStyle = `rgba(${rnd() < 0.5 ? '60,70,40' : '70,0,6'},${0.25 + rnd() * 0.3})`;
            ctx.beginPath();
            ctx.ellipse(x + rnd(), y + rnd(), 0.1 + rnd() * 0.25, 0.08 + rnd() * 0.15, rnd() * 3, 0, Math.PI * 2);
            ctx.fill();
          }
        } else {
          const v = 30 + rnd() * 5;
          ctx.fillStyle = `rgb(${v},${v - 2},${v + 3})`;
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }
    // 墙边阴影
    const isWall = (x, y) => T(x, y) === '#';
    for (let y = 0; y < map.H; y++) {
      for (let x = 0; x < map.W; x++) {
        if (!isWall(x, y)) continue;
        ctx.fillStyle = 'rgba(64,62,70,0.9)';
        if (y + 1 < map.H && !isWall(x, y + 1)) ctx.fillRect(x, y + 0.88, 1, 0.12);
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        if (y > 0 && !isWall(x, y - 1)) ctx.fillRect(x, y, 1, 0.08);
        if (x > 0 && !isWall(x - 1, y)) ctx.fillRect(x, y, 0.08, 1);
        if (x + 1 < map.W && !isWall(x + 1, y)) ctx.fillRect(x + 0.92, y, 0.08, 1);
      }
    }
    // 家具
    for (const r of map.rooms) {
      for (const [x, y, kind] of r.furniture) {
        ctx.save();
        ctx.translate(x + 0.5, y + 0.5);
        drawFurniture(ctx, kind);
        ctx.restore();
      }
    }
    // 血池
    const L = map.lair;
    const pool = ctx.createRadialGradient(L.cx, L.cy, 0.2, L.cx, L.cy, 3);
    pool.addColorStop(0, '#5a0006');
    pool.addColorStop(0.6, '#3a0004');
    pool.addColorStop(1, 'rgba(30,0,3,0)');
    ctx.fillStyle = pool;
    ctx.beginPath();
    ctx.ellipse(L.cx, L.cy, 2.1, Math.min(3.4, L.h / 2 - 0.5), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(160,20,24,0.45)';
    ctx.lineWidth = 0.05;
    const ry = Math.min(3.9, L.h / 2 - 0.2);
    ctx.beginPath();
    ctx.ellipse(L.cx, L.cy, 2.4, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.font = '0.5px serif';
    ctx.fillStyle = 'rgba(170,24,30,0.4)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const runes = '敕令鎮煞封魂';
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      ctx.fillText(runes[i % runes.length], L.cx + Math.cos(a) * 2.4, L.cy + Math.sin(a) * ry);
    }
    // 走廊上的血迹与拖痕
    const hall = map.hall;
    for (let i = 0; i < 18; i++) {
      const x = hall.x0 + 0.5 + rnd() * (hall.x1 - hall.x0 - 1);
      const y = hall.y + 0.2 + rnd() * (hall.h - 0.4);
      ctx.fillStyle = `rgba(${70 + rnd() * 40},0,4,${0.25 + rnd() * 0.35})`;
      ctx.beginPath();
      ctx.ellipse(x, y, 0.08 + rnd() * 0.25, 0.05 + rnd() * 0.15, rnd() * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(80,0,6,0.35)';
    ctx.lineWidth = 0.12;
    ctx.beginPath();
    ctx.moveTo(L.cx + 1.6, L.cy + 0.1);
    ctx.bezierCurveTo(L.cx + 5, L.cy - 0.3, L.cx + 7, L.cy + 0.6, L.cx + 10.5, L.cy + 0.2);
    ctx.stroke();
    // 入口：门垫与楼梯
    const E = map.entrance;
    ctx.fillStyle = '#2a3a2a';
    ctx.fillRect(E.x + 0.3, E.y + 1.2, E.w - 0.9, E.h - 2.4);
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 0.06;
    for (let k = 0; k < 5; k++) {
      ctx.beginPath();
      ctx.moveTo(E.x + E.w - 0.95 + k * 0.17, E.y + 0.3);
      ctx.lineTo(E.x + E.w - 0.95 + k * 0.17, E.y + E.h - 0.3);
      ctx.stroke();
    }
    for (let i = 0; i < 3000; i++) {
      ctx.fillStyle = `rgba(0,0,0,${rnd() * 0.35})`;
      ctx.fillRect(rnd() * map.W, rnd() * map.H, 0.04, 0.04);
    }
    return c;
  }

  // ---------------- 镜头 ----------------
  resize() {
    const r = this.cv.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.cw = r.width;
    this.ch = r.height;
    this.cv.width = Math.round(r.width * this.dpr);
    this.cv.height = Math.round(r.height * this.dpr);
    this.dark.width = this.cv.width;
    this.dark.height = this.cv.height;
    this.T = this.ch > this.cw * 1.05;
    if (this.map) this.refocus(true);
  }
  get VW() {
    return this.T ? this.H : this.W;
  }
  get VH() {
    return this.T ? this.W : this.H;
  }
  avail() {
    const i = this.insets;
    return { w: Math.max(50, this.cw - i.left - i.right), h: Math.max(50, this.ch - i.top - i.bottom), cx: i.left + (this.cw - i.left - i.right) / 2, cy: i.top + (this.ch - i.top - i.bottom) / 2 };
  }
  fitScale() {
    const a = this.avail();
    return Math.min(a.w / this.VW, a.h / this.VH);
  }
  toView(x, y) {
    return this.T ? { x: y, y: x } : { x, y };
  }
  w2s(x, y) {
    const v = this.toView(x, y);
    const a = this.avail();
    return { x: (v.x - this.cam.x) * this.s + a.cx, y: (v.y - this.cam.y) * this.s + a.cy };
  }
  s2w(px, py) {
    const a = this.avail();
    const vx = (px - a.cx) / this.s + this.cam.x;
    const vy = (py - a.cy) / this.s + this.cam.y;
    return this.T ? { x: vy, y: vx } : { x: vx, y: vy };
  }
  clampCam() {
    if (!this.map) return;
    const a = this.avail();
    const fs = this.fitScale();
    this.s = Math.max(fs * 0.9, Math.min(Math.max(fs * 4, 100), this.s));
    const halfW = a.w / 2 / this.s;
    const halfH = a.h / 2 / this.s;
    const mx = Math.max(0, this.VW / 2 - halfW + 1);
    const my = Math.max(0, this.VH / 2 - halfH + 1);
    this.cam.x = Math.max(this.VW / 2 - mx, Math.min(this.VW / 2 + mx, this.cam.x));
    this.cam.y = Math.max(this.VH / 2 - my, Math.min(this.VH / 2 + my, this.cam.y));
  }
  frameRect(x0, y0, x1, y1, maxS = 80) {
    const a = this.avail();
    const p0 = this.toView(x0, y0);
    const p1 = this.toView(x1, y1);
    const w = Math.abs(p1.x - p0.x);
    const h = Math.abs(p1.y - p0.y);
    const s = Math.min(a.w / w, a.h / h, maxS);
    return { s: Math.max(s, this.fitScale()), x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
  }
  // 视角：all 全图 / room 自己的宿舍 / me 跟着自己走
  refocus(instant = false) {
    if (!this.map) return;
    let tgt;
    const ri = this.myRoomIndex();
    const meAv = this.me && this.avatars.get(this.me);
    if (this.focusMode === 'room' && ri !== null) {
      const g = this.map.rooms[ri];
      const r = g.rect;
      const hall = this.map.hall;
      const y0 = g.top ? r.y - 1 : hall.y;
      const y1 = g.top ? hall.y + hall.h : r.y + r.h + 1;
      tgt = this.frameRect(r.x - 1.5, y0, r.x + r.w + 1.5, y1);
    } else if (this.focusMode === 'me' && meAv) {
      tgt = this.frameRect(meAv.x - 6, meAv.y - 4.5, meAv.x + 6, meAv.y + 4.5, 70);
    } else {
      tgt = { s: this.fitScale(), x: this.VW / 2, y: this.VH / 2 };
    }
    if (instant || this.reduced) {
      this.s = tgt.s;
      this.cam.x = tgt.x;
      this.cam.y = tgt.y;
      this.target = null;
      this.clampCam();
    } else this.target = tgt;
  }
  ensureVisible(x, y, bottomPx) {
    const p = this.w2s(x, y);
    const top = this.insets.top + 20;
    const bottom = bottomPx - 30;
    if (p.y >= top && p.y <= bottom) return;
    const want = Math.max(top, (top + bottom) / 2);
    this.target = { s: this.s, x: this.cam.x, y: this.cam.y + (p.y - want) / this.s };
  }
  setFocus(mode) {
    this.focusMode = mode;
    this.refocus();
  }
  myRoomIndex() {
    const p = this.me && this.players.get(this.me);
    return p && p.st === 'bed' && p.room !== null && p.room !== undefined ? p.room : null;
  }

  bindInput() {
    const cv = this.cv;
    const pts = new Map();
    let start = null;
    let pinch = null;
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (pts.size === 1) start = { x: e.offsetX, y: e.offsetY, t: performance.now(), cam: { ...this.cam }, moved: 0 };
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: this.s, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
        if (start) start.moved = 99;
      }
    });
    cv.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (pts.size === 2 && pinch) {
        this.target = null;
        this.manual = true;
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        this.zoomAt(pinch.mid.x, pinch.mid.y, (pinch.s * d) / pinch.d / this.s);
        this.panBy(mid.x - pinch.mid.x, mid.y - pinch.mid.y);
        pinch.mid = mid;
      } else if (pts.size === 1 && start) {
        const dx = e.offsetX - start.x;
        const dy = e.offsetY - start.y;
        start.moved = Math.max(start.moved, Math.hypot(dx, dy));
        if (start.moved > 8) {
          this.target = null;
          this.manual = true;
          this.cam.x = start.cam.x - dx / this.s;
          this.cam.y = start.cam.y - dy / this.s;
          this.clampCam();
        }
      }
    });
    const up = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (pts.size === 0 && start) {
        if (start.moved <= 8 && performance.now() - start.t < 600 && this.onTap) {
          const w = this.s2w(e.offsetX, e.offsetY);
          this.onTap(this.hitTest(w.x, w.y), w);
        }
        start = null;
      }
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.target = null;
        this.manual = true;
        this.zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015));
      },
      { passive: false }
    );
  }
  zoomAt(px, py, k) {
    const before = this.s2w(px, py);
    this.s *= k;
    this.clampCam();
    const after = this.s2w(px, py);
    const vb = this.toView(before.x, before.y);
    const va = this.toView(after.x, after.y);
    this.cam.x += vb.x - va.x;
    this.cam.y += vb.y - va.y;
    this.clampCam();
  }
  panBy(dx, dy) {
    this.cam.x -= dx / this.s;
    this.cam.y -= dy / this.s;
    this.clampCam();
  }

  // ---------------- 数据 ----------------
  setState(g, rooms, players, me) {
    const now = performance.now() / 1000;
    const hadRoom = this.myRoomIndex();
    this.g = g;
    this.rooms = rooms;
    this.players = players;
    this.me = me;
    if (!this.ghostPos) this.ghostPos = { x: g.ghost.x, y: g.ghost.y };
    for (const p of players.values()) {
      if (p.x === undefined) continue;
      const a = this.avatars.get(p.id);
      if (!a) this.avatars.set(p.id, { x: p.x, y: p.y, tx: p.x, ty: p.y, walk: 0, moving: false });
      else {
        a.tx = p.x;
        a.ty = p.y;
      }
    }
    // 建筑变化 → 弹出 / 升级动画
    rooms.forEach((r, ri) => {
      if (!r || !r.cells) return;
      const prev = this.prevCells[ri];
      r.cells.forEach((c, idx) => {
        const was = prev && prev[idx];
        if (!prev) return;
        if (c && (!was || was[0] !== c[0])) this.anim.pop.set(`${ri}:${idx}`, now);
        else if (c && was && was[1] < c[1]) this.anim.upgrade.set(`${ri}:${idx}`, now);
      });
      this.prevCells[ri] = r.cells.map((c) => (c ? [...c] : 0));
    });
    const room = this.myRoomIndex();
    if (room !== null && hadRoom === null && !this.userFocused) {
      this.focusMode = 'room';
      this.refocus();
    }
  }

  cellC(ri, idx) {
    return this.map.rooms[ri].cellC[idx];
  }

  // 服务器事件 → 特效
  event(e, now) {
    if (!this.map) return;
    const gp = e.x !== undefined ? { x: e.x, y: e.y } : this.ghostPos || { x: 3, y: 7.5 };
    const R = (i) => this.map.rooms[i];
    const mine = (room) => room === this.myRoomIndex();
    const key = (e.room !== undefined ? e.room : '') + ':' + e.cell;
    switch (e.type) {
      case 'shot': {
        const from = this.cellC(e.room, e.cell);
        this.aim.set(key, Math.atan2(gp.y - from.y, gp.x - from.x));
        this.anim.fire.set(key, now);
        const big = e.kind === 'thunder' || e.kind === 'trap';
        if (e.kind === 'thunder') {
          this.fx.bolts.push({ kind: 'thunder', to: { ...gp }, t0: now, dur: 0.4, seed: Math.random() * 1000 });
          this.fx.flash.push({ t0: now, dur: 0.18, color: '255,240,190', a: 0.35 });
          this.fx.decals.push({ x: gp.x, y: gp.y, t0: now, dur: 3, kind: 'scorch' });
          this.fx.rings.push({ x: gp.x, y: gp.y, t0: now, dur: 0.5, color: '255,240,160', r: 1.6 });
          this.charge.set(key, now);
          this.fx.shake = Math.max(this.fx.shake, 0.2);
          this.burst(gp.x, gp.y, 16, '#fff3b0', 4, 0.06, 0, 0.4);
        } else if (e.kind === 'sword') {
          this.fx.bolts.push({ kind: 'sword', from, to: { ...gp }, t0: now, dur: 0.34 });
        } else if (e.kind === 'talisman') {
          this.fx.bolts.push({ kind: 'talisman', from, to: { ...gp }, t0: now, dur: 0.42, spin: Math.random() * 6 });
          this.charge.set(key, now);
        } else if (e.kind === 'trap') {
          this.anim.snap.set(key, now);
          this.burst(from.x, from.y, 14, '#b9c0c8', 3, 0.05, 2, 0.5);
          this.fx.shake = Math.max(this.fx.shake, 0.12);
          this.fx.marks.push({ x: gp.x, y: gp.y, t0: now, dur: 0.4, kind: 'chomp' });
        } else {
          this.fx.bolts.push({ kind: 'arrow', from, to: { ...gp }, t0: now, dur: 0.13, boost: e.boost });
        }
        this.ghostHurt = 1;
        if (big || mine(e.room)) this.fx.texts.push({ x: gp.x, y: gp.y, dy: -1.1, dx: (Math.random() - 0.5) * 0.6, text: String(e.dmg), color: e.kind === 'thunder' ? '#ffe680' : e.kind === 'talisman' ? '#ffb070' : '#f2e6dc', t0: now + (big ? 0 : 0.12), size: big ? 0.62 : 0.4 });
        break;
      }
      case 'bell': {
        const from = this.cellC(e.room, e.cell);
        this.anim.ring.set(key, now);
        for (let k = 0; k < 3; k++) this.fx.rings.push({ x: from.x, y: from.y, t0: now + k * 0.18, dur: 0.8, color: '255,215,110', r: RANGE.bell });
        this.fx.texts.push({ x: gp.x, y: gp.y, dy: -1.6, text: '定！', color: '#ffe08a', t0: now, size: 0.55 });
        break;
      }
      case 'hitDoor': {
        const d = R(e.room).door;
        this.burst(d.x + 0.5, d.y + 0.5, 6, '#7a5130', 2.5, 0.06, 4, 0.6);
        this.ghostAttack = 1;
        this.anim.doorShake.set(e.room, now);
        this.fx.marks.push({ x: d.x + 0.5, y: d.y + 0.5, t0: now, dur: 0.45, kind: 'claw', rot: Math.random() * 0.6 - 0.3 });
        if (mine(e.room)) this.fx.shake = Math.max(this.fx.shake, 0.12);
        this.fx.texts.push({ x: d.x + 0.5, y: d.y + 0.5, dy: -0.3, text: '-' + e.dmg, color: '#ff6b6b', t0: now, size: 0.36 });
        break;
      }
      case 'doorBroken': {
        const d = R(e.room).door;
        this.burst(d.x + 0.5, d.y + 0.5, 40, '#8a5a32', 5, 0.1, 5, 1.2);
        this.burst(d.x + 0.5, d.y + 0.5, 16, '#2a2a2a', 3, 0.15, 1, 1.5);
        this.fx.rings.push({ x: d.x + 0.5, y: d.y + 0.5, t0: now, dur: 0.6, color: '255,120,60', r: 2 });
        this.fx.shake = Math.max(this.fx.shake, mine(e.room) ? 0.5 : 0.2);
        break;
      }
      case 'hitBed': {
        const b = R(e.room).bed;
        this.burst(b.cx, b.cy, 10, '#a3000c', 2.5, 0.07, 3, 0.9);
        this.ghostAttack = 1;
        this.fx.marks.push({ x: b.cx, y: b.cy, t0: now, dur: 0.45, kind: 'claw', rot: Math.random() });
        if (mine(e.room)) this.fx.shake = Math.max(this.fx.shake, 0.2);
        break;
      }
      case 'kill': {
        const b = R(e.room).bed;
        this.burst(b.cx, b.cy, 60, '#b0000d', 5, 0.11, 2, 1.6);
        this.fx.rings.push({ x: b.cx, y: b.cy, t0: now, dur: 1.2, color: '200,0,10', r: 4 });
        this.fx.decals.push({ x: b.cx, y: b.cy, t0: now, dur: 9999, kind: 'blood' });
        this.fx.flash.push({ t0: now, dur: 0.6, color: '150,0,8', a: mine(e.room) ? 0.7 : 0.35 });
        this.fx.shake = Math.max(this.fx.shake, 0.6);
        break;
      }
      case 'reflect': {
        const g = R(e.room);
        const r = this.rooms[e.room];
        if (r && r.cells) r.cells.forEach((c, idx) => c && c[0] === 'mirror' && this.fx.bolts.push({ kind: 'beam', from: g.cellC[idx], to: { ...gp }, t0: now, dur: 0.35 }));
        this.fx.rings.push({ x: g.door.x + 0.5, y: g.door.y + 0.5, t0: now, dur: 0.4, color: '255,220,120', r: 1.2 });
        this.fx.texts.push({ x: gp.x, y: gp.y, dy: -1.3, text: String(e.dmg), color: '#ffd77a', t0: now, size: 0.36 });
        break;
      }
      case 'scream':
        this.fx.rings.push({ x: gp.x, y: gp.y, t0: now, dur: 1, color: '170,60,255', r: 6 });
        this.fx.rings.push({ x: gp.x, y: gp.y, t0: now + 0.15, dur: 1, color: '120,30,200', r: 4.5 });
        this.fx.flash.push({ t0: now, dur: 0.5, color: '80,0,120', a: 0.3 });
        this.fx.shake = Math.max(this.fx.shake, 0.35);
        break;
      case 'ghostLevel':
        this.fx.rings.push({ x: gp.x, y: gp.y, t0: now, dur: 1.4, color: '220,0,20', r: 3.5 });
        this.burst(gp.x, gp.y, 30, '#5a0008', 3, 0.12, -0.5, 1.4);
        this.fx.texts.push({ x: gp.x, y: gp.y, dy: -1.8, text: `${e.lv} 级`, color: '#ff4d55', t0: now, size: 0.6, long: true });
        break;
      case 'build': {
        const c = this.cellC(e.room, e.cell);
        this.burst(c.x, c.y, 12, e.lv > 1 ? '#ffe39a' : '#9a8a7a', 1.8, 0.05, 1, 0.6);
        this.fx.rings.push({ x: c.x, y: c.y, t0: now, dur: 0.5, color: '255,220,120', r: 0.8 });
        break;
      }
      case 'sell': {
        const c = this.cellC(e.room, e.cell);
        this.burst(c.x, c.y, 14, '#666', 1.6, 0.07, 1.5, 0.6);
        this.burst(c.x, c.y, 6, '#f2cf63', 2, 0.06, 2, 0.6);
        break;
      }
      case 'loot': {
        const c = this.cellC(e.room, e.cell);
        this.anim.chest.push({ x: c.x, y: c.y, t0: now });
        for (let k = 0; k < 18; k++) this.fx.parts.push({ x: c.x, y: c.y, vx: (Math.random() - 0.5) * 2.4, vy: -2 - Math.random() * 2.5, life: 1.1, max: 1.1, color: e.e ? '#ffe680' : '#f2cf63', size: 0.11, grav: 6, coin: true });
        this.fx.texts.push({ x: c.x, y: c.y, dy: -0.6, text: e.e ? `+${e.e} 电` : `+${e.g} 金`, color: e.e ? '#ffe680' : '#f2cf63', t0: now, size: 0.5, long: true });
        break;
      }
      case 'bed':
      case 'door': {
        const g = R(e.room);
        const p = e.type === 'bed' ? { x: g.bed.cx, y: g.bed.cy } : { x: g.door.x + 0.5, y: g.door.y + 0.5 };
        this.fx.rings.push({ x: p.x, y: p.y, t0: now, dur: 0.6, color: '255,220,120', r: 1.2 });
        this.burst(p.x, p.y, 16, '#ffe39a', 1.8, 0.05, -0.8, 0.9);
        this.anim.upgrade.set(e.type + e.room, now);
        break;
      }
      case 'wake':
        this.fx.flash.push({ t0: now, dur: 1.2, color: '160,0,10', a: 0.6 });
        this.fx.rings.push({ x: gp.x, y: gp.y, t0: now, dur: 1.5, color: '220,0,20', r: 8 });
        this.fx.shake = 0.5;
        break;
      case 'ghostDie':
        this.burst(gp.x, gp.y, 80, '#eeeeee', 6, 0.1, -0.5, 2);
        this.fx.flash.push({ t0: now, dur: 1.5, color: '255,255,255', a: 0.8 });
        break;
      case 'claim': {
        const g = R(e.room);
        this.anim.claim.set(e.room, now);
        this.fx.rings.push({ x: g.center.x, y: g.center.y, t0: now, dur: 0.7, color: '255,230,160', r: 2.5 });
        // 门关上的灰尘
        this.burst(g.door.x + 0.5, g.door.y + 0.5, 8, '#6a5a4a', 1.2, 0.06, 1, 0.6);
        break;
      }
      case 'bump': {
        const a = this.avatars.get(e.pid);
        if (a) this.burst(a.tx, a.ty, 8, '#8a7a6a', 1.5, 0.06, 1, 0.5);
        break;
      }
    }
  }

  burst(x, y, n, color, spd = 2, size = 0.07, grav = 3, life = 0.8) {
    if (this.reduced) n = Math.ceil(n / 3);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = spd * (0.3 + Math.random());
      this.fx.parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - spd * 0.3, life: life * (0.6 + Math.random() * 0.6), max: life, color, size: size * (0.6 + Math.random()), grav });
    }
  }

  // ---------------- 每帧 ----------------
  frame(t, dt) {
    const ctx = this.ctx;
    const dpr = this.dpr;
    if (!this.cw) return;
    // 走动的人：平滑移动
    for (const [pid, a] of this.avatars) {
      const d = Math.hypot(a.tx - a.x, a.ty - a.y);
      a.moving = d > 0.03;
      if (d > 3) {
        a.x = a.tx;
        a.y = a.ty;
      } else {
        const k = Math.min(1, dt * 10);
        a.x += (a.tx - a.x) * k;
        a.y += (a.ty - a.y) * k;
      }
      if (a.moving) a.walk += dt;
      if (pid === this.me && this.focusMode === 'me' && !this.manual && !this.target) {
        // 镜头跟着自己
        const v = this.toView(a.x, a.y);
        this.cam.x += (v.x - this.cam.x) * Math.min(1, dt * 4);
        this.cam.y += (v.y - this.cam.y) * Math.min(1, dt * 4);
        this.clampCam();
      }
    }
    if (this.target) {
      const k = Math.min(1, dt * 6);
      this.s += (this.target.s - this.s) * k;
      this.cam.x += (this.target.x - this.cam.x) * k;
      this.cam.y += (this.target.y - this.cam.y) * k;
      if (Math.abs(this.target.s - this.s) < 0.05 && Math.abs(this.target.x - this.cam.x) < 0.005) this.target = null;
      this.clampCam();
    }
    const g = this.g;
    if (g && this.ghostPos) {
      const d = Math.hypot(g.ghost.x - this.ghostPos.x, g.ghost.y - this.ghostPos.y);
      if (d > 4) this.ghostPos = { x: g.ghost.x, y: g.ghost.y };
      else {
        const k = Math.min(1, dt * 10);
        this.ghostPos.x += (g.ghost.x - this.ghostPos.x) * k;
        this.ghostPos.y += (g.ghost.y - this.ghostPos.y) * k;
      }
    }
    this.ghostAttack = Math.max(0, this.ghostAttack - dt * 4);
    this.ghostHurt = Math.max(0, this.ghostHurt - dt * 6);

    let sx = 0;
    let sy = 0;
    if (this.fx.shake > 0 && !this.reduced) {
      const amp = this.fx.shake * 10;
      sx = (Math.random() - 0.5) * amp;
      sy = (Math.random() - 0.5) * amp;
      this.fx.shake = Math.max(0, this.fx.shake - dt * 1.6);
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#030203';
    ctx.fillRect(0, 0, this.cv.width, this.cv.height);
    const a = this.avail();
    const S = this.s * dpr;
    const ox = (a.cx - this.cam.x * this.s + sx) * dpr;
    const oy = (a.cy - this.cam.y * this.s + sy) * dpr;
    const world = () => {
      if (this.T) ctx.setTransform(0, S, S, 0, ox, oy);
      else ctx.setTransform(S, 0, 0, S, ox, oy);
    };
    const upright = (x, y, scale, fn, dy = 0) => {
      const p = this.w2s(x, y);
      ctx.setTransform(S * scale, 0, 0, S * scale, (p.x + sx) * dpr, (p.y + sy + dy * this.s) * dpr);
      fn();
    };
    this.world = world;
    this.upright = upright;

    world();
    ctx.drawImage(this.staticLayer, 0, 0, this.W, this.H);
    this.drawDecals(t);
    this.drawLair(t);
    this.drawEntrance(t);
    this.drawRooms(t, dt);
    this.drawAvatars(t);
    this.drawGhostAndFx(t, dt);
    this.drawLighting(t);
  }

  drawDecals(t) {
    const ctx = this.ctx;
    this.world();
    this.fx.decals = this.fx.decals.filter((d) => t - d.t0 < d.dur);
    for (const d of this.fx.decals) {
      const p = Math.min(1, (t - d.t0) / d.dur);
      if (d.kind === 'scorch') {
        ctx.fillStyle = `rgba(10,6,4,${0.7 * (1 - p)})`;
        ctx.beginPath();
        ctx.ellipse(d.x, d.y, 0.55, 0.4, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = `rgba(255,200,90,${0.5 * (1 - p * 2)})`;
        ctx.lineWidth = 0.03;
        ctx.stroke();
      } else if (d.kind === 'blood') {
        ctx.fillStyle = 'rgba(110,0,6,0.55)';
        ctx.beginPath();
        ctx.ellipse(d.x, d.y, 0.9, 0.6, 0.3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  drawLair(t) {
    const ctx = this.ctx;
    const L = this.map.lair;
    this.world();
    for (let i = 0; i < 3; i++) {
      const p = (t * 0.25 + i / 3) % 1;
      ctx.strokeStyle = `rgba(200,20,30,${0.35 * (1 - p)})`;
      ctx.lineWidth = 0.05;
      ctx.beginPath();
      ctx.ellipse(L.cx, L.cy, 0.3 + p * 1.8, 0.45 + p * 2.6, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    const candles = [
      [L.cx - 1.8, L.cy - 3.6],
      [L.cx + 1.8, L.cy - 3.6],
      [L.cx - 1.8, L.cy + 3.6],
      [L.cx + 1.8, L.cy + 3.6],
      [L.cx, L.cy - 4.4],
      [L.cx, L.cy + 4.4],
    ].filter(([, y]) => y > 1 && y < this.H - 1);
    for (const [x, y] of candles) {
      ctx.fillStyle = '#d9d0b8';
      ctx.fillRect(x - 0.06, y - 0.05, 0.12, 0.25);
      const fl = 0.8 + Math.sin(t * 13 + x * 7) * 0.1 + Math.sin(t * 7.3 + y) * 0.1;
      ctx.fillStyle = `rgba(255,${150 + fl * 60},60,0.95)`;
      ctx.beginPath();
      ctx.ellipse(x, y - 0.12, 0.05 * fl, 0.1 * fl, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawEntrance(t) {
    const ctx = this.ctx;
    const E = this.map.entrance;
    // 绿色的「安全出口」灯牌，偶尔闪
    const on = Math.sin(t * 23) * Math.sin(t * 3.1) > 0.9 ? 0.3 : 1;
    this.upright(E.cx, E.y - 0.5, 1, () => {
      ctx.fillStyle = `rgba(20,120,60,${0.9 * on})`;
      rr(ctx, -0.9, -0.22, 1.8, 0.44, 0.05);
      ctx.fill();
      ctx.fillStyle = `rgba(210,255,220,${on})`;
      ctx.font = '700 0.26px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('安全出口 EXIT', 0, 0.01);
    });
    if (this.g && this.g.phase === 'prep') {
      this.upright(E.cx, E.y + E.h - 0.45, 1, () => {
        ctx.fillStyle = 'rgba(217,192,111,0.75)';
        ctx.font = '600 0.28px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('宿舍楼入口', 0, 0);
      });
    }
  }

  drawRooms(t, dt) {
    const ctx = this.ctx;
    const g = this.g;
    const myRoom = this.myRoomIndex();
    const prep = g && g.phase === 'prep';
    const meWalking = prep && myRoom === null;
    for (const geo of this.map.rooms) {
      const r = this.rooms[geo.i];
      this.world();
      const owner = r && r.owner ? this.players.get(r.owner) : null;
      const rect = geo.rect;
      if (r && r.dead) {
        ctx.fillStyle = 'rgba(60,0,4,0.45)';
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      } else if (owner) {
        ctx.fillStyle = owner.color;
        ctx.globalAlpha = 0.06;
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
        ctx.globalAlpha = 1;
      }
      if (meWalking && r && !r.owner) {
        // 空宿舍：床在闪，提示可以去躺
        const p = 0.45 + Math.sin(t * 4) * 0.3;
        ctx.strokeStyle = `rgba(217,192,111,${p})`;
        ctx.lineWidth = 0.07;
        ctx.setLineDash([0.25, 0.15]);
        ctx.strokeRect(geo.bed.x + 0.04, geo.bed.y + 0.04, geo.bed.w - 0.08, geo.bed.h - 0.08);
        ctx.setLineDash([]);
      }
      // 自己宿舍：格子线
      if (geo.i === myRoom && r && !r.dead) {
        ctx.strokeStyle = 'rgba(217,192,111,0.14)';
        ctx.lineWidth = 0.02;
        for (const [x, y] of geo.cells) ctx.strokeRect(x + 0.04, y + 0.04, 0.92, 0.92);
      }
      // 床
      const claimT = this.anim.claim.get(geo.i);
      const cover = claimT ? Math.min(1, (t - claimT) / 0.8) : 1;
      const sleeper = owner && owner.st === 'bed';
      const upB = this.anim.upgrade.get('bed' + geo.i);
      drawBed(ctx, geo.bed, { head: geo.bed.side, color: sleeper ? owner.color : null, cover, dead: r && r.dead, lv: r && r.bed ? r.bed[0] : 1, t });
      if (upB && t - upB < 0.8) {
        ctx.fillStyle = `rgba(255,230,150,${0.5 * (1 - (t - upB) / 0.8)})`;
        ctx.fillRect(geo.bed.x, geo.bed.y, geo.bed.w, geo.bed.h);
      }
      // 睡着的 Zzz
      if (sleeper && !(r && r.dead) && (!g || g.phase !== 'ended')) {
        const ph = (t * 0.5 + geo.i * 0.37) % 1;
        const [hx, hy] = geo.bed.head;
        this.upright(hx + 0.5, hy + 0.5, 1, () => {
          ctx.globalAlpha = Math.sin(ph * Math.PI) * 0.8;
          ctx.fillStyle = '#cfd8ff';
          ctx.font = `700 ${0.22 + ph * 0.12}px system-ui, sans-serif`;
          ctx.fillText('z', 0.15 + ph * 0.3, -0.25 - ph * 0.5);
          ctx.globalAlpha = 1;
        });
      }
      this.drawDoor(t, geo, r);
      if (r && r.cells) this.drawCells(t, geo, r);
      // 选中格
      if (this.selected && this.selected.room === geo.i && this.selected.cell !== null) {
        const cc = geo.cellC[this.selected.cell];
        this.world();
        ctx.strokeStyle = `rgba(255,230,150,${0.6 + Math.sin(t * 6) * 0.3})`;
        ctx.lineWidth = 0.06;
        ctx.strokeRect(cc.x - 0.47, cc.y - 0.47, 0.94, 0.94);
        const range = this.preview ? RANGE[this.preview] : null;
        if (range) {
          ctx.fillStyle = 'rgba(255,230,150,0.06)';
          ctx.strokeStyle = 'rgba(255,230,150,0.35)';
          ctx.lineWidth = 0.04;
          ctx.setLineDash([0.2, 0.15]);
          ctx.beginPath();
          ctx.arc(cc.x, cc.y, range, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
      // 门牌
      const lx = this.T ? rect.x - 0.5 : rect.x + rect.w / 2;
      const ly = this.T ? rect.y + rect.h / 2 : geo.top ? rect.y - 0.5 : rect.y + rect.h + 0.5;
      this.upright(lx, ly, 1, () => {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const fs = Math.min(0.34, 15 / this.s);
        ctx.font = `600 ${fs}px system-ui, sans-serif`;
        const label = `${geo.i + 1} 号${owner ? ' · ' + owner.name : prep ? ' · 空' : ''}`;
        const w = Math.min(4.8, ctx.measureText(label).width + 0.3);
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        rr(ctx, -w / 2, -fs * 0.7, w, fs * 1.4, 0.06);
        ctx.fill();
        ctx.fillStyle = r && r.dead ? '#8a3a40' : owner ? owner.color : 'rgba(217,192,111,0.7)';
        ctx.fillText(label, 0, 0.01, 4.6);
      });
      if (r && r.bed && r.bed[1] < r.bed[2] && !r.dead) this.bar(geo.bed.cx, geo.bed.cy, r.bed[1] / r.bed[2], '#e05050', 1.3, -0.75);
    }
  }

  drawCells(t, geo, r) {
    const ctx = this.ctx;
    const g = this.g;
    const gp = this.ghostPos;
    const gs = g && g.ghost.state;
    const ghostActive = gp && gs && gs !== 'sleep' && gs !== 'heal' && gs !== 'dead';
    for (let idx = 0; idx < r.cells.length; idx++) {
      const c = r.cells[idx];
      if (!c) continue;
      const [type, lv] = c;
      const cc = geo.cellC[idx];
      const key = `${geo.i}:${idx}`;
      // 弩的朝向（转置时 x、y 互换）
      let aim = this.aim.get(key);
      if (aim === undefined) aim = -Math.PI / 2 + Math.sin(t + idx) * 0.3;
      let sAim = aim;
      if (this.T) sAim = Math.atan2(Math.cos(aim), Math.sin(aim));
      const fireT = this.anim.fire.get(key);
      const recoil = fireT ? Math.max(0, 1 - (t - fireT) / 0.15) : 0;
      const charged = this.charge.get(key);
      const charge = type === 'thunder' ? Math.min(1, charged ? (t - charged) / 3.5 : 1) : type === 'talisman' ? Math.min(1, charged ? (t - charged) / 1.5 : 1) : 0;
      const ringT = this.anim.ring.get(key);
      const ring = ringT ? Math.max(0, 1 - (t - ringT) / 1) : 0;
      const snapT = this.anim.snap.get(key);
      const snap = snapT ? Math.max(0, 1 - (t - snapT) / 0.6) : 0;
      const swing = type === 'sword' && fireT && t - fireT < 0.34 ? (t - fireT) / 0.34 : 0;
      const popT = this.anim.pop.get(key);
      let scale = 1;
      if (popT && t - popT < 0.4) scale = Math.max(0.05, easeOutBack((t - popT) / 0.4));
      this.upright(cc.x, cc.y, scale, () => {
        // 飞出去的剑：原位只剩底座
        if (swing) {
          ctx.globalAlpha = 0.25;
        }
        drawBuilding(ctx, type, lv, { t: t + idx, aim: sAim, stunned: r.stun > 0, charge, recoil, ring, snap: Math.max(snap, 0), swing: 0 });
        ctx.globalAlpha = 1;
      });
      // 升级：金色光柱
      const upT = this.anim.upgrade.get(key);
      if (upT && t - upT < 0.7) {
        const p = (t - upT) / 0.7;
        this.upright(cc.x, cc.y, 1, () => {
          const grd = ctx.createLinearGradient(0, 0.4, 0, -2);
          grd.addColorStop(0, `rgba(255,230,140,${0.6 * (1 - p)})`);
          grd.addColorStop(1, 'rgba(255,230,140,0)');
          ctx.fillStyle = grd;
          ctx.fillRect(-0.35 * (1 - p * 0.5), -2, 0.7 * (1 - p * 0.5), 2.4);
        });
      }
      if (r.dead) continue;
      // 引魂灯：和周围攻击建筑之间的光链
      if (type === 'lantern') {
        const [x, y] = geo.cells[idx];
        this.world();
        geo.cells.forEach(([cx, cy], k) => {
          const o = r.cells[k];
          if (!o || k === idx || !ATTACKERS.has(o[0]) || Math.abs(cx - x) > 1 || Math.abs(cy - y) > 1) return;
          ctx.strokeStyle = `rgba(255,120,60,${0.25 + Math.sin(t * 3 + k) * 0.15})`;
          ctx.lineWidth = 0.05;
          ctx.beginPath();
          ctx.moveTo(cc.x, cc.y);
          ctx.lineTo(cx + 0.5, cy + 0.5);
          ctx.stroke();
        });
      }
      // 环境小动画（按节拍刷）
      const next = this.ambient.get(key) || 0;
      if (t < next) continue;
      const room = this.rooms[geo.i];
      if (type === 'cat') {
        this.ambient.set(key, t + 3 + Math.random());
        this.fx.texts.push({ x: cc.x, y: cc.y, dy: -0.5, text: '+' + [1, 3, 7, 14, 26][lv - 1], color: '#f2cf63', t0: t, size: 0.28 });
        this.fx.parts.push({ x: cc.x + 0.2, y: cc.y - 0.2, vx: 0, vy: -1.2, life: 0.6, max: 0.6, color: '#f2cf63', size: 0.1, grav: 2, coin: true });
      } else if (type === 'generator') {
        this.ambient.set(key, t + 0.8 + Math.random() * 1.2);
        this.fx.bolts.push({ kind: 'spark', from: cc, t0: t, dur: 0.18, seed: Math.random() * 99 });
      } else if (type === 'repair' && room.door && room.door[1] > 0 && room.door[1] < room.door[2]) {
        this.ambient.set(key, t + 0.6);
        this.fx.bolts.push({ kind: 'drop', from: cc, to: { x: geo.door.x + 0.5, y: geo.door.y + 0.5 }, t0: t, dur: 0.7, color: '#7fffd0' });
      } else if (type === 'altar' && room.bed && room.bed[1] < room.bed[2]) {
        this.ambient.set(key, t + 0.7);
        this.fx.bolts.push({ kind: 'drop', from: cc, to: { x: geo.bed.cx, y: geo.bed.cy }, t0: t, dur: 0.8, color: '#ffd8a0' });
      } else if (type === 'frost' && ghostActive && Math.hypot(gp.x - cc.x, gp.y - cc.y) <= RANGE.frost) {
        this.ambient.set(key, t + 0.25);
        this.fx.bolts.push({ kind: 'snow', from: cc, to: { ...gp }, t0: t, dur: 0.6, wob: Math.random() * 6 });
      } else this.ambient.set(key, t + 0.5);
    }
    // 储物柜打开的动画
    this.anim.chest = this.anim.chest.filter((c) => t - c.t0 < 0.8);
    for (const c of this.anim.chest) {
      const p = (t - c.t0) / 0.8;
      this.upright(c.x, c.y, 1, () => {
        ctx.globalAlpha = 1 - p;
        drawBuilding(ctx, 'chest', 1, { t, plate: false, pips: false });
        ctx.fillStyle = `rgba(255,220,120,${0.6 * (1 - p)})`;
        ctx.beginPath();
        ctx.arc(0, 0, 0.3 + p * 0.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      });
    }
  }

  bar(x, y, frac, color, w = 1, dy = 0) {
    const ctx = this.ctx;
    this.upright(
      x,
      y,
      1,
      () => {
        ctx.fillStyle = 'rgba(0,0,0,0.75)';
        ctx.fillRect(-w / 2 - 0.03, -0.07, w + 0.06, 0.14);
        ctx.fillStyle = color;
        ctx.fillRect(-w / 2, -0.04, w * Math.max(0, Math.min(1, frac)), 0.08);
      },
      dy
    );
  }

  drawDoor(t, geo, r) {
    const ctx = this.ctx;
    this.world();
    const x = geo.door.x;
    const y = geo.door.y;
    const lv = r && r.door ? r.door[0] : 1;
    const hp = r && r.door ? r.door[1] : 1;
    const max = r && r.door ? r.door[2] : 1;
    const frac = hp / max;
    if (r && !r.owner) {
      // 没人住：门开着（门板贴在门框一侧）
      ctx.fillStyle = '#6a4428';
      ctx.fillRect(x + 0.02, geo.top ? y + 0.05 : y + 0.05, 0.14, 0.9);
      ctx.fillStyle = 'rgba(255,220,150,0.06)';
      ctx.fillRect(x, y, 1, 1);
      return;
    }
    if (hp <= 0) {
      ctx.fillStyle = '#3a2416';
      ctx.fillRect(x + 0.02, y + 0.35, 0.18, 0.3);
      ctx.fillRect(x + 0.82, y + 0.4, 0.16, 0.22);
      ctx.save();
      ctx.translate(x + 0.5, y + (geo.top ? 1.05 : -0.05));
      ctx.rotate(0.5);
      ctx.fillStyle = '#4a2e1a';
      ctx.fillRect(-0.35, -0.05, 0.6, 0.12);
      ctx.restore();
      return;
    }
    // 被砸时抖动
    const sh = this.anim.doorShake.get(geo.i);
    const jit = sh && t - sh < 0.2 ? (Math.random() - 0.5) * 0.08 * (1 - (t - sh) / 0.2) : 0;
    ctx.save();
    ctx.translate(jit, jit);
    const col = lv >= 7 ? ['#2c2f36', '#8a7240'] : lv >= 4 ? ['#4c5058', '#24272c'] : ['#6a4428', '#3a2414'];
    ctx.fillStyle = col[0];
    ctx.fillRect(x + 0.04, y + 0.28, 0.92, 0.44);
    ctx.strokeStyle = col[1];
    ctx.lineWidth = 0.04;
    ctx.strokeRect(x + 0.08, y + 0.32, 0.84, 0.36);
    if (lv >= 4) {
      ctx.fillStyle = '#9aa0a8';
      for (const k of [0.18, 0.5, 0.82]) {
        ctx.beginPath();
        ctx.arc(x + k, y + 0.5, 0.035, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (lv >= 7) {
      ctx.fillStyle = '#e0c66c';
      ctx.fillRect(x + 0.42, y + 0.26, 0.16, 0.48);
      ctx.strokeStyle = '#a3170e';
      ctx.lineWidth = 0.025;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, y + 0.3);
      ctx.lineTo(x + 0.5, y + 0.7);
      ctx.stroke();
    }
    if (frac < 0.75) {
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.lineWidth = 0.03;
      const n = frac < 0.25 ? 4 : frac < 0.5 ? 3 : 1;
      for (let i = 0; i < n; i++) {
        const cx = x + 0.2 + i * 0.2;
        ctx.beginPath();
        ctx.moveTo(cx, y + 0.3);
        ctx.lineTo(cx + 0.06, y + 0.42);
        ctx.lineTo(cx - 0.03, y + 0.55);
        ctx.lineTo(cx + 0.05, y + 0.7);
        ctx.stroke();
      }
    }
    if (frac < 0.3) {
      ctx.fillStyle = `rgba(255,40,40,${0.15 + Math.sin(t * 8) * 0.1})`;
      ctx.fillRect(x + 0.04, y + 0.28, 0.92, 0.44);
    }
    // 升级时的金属反光扫过
    const up = this.anim.upgrade.get('door' + geo.i);
    if (up && t - up < 0.6) {
      const p = (t - up) / 0.6;
      ctx.fillStyle = 'rgba(255,250,220,0.6)';
      ctx.fillRect(x + 0.04 + p * 0.8, y + 0.28, 0.12, 0.44);
    }
    ctx.restore();
    const g = this.g;
    if (frac < 1 || (g && g.ghost.target === geo.i)) this.bar(x + 0.5, geo.top ? y + 1.15 : y - 0.15, frac, frac < 0.3 ? '#ff4040' : '#d9a441', 1.1);
  }

  drawAvatars(t) {
    const ctx = this.ctx;
    for (const [pid, a] of this.avatars) {
      const p = this.players.get(pid);
      if (!p || p.st === 'bed' || p.alive === false) continue;
      const me = pid === this.me;
      this.upright(a.x, a.y, 1, () => drawAvatar(ctx, { color: p.color, walk: a.walk, moving: a.moving, t: t + pid.length, me }), -0.1);
      this.upright(a.x, a.y, 1, () => {
        const fs = Math.min(0.3, 13 / this.s);
        ctx.font = `600 ${fs}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const w = ctx.measureText(p.name).width + 0.2;
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        rr(ctx, -w / 2, -fs * 0.65, w, fs * 1.3, 0.05);
        ctx.fill();
        ctx.fillStyle = p.color;
        ctx.fillText(p.name, 0, 0.01);
      }, -0.85);
    }
    // 走路目标
    if (this.marker && t - this.marker.t0 < 4) {
      const m = this.marker;
      const p = ((t - m.t0) * 1.5) % 1;
      this.world();
      ctx.strokeStyle = `rgba(255,230,150,${0.8 * (1 - p)})`;
      ctx.lineWidth = 0.05;
      ctx.beginPath();
      ctx.arc(m.x + 0.5, m.y + 0.5, 0.15 + p * 0.35, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  drawGhostAndFx(t, dt) {
    const ctx = this.ctx;
    const g = this.g;
    const fx = this.fx;
    this.world();
    fx.parts = fx.parts.filter((p) => (p.life -= dt) > 0);
    for (const p of fx.parts) {
      p.vy += p.grav * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.96;
      ctx.globalAlpha = Math.min(1, (p.life / p.max) * 1.5);
      ctx.fillStyle = p.color;
      if (p.coin) {
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, p.size * Math.abs(Math.sin(p.life * 12)) + 0.02, p.size, 0, 0, Math.PI * 2);
        ctx.fill();
      } else ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
    // 猛鬼
    if (g && this.ghostPos) {
      const gs = g.ghost.state;
      const gp = this.ghostPos;
      const alpha = gs === 'dead' ? 0 : gs === 'retreat' ? 0.55 : gs === 'heal' ? 0.75 : gs === 'sleep' ? 0.35 + Math.sin(t * 1.5) * 0.15 : 1;
      if (gs === 'heal') {
        this.world();
        ctx.strokeStyle = `rgba(255,30,40,${0.4 + Math.sin(t * 5) * 0.2})`;
        ctx.lineWidth = 0.08;
        ctx.beginPath();
        ctx.arc(gp.x, gp.y, 0.8 + Math.sin(t * 3) * 0.1, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (g.ghost.slow > 0) {
        this.world();
        ctx.fillStyle = `rgba(143,211,255,${0.12 + g.ghost.slow * 0.3})`;
        ctx.beginPath();
        ctx.arc(gp.x, gp.y, 0.7, 0, Math.PI * 2);
        ctx.fill();
      }
      if (g.ghost.root) {
        // 捕鬼夹的铁链
        this.world();
        ctx.strokeStyle = '#8a9098';
        ctx.lineWidth = 0.05;
        ctx.setLineDash([0.08, 0.06]);
        for (let k = 0; k < 4; k++) {
          const a = (k / 4) * Math.PI * 2 + 0.4;
          ctx.beginPath();
          ctx.moveTo(gp.x, gp.y);
          ctx.lineTo(gp.x + Math.cos(a) * 0.7, gp.y + Math.sin(a) * 0.7);
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }
      if (gs === 'hunt' || gs === 'retreat') {
        if (Math.random() < 0.5) fx.parts.push({ x: gp.x + (Math.random() - 0.5) * 0.5, y: gp.y + 0.3, vx: 0, vy: -0.3, life: 0.9, max: 0.9, color: 'rgba(200,200,210,0.25)', size: 0.25, grav: 0 });
      }
      if (g.ghost.burn && Math.random() < 0.7) {
        // 火符灼烧：身上冒火
        fx.parts.push({ x: gp.x + (Math.random() - 0.5) * 0.6, y: gp.y - Math.random() * 0.6, vx: (Math.random() - 0.5) * 0.4, vy: -1.2 - Math.random(), life: 0.5, max: 0.5, color: Math.random() < 0.5 ? '#ff8a2a' : '#ffd060', size: 0.09, grav: -0.5 });
      }
      if (alpha > 0) {
        const stun = g.ghost.stun;
        this.upright(gp.x, gp.y, 1.25, () => drawGhost(ctx, { t: stun ? 0 : t, alpha, hurt: this.ghostHurt, attack: stun ? 0 : this.ghostAttack }), -0.35);
        if (stun) {
          // 定身：额头贴一张黄符，头上转星星
          this.upright(gp.x, gp.y, 1.25, () => {
            ctx.save();
            ctx.rotate(Math.sin(t * 8) * 0.05);
            ctx.fillStyle = '#e6cf74';
            ctx.fillRect(-0.08, -0.72, 0.16, 0.34);
            ctx.strokeStyle = '#a3170e';
            ctx.lineWidth = 0.02;
            ctx.beginPath();
            ctx.moveTo(0, -0.68);
            ctx.lineTo(0, -0.42);
            ctx.moveTo(-0.05, -0.6);
            ctx.lineTo(0.05, -0.6);
            ctx.stroke();
            ctx.restore();
            ctx.fillStyle = '#ffe08a';
            for (let k = 0; k < 3; k++) {
              const a = t * 5 + (k * Math.PI * 2) / 3;
              ctx.beginPath();
              ctx.arc(Math.cos(a) * 0.3, -0.85 + Math.sin(a) * 0.08, 0.04, 0, Math.PI * 2);
              ctx.fill();
            }
          }, -0.35);
        }
      }
      if (gs !== 'sleep' && gs !== 'dead') this.bar(gp.x, gp.y, g.ghost.hp / g.ghost.max, '#d91f2a', 1.2, -1.45);
    }
    // 投射物
    fx.bolts = fx.bolts.filter((b) => {
      const alive = t - b.t0 < b.dur;
      if (!alive && !b.done) {
        b.done = true;
        // 命中的效果
        if (b.kind === 'arrow') this.burst(b.to.x, b.to.y, 5, '#ffe2b0', 2.5, 0.04, 0, 0.25);
        if (b.kind === 'talisman') {
          this.burst(b.to.x, b.to.y, 14, '#ff8a2a', 2.5, 0.07, -1, 0.5);
          this.fx.rings.push({ x: b.to.x, y: b.to.y, t0: t, dur: 0.35, color: '255,140,40', r: 0.9 });
        }
        if (b.kind === 'sword') this.fx.marks.push({ x: b.to.x, y: b.to.y, t0: t - b.dur * 0.5, dur: 0.3, kind: 'slash', rot: Math.random() * 3 });
      }
      return alive;
    });
    for (const b of fx.bolts) {
      const p = Math.max(0, (t - b.t0) / b.dur);
      if (b.kind === 'arrow') {
        this.world();
        const x = b.from.x + (b.to.x - b.from.x) * p;
        const y = b.from.y + (b.to.y - b.from.y) * p;
        const ang = Math.atan2(b.to.y - b.from.y, b.to.x - b.from.x);
        const grd = ctx.createLinearGradient(x - Math.cos(ang) * 0.7, y - Math.sin(ang) * 0.7, x, y);
        grd.addColorStop(0, 'rgba(243,217,168,0)');
        grd.addColorStop(1, b.boost ? 'rgba(255,140,90,0.9)' : 'rgba(243,217,168,0.9)');
        ctx.strokeStyle = grd;
        ctx.lineWidth = 0.06;
        ctx.beginPath();
        ctx.moveTo(x - Math.cos(ang) * 0.7, y - Math.sin(ang) * 0.7);
        ctx.lineTo(x, y);
        ctx.stroke();
      } else if (b.kind === 'sword') {
        // 飞剑：出去再回来，边飞边转，带拖影
        const out = p < 0.5 ? p * 2 : (1 - p) * 2;
        const ease = 1 - Math.pow(1 - out, 2);
        for (let k = 0; k < 4; k++) {
          const e2 = Math.max(0, ease - k * 0.08);
          const x = b.from.x + (b.to.x - b.from.x) * e2;
          const y = b.from.y + (b.to.y - b.from.y) * e2;
          this.upright(x, y, 0.9 - k * 0.1, () => {
            ctx.globalAlpha = k ? 0.25 / k : 1;
            ctx.rotate(t * 25);
            drawBuilding(ctx, 'sword', 1, { plate: false, pips: false, t, swing: 0 });
            ctx.globalAlpha = 1;
          });
        }
      } else if (b.kind === 'talisman') {
        // 火符：抛物线飞过去，边飞边转，尾巴冒火星
        const x = b.from.x + (b.to.x - b.from.x) * p;
        const y = b.from.y + (b.to.y - b.from.y) * p;
        const arc = -Math.sin(p * Math.PI) * 1.2;
        this.upright(x, y, 1, () => {
          ctx.rotate(b.spin + t * 10);
          ctx.fillStyle = '#e6cf74';
          ctx.fillRect(-0.08, -0.15, 0.16, 0.3);
          ctx.strokeStyle = '#a3170e';
          ctx.lineWidth = 0.025;
          ctx.strokeRect(-0.06, -0.12, 0.12, 0.24);
          ctx.fillStyle = 'rgba(255,140,40,0.85)';
          ctx.beginPath();
          ctx.arc(0, 0.15, 0.07, 0, Math.PI * 2);
          ctx.fill();
        }, arc);
        if (Math.random() < 0.6) {
          const w = this.s2w(this.w2s(x, y).x, this.w2s(x, y).y + arc * this.s);
          fx.parts.push({ x: w.x, y: w.y, vx: 0, vy: 0.2, life: 0.3, max: 0.3, color: '#ff8a2a', size: 0.06, grav: 0 });
        }
      } else if (b.kind === 'beam') {
        this.world();
        ctx.strokeStyle = `rgba(255,240,180,${0.8 * (1 - p)})`;
        ctx.lineWidth = 0.12 * (1 - p) + 0.02;
        ctx.beginPath();
        ctx.moveTo(b.from.x, b.from.y);
        ctx.lineTo(b.to.x, b.to.y);
        ctx.stroke();
      } else if (b.kind === 'drop' || b.kind === 'snow') {
        this.world();
        const x = b.from.x + (b.to.x - b.from.x) * p + (b.kind === 'snow' ? Math.sin(p * 6 + b.wob) * 0.15 : 0);
        const y = b.from.y + (b.to.y - b.from.y) * p - Math.sin(p * Math.PI) * (b.kind === 'drop' ? 0.6 : 0.2);
        ctx.fillStyle = b.kind === 'snow' ? `rgba(220,240,255,${1 - p * 0.5})` : b.color;
        ctx.globalAlpha = 1 - p * 0.4;
        if (b.kind === 'snow') {
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(t * 3);
          ctx.fillRect(-0.06, -0.015, 0.12, 0.03);
          ctx.fillRect(-0.015, -0.06, 0.03, 0.12);
          ctx.restore();
        } else {
          ctx.beginPath();
          ctx.arc(x, y, 0.06, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      } else if (b.kind === 'spark') {
        this.world();
        const rnd = mulberry(Math.floor(b.seed + p * 4));
        ctx.strokeStyle = `rgba(255,240,120,${1 - p})`;
        ctx.lineWidth = 0.03;
        ctx.beginPath();
        let x = b.from.x;
        let y = b.from.y - 0.1;
        ctx.moveTo(x, y);
        for (let k = 0; k < 4; k++) {
          x += (rnd() - 0.5) * 0.3;
          y -= 0.1 + rnd() * 0.08;
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      } else if (b.kind === 'thunder') {
        const to = this.w2s(b.to.x, b.to.y);
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        const rnd = mulberry(Math.floor(b.seed + p * 6));
        const top = to.y - 260;
        const drawBolt = (x0, y0, x1, y1, w, n) => {
          ctx.lineWidth = w;
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          const pts = [];
          for (let i = 1; i <= n; i++) {
            const k = i / n;
            const x = x0 + (x1 - x0) * k + (i < n ? (rnd() - 0.5) * 40 * (1 - k * 0.5) : 0);
            const y = y0 + (y1 - y0) * k;
            ctx.lineTo(x, y);
            pts.push([x, y]);
          }
          ctx.stroke();
          return pts;
        };
        ctx.strokeStyle = `rgba(255,250,210,${1 - p})`;
        ctx.shadowColor = '#ffe680';
        ctx.shadowBlur = 20;
        const main = drawBolt(to.x + (rnd() - 0.5) * 60, top, to.x, to.y, 3.5, 9);
        // 分叉
        ctx.strokeStyle = `rgba(255,240,180,${0.7 * (1 - p)})`;
        for (let k = 0; k < 3; k++) {
          const [bx, by] = main[2 + Math.floor(rnd() * 5)];
          drawBolt(bx, by, bx + (rnd() - 0.5) * 120, by + 40 + rnd() * 60, 1.5, 4);
        }
        ctx.shadowBlur = 0;
      }
    }
    // 抓痕、剑痕、夹痕
    fx.marks = fx.marks.filter((m) => t - m.t0 < m.dur);
    for (const m of fx.marks) {
      const p = Math.max(0, (t - m.t0) / m.dur);
      this.upright(m.x, m.y, 1, () => {
        ctx.rotate(m.rot || 0);
        if (m.kind === 'claw') {
          ctx.strokeStyle = `rgba(220,20,30,${1 - p})`;
          ctx.lineWidth = 0.06;
          for (let k = -1; k <= 1; k++) {
            ctx.beginPath();
            ctx.moveTo(-0.35 + k * 0.12, -0.35);
            ctx.quadraticCurveTo(k * 0.12, 0, 0.35 + k * 0.12, 0.35 * Math.min(1, p * 4));
            ctx.stroke();
          }
        } else if (m.kind === 'slash') {
          ctx.strokeStyle = `rgba(255,230,160,${1 - p})`;
          ctx.lineWidth = 0.07 * (1 - p) + 0.01;
          ctx.beginPath();
          ctx.arc(0, 0, 0.5, -0.9, 0.9);
          ctx.stroke();
        } else if (m.kind === 'chomp') {
          ctx.strokeStyle = `rgba(200,210,220,${1 - p})`;
          ctx.lineWidth = 0.05;
          ctx.beginPath();
          for (let i = 0; i <= 6; i++) ctx.lineTo(-0.45 + i * 0.15, i % 2 ? -0.1 : 0.1);
          ctx.stroke();
        }
      });
    }
    // 光环
    this.world();
    fx.rings = fx.rings.filter((r) => t - r.t0 < r.dur);
    for (const r of fx.rings) {
      const p = (t - r.t0) / r.dur;
      if (p < 0) continue;
      ctx.strokeStyle = `rgba(${r.color},${(1 - p) * 0.8})`;
      ctx.lineWidth = 0.1 * (1 - p) + 0.02;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r * (0.2 + p * 0.8), 0, Math.PI * 2);
      ctx.stroke();
    }
    // 飘字
    fx.texts = fx.texts.filter((x) => t - x.t0 < (x.long ? 1.8 : 0.9));
    for (const tx of fx.texts) {
      const p = (t - tx.t0) / (tx.long ? 1.8 : 0.9);
      if (p < 0) continue;
      this.upright(
        tx.x,
        tx.y,
        1,
        () => {
          ctx.globalAlpha = Math.min(1, (1 - p) * 2);
          // 弹出时先放大
          const pop = p < 0.15 ? 0.6 + (p / 0.15) * 0.6 : 1.2 - Math.min(0.2, (p - 0.15) * 0.5);
          ctx.scale(pop, pop);
          ctx.font = `800 ${tx.size}px system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.lineWidth = 0.08;
          ctx.strokeStyle = 'rgba(0,0,0,0.85)';
          ctx.strokeText(tx.text, tx.dx || 0, 0);
          ctx.fillStyle = tx.color;
          ctx.fillText(tx.text, tx.dx || 0, 0);
          ctx.globalAlpha = 1;
        },
        (tx.dy || 0) - p * 0.7
      );
    }
  }

  drawLighting(t) {
    const d = this.dctx;
    const W = this.dark.width;
    const H = this.dark.height;
    const dpr = this.dpr;
    const g = this.g;
    const map = this.map;
    d.globalCompositeOperation = 'source-over';
    d.setTransform(1, 0, 0, 1, 0, 0);
    d.clearRect(0, 0, W, H);
    const night = g && g.phase === 'ended' && g.result && g.result.win ? 0.35 : 0.86;
    d.fillStyle = `rgba(3,1,4,${night})`;
    d.fillRect(0, 0, W, H);
    d.globalCompositeOperation = 'destination-out';
    const hole = (x, y, r, a = 1) => {
      const p = this.w2s(x, y);
      const R = r * this.s * dpr;
      const grd = d.createRadialGradient(p.x * dpr, p.y * dpr, R * 0.05, p.x * dpr, p.y * dpr, R);
      grd.addColorStop(0, `rgba(0,0,0,${a})`);
      grd.addColorStop(0.55, `rgba(0,0,0,${a * 0.55})`);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      d.fillStyle = grd;
      d.fillRect(p.x * dpr - R, p.y * dpr - R, R * 2, R * 2);
    };
    const flick = (k) => {
      const n = Math.sin(t * 17 + k * 13.1) * Math.sin(t * 3.7 + k * 5.3);
      return n > 0.92 ? 0.15 : 0.85 + Math.sin(t * 9 + k) * 0.08;
    };
    const hall = map.hall;
    const hy = hall.y + hall.h / 2;
    let k = 0;
    for (let x = hall.x0 + 3.5; x < hall.x1; x += 6, k++) hole(x, hy, 2.6, k === 2 ? flick(k) * (Math.sin(t * 1.3) > 0.3 ? 1 : 0.2) : flick(k));
    hole(map.entrance.cx, map.entrance.cy, 2.6, 0.75);
    hole(map.lair.cx, map.lair.cy, 3.4, 0.7 + Math.sin(t * 2) * 0.1);
    const myRoom = this.myRoomIndex();
    for (const geo of map.rooms) {
      const r = this.rooms[geo.i];
      if (!r) continue;
      const rad = Math.max(2.4, Math.sqrt(geo.rect.w * geo.rect.h) * 0.8);
      if (r.owner && !r.dead) hole(geo.center.x, geo.center.y, geo.i === myRoom ? rad + 0.6 : rad, flick(geo.i + 5));
      else if (r.dead) hole(geo.center.x, geo.center.y, 1.6, 0.35);
      else if (g && g.phase === 'prep') hole(geo.center.x, geo.center.y, rad * 0.75, 0.45);
    }
    // 走动的人手里的手电
    for (const [pid, a] of this.avatars) {
      const p = this.players.get(pid);
      if (p && p.st !== 'bed' && p.alive !== false) hole(a.x, a.y, pid === this.me ? 2.4 : 1.6, 0.9);
    }
    if (g && this.ghostPos && g.ghost.state !== 'dead') hole(this.ghostPos.x, this.ghostPos.y, 1.8, 0.8);
    for (const b of this.fx.bolts) if (b.kind === 'thunder') hole(b.to.x, b.to.y, 4, 1);
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.dark, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    const glow = (x, y, r, rgb, a) => {
      const p = this.w2s(x, y);
      const R = r * this.s * dpr;
      const grd = ctx.createRadialGradient(p.x * dpr, p.y * dpr, 0, p.x * dpr, p.y * dpr, R);
      grd.addColorStop(0, `rgba(${rgb},${a})`);
      grd.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = grd;
      ctx.fillRect(p.x * dpr - R, p.y * dpr - R, R * 2, R * 2);
    };
    glow(map.lair.cx, map.lair.cy, 3, '120,0,8', 0.35 + Math.sin(t * 2) * 0.08);
    glow(map.entrance.cx, map.entrance.y + 0.5, 2, '20,160,70', 0.22);
    if (g && this.ghostPos && g.ghost.state !== 'dead') glow(this.ghostPos.x, this.ghostPos.y, 1.5, g.ghost.burn ? '200,80,10' : '170,0,10', 0.25);
    for (const geo of map.rooms) {
      const r = this.rooms[geo.i];
      if (!r || !r.owner || r.dead) continue;
      glow(geo.bed.cx, geo.bed.cy, 2.2, '120,80,30', 0.1 * flick(geo.i + 5));
      if (r.cells) r.cells.forEach((c, idx) => c && c[0] === 'lantern' && glow(geo.cellC[idx].x, geo.cellC[idx].y, 1.6, '200,60,20', 0.18 + Math.sin(t * 3 + idx) * 0.04));
    }
    ctx.globalCompositeOperation = 'source-over';
    this.fx.flash = this.fx.flash.filter((f) => t - f.t0 < f.dur);
    for (const f of this.fx.flash) {
      const p = (t - f.t0) / f.dur;
      ctx.fillStyle = `rgba(${f.color},${f.a * (1 - p)})`;
      ctx.fillRect(0, 0, this.cv.width, this.cv.height);
    }
    const vg = ctx.createRadialGradient(this.cv.width / 2, this.cv.height / 2, Math.min(this.cv.width, this.cv.height) * 0.35, this.cv.width / 2, this.cv.height / 2, Math.max(this.cv.width, this.cv.height) * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.75)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, this.cv.width, this.cv.height);
  }
}
