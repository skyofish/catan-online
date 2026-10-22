// 画布渲染：宿舍楼俯视图、猛鬼、建筑、特效与「熄灯」光照。
// 竖屏时把地图转置（走廊变成竖的），保证手机上格子足够大。
import { MAP, GEOM, CELLS, BUILD_TYPES, hitTest } from './geom.js';
import { drawBuilding, drawGhost, drawBed, rr } from './sprites.js';

const TILE_PX = 48; // 静态底图的分辨率（每格像素）
const RANGE = { turret: 4.6, thunder: 5.2, frost: 4.2 };

// 简单可复现的随机数（底图花纹）
function mulberry(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tileType(x, y) {
  if (x < 0 || y < 0 || x >= MAP.W || y >= MAP.H) return 'void';
  if (x < 6) {
    if (x === 0 || y === 0 || y === MAP.H - 1) return 'wall';
    return 'lair';
  }
  if (y >= 6 && y <= 8) return x === MAP.W - 1 ? 'wall' : 'hall';
  for (const g of GEOM) {
    const r = g.rect;
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return 'room';
    if (x === g.doorX && y === g.doorY) return 'door';
  }
  return 'wall';
}

export class Stage {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.dark = document.createElement('canvas');
    this.dctx = this.dark.getContext('2d');
    this.dpr = 1;
    this.cw = 0;
    this.ch = 0;
    this.T = false; // 竖屏转置
    this.s = 30;
    this.cam = { x: MAP.W / 2, y: MAP.H / 2 };
    this.target = null; // 镜头动画目标 { s, x, y }
    this.insets = { top: 70, bottom: 90, left: 8, right: 8 };
    this.g = null; // 最新对局状态
    this.rooms = [];
    this.players = new Map();
    this.me = null;
    this.ghostPos = null;
    this.ghostAttack = 0;
    this.ghostHurt = 0;
    this.selected = null; // { room, cell }
    this.preview = null; // { type, cell } 建造范围预览
    this.fx = { bolts: [], parts: [], texts: [], rings: [], flash: [], shake: 0 };
    this.aim = new Map();
    this.charge = new Map();
    this.onTap = null;
    this.focusMode = 'all';
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.staticLayer = this.buildStatic();
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
      this.frame(now / 1000, dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  stop() {
    this.running = false;
  }

  // ---------------- 底图 ----------------
  buildStatic() {
    const c = document.createElement('canvas');
    c.width = MAP.W * TILE_PX;
    c.height = MAP.H * TILE_PX;
    const ctx = c.getContext('2d');
    const rnd = mulberry(20261031);
    ctx.scale(TILE_PX, TILE_PX);
    ctx.fillStyle = '#030203';
    ctx.fillRect(0, 0, MAP.W, MAP.H);
    for (let y = 0; y < MAP.H; y++) {
      for (let x = 0; x < MAP.W; x++) {
        const t = tileType(x, y);
        if (t === 'lair') {
          ctx.fillStyle = `rgb(${22 + rnd() * 6},${10 + rnd() * 4},${11 + rnd() * 4})`;
          ctx.fillRect(x, y, 1, 1);
        } else if (t === 'hall' || t === 'door') {
          const odd = (x + y) % 2;
          const v = odd ? 26 : 21;
          ctx.fillStyle = `rgb(${v + rnd() * 4},${v + 3 + rnd() * 4},${v + 1 + rnd() * 3})`;
          ctx.fillRect(x, y, 1, 1);
          ctx.strokeStyle = 'rgba(0,0,0,0.5)';
          ctx.lineWidth = 0.03;
          ctx.strokeRect(x + 0.015, y + 0.015, 0.97, 0.97);
        } else if (t === 'room') {
          // 木地板
          for (let k = 0; k < 2; k++) {
            const v = 34 + rnd() * 10;
            ctx.fillStyle = `rgb(${v + 8},${v - 4},${v - 14})`;
            ctx.fillRect(x, y + k * 0.5, 1, 0.5);
            ctx.fillStyle = 'rgba(0,0,0,0.45)';
            ctx.fillRect(x, y + k * 0.5 + 0.47, 1, 0.03);
            ctx.fillRect(x + ((k + x) % 2 ? 0.3 : 0.75), y + k * 0.5, 0.025, 0.5);
          }
        } else if (t === 'wall') {
          const v = 30 + rnd() * 5;
          ctx.fillStyle = `rgb(${v},${v - 2},${v + 3})`;
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }
    // 墙与地面交界的阴影
    for (let y = 0; y < MAP.H; y++) {
      for (let x = 0; x < MAP.W; x++) {
        if (tileType(x, y) !== 'wall') continue;
        ctx.fillStyle = 'rgba(60,58,66,0.9)';
        if (tileType(x, y + 1) !== 'wall' && tileType(x, y + 1) !== 'void') ctx.fillRect(x, y + 0.9, 1, 0.1);
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        if (tileType(x, y - 1) !== 'wall' && tileType(x, y - 1) !== 'void') ctx.fillRect(x, y, 1, 0.08);
        if (tileType(x - 1, y) !== 'wall' && tileType(x - 1, y) !== 'void') ctx.fillRect(x, y, 0.08, 1);
        if (tileType(x + 1, y) !== 'wall' && tileType(x + 1, y) !== 'void') ctx.fillRect(x + 0.92, y, 0.08, 1);
      }
    }
    // 血池
    const pool = ctx.createRadialGradient(3, 7.5, 0.2, 3, 7.5, 3);
    pool.addColorStop(0, '#5a0006');
    pool.addColorStop(0.6, '#3a0004');
    pool.addColorStop(1, 'rgba(30,0,3,0)');
    ctx.fillStyle = pool;
    ctx.beginPath();
    ctx.ellipse(3, 7.5, 2.1, 3.4, 0, 0, Math.PI * 2);
    ctx.fill();
    // 血池周围的符咒圈
    ctx.strokeStyle = 'rgba(160,20,24,0.45)';
    ctx.lineWidth = 0.05;
    ctx.beginPath();
    ctx.ellipse(3, 7.5, 2.5, 3.9, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.font = '0.5px serif';
    ctx.fillStyle = 'rgba(170,24,30,0.4)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const runes = '敕令鎮煞封魂';
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      ctx.fillText(runes[i % runes.length], 3 + Math.cos(a) * 2.5, 7.5 + Math.sin(a) * 3.9);
    }
    // 走廊上的血迹与拖痕
    for (let i = 0; i < 14; i++) {
      const x = 6.5 + rnd() * 24;
      const y = 6.2 + rnd() * 2.6;
      ctx.fillStyle = `rgba(${70 + rnd() * 40},0,4,${0.25 + rnd() * 0.35})`;
      ctx.beginPath();
      ctx.ellipse(x, y, 0.08 + rnd() * 0.25, 0.05 + rnd() * 0.15, rnd() * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(80,0,6,0.35)';
    ctx.lineWidth = 0.12;
    ctx.beginPath();
    ctx.moveTo(4.6, 7.6);
    ctx.bezierCurveTo(8, 7.2, 10, 8.1, 13.5, 7.7);
    ctx.stroke();
    // 噪点
    for (let i = 0; i < 2600; i++) {
      ctx.fillStyle = `rgba(0,0,0,${rnd() * 0.35})`;
      ctx.fillRect(rnd() * MAP.W, rnd() * MAP.H, 0.04, 0.04);
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
    const T = this.ch > this.cw * 1.05;
    this.T = T;
    this.refocus(true);
  }

  get VW() {
    return this.T ? MAP.H : MAP.W;
  }
  get VH() {
    return this.T ? MAP.W : MAP.H;
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
    const a = this.avail();
    const fs = this.fitScale();
    this.s = Math.max(fs * 0.9, Math.min(Math.max(fs * 4, 110), this.s));
    const halfW = a.w / 2 / this.s;
    const halfH = a.h / 2 / this.s;
    const mx = Math.max(0, this.VW / 2 - halfW + 1);
    const my = Math.max(0, this.VH / 2 - halfH + 1);
    this.cam.x = Math.max(this.VW / 2 - mx, Math.min(this.VW / 2 + mx, this.cam.x));
    this.cam.y = Math.max(this.VH / 2 - my, Math.min(this.VH / 2 + my, this.cam.y));
  }
  // 全图或聚焦自己的宿舍
  refocus(instant = false) {
    let tgt;
    if (this.focusMode === 'room' && this.myRoomIndex() !== null) {
      const g = GEOM[this.myRoomIndex()];
      // 宿舍 + 整条走廊（能看到门外的猛鬼和对面的宿舍门）
      const y0 = g.top ? 0 : 5.6;
      const y1 = g.top ? 9.4 : 15;
      const a = this.avail();
      const p0 = this.toView(g.x0 - 1.2, y0);
      const p1 = this.toView(g.x0 + 6.2, y1);
      const w = Math.abs(p1.x - p0.x);
      const h = Math.abs(p1.y - p0.y);
      const s = Math.min(a.w / w, a.h / h, 80);
      tgt = { s: Math.max(s, this.fitScale()), x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
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
  // 让世界坐标 (x,y) 落在 [top, bottom] 屏幕范围内（弹出面板挡住时用）
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
    return p && p.room !== null && p.room !== undefined ? p.room : null;
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
      this.target = null;
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
          this.onTap(hitTest(w.x, w.y), w);
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
    const first = !this.g;
    const hadRoom = this.myRoomIndex();
    this.g = g;
    this.rooms = rooms;
    this.players = players;
    this.me = me;
    if (!this.ghostPos || first) this.ghostPos = { x: g.ghost.x, y: g.ghost.y };
    const room = this.myRoomIndex();
    if (room !== null && hadRoom === null && this.focusMode === 'all' && !this.userFocused) {
      this.focusMode = 'room';
      this.refocus();
    }
  }

  ghostScreen() {
    return this.ghostPos ? this.w2s(this.ghostPos.x, this.ghostPos.y) : null;
  }

  // 服务器事件 → 特效
  event(e, now) {
    const gp = this.ghostPos || { x: 3, y: 7.5 };
    const parts = this.fx.parts;
    const burst = (x, y, n, color, spd = 2, size = 0.07, grav = 3, life = 0.8) => {
      if (this.reduced) n = Math.ceil(n / 3);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const v = spd * (0.3 + Math.random());
        parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - spd * 0.3, life: life * (0.6 + Math.random() * 0.6), max: life, color, size: size * (0.6 + Math.random()), grav });
      }
    };
    const mine = (room) => room === this.myRoomIndex();
    switch (e.type) {
      case 'shot': {
        const from = GEOM[e.room].cellCenter(e.cell);
        this.aim.set(`${e.room}:${e.cell}`, Math.atan2(gp.y - from.y, gp.x - from.x));
        if (e.kind === 'thunder') {
          this.fx.bolts.push({ kind: 'thunder', to: { ...gp }, t0: now, dur: 0.35, seed: Math.random() * 1000 });
          this.fx.flash.push({ t0: now, dur: 0.18, color: '255,240,190', a: 0.35 });
          this.charge.set(`${e.room}:${e.cell}`, now);
          this.fx.shake = Math.max(this.fx.shake, 0.18);
          burst(gp.x, gp.y, 12, '#fff3b0', 4, 0.06, 0, 0.4);
        } else {
          this.fx.bolts.push({ kind: 'arrow', from, to: { ...gp }, t0: now, dur: 0.12 });
        }
        this.ghostHurt = 1;
        // 只显示天雷和自己宿舍打出的伤害，避免满屏数字
        if (e.kind === 'thunder' || mine(e.room)) this.fx.texts.push({ x: gp.x, y: gp.y, dy: -1.1, dx: (Math.random() - 0.5) * 0.6, text: String(e.dmg), color: e.kind === 'thunder' ? '#ffe680' : '#f2e6dc', t0: now + (e.kind === 'thunder' ? 0 : 0.1), size: e.kind === 'thunder' ? 0.62 : 0.4 });
        break;
      }
      case 'hitDoor': {
        const d = GEOM[e.room].door;
        burst(d.x, d.y, 6, '#7a5130', 2.5, 0.06, 4, 0.6);
        this.ghostAttack = 1;
        if (mine(e.room)) this.fx.shake = Math.max(this.fx.shake, 0.12);
        this.fx.texts.push({ x: d.x, y: d.y, dy: -0.3, text: '-' + e.dmg, color: '#ff6b6b', t0: now, size: 0.36 });
        break;
      }
      case 'doorBroken': {
        const d = GEOM[e.room].door;
        burst(d.x, d.y, 40, '#8a5a32', 5, 0.1, 5, 1.2);
        burst(d.x, d.y, 16, '#2a2a2a', 3, 0.15, 1, 1.5);
        this.fx.rings.push({ x: d.x, y: d.y, t0: now, dur: 0.6, color: '255,120,60', r: 2 });
        this.fx.shake = Math.max(this.fx.shake, mine(e.room) ? 0.5 : 0.2);
        break;
      }
      case 'hitBed': {
        const b = GEOM[e.room];
        burst(b.bedRect.x + 1, b.bedRect.y + 0.5, 10, '#a3000c', 2.5, 0.07, 3, 0.9);
        this.ghostAttack = 1;
        if (mine(e.room)) this.fx.shake = Math.max(this.fx.shake, 0.2);
        break;
      }
      case 'kill': {
        const b = GEOM[e.room];
        const cx = b.bedRect.x + 1;
        const cy = b.bedRect.y + 0.5;
        burst(cx, cy, 60, '#b0000d', 5, 0.11, 2, 1.6);
        this.fx.rings.push({ x: cx, y: cy, t0: now, dur: 1.2, color: '200,0,10', r: 4 });
        this.fx.flash.push({ t0: now, dur: 0.6, color: '150,0,8', a: mine(e.room) ? 0.7 : 0.35 });
        this.fx.shake = Math.max(this.fx.shake, 0.6);
        break;
      }
      case 'reflect': {
        const d = GEOM[e.room].door;
        this.fx.rings.push({ x: d.x, y: d.y, t0: now, dur: 0.4, color: '255,220,120', r: 1.2 });
        this.fx.texts.push({ x: gp.x, y: gp.y, dy: -1.3, text: String(e.dmg), color: '#ffd77a', t0: now, size: 0.36 });
        break;
      }
      case 'scream':
        this.fx.rings.push({ x: gp.x, y: gp.y, t0: now, dur: 1, color: '170,60,255', r: 6 });
        this.fx.flash.push({ t0: now, dur: 0.5, color: '80,0,120', a: 0.3 });
        this.fx.shake = Math.max(this.fx.shake, 0.35);
        break;
      case 'ghostLevel':
        this.fx.rings.push({ x: gp.x, y: gp.y, t0: now, dur: 1.4, color: '220,0,20', r: 3.5 });
        this.fx.texts.push({ x: gp.x, y: gp.y, dy: -1.8, text: `${e.lv} 级`, color: '#ff4d55', t0: now, size: 0.6, long: true });
        break;
      case 'build': {
        const c = GEOM[e.room].cellCenter(e.cell);
        burst(c.x, c.y, 10, e.lv > 1 ? '#ffe39a' : '#9a8a7a', 1.6, 0.05, 1, 0.6);
        if (e.lv > 1) this.fx.rings.push({ x: c.x, y: c.y, t0: now, dur: 0.5, color: '255,220,120', r: 0.8 });
        break;
      }
      case 'sell': {
        const c = GEOM[e.room].cellCenter(e.cell);
        burst(c.x, c.y, 8, '#555', 1.4, 0.06, 1, 0.5);
        break;
      }
      case 'bed':
      case 'door': {
        const g = GEOM[e.room];
        const p = e.type === 'bed' ? { x: g.bedRect.x + 1, y: g.bedRect.y + 0.5 } : g.door;
        this.fx.rings.push({ x: p.x, y: p.y, t0: now, dur: 0.6, color: '255,220,120', r: 1.1 });
        burst(p.x, p.y, 12, '#ffe39a', 1.8, 0.05, 0, 0.7);
        break;
      }
      case 'wake':
        this.fx.flash.push({ t0: now, dur: 1.2, color: '160,0,10', a: 0.6 });
        this.fx.rings.push({ x: gp.x, y: gp.y, t0: now, dur: 1.5, color: '220,0,20', r: 8 });
        this.fx.shake = 0.5;
        break;
      case 'ghostDie':
        burst(gp.x, gp.y, 80, '#eeeeee', 6, 0.1, -0.5, 2);
        this.fx.flash.push({ t0: now, dur: 1.5, color: '255,255,255', a: 0.8 });
        break;
      case 'claim': {
        const g = GEOM[e.room];
        this.fx.rings.push({ x: g.center.x, y: g.center.y, t0: now, dur: 0.7, color: '255,230,160', r: 2.5 });
        break;
      }
    }
  }

  // ---------------- 每帧 ----------------
  frame(t, dt) {
    const ctx = this.ctx;
    const dpr = this.dpr;
    if (!this.cw) return;
    // 镜头动画
    if (this.target) {
      const k = Math.min(1, dt * 6);
      this.s += (this.target.s - this.s) * k;
      this.cam.x += (this.target.x - this.cam.x) * k;
      this.cam.y += (this.target.y - this.cam.y) * k;
      if (Math.abs(this.target.s - this.s) < 0.05 && Math.abs(this.target.x - this.cam.x) < 0.005) this.target = null;
      this.clampCam();
    }
    // 猛鬼位置平滑
    const g = this.g;
    if (g && this.ghostPos) {
      const tx = g.ghost.x;
      const ty = g.ghost.y;
      const d = Math.hypot(tx - this.ghostPos.x, ty - this.ghostPos.y);
      if (d > 4) this.ghostPos = { x: tx, y: ty };
      else {
        const k = Math.min(1, dt * 10);
        this.ghostPos.x += (tx - this.ghostPos.x) * k;
        this.ghostPos.y += (ty - this.ghostPos.y) * k;
      }
    }
    this.ghostAttack = Math.max(0, this.ghostAttack - dt * 4);
    this.ghostHurt = Math.max(0, this.ghostHurt - dt * 6);

    // 屏幕震动
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
    // 在世界坐标 (x,y) 处以屏幕朝向画东西（文字、精灵不会被转置成镜像）
    // dy：屏幕方向上的偏移（单位格，负数向上）
    const upright = (x, y, scale, fn, dy = 0) => {
      const p = this.w2s(x, y);
      ctx.setTransform(S * scale, 0, 0, S * scale, (p.x + sx) * dpr, (p.y + sy + dy * this.s) * dpr);
      fn();
    };
    this.upright = upright;

    world();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.staticLayer, 0, 0, MAP.W, MAP.H);
    this.drawLair(t, world, upright);
    this.drawRooms(t, world, upright);
    this.drawGhostAndFx(t, dt, world, upright);
    this.drawLighting(t);
    this.drawOverlay(t, world, upright);
  }

  drawLair(t, world, upright) {
    const ctx = this.ctx;
    world();
    // 血池波纹
    for (let i = 0; i < 3; i++) {
      const p = (t * 0.25 + i / 3) % 1;
      ctx.strokeStyle = `rgba(200,20,30,${0.35 * (1 - p)})`;
      ctx.lineWidth = 0.05;
      ctx.beginPath();
      ctx.ellipse(3, 7.5, 0.3 + p * 1.8, 0.45 + p * 2.9, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    // 蜡烛
    const candles = [
      [1.2, 3.2], [4.8, 3.2], [1.2, 11.8], [4.8, 11.8], [3, 2.3], [3, 12.7],
    ];
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

  drawRooms(t, world, upright) {
    const ctx = this.ctx;
    const g = this.g;
    const myRoom = this.myRoomIndex();
    const prep = g && g.phase === 'prep';
    for (const geo of GEOM) {
      const r = this.rooms[geo.i];
      world();
      const owner = r && r.owner ? this.players.get(r.owner) : null;
      const rect = geo.rect;
      if (r && r.dead) {
        ctx.fillStyle = 'rgba(60,0,4,0.45)';
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      } else if (owner) {
        ctx.fillStyle = owner.color;
        ctx.globalAlpha = 0.07;
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
        ctx.globalAlpha = 1;
      }
      // 准备阶段：空宿舍闪烁提示可入住
      if (prep && r && !r.owner && myRoom === null) {
        const p = 0.4 + Math.sin(t * 4) * 0.25;
        ctx.strokeStyle = `rgba(217,192,111,${p})`;
        ctx.lineWidth = 0.08;
        ctx.setLineDash([0.3, 0.2]);
        ctx.strokeRect(rect.x + 0.05, rect.y + 0.05, rect.w - 0.1, rect.h - 0.1);
        ctx.setLineDash([]);
      }
      if (geo.i === myRoom) {
        ctx.strokeStyle = r && r.dead ? 'rgba(150,0,10,0.6)' : 'rgba(217,192,111,0.55)';
        ctx.lineWidth = 0.06;
        ctx.strokeRect(rect.x + 0.03, rect.y + 0.03, rect.w - 0.06, rect.h - 0.06);
        // 格子线
        if (r && !r.dead) {
          ctx.strokeStyle = 'rgba(217,192,111,0.12)';
          ctx.lineWidth = 0.02;
          for (let k = 1; k < 5; k++) {
            ctx.beginPath();
            ctx.moveTo(rect.x + k, rect.y);
            ctx.lineTo(rect.x + k, rect.y + rect.h);
            ctx.stroke();
          }
          for (let k = 1; k < 4; k++) {
            ctx.beginPath();
            ctx.moveTo(rect.x, rect.y + k);
            ctx.lineTo(rect.x + rect.w, rect.y + k);
            ctx.stroke();
          }
        }
      }
      // 床
      drawBed(ctx, geo.bedRect, { color: owner ? owner.color : null, dead: r && r.dead });
      // 门
      this.drawDoor(t, geo, r, world);
      // 建筑
      if (r && r.cells) {
        for (let idx = 0; idx < CELLS; idx++) {
          const c = r.cells[idx];
          if (!c) continue;
          const type = BUILD_TYPES[c[0]];
          const cc = geo.cellCenter(idx);
          const key = `${geo.i}:${idx}`;
          let aim = null;
          if (type === 'turret' && this.ghostPos) {
            const want = this.aim.get(key);
            if (want !== undefined) aim = want;
          }
          const charged = this.charge.get(key);
          const charge = type === 'thunder' ? Math.min(1, charged ? (t - charged) / 3.5 : 1) : 0;
          // 弩的朝向要换算到屏幕方向（转置时 x、y 互换）
          let sAim = aim;
          if (aim !== null && this.T) sAim = Math.atan2(Math.cos(aim), Math.sin(aim));
          upright(cc.x, cc.y, 1, () => drawBuilding(ctx, type, c[1], { t: t + idx, aim: sAim === null ? -Math.PI / 2 + Math.sin(t + idx) * 0.3 : sAim, stunned: r.stun > 0, charge }));
        }
      }
      // 选中的格子
      if (this.selected && this.selected.room === geo.i && this.selected.cell !== null) {
        const cc = geo.cellCenter(this.selected.cell);
        world();
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
      // 门牌：贴在外墙上，「4 号 · 名字」
      // 竖屏（转置）时外墙是竖的，门牌改贴在两间宿舍之间的隔墙上
      const lx = this.T ? geo.x0 - 0.5 : geo.x0 + 2.5;
      const ly = this.T ? geo.center.y : geo.top ? 0.5 : 14.5;
      upright(lx, ly, 1, () => {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const fs = Math.min(0.34, 15 / this.s);
        ctx.font = `600 ${fs}px system-ui, sans-serif`;
        const label = `${geo.i + 1} 号${owner ? ' · ' + owner.name : prep ? ' · 空' : ''}`;
        const w = Math.min(4.8, ctx.measureText(label).width + 0.3);
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        rr(ctx, -w / 2, -fs * 0.7, w, fs * 1.4, 0.06);
        ctx.fill();
        ctx.fillStyle = r && r.dead ? '#8a3a40' : owner ? owner.color : 'rgba(217,192,111,0.6)';
        ctx.fillText(label, 0, 0.01, 4.6);
      });
      // 床血条
      if (r && r.bed && r.bed[1] < r.bed[2] && !r.dead) this.bar(upright, geo.bedRect.x + 1, geo.bedRect.y + (geo.top ? 1.15 : -0.15), r.bed[1] / r.bed[2], '#e05050', 1.3);
    }
  }

  bar(upright, x, y, frac, color, w = 1, dy = 0) {
    const ctx = this.ctx;
    upright(x, y, 1, () => {
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(-w / 2 - 0.03, -0.07, w + 0.06, 0.14);
      ctx.fillStyle = color;
      ctx.fillRect(-w / 2, -0.04, w * Math.max(0, Math.min(1, frac)), 0.08);
    }, dy);
  }

  drawDoor(t, geo, r, world) {
    const ctx = this.ctx;
    world();
    const x = geo.doorX;
    const y = geo.doorY;
    const lv = r && r.door ? r.door[0] : 1;
    const hp = r && r.door ? r.door[1] : 1;
    const max = r && r.door ? r.door[2] : 1;
    const frac = hp / max;
    if (hp <= 0) {
      // 被砸烂：门框上挂着碎木
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
      // 门上贴的黄符
      ctx.fillStyle = '#e0c66c';
      ctx.fillRect(x + 0.42, y + 0.26, 0.16, 0.48);
      ctx.strokeStyle = '#a3170e';
      ctx.lineWidth = 0.025;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, y + 0.3);
      ctx.lineTo(x + 0.5, y + 0.7);
      ctx.stroke();
    }
    // 裂纹
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
    // 门的血条：被攻击或受伤时显示
    const g = this.g;
    if (frac < 1 || (g && g.ghost.target === geo.i)) this.bar(this.upright, x + 0.5, geo.top ? y + 1.15 : y - 0.15, frac, frac < 0.3 ? '#ff4040' : '#d9a441', 1.1);
  }

  drawGhostAndFx(t, dt, world, upright) {
    const ctx = this.ctx;
    const g = this.g;
    const fx = this.fx;
    // 粒子
    world();
    fx.parts = fx.parts.filter((p) => (p.life -= dt) > 0);
    for (const p of fx.parts) {
      p.vy += p.grav * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.96;
      ctx.globalAlpha = Math.min(1, p.life / p.max * 1.5);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
    // 猛鬼
    if (g && this.ghostPos) {
      const gs = g.ghost.state;
      const gp = this.ghostPos;
      const alpha = gs === 'dead' ? 0 : gs === 'retreat' ? 0.55 : gs === 'heal' ? 0.75 : gs === 'sleep' ? 0.35 + Math.sin(t * 1.5) * 0.15 : 1;
      if (gs === 'heal') {
        world();
        ctx.strokeStyle = `rgba(255,30,40,${0.4 + Math.sin(t * 5) * 0.2})`;
        ctx.lineWidth = 0.08;
        ctx.beginPath();
        ctx.arc(gp.x, gp.y, 0.8 + Math.sin(t * 3) * 0.1, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (g.ghost.slow > 0) {
        world();
        ctx.fillStyle = `rgba(143,211,255,${0.12 + g.ghost.slow * 0.3})`;
        ctx.beginPath();
        ctx.arc(gp.x, gp.y, 0.7, 0, Math.PI * 2);
        ctx.fill();
      }
      // 雾气拖尾
      if (gs === 'hunt' || gs === 'retreat') {
        if (Math.random() < 0.5) fx.parts.push({ x: gp.x + (Math.random() - 0.5) * 0.5, y: gp.y + 0.3, vx: 0, vy: -0.3, life: 0.9, max: 0.9, color: 'rgba(200,200,210,0.25)', size: 0.25, grav: 0 });
      }
      if (alpha > 0) upright(gp.x, gp.y, 1.25, () => drawGhost(ctx, { t, alpha, hurt: this.ghostHurt, attack: this.ghostAttack }), -0.35);
      if (gs !== 'sleep' && gs !== 'dead') this.bar(upright, gp.x, gp.y, g.ghost.hp / g.ghost.max, '#d91f2a', 1.2, -1.45);
    }
    // 弩箭与天雷
    fx.bolts = fx.bolts.filter((b) => t - b.t0 < b.dur);
    for (const b of fx.bolts) {
      const p = (t - b.t0) / b.dur;
      if (b.kind === 'arrow') {
        world();
        const x = b.from.x + (b.to.x - b.from.x) * p;
        const y = b.from.y + (b.to.y - b.from.y) * p;
        const ang = Math.atan2(b.to.y - b.from.y, b.to.x - b.from.x);
        ctx.strokeStyle = '#f3d9a8';
        ctx.lineWidth = 0.05;
        ctx.beginPath();
        ctx.moveTo(x - Math.cos(ang) * 0.35, y - Math.sin(ang) * 0.35);
        ctx.lineTo(x, y);
        ctx.stroke();
      } else {
        // 天雷：从屏幕上方劈下的锯齿闪电
        const to = this.w2s(b.to.x, b.to.y);
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        const rnd = mulberry(Math.floor(b.seed + p * 6));
        ctx.strokeStyle = `rgba(255,250,210,${1 - p})`;
        ctx.shadowColor = '#ffe680';
        ctx.shadowBlur = 18;
        ctx.lineWidth = 3;
        ctx.beginPath();
        let x = to.x + (rnd() - 0.5) * 60;
        let y = to.y - 240;
        ctx.moveTo(x, y);
        for (let i = 1; i <= 8; i++) {
          x = to.x + (rnd() - 0.5) * 40 * (1 - i / 8);
          y = to.y - 240 + (240 * i) / 8;
          ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
    }
    // 光环
    world();
    fx.rings = fx.rings.filter((r) => t - r.t0 < r.dur);
    for (const r of fx.rings) {
      const p = (t - r.t0) / r.dur;
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
      upright(tx.x, tx.y, 1, () => {
        ctx.globalAlpha = Math.min(1, (1 - p) * 2);
        ctx.font = `800 ${tx.size}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.lineWidth = 0.08;
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.strokeText(tx.text, tx.dx || 0, 0);
        ctx.fillStyle = tx.color;
        ctx.fillText(tx.text, tx.dx || 0, 0);
        ctx.globalAlpha = 1;
      }, (tx.dy || 0) - p * 0.7);
    }
  }

  // 熄灯：整张图压暗，再在灯光处「挖洞」
  drawLighting(t) {
    const d = this.dctx;
    const W = this.dark.width;
    const H = this.dark.height;
    const dpr = this.dpr;
    const g = this.g;
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
    // 走廊的灯（有一盏坏了，一直在闪）
    [9.5, 15.5, 21.5, 27.5].forEach((x, i) => hole(x, 7.5, 2.6, i === 2 ? flick(i) * (Math.sin(t * 1.3) > 0.3 ? 1 : 0.2) : flick(i)));
    // 血池
    hole(3, 7.5, 3.4, 0.7 + Math.sin(t * 2) * 0.1);
    const myRoom = this.myRoomIndex();
    for (const geo of GEOM) {
      const r = this.rooms[geo.i];
      if (!r) continue;
      if (r.owner && !r.dead) hole(geo.center.x, geo.center.y, geo.i === myRoom ? 3.8 : 3.1, flick(geo.i + 5));
      else if (r.dead) hole(geo.center.x, geo.center.y, 1.6, 0.35);
      else if (g && g.phase === 'prep') hole(geo.center.x, geo.center.y, 2.2, 0.5);
    }
    if (g && this.ghostPos && g.ghost.state !== 'dead') hole(this.ghostPos.x, this.ghostPos.y, 1.8, 0.8);
    for (const b of this.fx.bolts) if (b.kind === 'thunder') hole(b.to.x, b.to.y, 4, 1);
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.dark, 0, 0);
    // 彩色光晕
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
    glow(3, 7.5, 3, '120,0,8', 0.35 + Math.sin(t * 2) * 0.08);
    if (g && this.ghostPos && g.ghost.state !== 'dead') glow(this.ghostPos.x, this.ghostPos.y, 1.5, '170,0,10', 0.25);
    for (const geo of GEOM) {
      const r = this.rooms[geo.i];
      if (r && r.owner && !r.dead) glow(geo.bedRect.x + 1, geo.bedRect.y + 0.5, 2.2, '120,80,30', 0.1 * flick(geo.i + 5));
    }
    ctx.globalCompositeOperation = 'source-over';
    // 全屏闪光
    this.fx.flash = this.fx.flash.filter((f) => t - f.t0 < f.dur);
    for (const f of this.fx.flash) {
      const p = (t - f.t0) / f.dur;
      ctx.fillStyle = `rgba(${f.color},${f.a * (1 - p)})`;
      ctx.fillRect(0, 0, this.cv.width, this.cv.height);
    }
    // 暗角
    const vg = ctx.createRadialGradient(this.cv.width / 2, this.cv.height / 2, Math.min(this.cv.width, this.cv.height) * 0.35, this.cv.width / 2, this.cv.height / 2, Math.max(this.cv.width, this.cv.height) * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.75)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, this.cv.width, this.cv.height);
  }

  drawOverlay() {}
}
