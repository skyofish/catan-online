'use strict';
// 青野牧歌：一座农场的完整模拟（地图、作物、天气、动物、钓鱼、出货、祭坛）。
// 地图上的变化（地面、浇水、物体）记成增量，每次推进后由 flushChanges() 取走广播给所有人；新加入的人拿 fullView()。
const D = require('./data');

const { G, MAP, TIME, PLAYER, ITEMS, CROPS, FORAGE, FISH, ANIMALS, BUILDINGS, RECIPES, BUNDLES } = D;
const W = MAP.W;
const H = MAP.H;
const STACK = 999;

// ---------------- 小工具 ----------------
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const inRect = (x, y, r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
const rint = (rng, a, b) => a + Math.floor(rng() * (b - a + 1));
const idx = (x, y) => y * W + x;
const okXY = (x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < W && y < H;

// 会挡路的物体
const BLOCKING = new Set(['tree', 'stump', 'rock', 'ore', 'twig', 'weed', 'place', 'pillar']);
const blocks = (o) => !!o && BLOCKING.has(o.k) && !(o.k === 'tree' && o.s === 0);

// ---------------- 背包 ----------------
function invAdd(inv, id, n) {
  if (!ITEMS[id] || n <= 0) return n;
  const tool = ITEMS[id].kind === 'tool';
  if (!tool) {
    for (const s of inv) {
      if (s && s.id === id && s.n < STACK) {
        const k = Math.min(n, STACK - s.n);
        s.n += k;
        n -= k;
        if (!n) return 0;
      }
    }
  }
  for (let i = 0; i < inv.length && n > 0; i++) {
    if (inv[i]) continue;
    const k = tool ? 1 : Math.min(n, STACK);
    inv[i] = { id, n: k };
    n -= k;
  }
  return n;
}
function invCount(inv, id) {
  let n = 0;
  for (const s of inv) if (s && s.id === id) n += s.n;
  return n;
}
function invRemove(inv, id, n) {
  if (invCount(inv, id) < n) return false;
  for (let i = inv.length - 1; i >= 0 && n > 0; i--) {
    const s = inv[i];
    if (!s || s.id !== id) continue;
    const k = Math.min(n, s.n);
    s.n -= k;
    n -= k;
    if (!s.n) inv[i] = null;
  }
  return true;
}
function invSpace(inv, id, n) {
  let room = 0;
  for (const s of inv) {
    if (!s) room += ITEMS[id].kind === 'tool' ? 1 : STACK;
    else if (s.id === id && ITEMS[id].kind !== 'tool') room += STACK - s.n;
    if (room >= n) return true;
  }
  return room >= n;
}

class FarmWorld {
  constructor(opts = {}) {
    this.seed = opts.seed >>> 0 || (Math.random() * 2 ** 32) >>> 0;
    this.name = opts.name || '青野农场';
    this.ground = new Uint8Array(W * H);
    this.wet = new Uint8Array(W * H);
    this.objs = new Map(); // 格子编号 -> 物体
    this.reserved = new Uint8Array(W * H); // 建筑占用：不能开垦、不能放东西
    this.buildings = { coop: { built: false, pending: false }, barn: { built: false, pending: false } };
    this.animals = [];
    this.gold = 500;
    this.hay = 0;
    this.day = 1;
    this.season = 0;
    this.year = 1;
    this.time = TIME.start;
    this.weather = 'sun';
    this.tomorrow = 'sun';
    this.bin = []; // 出货箱 [{ id, n, by }]
    this.bundles = {};
    this.bundleDone = {};
    this.members = {}; // userId -> 玩家存档
    this.stats = { earned: 0, harvested: 0, fish: 0, shipped: 0, days: 0 };
    this.lastReport = null;
    this.nextAnimalId = 1;
    this.createdAt = Date.now();
    this.rng = Math.random;
    this.initRuntime();
    if (!opts.empty) this.generate();
  }

  initRuntime() {
    this.t = 0; // 现实秒数（本次加载以来）
    this.clockAcc = 0;
    this.online = new Map(); // userId -> { sleep, lastUse, lastMove, fishing }
    this.changes = { g: new Map(), w: new Map(), o: new Map() };
    this.events = [];
    this.metaVer = 1;
    this.meDirty = new Set();
    this.dirty = true;
    this.buildReserved();
  }

  // ======================= 地图生成 =======================
  buildReserved() {
    this.reserved.fill(0);
    const mark = (r) => {
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (okXY(x, y)) this.reserved[idx(x, y)] = 1;
    };
    mark(MAP.house);
    mark(MAP.bin);
    mark(MAP.shop);
    mark(MAP.shrine.altar);
    mark(MAP.coop);
    mark(MAP.barn);
  }

  generate() {
    const rng = mulberry32(this.seed);
    const g = this.ground;
    g.fill(G.GRASS);
    const set = (x, y, v) => okXY(x, y) && (g[idx(x, y)] = v);

    // 四周是山崖，边缘做一点起伏
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const edge = Math.min(x, y, W - 1 - x, H - 1 - y);
        const wobble = (Math.sin(x * 0.7 + this.seed) + Math.cos(y * 0.9 + this.seed * 0.3)) > 1.2 ? 1 : 0;
        if (edge < 2 + wobble) g[idx(x, y)] = G.CLIFF;
      }
    }
    // 池塘：椭圆形水面，外面一圈沙滩
    const P = MAP.pond;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const dx = (x + 0.5 - P.cx) / P.rx;
        const dy = (y + 0.5 - P.cy) / P.ry;
        const n = Math.sin(Math.atan2(dy, dx) * 3 + this.seed) * 0.08;
        const d = Math.sqrt(dx * dx + dy * dy) + n;
        if (d < 1) g[idx(x, y)] = G.WATER;
        else if (d < 1.28 && g[idx(x, y)] !== G.CLIFF) g[idx(x, y)] = G.SAND;
      }
    }
    // 古代遗迹：圆形石台
    const S = MAP.shrine;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const d = Math.hypot(x + 0.5 - S.cx, y + 0.5 - S.cy);
        if (d <= S.r + 0.6 && g[idx(x, y)] !== G.CLIFF) g[idx(x, y)] = G.STONE;
      }
    }
    // 小路
    const hline = (x0, x1, y) => {
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) if (g[idx(x, y)] === G.GRASS) set(x, y, G.DIRT);
    };
    const vline = (x, y0, y1) => {
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) if (g[idx(x, y)] === G.GRASS) set(x, y, G.DIRT);
    };
    vline(MAP.house.door.x, MAP.house.door.y, 9);
    hline(MAP.house.door.x, 46, 9);
    vline(MAP.shop.front.x, MAP.shop.front.y, 9);
    vline(37, 9, 30);
    hline(37, MAP.pasture.x, MAP.pasture.gate[0]);
    hline(37, MAP.pasture.x, MAP.pasture.gate[1]);
    vline(MAP.bin.x, MAP.bin.y + 1, 9);
    // 牧场栅栏，西边留门
    const Pa = MAP.pasture;
    for (let y = Pa.y; y < Pa.y + Pa.h; y++) {
      for (let x = Pa.x; x < Pa.x + Pa.w; x++) {
        const border = x === Pa.x || y === Pa.y || x === Pa.x + Pa.w - 1 || y === Pa.y + Pa.h - 1;
        if (!border) continue;
        if (x === Pa.x && Pa.gate.includes(y)) set(x, y, G.DIRT);
        else if (g[idx(x, y)] !== G.CLIFF) set(x, y, G.FENCE);
      }
    }
    // 建筑地基
    for (const r of [MAP.house, MAP.bin, MAP.shop, MAP.coop, MAP.barn, S.altar]) {
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) set(x, y, G.STONE);
    }
    // 门口门前的小路
    for (const dpos of [MAP.coop.door, MAP.barn.door]) set(dpos.x, dpos.y, G.DIRT);

    // 遗迹的石柱：每根对应一组供品
    for (let k = 0; k < BUNDLES.length; k++) {
      const a = (k / BUNDLES.length) * Math.PI * 2 - Math.PI / 2 + Math.PI / BUNDLES.length;
      const x = Math.floor(S.cx + Math.cos(a) * (S.r - 0.6));
      const y = Math.floor(S.cy + Math.sin(a) * (S.r - 0.6));
      this.objs.set(idx(x, y), { k: 'pillar', b: k });
    }

    // 杂物与树木
    const clear = { x: 8, y: 8, w: 11, h: 7 };
    for (let y = 2; y < H - 2; y++) {
      for (let x = 2; x < W - 2; x++) {
        const i = idx(x, y);
        if (g[i] !== G.GRASS || this.reserved[i] || this.objs.has(i)) continue;
        if (inRect(x, y, clear)) continue;
        const r = rng();
        const forest = x < 8 || (y > 37 && x < 34) || (y < 4 && x > 16 && x < 26);
        const ruins = x >= 44 && y <= 15;
        const pasture = inRect(x, y, Pa);
        const field = inRect(x, y, MAP.field);
        let o = null;
        if (forest) {
          if (r < 0.34) o = { k: 'tree', hp: 10, s: 2, v: rint(rng, 0, 2) };
          else if (r < 0.42) o = { k: 'weed', v: rint(rng, 0, 2) };
          else if (r < 0.46) o = { k: 'twig' };
        } else if (ruins) {
          if (r < 0.1) o = { k: 'ore', hp: 3 };
          else if (r < 0.18) o = { k: 'rock', hp: 1 };
          else if (r < 0.2) o = { k: 'rock', hp: 6, big: 1 };
          else if (r < 0.26) o = { k: 'weed', v: rint(rng, 0, 2) };
        } else if (pasture) {
          if (r < 0.05) o = { k: 'weed', v: rint(rng, 0, 2) };
        } else if (field) {
          if (r < 0.13) o = { k: 'weed', v: rint(rng, 0, 2) };
          else if (r < 0.18) o = { k: 'twig' };
          else if (r < 0.23) o = { k: 'rock', hp: 1 };
          else if (r < 0.245) o = { k: 'rock', hp: 6, big: 1 };
          else if (r < 0.27) o = { k: 'tree', hp: 10, s: 2, v: rint(rng, 0, 2) };
        } else {
          if (r < 0.06) o = { k: 'weed', v: rint(rng, 0, 2) };
          else if (r < 0.08) o = { k: 'rock', hp: 1 };
          else if (r < 0.12) o = { k: 'tree', hp: 10, s: 2, v: rint(rng, 0, 2) };
        }
        // 不挡门、不挡路口
        if (o && this.nearDoor(x, y)) o = null;
        if (o) this.objs.set(i, o);
      }
    }
    this.spawnForage(6, rng);
  }

  nearDoor(x, y) {
    for (const d of [MAP.house.door, MAP.coop.door, MAP.barn.door, MAP.shop.front]) if (Math.abs(d.x - x) <= 1 && Math.abs(d.y - y) <= 1) return true;
    return Math.abs(x - (MAP.bin.x + 0.5)) <= 1.5 && y === MAP.bin.y + 1;
  }

  seasonId() {
    return D.SEASONS[this.season].id;
  }

  // ======================= 地图读写（记录增量） =======================
  setGround(i, v) {
    if (this.ground[i] === v) return;
    this.ground[i] = v;
    this.changes.g.set(i, v);
    this.dirty = true;
  }
  setWet(i, v) {
    if (this.wet[i] === v) return;
    this.wet[i] = v;
    this.changes.w.set(i, v);
    this.dirty = true;
  }
  setObj(i, o) {
    if (o) this.objs.set(i, o);
    else this.objs.delete(i);
    this.changes.o.set(i, o || null);
    this.dirty = true;
  }
  touchObj(i) {
    this.changes.o.set(i, this.objs.get(i) || null);
    this.dirty = true;
  }
  bumpMeta() {
    this.metaVer++;
    this.dirty = true;
  }

  walkable(x, y) {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (!okXY(tx, ty)) return false;
    const i = idx(tx, ty);
    const gr = this.ground[i];
    if (gr === G.WATER || gr === G.CLIFF || gr === G.FENCE) return false;
    if (this.reserved[i]) {
      // 没建好的鸡舍 / 畜棚地基可以走
      if (inRect(tx, ty, MAP.coop) && !this.buildings.coop.built) return true;
      if (inRect(tx, ty, MAP.barn) && !this.buildings.barn.built) return true;
      return false;
    }
    return !blocks(this.objs.get(i));
  }

  // 空地：能开垦、能放东西
  freeTile(i) {
    const gr = this.ground[i];
    return !this.reserved[i] && !this.objs.has(i) && gr !== G.WATER && gr !== G.CLIFF && gr !== G.FENCE;
  }

  // ======================= 玩家 =======================
  addMember(userId, name, color) {
    const k = String(userId);
    let m = this.members[k];
    if (!m) {
      const inv = new Array(PLAYER.invSize).fill(null);
      for (const t of ['hoe', 'can', 'axe', 'pick', 'scythe', 'rod']) invAdd(inv, t, 1);
      invAdd(inv, 'parsnip_seed', Object.keys(this.members).length ? 6 : 12);
      invAdd(inv, 'bread', 2);
      m = this.members[k] = { name, color, inv, energy: PLAYER.maxEnergy, water: PLAYER.canMax, x: MAP.start.x, y: MAP.start.y, f: 2, joinedAt: Date.now(), stats: { harvested: 0, fish: 0, shipped: 0 } };
      this.bumpMeta();
    }
    m.name = name;
    if (color) m.color = color;
    return m;
  }

  maxEnergy() {
    return PLAYER.maxEnergy + (this.shrineAwake() ? D.SHRINE_BONUS_ENERGY : 0);
  }

  join(userId) {
    const k = String(userId);
    if (!this.members[k]) throw new Error('不是这座农场的成员');
    if (!this.online.has(k)) this.online.set(k, { sleep: false, lastUse: 0, lastMove: this.t, fishing: null, held: null, anim: 0 });
    const m = this.members[k];
    if (!this.walkable(m.x, m.y)) Object.assign(m, { x: MAP.start.x, y: MAP.start.y });
    this.events.push({ type: 'join', pid: k });
    this.meDirty.add(k);
  }

  leave(userId) {
    const k = String(userId);
    if (!this.online.delete(k)) return;
    this.events.push({ type: 'leave', pid: k });
    this.checkAllAsleep();
  }

  M(userId) {
    return this.members[String(userId)];
  }

  // 客户端负责自己的走位，这里只做合理性检查：速度过快或走进障碍物就拉回去
  move(userId, d) {
    const k = String(userId);
    const m = this.members[k];
    const rt = this.online.get(k);
    if (!m || !rt) return { ok: false };
    const x = Number(d.x);
    const y = Number(d.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false };
    if (rt.sleep) return { ok: false, corr: { x: m.x, y: m.y } };
    const dt = Math.max(0.05, this.t - rt.lastMove);
    const dist = Math.hypot(x - m.x, y - m.y);
    if (dist > PLAYER.speed * dt * 1.6 + 0.8 || !this.walkable(x, y)) return { ok: false, corr: { x: m.x, y: m.y } };
    rt.lastMove = this.t;
    m.x = x;
    m.y = y;
    if ([0, 1, 2, 3].includes(d.f)) m.f = d.f;
    rt.held = typeof d.h === 'string' && ITEMS[d.h] ? d.h : null;
    rt.anim = d.a ? 1 : 0;
    // 走开了就收竿
    if (rt.fishing && Math.hypot(x - rt.fishing.px, y - rt.fishing.py) > 0.6) this.endFishing(k, 'cancel');
    return { ok: true };
  }

  reach(m, x, y, r = PLAYER.reach) {
    return Math.hypot(m.x - (x + 0.5), m.y - (y + 0.5)) <= r;
  }

  nearRect(m, r, dist = 2.2) {
    const cx = Math.max(r.x, Math.min(m.x, r.x + r.w));
    const cy = Math.max(r.y, Math.min(m.y, r.y + r.h));
    return Math.hypot(m.x - cx, m.y - cy) <= dist;
  }

  // 背包放不下的东西掉在脚边，捡起来就行
  give(k, id, n) {
    const m = this.members[k];
    const left = invAdd(m.inv, id, n);
    this.meDirty.add(k);
    if (left > 0) this.drop(Math.floor(m.x), Math.floor(m.y), id, left);
    return n - left;
  }

  drop(x0, y0, id, n) {
    for (let r = 0; r < 6; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = x0 + dx;
          const y = y0 + dy;
          if (!okXY(x, y)) continue;
          const i = idx(x, y);
          const o = this.objs.get(i);
          if (o && o.k === 'drop' && o.id === id && o.n + n <= STACK) {
            o.n += n;
            this.touchObj(i);
            return;
          }
          if (!o && this.walkable(x + 0.5, y + 0.5) && !this.reserved[i]) {
            this.setObj(i, { k: 'drop', id, n });
            return;
          }
        }
      }
    }
  }

  // ======================= 操作 =======================
  act(userId, d) {
    const k = String(userId);
    const m = this.members[k];
    const rt = this.online.get(k);
    if (!m || !rt) return { ok: false, error: '你不在农场里' };
    const fn = this['do_' + d.type];
    if (typeof fn !== 'function') return { ok: false, error: '未知操作' };
    if (rt.sleep && d.type !== 'wake') return { ok: false, error: '你已经睡下了' };
    const r = fn.call(this, k, m, rt, d) || { ok: true };
    if (r.ok !== false) {
      r.ok = true;
      this.meDirty.add(k);
    }
    return r;
  }

  // 手里拿着的东西用在某一格上
  do_use(k, m, rt, d) {
    const slot = Number(d.slot);
    const it = m.inv[slot];
    if (!it) return { ok: false, error: '这一格是空的' };
    const def = ITEMS[it.id];
    const now = this.t * 1000;
    if (now - rt.lastUse < PLAYER.useCooldownMs) return { ok: false, error: '慢一点' };
    rt.lastUse = now;
    if (def.kind === 'food' || ((def.kind === 'crop' || def.kind === 'forage' || def.kind === 'fish' || def.kind === 'animal') && def.energy && d.x === undefined)) {
      return this.do_eat(k, m, rt, { slot });
    }
    const x = Number(d.x);
    const y = Number(d.y);
    if (!okXY(x, y)) return { ok: false, error: '位置无效' };
    if (it.id === 'rod') return this.cast(k, m, rt, x, y);
    if (rt.fishing) this.endFishing(k, 'cancel');
    if (!this.reach(m, x, y)) return { ok: false, error: '太远了，走近一点' };
    const i = idx(x, y);
    if (def.kind === 'tool') {
      const cost = D.ENERGY_COST[it.id] || 0;
      if (cost && m.energy < cost) return { ok: false, error: '太累了，吃点东西或者回家睡觉吧' };
      const did = this.tool(k, m, it.id, x, y, i);
      if (did === true) {
        m.energy = Math.max(0, m.energy - cost);
        return { ok: true };
      }
      this.events.push({ type: 'whiff', pid: k, tool: it.id, x, y });
      return { ok: false, error: did || '这里用不了' };
    }
    if (def.kind === 'seed') return this.plant(k, m, slot, it, x, y, i);
    if (def.kind === 'place') return this.place(k, m, slot, it, x, y, i);
    return this.do_interact(k, m, rt, { x, y });
  }

  tool(k, m, tool, x, y, i) {
    const o = this.objs.get(i);
    const gr = this.ground[i];
    const ev = (type, extra = {}) => this.events.push({ type, pid: k, tool, x, y, ...extra });
    const sid = this.seasonId();
    // 除草：所有工具都能清掉杂草（镰刀会顺手扫掉周围一圈）
    if (o && o.k === 'weed') {
      this.cutWeed(k, i);
      if (tool === 'scythe') for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [1, -1], [-1, 1]]) {
        if (!okXY(x + dx, y + dy)) continue;
        const j = idx(x + dx, y + dy);
        const p = this.objs.get(j);
        if (p && p.k === 'weed') this.cutWeed(k, j);
      }
      ev('cut');
      return true;
    }
    switch (tool) {
      case 'hoe':
        if (!o && (gr === G.GRASS || gr === G.DIRT) && !this.reserved[i]) {
          this.setGround(i, G.TILLED);
          if (this.weather === 'rain') this.setWet(i, 1);
          ev('till');
          return true;
        }
        if (o && o.k === 'forage') return '用手采吧';
        return gr === G.TILLED ? '已经翻好了' : '这里不能翻地';
      case 'can':
        if (gr === G.WATER) {
          m.water = PLAYER.canMax;
          ev('refill');
          return true;
        }
        if (gr === G.TILLED) {
          if (m.water <= 0) return '水壶空了，去池塘边打水';
          m.water--;
          this.setWet(i, 1);
          ev('water');
          return true;
        }
        return '这里不用浇水';
      case 'axe':
        if (!o) return '这里没有能砍的';
        if (o.k === 'tree') {
          if (o.s === 0) {
            this.setObj(i, null);
            ev('chop');
            return true;
          }
          o.hp--;
          ev('chop', { hp: o.hp });
          if (o.hp <= 0) {
            if (o.s === 2) {
              this.give(k, 'wood', rint(this.rng, 8, 12));
              this.setObj(i, { k: 'stump', hp: 4 });
              ev('fall', { v: o.v });
            } else {
              this.give(k, 'wood', 3);
              this.setObj(i, null);
            }
          } else this.touchObj(i);
          return true;
        }
        if (o.k === 'stump') {
          o.hp--;
          ev('chop', { hp: o.hp });
          if (o.hp <= 0) {
            this.give(k, 'wood', rint(this.rng, 2, 4));
            this.setObj(i, null);
          } else this.touchObj(i);
          return true;
        }
        if (o.k === 'twig') {
          this.give(k, 'wood', rint(this.rng, 1, 2));
          this.setObj(i, null);
          ev('chop', { hp: 0 });
          return true;
        }
        return '斧头砍不动这个';
      case 'pick':
        if (o && (o.k === 'rock' || o.k === 'ore')) {
          o.hp--;
          ev('mine', { hp: o.hp, ore: o.k === 'ore' });
          if (o.hp <= 0) {
            if (o.k === 'ore') {
              this.give(k, 'ore', rint(this.rng, 1, 2));
              this.give(k, 'stone', 1);
            } else this.give(k, 'stone', o.big ? rint(this.rng, 8, 11) : rint(this.rng, 1, 3));
            this.setObj(i, null);
          } else this.touchObj(i);
          return true;
        }
        if (o && o.k === 'place') {
          this.setObj(i, null);
          this.give(k, o.id, 1);
          ev('mine', { hp: 0 });
          return true;
        }
        if (o && o.k === 'crop' && o.dead) {
          this.setObj(i, null);
          ev('mine', { hp: 0 });
          return true;
        }
        if (!o && gr === G.TILLED) {
          this.setGround(i, G.GRASS);
          this.setWet(i, 0);
          ev('mine', { hp: 0 });
          return true;
        }
        if (!o && gr === G.PATH) {
          this.setGround(i, G.GRASS);
          this.give(k, 'path', 1);
          ev('mine', { hp: 0 });
          return true;
        }
        return '镐子敲不动这个';
      case 'scythe':
        if (o && o.k === 'crop' && (o.dead || o.ready)) {
          if (o.dead) this.setObj(i, null);
          else this.harvest(k, i, o);
          ev('cut');
          return true;
        }
        if (o && o.k === 'tree' && o.s === 0) {
          this.setObj(i, null);
          ev('cut');
          return true;
        }
        if (o && (o.k === 'forage' || o.k === 'drop')) return this.pickup(k, i, o) || '背包满了';
        return '这里没有能割的';
      default:
        return '用不了';
    }
  }

  cutWeed(k, i) {
    this.setObj(i, null);
    if (this.rng() < 0.7) this.give(k, 'fiber', 1);
    // 割下来的草晒成干草，存进牧场的草料仓
    if (this.rng() < 0.5) {
      this.hay++;
      this.bumpMeta();
    }
  }

  plant(k, m, slot, it, x, y, i) {
    const cid = ITEMS[it.id].crop;
    const c = CROPS[cid];
    if (this.ground[i] !== G.TILLED) return { ok: false, error: '先用锄头翻地' };
    if (this.objs.has(i)) return { ok: false, error: '这里已经种了东西' };
    if (!c.season.includes(this.seasonId())) return { ok: false, error: `${c.name}只能在${c.season.map((s) => D.SEASONS.find((x) => x.id === s).name).join('、')}天种` };
    it.n--;
    if (!it.n) m.inv[slot] = null;
    this.setObj(i, { k: 'crop', c: cid, age: 0, ready: false });
    this.events.push({ type: 'plant', pid: k, x, y, c: cid });
    return { ok: true };
  }

  place(k, m, slot, it, x, y, i) {
    if (it.id === 'path') {
      const gr = this.ground[i];
      if (this.objs.has(i) || this.reserved[i] || !(gr === G.GRASS || gr === G.DIRT)) return { ok: false, error: '这里铺不了' };
      this.setGround(i, G.PATH);
    } else {
      if (!this.freeTile(i)) return { ok: false, error: '这里放不下' };
      const mx = Math.floor(m.x);
      const my = Math.floor(m.y);
      if (mx === x && my === y) return { ok: false, error: '站开一点再放' };
      this.setObj(i, { k: 'place', id: it.id });
    }
    it.n--;
    if (!it.n) m.inv[slot] = null;
    this.events.push({ type: 'place', pid: k, x, y, id: it.id });
    return { ok: true };
  }

  harvest(k, i, o) {
    const c = CROPS[o.c];
    const n = c.yield || 1;
    const m = this.members[k];
    if (!invSpace(m.inv, o.c, n)) return false;
    this.give(k, o.c, n);
    const [x, y] = [i % W, Math.floor(i / W)];
    this.events.push({ type: 'harvest', pid: k, x, y, c: o.c, n });
    this.stats.harvested += n;
    m.stats.harvested += n;
    if (c.regrow) {
      o.age = c.days - c.regrow;
      o.ready = false;
      this.touchObj(i);
    } else this.setObj(i, null);
    return true;
  }

  pickup(k, i, o) {
    const m = this.members[k];
    const id = o.k === 'forage' ? o.id : o.id;
    const n = o.k === 'drop' ? o.n : 1;
    if (!invSpace(m.inv, id, 1)) return false;
    const left = invAdd(m.inv, id, n);
    this.meDirty.add(k);
    if (left > 0 && o.k === 'drop') {
      o.n = left;
      this.touchObj(i);
    } else this.setObj(i, null);
    this.events.push({ type: 'pickup', pid: k, x: i % W, y: Math.floor(i / W), id });
    return true;
  }

  // 空手点一格：收作物、采野果、捡东西
  do_interact(k, m, rt, d) {
    const x = Number(d.x);
    const y = Number(d.y);
    if (!okXY(x, y)) return { ok: false, error: '位置无效' };
    if (!this.reach(m, x, y)) return { ok: false, error: '太远了，走近一点' };
    const i = idx(x, y);
    const o = this.objs.get(i);
    if (!o) return { ok: false, error: '这里什么也没有' };
    if (o.k === 'crop') {
      if (o.dead) return { ok: false, error: '作物枯死了，用镐子或镰刀清掉' };
      if (!o.ready) return { ok: false, error: `${CROPS[o.c].name}还没熟（${o.age}/${CROPS[o.c].days} 天）` };
      return this.harvest(k, i, o) ? { ok: true } : { ok: false, error: '背包满了' };
    }
    if (o.k === 'forage' || o.k === 'drop') return this.pickup(k, i, o) ? { ok: true } : { ok: false, error: '背包满了' };
    return { ok: false, error: '用工具试试' };
  }

  do_eat(k, m, rt, d) {
    const slot = Number(d.slot);
    const it = m.inv[slot];
    if (!it) return { ok: false, error: '这一格是空的' };
    const def = ITEMS[it.id];
    if (!def.energy) return { ok: false, error: '这个不能吃' };
    if (m.energy >= this.maxEnergy()) return { ok: false, error: '已经吃饱了' };
    m.energy = Math.min(this.maxEnergy(), m.energy + def.energy);
    it.n--;
    if (!it.n) m.inv[slot] = null;
    this.events.push({ type: 'eat', pid: k, id: it.id });
    return { ok: true };
  }

  do_swap(k, m, rt, d) {
    const a = Number(d.a);
    const b = Number(d.b);
    if (!(a >= 0 && b >= 0 && a < m.inv.length && b < m.inv.length) || a === b) return { ok: false, error: '无效' };
    const A = m.inv[a];
    const B = m.inv[b];
    if (A && B && A.id === B.id && ITEMS[A.id].kind !== 'tool' && B.n < STACK) {
      const n = Math.min(A.n, STACK - B.n);
      B.n += n;
      A.n -= n;
      if (!A.n) m.inv[a] = null;
    } else [m.inv[a], m.inv[b]] = [B, A];
    return { ok: true };
  }

  do_trash(k, m, rt, d) {
    const slot = Number(d.slot);
    const it = m.inv[slot];
    if (!it) return { ok: false, error: '这一格是空的' };
    if (ITEMS[it.id].kind === 'tool') return { ok: false, error: '工具不能扔' };
    m.inv[slot] = null;
    return { ok: true };
  }

  // ---------- 出货箱 ----------
  do_ship(k, m, rt, d) {
    if (!this.nearRect(m, MAP.bin)) return { ok: false, error: '走到出货箱旁边' };
    const slot = Number(d.slot);
    const it = m.inv[slot];
    if (!it) return { ok: false, error: '这一格是空的' };
    const def = ITEMS[it.id];
    if (!def.price || def.kind === 'tool') return { ok: false, error: '这个卖不了' };
    const n = Math.max(1, Math.min(it.n, Number(d.n) || it.n));
    it.n -= n;
    if (!it.n) m.inv[slot] = null;
    const last = this.bin[this.bin.length - 1];
    if (last && last.id === it.id && last.by === k) last.n += n;
    else this.bin.push({ id: it.id, n, by: k });
    if (this.bin.length > 60) this.bin.splice(0, this.bin.length - 60);
    this.events.push({ type: 'ship', pid: k, id: it.id, n });
    this.bumpMeta();
    return { ok: true };
  }

  do_unship(k, m, rt, d) {
    if (!this.nearRect(m, MAP.bin)) return { ok: false, error: '走到出货箱旁边' };
    const e = this.bin[Number(d.i)];
    if (!e) return { ok: false, error: '没有这件货' };
    if (!invSpace(m.inv, e.id, e.n)) return { ok: false, error: '背包放不下' };
    invAdd(m.inv, e.id, e.n);
    this.bin.splice(Number(d.i), 1);
    this.bumpMeta();
    return { ok: true };
  }

  // ---------- 商店 ----------
  shopOpen() {
    return this.time >= D.SHOP_HOURS[0] && this.time < D.SHOP_HOURS[1];
  }

  do_buy(k, m, rt, d) {
    if (!this.nearRect(m, MAP.shop, 3)) return { ok: false, error: '走到行商的摊位前' };
    if (!this.shopOpen()) return { ok: false, error: '阿青收摊了（每天 7:00–22:00）' };
    const n = Math.max(1, Math.min(99, Number(d.n) || 1));
    // 动物
    if (ANIMALS[d.id]) {
      const a = ANIMALS[d.id];
      if (!this.buildings[a.house].built) return { ok: false, error: `先盖好${BUILDINGS[a.house].name}` };
      const cap = BUILDINGS[a.house].cap;
      if (this.animals.filter((x) => x.house === a.house).length >= cap) return { ok: false, error: `${BUILDINGS[a.house].name}满了` };
      if (this.gold < a.buy) return { ok: false, error: '钱不够' };
      this.gold -= a.buy;
      const used = new Set(this.animals.map((x) => x.name));
      const name = D.ANIMAL_NAMES.find((x) => !used.has(x)) || a.name + this.nextAnimalId;
      const an = { id: this.nextAnimalId++, kind: d.id, name, house: a.house, fr: 100, since: 0, ready: false, petted: false, inside: false, x: 0, y: 0, tx: 0, ty: 0, f: 2, wait: 0 };
      this.placeAnimal(an);
      this.animals.push(an);
      this.events.push({ type: 'animalNew', pid: k, kind: d.id, name });
      this.bumpMeta();
      return { ok: true, msg: `买下了一只${a.name}，取名「${name}」` };
    }
    // 建筑
    if (BUILDINGS[d.id]) {
      const b = BUILDINGS[d.id];
      const st = this.buildings[d.id];
      if (st.built || st.pending) return { ok: false, error: '已经盖了' };
      if (this.gold < b.cost.gold) return { ok: false, error: '钱不够' };
      for (const r of ['wood', 'stone']) if (invCount(m.inv, r) < b.cost[r]) return { ok: false, error: `${ITEMS[r].name}不够（需要 ${b.cost[r]}，你带着 ${invCount(m.inv, r)}）` };
      this.gold -= b.cost.gold;
      invRemove(m.inv, 'wood', b.cost.wood);
      invRemove(m.inv, 'stone', b.cost.stone);
      st.pending = true;
      // 地基上的杂物清掉
      const r = MAP[d.id];
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (this.objs.has(idx(x, y))) this.setObj(idx(x, y), null);
      this.events.push({ type: 'build', pid: k, id: d.id });
      this.bumpMeta();
      return { ok: true, msg: `${b.name}明天早上就能盖好` };
    }
    const stock = D.shopStock(this.seasonId()).find((s) => s.id === d.id);
    if (!stock) return { ok: false, error: '这个季节没有卖' };
    const cost = stock.price * n;
    if (this.gold < cost) return { ok: false, error: '钱不够' };
    if (d.id === 'hay') {
      this.hay += n;
    } else {
      if (!invSpace(m.inv, d.id, n)) return { ok: false, error: '背包放不下' };
      invAdd(m.inv, d.id, n);
    }
    this.gold -= cost;
    this.events.push({ type: 'buy', pid: k, id: d.id, n });
    this.bumpMeta();
    return { ok: true };
  }

  // ---------- 制作 ----------
  do_craft(k, m, rt, d) {
    const r = RECIPES[d.id];
    if (!r) return { ok: false, error: '没有这个配方' };
    for (const [id, n] of Object.entries(r.in)) if (invCount(m.inv, id) < n) return { ok: false, error: `${ITEMS[id].name}不够` };
    if (!invSpace(m.inv, d.id, r.out)) return { ok: false, error: '背包放不下' };
    for (const [id, n] of Object.entries(r.in)) invRemove(m.inv, id, n);
    invAdd(m.inv, d.id, r.out);
    this.events.push({ type: 'craft', pid: k, id: d.id });
    return { ok: true };
  }

  // ---------- 动物 ----------
  animalArea() {
    const P = MAP.pasture;
    return { x: P.x + 1, y: P.y + 1, w: P.w - 2, h: P.h - 2 };
  }

  placeAnimal(an) {
    const A = this.animalArea();
    for (let tries = 0; tries < 50; tries++) {
      const x = A.x + this.rng() * A.w;
      const y = A.y + this.rng() * A.h;
      if (this.walkable(x, y)) {
        an.x = an.tx = x;
        an.y = an.ty = y;
        return;
      }
    }
    const dd = MAP[an.house].door;
    an.x = an.tx = dd.x + 0.5;
    an.y = an.ty = dd.y + 0.5;
  }

  do_pet(k, m, rt, d) {
    const an = this.animals.find((a) => a.id === Number(d.id));
    if (!an || an.inside) return { ok: false, error: '找不到它' };
    if (Math.hypot(m.x - an.x, m.y - an.y) > PLAYER.reach + 0.4) return { ok: false, error: '走近一点' };
    return this.tendAnimal(k, an) ? { ok: true } : { ok: false, error: `${an.name}今天已经摸过了` };
  }

  tendAnimal(k, an) {
    let did = false;
    if (an.ready) {
      const p = ANIMALS[an.kind].product;
      if (!invSpace(this.members[k].inv, p, 1)) return false;
      this.give(k, p, 1);
      an.ready = false;
      this.events.push({ type: 'collect', pid: k, aid: an.id, id: p });
      did = true;
    }
    if (!an.petted) {
      an.petted = true;
      an.fr = Math.min(1000, an.fr + 15);
      this.events.push({ type: 'pet', pid: k, aid: an.id });
      did = true;
    }
    if (did) this.bumpMeta();
    return did;
  }

  // 点鸡舍 / 畜棚的门：照顾屋里所有动物
  do_barn(k, m, rt, d) {
    const id = d.id === 'barn' ? 'barn' : 'coop';
    if (!this.buildings[id].built) return { ok: false, error: '还没盖好' };
    const door = MAP[id].door;
    if (!this.reach(m, door.x, door.y, 2.6)) return { ok: false, error: '走到门口' };
    let n = 0;
    for (const an of this.animals) if (an.house === id && this.tendAnimal(k, an)) n++;
    return n ? { ok: true } : { ok: false, error: '大家都照顾好了' };
  }

  // ---------- 祭坛 ----------
  shrineAwake() {
    return BUNDLES.every((b) => this.bundleDone[b.id]);
  }

  do_donate(k, m, rt, d) {
    const S = MAP.shrine;
    if (Math.hypot(m.x - S.cx, m.y - S.cy) > S.r + 1.5) return { ok: false, error: '走到古代祭坛那里' };
    const b = BUNDLES.find((x) => x.id === d.bundle);
    if (!b) return { ok: false, error: '没有这组供品' };
    if (this.bundleDone[b.id]) return { ok: false, error: '这组已经交齐了' };
    const got = (this.bundles[b.id] = this.bundles[b.id] || {});
    let gave = 0;
    for (const [id, need] of Object.entries(b.need)) {
      if (d.item && d.item !== id) continue;
      const want = need - (got[id] || 0);
      const n = Math.min(want, invCount(m.inv, id));
      if (n > 0) {
        invRemove(m.inv, id, n);
        got[id] = (got[id] || 0) + n;
        gave += n;
      }
    }
    if (!gave) return { ok: false, error: '你身上没有这组需要的东西' };
    this.events.push({ type: 'donate', pid: k, bundle: b.id });
    if (Object.entries(b.need).every(([id, n]) => (got[id] || 0) >= n)) {
      this.bundleDone[b.id] = true;
      for (const [id, n] of Object.entries(b.reward)) {
        if (id === 'gold') this.gold += n;
        else if (id === 'hay') this.hay += n;
        else this.give(k, id, n);
      }
      const awake = this.shrineAwake();
      this.events.push({ type: 'bundle', pid: k, bundle: b.id, awake });
      if (awake) for (const mk of Object.keys(this.members)) {
        this.members[mk].energy = this.maxEnergy();
        this.meDirty.add(mk);
      }
    }
    this.bumpMeta();
    return { ok: true };
  }

  // ---------- 钓鱼 ----------
  cast(k, m, rt, x, y) {
    if (!this.reach(m, x, y, 5)) return { ok: false, error: '抛不了那么远' };
    if (this.ground[idx(x, y)] !== G.WATER) return { ok: false, error: '要抛到水里' };
    if (m.energy < D.ENERGY_COST.rod) return { ok: false, error: '太累了' };
    if (rt.fishing) this.endFishing(k, 'cancel');
    m.energy -= D.ENERGY_COST.rod;
    rt.fishing = { x, y, px: m.x, py: m.y, st: 'wait', at: this.t + 1.5 + this.rng() * 4.5, fish: null };
    this.events.push({ type: 'cast', pid: k, x, y });
    return { ok: true };
  }

  pickFish(x, y) {
    const sid = this.seasonId();
    const night = this.time >= 20 * 60;
    const rain = this.weather === 'rain';
    // 离岸越远越容易钓到好鱼
    let deep = 0;
    for (let r = 1; r <= 3; r++) for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r]]) if (okXY(x + dx, y + dy) && this.ground[idx(x + dx, y + dy)] === G.WATER) deep++;
    const pool = Object.entries(FISH).filter(([, f]) => f.season.includes(sid) && (!f.night || night) && (!f.rain || rain));
    let sum = 0;
    const ws = pool.map(([id, f]) => {
      const w = f.w * (f.diff >= 3 ? 1 + deep / 12 : 1);
      sum += w;
      return [id, w];
    });
    let r = this.rng() * sum;
    for (const [id, w] of ws) if ((r -= w) <= 0) return id;
    return 'carp';
  }

  do_hook(k, m, rt) {
    const f = rt.fishing;
    if (!f || f.st !== 'bite') {
      if (f && f.st === 'wait') {
        this.endFishing(k, 'early');
        return { ok: false, error: '拉早了，鱼跑了' };
      }
      return { ok: false, error: '没有鱼上钩' };
    }
    f.st = 'game';
    f.gameAt = this.t;
    f.fish = this.pickFish(f.x, f.y);
    this.events.push({ type: 'hooked', pid: k, fish: f.fish, diff: FISH[f.fish].diff });
    return { ok: true, fish: f.fish, diff: FISH[f.fish].diff };
  }

  do_reel(k, m, rt, d) {
    const f = rt.fishing;
    if (!f || f.st !== 'game') return { ok: false, error: '没有在钓鱼' };
    if (!d.ok) {
      this.endFishing(k, 'escape');
      return { ok: true };
    }
    if (this.t - f.gameAt < 0.8) return { ok: false, error: '太快了' };
    const id = f.fish;
    this.give(k, id, 1);
    this.stats.fish++;
    m.stats.fish++;
    this.endFishing(k, 'catch', id);
    return { ok: true };
  }

  do_reelIn(k) {
    this.endFishing(k, 'cancel');
    return { ok: true };
  }

  endFishing(k, why, fish) {
    const rt = this.online.get(k);
    if (!rt || !rt.fishing) return;
    rt.fishing = null;
    this.events.push({ type: 'fishEnd', pid: k, why, fish });
  }

  // ---------- 睡觉 ----------
  do_sleep(k, m, rt) {
    const dd = MAP.house.door;
    if (!this.reach(m, dd.x, dd.y, 2.6)) return { ok: false, error: '回家再睡' };
    rt.sleep = true;
    if (rt.fishing) this.endFishing(k, 'cancel');
    this.events.push({ type: 'sleep', pid: k });
    this.checkAllAsleep();
    return { ok: true };
  }

  do_wake(k, m, rt) {
    if (!rt.sleep) return { ok: true };
    rt.sleep = false;
    this.events.push({ type: 'wake', pid: k });
    return { ok: true };
  }

  checkAllAsleep() {
    if (!this.online.size) return;
    for (const rt of this.online.values()) if (!rt.sleep) return;
    this.newDay([]);
  }

  // ======================= 时间推进 =======================
  step(dt) {
    this.t += dt;
    // 有人在线时时钟才走
    if (this.online.size) {
      this.clockAcc += dt;
      const per = TIME.realSecPer10Min;
      while (this.clockAcc >= per) {
        this.clockAcc -= per;
        this.time += 10;
        this.bumpMeta();
        if (this.time >= TIME.end) {
          const out = [...this.online.entries()].filter(([, rt]) => !rt.sleep).map(([k]) => k);
          this.newDay(out);
          break;
        }
      }
    }
    // 钓鱼：等鱼咬钩
    for (const [k, rt] of this.online) {
      const f = rt.fishing;
      if (!f) continue;
      if (f.st === 'wait' && this.t >= f.at) {
        f.st = 'bite';
        f.until = this.t + 2.0;
        this.events.push({ type: 'bite', pid: k });
      } else if (f.st === 'bite' && this.t > f.until) {
        f.st = 'wait';
        f.at = this.t + 2 + this.rng() * 4;
        this.events.push({ type: 'nibble', pid: k });
      } else if (f.st === 'game' && this.t - f.gameAt > 40) this.endFishing(k, 'escape');
    }
    this.stepAnimals(dt);
    const ev = this.events;
    this.events = [];
    return ev;
  }

  stepAnimals(dt) {
    const evening = this.time >= 19 * 60 + 30;
    const bad = this.weather !== 'sun';
    for (const an of this.animals) {
      const door = MAP[an.house].door;
      if (evening || bad) {
        if (an.inside) continue;
        // 傍晚回屋
        an.tx = door.x + 0.5;
        an.ty = door.y + 0.5 - 0.6;
        if (Math.hypot(an.x - an.tx, an.y - an.ty) < 0.4) {
          an.inside = true;
          continue;
        }
      } else if (an.inside) {
        an.inside = false;
        an.x = door.x + 0.5;
        an.y = door.y + 0.5 - 0.6;
        an.wait = 0;
      } else {
        an.wait -= dt;
        if (an.wait <= 0 && Math.hypot(an.x - an.tx, an.y - an.ty) < 0.2) {
          an.wait = 3 + this.rng() * 8;
          const A = this.animalArea();
          for (let tries = 0; tries < 8; tries++) {
            const tx = Math.max(A.x + 0.4, Math.min(A.x + A.w - 0.4, an.x + (this.rng() - 0.5) * 6));
            const ty = Math.max(A.y + 0.4, Math.min(A.y + A.h - 0.4, an.y + (this.rng() - 0.5) * 6));
            if (this.walkable(tx, ty)) {
              an.tx = tx;
              an.ty = ty;
              break;
            }
          }
        }
      }
      const dx = an.tx - an.x;
      const dy = an.ty - an.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 0.05) {
        const sp = (ANIMALS[an.kind].house === 'coop' ? 1.1 : 0.8) * dt;
        const nx = an.x + (dx / dist) * Math.min(sp, dist);
        const ny = an.y + (dy / dist) * Math.min(sp, dist);
        if (this.walkable(nx, ny) || evening || bad) {
          an.x = nx;
          an.y = ny;
        } else {
          an.tx = an.x;
          an.ty = an.y;
        }
        an.f = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : dy > 0 ? 2 : 0;
      }
    }
  }

  // ======================= 新的一天 =======================
  newDay(passedOut = []) {
    const sid0 = this.seasonId();
    const rained = this.weather === 'rain';
    // 1. 出货结算
    const sold = {};
    let total = 0;
    for (const e of this.bin) {
      const v = (ITEMS[e.id].price || 0) * e.n;
      total += v;
      sold[e.id] = sold[e.id] || { id: e.id, n: 0, total: 0 };
      sold[e.id].n += e.n;
      sold[e.id].total += v;
      const mem = this.members[e.by];
      if (mem) mem.stats.shipped += v;
    }
    this.gold += total;
    this.stats.earned += total;
    this.stats.shipped += total;
    this.bin = [];

    // 2. 作物生长（浇过水或下过雨）
    for (const [i, o] of this.objs) {
      if (o.k !== 'crop' || o.dead || o.ready) continue;
      if (this.wet[i] || rained) {
        o.age++;
        if (o.age >= CROPS[o.c].days) o.ready = true;
        this.touchObj(i);
      }
    }

    // 3. 日期与季节
    this.day++;
    this.stats.days++;
    let newSeason = false;
    if (this.day > TIME.daysPerSeason) {
      this.day = 1;
      this.season = (this.season + 1) % 4;
      if (this.season === 0) this.year++;
      newSeason = true;
    }
    const sid = this.seasonId();
    if (newSeason) {
      for (const [i, o] of this.objs) {
        if (o.k === 'crop' && !o.dead && !CROPS[o.c].season.includes(sid)) {
          o.dead = true;
          this.touchObj(i);
        }
        if (o.k === 'forage') this.setObj(i, null);
      }
    }

    // 4. 天气
    this.weather = this.tomorrow;
    if (newSeason || this.day === 1) this.weather = 'sun';
    const rainP = D.SEASONS[this.season].rain;
    this.tomorrow = this.rng() < rainP ? (sid === 'winter' ? 'snow' : 'rain') : 'sun';
    if (this.day === TIME.daysPerSeason) this.tomorrow = 'sun';

    // 5. 浇水状态：昨天的水干了；下雨天全都湿；洒水器浇周围 8 格
    for (let i = 0; i < W * H; i++) {
      if (this.ground[i] !== G.TILLED) {
        this.setWet(i, 0);
        continue;
      }
      // 没种东西的地有一点几率长回草
      if (!this.wet[i] && !this.objs.has(i) && this.rng() < 0.05) {
        this.setGround(i, G.GRASS);
        this.setWet(i, 0);
        continue;
      }
      this.setWet(i, this.weather === 'rain' ? 1 : 0);
    }
    for (const [i, o] of this.objs) {
      if (o.k !== 'place' || o.id !== 'sprinkler') continue;
      const x = i % W;
      const y = Math.floor(i / W);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!okXY(x + dx, y + dy)) continue;
        const j = idx(x + dx, y + dy);
        if (this.ground[j] === G.TILLED) this.setWet(j, 1);
      }
    }

    // 6. 动物：晴天不在冬天就自己吃草，否则吃草料仓里的干草
    const graze = sid0 !== 'winter' && !rained && this.weather !== 'snow';
    const animalNews = [];
    for (const an of this.animals) {
      let fed = graze;
      if (!fed && this.hay > 0) {
        this.hay--;
        fed = true;
      }
      if (fed) {
        an.since++;
        if (an.since >= ANIMALS[an.kind].every) {
          an.since = 0;
          an.ready = true;
        }
      } else {
        an.fr = Math.max(0, an.fr - 20);
        animalNews.push(an.name);
      }
      if (!an.petted) an.fr = Math.max(0, an.fr - 8);
      an.petted = false;
      an.inside = this.weather !== 'sun';
      this.placeAnimal(an);
    }

    // 7. 建筑完工
    for (const [id, st] of Object.entries(this.buildings)) {
      if (st.pending) {
        st.pending = false;
        st.built = true;
      }
    }

    // 8. 野外：杂草、树苗、矿石慢慢长回来，刷新野果
    this.regrow();
    this.spawnForage(3 + Math.floor(this.rng() * 4), this.rng);

    // 9. 玩家
    for (const [mk, m] of Object.entries(this.members)) {
      const out = passedOut.includes(mk);
      m.energy = out ? Math.round(this.maxEnergy() * 0.6) : this.maxEnergy();
      m.x = MAP.start.x;
      m.y = MAP.start.y;
      m.f = 2;
      this.meDirty.add(mk);
    }
    for (const rt of this.online.values()) {
      rt.sleep = false;
      rt.fishing = null;
    }
    this.time = TIME.start;
    this.clockAcc = 0;
    this.lastReport = { sold: Object.values(sold), total, day: this.day, season: this.season, year: this.year, weather: this.weather, hungry: animalNews, newSeason };
    this.events.push({ type: 'day', report: this.lastReport, passedOut: passedOut.map((k) => this.members[k] && this.members[k].name).filter(Boolean) });
    this.bumpMeta();
  }

  regrow() {
    const rng = this.rng;
    let ore = 0;
    let trees = 0;
    for (const o of this.objs.values()) {
      if (o.k === 'ore') ore++;
      if (o.k === 'tree') trees++;
    }
    // 树苗长大
    for (const [i, o] of this.objs) {
      if (o.k !== 'tree' || o.s >= 2) continue;
      o.g = (o.g || 0) + 1;
      if (o.g >= 4) {
        o.g = 0;
        o.s++;
        o.hp = o.s === 2 ? 10 : 4;
        this.touchObj(i);
      }
    }
    const randTile = (zone) => {
      for (let t = 0; t < 30; t++) {
        const x = rint(rng, zone.x, zone.x + zone.w - 1);
        const y = rint(rng, zone.y, zone.y + zone.h - 1);
        if (!okXY(x, y)) continue;
        const i = idx(x, y);
        if (this.ground[i] === G.GRASS && this.freeTile(i) && !this.nearDoor(x, y)) return i;
      }
      return -1;
    };
    const forest = [{ x: 2, y: 2, w: 6, h: H - 4 }, { x: 2, y: 38, w: 32, h: 6 }];
    const anywhere = { x: 2, y: 2, w: W - 4, h: H - 4 };
    for (let n = rint(rng, 3, 7); n > 0; n--) {
      const i = randTile(anywhere);
      if (i >= 0) this.setObj(i, { k: 'weed', v: rint(rng, 0, 2) });
    }
    if (trees < 160) {
      for (let n = rint(rng, 1, 3); n > 0; n--) {
        const i = randTile(forest[rint(rng, 0, 1)]);
        if (i >= 0) this.setObj(i, { k: 'tree', hp: 1, s: 0, v: rint(rng, 0, 2), g: 0 });
      }
    }
    if (ore < 10) {
      for (let n = rint(rng, 1, 3); n > 0; n--) {
        const i = randTile({ x: 44, y: 2, w: 14, h: 14 });
        if (i >= 0) this.setObj(i, { k: 'ore', hp: 3 });
      }
    }
  }

  spawnForage(n, rng = this.rng) {
    const sid = this.seasonId();
    const land = Object.entries(FORAGE).filter(([, f]) => f.season.includes(sid) && !f.shore).map(([id]) => id);
    const shore = Object.entries(FORAGE).filter(([, f]) => f.season.includes(sid) && f.shore).map(([id]) => id);
    let count = 0;
    for (const o of this.objs.values()) if (o.k === 'forage') count++;
    for (let tries = 0; tries < n * 30 && n > 0 && count < 24; tries++) {
      const x = rint(rng, 2, W - 3);
      const y = rint(rng, 2, H - 3);
      const i = idx(x, y);
      if (!this.freeTile(i) || this.nearDoor(x, y)) continue;
      const gr = this.ground[i];
      const wild = x < 9 || y > 36 || (x > 44 && y < 16);
      let id = null;
      if (gr === G.SAND && shore.length && rng() < 0.5) id = shore[rint(rng, 0, shore.length - 1)];
      else if (gr === G.GRASS && wild && land.length) id = land[rint(rng, 0, land.length - 1)];
      if (!id) continue;
      this.setObj(i, { k: 'forage', id });
      n--;
      count++;
    }
  }

  // ======================= 视图 =======================
  playersView() {
    const out = [];
    for (const [k, rt] of this.online) {
      const m = this.members[k];
      const f = rt.fishing;
      out.push([k, Math.round(m.x * 100) / 100, Math.round(m.y * 100) / 100, m.f, rt.held, rt.anim, rt.sleep ? 1 : 0, f ? [f.x, f.y, f.st] : 0]);
    }
    return out;
  }

  animalsView() {
    return this.animals.map((a) => [a.id, Math.round(a.x * 100) / 100, Math.round(a.y * 100) / 100, a.f, a.inside ? 1 : 0, a.ready ? 1 : 0, a.petted ? 1 : 0]);
  }

  metaView() {
    return {
      v: this.metaVer,
      name: this.name,
      time: this.time,
      day: this.day,
      season: this.season,
      year: this.year,
      weather: this.weather,
      tomorrow: this.tomorrow,
      gold: this.gold,
      hay: this.hay,
      bin: this.bin.map((e) => ({ id: e.id, n: e.n, by: this.members[e.by] ? this.members[e.by].name : '' })),
      buildings: this.buildings,
      animals: this.animals.map((a) => ({ id: a.id, kind: a.kind, name: a.name, house: a.house, fr: a.fr, ready: a.ready, petted: a.petted })),
      bundles: this.bundles,
      bundleDone: this.bundleDone,
      awake: this.shrineAwake(),
      members: Object.entries(this.members).map(([k, m]) => ({ id: k, name: m.name, color: m.color, online: this.online.has(k), sleep: !!(this.online.get(k) || {}).sleep })),
      stats: this.stats,
      maxEnergy: this.maxEnergy(),
      shop: D.shopStock(this.seasonId()),
    };
  }

  fullView() {
    return {
      W,
      H,
      seed: this.seed,
      ground: Buffer.from(this.ground).toString('base64'),
      wet: Buffer.from(this.wet).toString('base64'),
      objs: [...this.objs.entries()],
      players: this.playersView(),
      a: this.animalsView(),
      meta: this.metaView(),
      clock: this.clockAcc / TIME.realSecPer10Min,
    };
  }

  meView(userId) {
    const m = this.members[String(userId)];
    return { inv: m.inv, energy: m.energy, maxEnergy: this.maxEnergy(), water: m.water, x: m.x, y: m.y, f: m.f };
  }

  flushChanges() {
    const c = this.changes;
    if (!c.g.size && !c.w.size && !c.o.size) return null;
    const out = { g: [...c.g.entries()], w: [...c.w.entries()], o: [...c.o.entries()] };
    this.changes = { g: new Map(), w: new Map(), o: new Map() };
    return out;
  }

  // ======================= 存档 =======================
  toJSON() {
    return {
      v: 1,
      seed: this.seed,
      name: this.name,
      ground: Buffer.from(this.ground).toString('base64'),
      wet: Buffer.from(this.wet).toString('base64'),
      objs: [...this.objs.entries()],
      buildings: this.buildings,
      animals: this.animals.map((a) => ({ ...a })),
      gold: this.gold,
      hay: this.hay,
      day: this.day,
      season: this.season,
      year: this.year,
      time: this.time,
      weather: this.weather,
      tomorrow: this.tomorrow,
      bin: this.bin,
      bundles: this.bundles,
      bundleDone: this.bundleDone,
      members: this.members,
      stats: this.stats,
      lastReport: this.lastReport,
      nextAnimalId: this.nextAnimalId,
      createdAt: this.createdAt,
    };
  }

  static fromJSON(d) {
    const w = new FarmWorld({ empty: true, seed: d.seed, name: d.name });
    w.ground = new Uint8Array(Buffer.from(d.ground, 'base64'));
    w.wet = new Uint8Array(Buffer.from(d.wet, 'base64'));
    if (w.ground.length !== W * H) throw new Error('地图尺寸不符');
    w.objs = new Map(d.objs);
    for (const k of ['buildings', 'animals', 'gold', 'hay', 'day', 'season', 'year', 'time', 'weather', 'tomorrow', 'bin', 'bundles', 'bundleDone', 'members', 'stats', 'lastReport', 'nextAnimalId', 'createdAt']) if (d[k] !== undefined) w[k] = d[k];
    w.initRuntime();
    return w;
  }
}

module.exports = { FarmWorld, invAdd, invCount, invRemove, W, H, idx };
