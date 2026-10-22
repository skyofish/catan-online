'use strict';
// 猛鬼宿舍规则引擎：服务器权威的实时模拟（固定步长推进）。
// 开局所有人在宿舍楼入口集合，自己走进一间空宿舍、躺到床上就占下了这间（一间只能一个人）。
// 躺下后床每秒产金币，造防御、升级床和门；猛鬼醒来后不断升级，挑一间宿舍砸门，门破后攻击床，床毁则出局。
// 坚持到天亮（或打死猛鬼）即胜利。地图每局随机（mapgen.js）。
const { BED, DOOR, BUILD, ATTACKERS, PROPS, SELL_RATE, GHOST, DIFFICULTY, PLAYER, itemMaxHp } = require('./config');
const { generateMap, findPath } = require('./mapgen');

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function afford(p, c) {
  return p.gold >= (c.g || 0) && p.energy >= (c.e || 0);
}
function pay(p, c) {
  p.gold -= c.g || 0;
  p.energy -= c.e || 0;
}
const lack = (p, c) => (c.e && p.energy < c.e ? '电力不足' : '金币不足');

class DormGame {
  /**
   * @param {object} opts { difficulty, rng, map }
   * @param {Array} players [{ id, name, color }]
   */
  constructor(opts, players) {
    this.diffKey = DIFFICULTY[opts.difficulty] ? opts.difficulty : 'normal';
    this.D = DIFFICULTY[this.diffKey];
    this.rng = opts.rng || Math.random;
    this.map = opts.map || generateMap(this.rng);
    this.geo = this.map.rooms;
    this.phase = 'prep';
    this.t = 0;
    this.playT = 0;
    this.prepLeft = this.D.prep;
    this.duration = this.D.duration;
    this.startedAt = Date.now();
    this.endedAt = null;
    this.result = null;
    this.kills = 0;
    this.events = [];

    // 每个格子属于哪间宿舍（含门、床、家具）
    this.tileRoom = this.map.tiles.map((row) => new Array(row.length).fill(-1));
    this.cellAt = new Map(); // "x,y" -> [room, idx]
    for (const g of this.geo) {
      const mark = (x, y) => (this.tileRoom[y][x] = g.i);
      g.cells.forEach(([x, y], idx) => {
        mark(x, y);
        this.cellAt.set(`${x},${y}`, [g.i, idx]);
      });
      for (const [x, y] of g.bed.tiles) mark(x, y);
      for (const [x, y] of g.furniture) mark(x, y);
      mark(g.door.x, g.door.y);
    }

    this.rooms = this.geo.map((g) => ({
      i: g.i,
      owner: null,
      dead: false,
      door: { lv: 1, hp: DOOR.hp[0], max: DOOR.hp[0] },
      bed: { lv: 1 },
      cells: new Array(g.cells.length).fill(null),
      stunUntil: 0,
      ver: 1,
    }));
    this.spawnProps();

    // 入口的空地，玩家在这里集合
    const spawn = [];
    const E = this.map.entrance;
    for (let y = E.y; y < E.y + E.h; y++) for (let x = E.x; x < E.x + E.w; x++) if (this.tile(x, y) === 'E') spawn.push({ x: x + 0.5, y: y + 0.5 });
    this.players = players.map((p, k) => {
      const s = spawn[k % spawn.length];
      return {
        id: p.id,
        name: p.name,
        color: p.color,
        x: s.x + (this.rng() - 0.5) * 0.3,
        y: s.y + (this.rng() - 0.5) * 0.3,
        path: [],
        goalBed: null, // 正在走向哪间宿舍的床
        state: 'idle', // idle | walk | bed
        room: null,
        gold: this.D.startGold,
        energy: 0,
        alive: true,
        diedAt: null,
        stats: { dmg: 0, earned: 0, built: 0 },
      };
    });

    this.hpMul = this.D.hpMul * (1 + GHOST.perPlayer * Math.max(0, this.players.length - 1));
    this.dmgMul = this.D.dmgMul * GHOST.dmgByPlayers[Math.min(this.players.length, GHOST.dmgByPlayers.length) - 1];
    const L = this.map.lair;
    this.lairPt = { x: L.cx, y: L.cy };
    this.ghost = {
      x: L.cx,
      y: L.cy,
      lv: 1,
      hp: Math.round(GHOST.hp(1) * this.hpMul),
      max: Math.round(GHOST.hp(1) * this.hpMul),
      state: 'sleep',
      target: null,
      path: [],
      hitCd: 0,
      slow: 0,
      screamCd: this.D.scream || 0,
      targetSince: 0,
      dmgTaken: 0,
      stunUntil: 0,
      stunImmune: 0,
      rootUntil: 0,
      burn: null, // { dps, until, by }
    };
  }

  // 每间宿舍随机刷 1–3 个初始道具：可以搜的储物柜，或免费的 1 级建筑
  spawnProps() {
    const total = PROPS.pool.reduce((s, x) => s + x.w, 0);
    for (const r of this.rooms) {
      const n = PROPS.count[0] + Math.floor(this.rng() * (PROPS.count[1] - PROPS.count[0] + 1));
      const free = r.cells.map((_, i) => i);
      for (let k = 0; k < n && free.length; k++) {
        let x = this.rng() * total;
        let type = PROPS.pool[0].type;
        for (const it of PROPS.pool) if ((x -= it.w) <= 0) {
          type = it.type;
          break;
        }
        const idx = free.splice(Math.floor(this.rng() * free.length), 1)[0];
        if (type === 'chest') {
          const C = PROPS.chest;
          const energy = this.rng() < C.energyChance;
          const range = energy ? C.energy : C.gold;
          const amt = Math.round(range[0] + this.rng() * (range[1] - range[0]));
          const hp = itemMaxHp('chest', 1);
          r.cells[idx] = { type: 'chest', lv: 1, hp, max: hp, loot: energy ? { e: amt } : { g: amt } };
        } else {
          const c = BUILD[type].cost[0];
          const hp = itemMaxHp(type, 1);
          r.cells[idx] = { type, lv: 1, cd: 0, hp, max: hp, spent: { g: c.g || 0, e: c.e || 0 }, prop: true };
        }
      }
      this.recalcItems(r);
    }
  }

  // 道具耐久上限（等级 + 香案加成）；上限提高时同时补上差值
  recalcItems(r) {
    const boost = Math.min(1, this.sumOf(r, 'altar', 'hpBoost'));
    for (const c of r.cells) {
      if (!c) continue;
      const max = itemMaxHp(c.type, c.lv, c.type === 'chest' ? 0 : boost);
      if (c.max === undefined) c.hp = c.max = max;
      if (max > c.max) c.hp += max - c.max;
      c.max = max;
      c.hp = Math.min(c.hp, max);
    }
  }

  tile(x, y) {
    const row = this.map.tiles[y];
    return row ? row[x] : '#';
  }
  roomAt(x, y) {
    const row = this.tileRoom[Math.floor(y)];
    const i = row ? row[Math.floor(x)] : -1;
    return i === undefined || i < 0 ? null : i;
  }
  P(id) {
    return this.players.find((p) => p.id === id) || null;
  }
  roomOf(p) {
    return p && p.room !== null ? this.rooms[p.room] : null;
  }
  emit(e) {
    this.events.push(e);
  }
  cellCenter(ri, idx) {
    const [x, y] = this.geo[ri].cells[idx];
    return { x: x + 0.5, y: y + 0.5 };
  }

  // 玩家能走的格子：没人占的宿舍门是开着的；家具、床、墙不能走
  passPlayer(x, y) {
    const c = this.tile(x, y);
    if (c === '.' || c === 'L' || c === 'E' || c === 'r') {
      if (c === 'r') {
        const ri = this.roomAt(x, y);
        return ri === null || !this.rooms[ri].owner;
      }
      return true;
    }
    if (c === 'D') return !this.rooms[this.roomAt(x, y)].owner;
    return false;
  }
  // 猛鬼能走的格子：门被砸烂了才能进屋（空宿舍门开着）
  passGhost(x, y) {
    const c = this.tile(x, y);
    if (c === '.' || c === 'L' || c === 'E' || c === 'r') return true;
    if (c === 'D') {
      const r = this.rooms[this.roomAt(x, y)];
      return !r.owner || r.door.hp <= 0;
    }
    return false;
  }

  // ---------------- 数值查询 ----------------
  income(p) {
    const r = this.roomOf(p);
    if (!r || !p.alive || r.dead) return 0;
    let s = BED.income[r.bed.lv - 1];
    for (const c of r.cells) if (c && c.type === 'cat') s += BUILD.cat.gold[c.lv - 1];
    return s;
  }
  energyRate(p) {
    const r = this.roomOf(p);
    if (!r || !p.alive || r.dead) return 0;
    let s = 0;
    for (const c of r.cells) if (c && c.type === 'generator') s += BUILD.generator.energy[c.lv - 1];
    return s;
  }
  ghostDmg() {
    return Math.round(GHOST.dmg(this.ghost.lv) * this.dmgMul);
  }
  armor() {
    return GHOST.armor(this.ghost.lv) * this.D.armorMul;
  }
  effDmg(dmg, armor = this.armor()) {
    return Math.max(dmg * 0.2, dmg - armor);
  }
  // 引魂灯加成：同一间宿舍里相邻（含斜角）的灯
  boostOf(ri, idx) {
    const r = this.rooms[ri];
    const [x, y] = this.geo[ri].cells[idx];
    let b = 0;
    this.geo[ri].cells.forEach(([cx, cy], k) => {
      const c = r.cells[k];
      if (c && c.type === 'lantern' && k !== idx && Math.abs(cx - x) <= 1 && Math.abs(cy - y) <= 1) b += BUILD.lantern.boost[c.lv - 1];
    });
    return Math.min(1, b);
  }
  // 一个攻击建筑对某点的每秒伤害（估算，用于 AI）
  cellDps(ri, idx, pt, armor = this.armor()) {
    const c = this.rooms[ri].cells[idx];
    if (!c || !ATTACKERS.includes(c.type)) return 0;
    const b = BUILD[c.type];
    if (dist(this.cellCenter(ri, idx), pt) > b.range) return 0;
    const k = 1 + this.boostOf(ri, idx);
    let s = this.effDmg(b.dmg[c.lv - 1] * k, armor) / b.cd;
    if (c.type === 'talisman') s += b.burn[c.lv - 1] * k;
    return s;
  }
  dpsAt(pt, now = this.t) {
    let s = 0;
    for (const r of this.rooms) {
      if (!r.owner || r.dead || r.stunUntil > now) continue;
      for (let idx = 0; idx < r.cells.length; idx++) s += this.cellDps(r.i, idx, pt);
    }
    return s;
  }
  slowAt(pt) {
    let s = 0;
    for (const r of this.rooms) {
      if (!r.owner || r.dead) continue;
      r.cells.forEach((c, idx) => {
        if (c && c.type === 'frost' && dist(this.cellCenter(r.i, idx), pt) <= BUILD.frost.range) s = Math.max(s, BUILD.frost.slow[c.lv - 1]);
      });
    }
    return s;
  }
  sumOf(r, type, key) {
    let s = 0;
    for (const c of r.cells) if (c && c.type === type) s += BUILD[type][key][c.lv - 1];
    return s;
  }
  reflectOf(r) {
    return Math.min(0.75, this.sumOf(r, 'mirror', 'reflect'));
  }
  repairOf(r) {
    return this.sumOf(r, 'repair', 'heal');
  }
  timeLeft() {
    if (this.phase === 'prep') return this.duration;
    return Math.max(0, this.duration - this.playT);
  }

  // ---------------- 玩家操作 ----------------
  act(pid, a) {
    const p = this.P(pid);
    if (!p) return { ok: false, error: '你不在这局游戏中' };
    if (this.phase === 'ended') return { ok: false, error: '游戏已结束' };
    if (!p.alive) return { ok: false, error: '你已经出局了' };
    const fn = this['a_' + (a && a.type)];
    if (!fn) return { ok: false, error: '未知操作' };
    try {
      return fn.call(this, p, a) || { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // 走到某个格子；目标是床的话，到了就躺下占房
  a_move(p, a) {
    if (p.state === 'bed') throw new Error('你已经躺下了');
    if (this.phase !== 'prep') throw new Error('猛鬼醒了，来不及了');
    const x = Math.floor(Number(a.x));
    const y = Math.floor(Number(a.y));
    if (!(x >= 0 && y >= 0 && x < this.map.W && y < this.map.H)) throw new Error('走不过去');
    let to = { x, y };
    let goalBed = null;
    if (this.tile(x, y) === 'B') {
      goalBed = this.roomAt(x, y);
      const r = this.rooms[goalBed];
      if (r.owner) throw new Error('这间宿舍已经有人了');
      // 走到床边那格，然后上床
      const [fx, fy] = this.geo[goalBed].front;
      to = { x: fx, y: fy };
    } else if (!this.passPlayer(x, y)) {
      throw new Error(this.tile(x, y) === 'D' || this.tile(x, y) === 'r' ? '这间宿舍已经有人了' : '走不过去');
    }
    const path = findPath(this.map, p, to, (tx, ty) => this.passPlayer(tx, ty));
    if (!path) throw new Error('走不过去');
    p.path = path;
    p.goalBed = goalBed;
    p.state = 'walk';
  }

  // 测试与断线代管用：直接走向某间宿舍的床
  a_claim(p, a) {
    const g = this.geo[Number(a.room)];
    if (!g) throw new Error('没有这间宿舍');
    return this.a_move(p, { x: g.bed.head[0], y: g.bed.head[1] });
  }

  movePlayers(dt) {
    for (const p of this.players) {
      if (p.state !== 'walk') continue;
      // 要去的宿舍被别人抢先躺下了
      if (p.goalBed !== null && this.rooms[p.goalBed].owner) {
        this.emit({ type: 'claimFail', pid: p.id, room: p.goalBed });
        p.path = [];
        p.goalBed = null;
        p.state = 'idle';
        continue;
      }
      let move = PLAYER.speed * dt;
      while (move > 0 && p.path.length) {
        const to = p.path[0];
        // 前面的门刚被别人关上：重新找路
        if (!this.passPlayer(Math.floor(to.x), Math.floor(to.y)) && !(p.goalBed !== null && p.path.length === 1)) {
          const last = p.path[p.path.length - 1];
          const np = findPath(this.map, p, { x: Math.floor(last.x), y: Math.floor(last.y) }, (tx, ty) => this.passPlayer(tx, ty));
          if (!np) {
            p.path = [];
            p.goalBed = null;
            break;
          }
          p.path = np;
          continue;
        }
        const d = dist(p, to);
        if (d <= move) {
          p.x = to.x;
          p.y = to.y;
          move -= d;
          p.path.shift();
        } else {
          p.x += ((to.x - p.x) / d) * move;
          p.y += ((to.y - p.y) / d) * move;
          move = 0;
        }
      }
      if (!p.path.length) {
        p.state = 'idle';
        if (p.goalBed !== null) this.lieDown(p, p.goalBed);
        p.goalBed = null;
      }
    }
  }

  lieDown(p, ri, auto = false) {
    const r = this.rooms[ri];
    if (r.owner && r.owner !== p.id) {
      this.emit({ type: 'claimFail', pid: p.id, room: ri });
      return false;
    }
    const g = this.geo[ri];
    r.owner = p.id;
    r.ver++;
    p.room = ri;
    p.state = 'bed';
    p.path = [];
    p.x = g.bed.cx;
    p.y = g.bed.cy;
    // 门关上，屋里的其他人被请出去
    for (const o of this.players) {
      if (o === p || o.state === 'bed') continue;
      if (this.roomAt(o.x, o.y) === ri) {
        o.x = g.outside.x + 0.5;
        o.y = g.outside.y + 0.5;
        o.path = [];
        o.goalBed = null;
        o.state = 'idle';
        this.emit({ type: 'bump', pid: o.id, room: ri });
      }
    }
    this.emit({ type: 'claim', room: ri, pid: p.id, auto });
    return true;
  }

  myRoom(p) {
    const r = this.roomOf(p);
    if (!r) throw new Error('先找一间宿舍躺下');
    if (r.dead) throw new Error('你的宿舍已经被攻破');
    return r;
  }
  cellOf(r, a) {
    const idx = Number(a.cell);
    if (!(idx >= 0 && idx < r.cells.length)) throw new Error('这里不能建造');
    return idx;
  }

  a_build(p, a) {
    const r = this.myRoom(p);
    const idx = this.cellOf(r, a);
    const b = BUILD[a.btype];
    if (!b) throw new Error('未知建筑');
    if (r.cells[idx]) throw new Error('这里已经有东西了');
    const c = b.cost[0];
    if (!afford(p, c)) throw new Error(lack(p, c));
    pay(p, c);
    r.cells[idx] = { type: a.btype, lv: 1, cd: 0, spent: { g: c.g || 0, e: c.e || 0 } };
    r.ver++;
    p.stats.built++;
    this.recalcItems(r);
    this.emit({ type: 'build', room: r.i, cell: idx, btype: a.btype, lv: 1, pid: p.id });
  }

  a_upgrade(p, a) {
    const r = this.myRoom(p);
    const idx = this.cellOf(r, a);
    const cell = r.cells[idx];
    if (!cell || cell.type === 'chest') throw new Error('这里没有建筑');
    const b = BUILD[cell.type];
    if (cell.lv >= b.cost.length) throw new Error('已经是最高级');
    const c = b.cost[cell.lv];
    if (!afford(p, c)) throw new Error(lack(p, c));
    pay(p, c);
    cell.lv++;
    cell.spent.g += c.g || 0;
    cell.spent.e += c.e || 0;
    r.ver++;
    // 升级后修好
    this.recalcItems(r);
    cell.hp = cell.max;
    this.emit({ type: 'build', room: r.i, cell: idx, btype: cell.type, lv: cell.lv, pid: p.id });
  }

  a_sell(p, a) {
    const r = this.myRoom(p);
    const idx = this.cellOf(r, a);
    const cell = r.cells[idx];
    if (!cell || cell.type === 'chest') throw new Error('这里没有建筑');
    p.gold += Math.floor(cell.spent.g * SELL_RATE);
    p.energy += Math.floor(cell.spent.e * SELL_RATE);
    r.cells[idx] = null;
    r.ver++;
    if (cell.type === 'altar') this.recalcItems(r);
    this.emit({ type: 'sell', room: r.i, cell: idx, pid: p.id });
  }

  // 搜储物柜
  a_open(p, a) {
    const r = this.myRoom(p);
    const idx = this.cellOf(r, a);
    const cell = r.cells[idx];
    if (!cell || cell.type !== 'chest') throw new Error('这里没有储物柜');
    p.gold += cell.loot.g || 0;
    p.energy += cell.loot.e || 0;
    r.cells[idx] = null;
    r.ver++;
    this.emit({ type: 'loot', room: r.i, cell: idx, pid: p.id, g: cell.loot.g || 0, e: cell.loot.e || 0 });
  }

  a_bed(p) {
    const r = this.myRoom(p);
    if (r.bed.lv >= BED.income.length) throw new Error('床已经是最高级');
    const c = BED.cost[r.bed.lv - 1];
    if (!afford(p, c)) throw new Error(lack(p, c));
    pay(p, c);
    r.bed.lv++;
    r.ver++;
    this.emit({ type: 'bed', room: r.i, lv: r.bed.lv, pid: p.id });
  }

  a_door(p) {
    const r = this.myRoom(p);
    if (r.door.hp <= 0) throw new Error('门已经被砸烂了');
    if (r.door.lv >= DOOR.hp.length) throw new Error('门已经是最高级');
    const c = DOOR.cost[r.door.lv - 1];
    if (!afford(p, c)) throw new Error(lack(p, c));
    pay(p, c);
    r.door.lv++;
    const max = DOOR.hp[r.door.lv - 1];
    r.door.hp = Math.min(max, r.door.hp + (max - r.door.max));
    r.door.max = max;
    r.ver++;
    this.emit({ type: 'door', room: r.i, lv: r.door.lv, pid: p.id });
  }

  // ---------------- 推进 ----------------
  step(dt) {
    if (this.phase === 'ended') return [];
    this.t += dt;
    if (this.phase === 'prep') {
      this.prepLeft -= dt;
      this.movePlayers(dt);
      this.economy(dt);
      if (this.prepLeft <= 0) this.wake();
    } else {
      this.playT += dt;
      this.economy(dt);
      this.levelUp();
      this.repairs(dt);
      this.ghostStep(dt);
      if (this.phase !== 'ended') this.towers(dt);
      if (this.phase !== 'ended') this.burnStep(dt);
      if (this.phase !== 'ended' && this.playT >= this.duration) this.finish(true, 'time');
    }
    const ev = this.events;
    this.events = [];
    return ev;
  }

  economy(dt) {
    for (const p of this.players) {
      if (!p.alive || p.room === null) continue;
      const g = this.income(p) * dt;
      p.gold += g;
      p.stats.earned += g;
      p.energy += this.energyRate(p) * dt;
    }
  }

  wake() {
    this.phase = 'play';
    this.prepLeft = 0;
    // 还没躺下的人：吓得钻进离自己最近的空宿舍
    for (const p of this.players) {
      if (p.state === 'bed') continue;
      const free = this.rooms.filter((r) => !r.owner);
      if (!free.length) {
        p.alive = false;
        continue;
      }
      const near = free.reduce((a, b) => (dist(p, this.geo[b.i].center) < dist(p, this.geo[a.i].center) ? b : a));
      this.lieDown(p, near.i, true);
    }
    this.emit({ type: 'wake' });
    this.pickTarget();
  }

  levelUp() {
    const g = this.ghost;
    const want = Math.min(GHOST.maxLv, 1 + Math.floor(this.playT / this.D.levelEvery) + Math.floor(this.kills / 2));
    if (want <= g.lv) return;
    const ratio = g.hp / g.max;
    g.lv = want;
    g.max = Math.round(GHOST.hp(g.lv) * this.hpMul);
    g.hp = Math.round(g.max * ratio);
    this.emit({ type: 'ghostLevel', lv: g.lv });
  }

  repairs(dt) {
    for (const r of this.rooms) {
      if (!r.owner || r.dead) continue;
      if (r.door.hp > 0 && r.door.hp < r.door.max) {
        const h = this.repairOf(r);
        if (h) r.door.hp = Math.min(r.door.max, r.door.hp + h * dt);
      }
      // 香案：修补被砸坏的道具
      const h = this.sumOf(r, 'altar', 'heal');
      if (h) {
        for (const c of r.cells) {
          if (c && c.hp < c.max) {
            c.hp = Math.min(c.max, c.hp + h * dt);
            r.healTick = (r.healTick || 0) + dt;
          }
        }
        if (r.healTick > 1) {
          r.healTick = 0;
          r.ver++;
        }
      }
    }
  }

  alivePlayers() {
    return this.players.filter((p) => p.alive && p.room !== null);
  }

  // ---------------- 猛鬼 ----------------
  evalRoom(r) {
    const g = this.geo[r.i];
    const gd = this.ghostDmg() / GHOST.hitEvery;
    const eff = gd * (1 - this.slowAt(g.atkDoor));
    const repair = r.door.hp > 0 ? this.repairOf(r) : 0;
    const doorTime = r.door.hp > 0 ? r.door.hp / Math.max(1, eff - repair) : 0;
    // 屋里：一路砸开挡路的道具走到床边要多久
    const inside = this.interior(r.i, { x: g.door.x, y: g.door.y });
    const bedTime = (inside ? inside.cost : 5) + GHOST.hitEvery;
    const travel = dist(this.ghost, g.hallPt) / GHOST.speed(this.ghost.lv);
    const dps = this.dpsAt(g.atkDoor) + eff * this.reflectOf(r);
    const taken = dps * doorTime + this.dpsAt(g.center) * bedTime;
    const ttk = doorTime + bedTime + travel;
    return { ttk, taken, risk: taken / Math.max(1, this.ghost.hp), feasible: eff > repair * 1.05 };
  }

  scoreRoom(r) {
    const e = this.evalRoom(r);
    let s = e.ttk * (1 + 2.5 * e.risk);
    if (!e.feasible) s *= 50;
    return s;
  }

  pickTarget(exclude = null) {
    const g = this.ghost;
    const cands = this.rooms.filter((r) => r.owner && !r.dead && r.i !== exclude);
    const list = cands.length ? cands : this.rooms.filter((r) => r.owner && !r.dead);
    if (!list.length) return;
    let pick;
    const smart = this.D.smart;
    if (smart === 0) {
      const w = list.map((r) => 1 / (1 + dist(g, this.geo[r.i].hallPt) / 6));
      let x = this.rng() * w.reduce((a, b) => a + b, 0);
      pick = list[list.length - 1];
      for (let i = 0; i < list.length; i++) if ((x -= w[i]) <= 0) {
        pick = list[i];
        break;
      }
    } else if (smart === 1) {
      pick = this.rng() < 0.6 ? list.reduce((a, b) => (b.door.hp < a.door.hp ? b : a)) : list[Math.floor(this.rng() * list.length)];
    } else {
      const scored = list.map((r) => ({ r, s: this.scoreRoom(r) * (1 + (smart === 2 ? this.rng() * 0.5 : this.rng() * 0.15)) }));
      scored.sort((a, b) => a.s - b.s);
      pick = scored[0].r;
    }
    this.setTarget(pick.i);
  }

  setTarget(i) {
    const g = this.ghost;
    g.target = i;
    g.targetSince = this.playT;
    g.dmgTaken = 0;
    g.state = 'hunt';
    g.path = this.pathTo(i);
    this.emit({ type: 'hunt', room: i });
  }

  // 去某间宿舍：门没破就走到门外，破了就进屋走到床边；'lair' 回血池
  pathTo(target) {
    const g = this.ghost;
    const pass = (x, y) => this.passGhost(x, y);
    let to;
    let tail;
    if (target === 'lair') {
      to = { x: Math.floor(this.lairPt.x), y: Math.floor(this.lairPt.y) };
      tail = this.lairPt;
    } else {
      const geo = this.geo[target];
      if (this.rooms[target].door.hp > 0) {
        to = geo.outside;
        tail = geo.atkDoor;
      } else {
        // 门破了：先走到门口，进门后再一路砸过去（见 arrive / planInside）
        to = geo.door;
        tail = { x: geo.door.x + 0.5, y: geo.door.y + 0.5 };
      }
    }
    const path = findPath(this.map, g, to, pass) || [];
    path.push({ x: tail.x, y: tail.y });
    return path;
  }

  ghostStep(dt) {
    const g = this.ghost;
    const here = { x: g.x, y: g.y };
    g.slow = this.slowAt(here);
    const stunned = g.stunUntil > this.t;
    const rooted = g.rootUntil > this.t;
    const spd = GHOST.speed(g.lv) * (1 - g.slow) * (g.state === 'retreat' ? GHOST.retreatSpeed : 1);

    if ((g.state === 'hunt' || g.state === 'retreat') && !stunned && !rooted) {
      let move = spd * dt;
      while (move > 0 && g.path.length) {
        const to = g.path[0];
        const d = dist(g, to);
        if (d <= move) {
          g.x = to.x;
          g.y = to.y;
          move -= d;
          g.path.shift();
        } else {
          g.x += ((to.x - g.x) / d) * move;
          g.y += ((to.y - g.y) / d) * move;
          move = 0;
        }
      }
      if (!g.path.length) this.arrive();
    } else if (g.state === 'heal') {
      g.hp = Math.min(g.max, g.hp + g.max * this.D.healRate * dt);
      if (g.hp >= g.max * 0.95) this.pickTarget();
    } else if ((g.state === 'door' || g.state === 'bed' || g.state === 'smash') && !stunned) {
      this.attack(dt);
    }

    const danger = this.D.smart >= 1 && g.state !== 'sleep' ? this.dpsAt(here) * (2 + this.D.smart) : 0;
    if (g.state !== 'retreat' && g.state !== 'heal' && (g.hp < g.max * this.D.retreatAt || g.hp < danger)) {
      g.state = 'retreat';
      g.path = this.pathTo('lair');
      g.target = null;
      g.burn = null;
      this.emit({ type: 'retreat' });
    }
  }

  arrive() {
    const g = this.ghost;
    if (g.state === 'retreat') {
      g.state = 'heal';
      return;
    }
    const r = this.rooms[g.target];
    if (!r || r.dead || !r.owner) return this.pickTarget();
    const geo = this.geo[r.i];
    if (r.door.hp > 0) {
      if (dist(g, geo.atkDoor) < 0.05) {
        g.state = 'door';
        g.hitCd = 0.4;
      } else g.path = this.pathTo(r.i);
      return;
    }
    if (dist(g, geo.atkBed) < 0.05) {
      // 到了床边：举起手……一下就够了
      g.state = 'bed';
      g.hitCd = 0.8;
      return;
    }
    const inRoom = this.roomAt(g.x, g.y) === r.i;
    if (!inRoom) {
      g.path = this.pathTo(r.i);
      return;
    }
    if (g.smash !== null && g.smash !== undefined && r.cells[g.smash]) {
      g.state = 'smash';
      g.hitCd = 0.4;
      return;
    }
    this.planInside(r);
  }

  // 屋里的寻路：道具挡路时算「砸开要多久」，选总时间最短的路线（4 方向，Dijkstra）
  interior(ri, from) {
    const geo = this.geo[ri];
    const r = this.rooms[ri];
    const W = this.map.W;
    const gd = Math.max(1, this.ghostDmg() / GHOST.hitEvery);
    const step = 1 / GHOST.speed(this.ghost.lv);
    const goal = geo.front[1] * W + geo.front[0];
    const start = Math.floor(from.y) * W + Math.floor(from.x);
    const cost = new Map([[start, 0]]);
    const prev = new Map();
    const open = [[0, start]];
    while (open.length) {
      open.sort((a, b) => a[0] - b[0]);
      const [c, k] = open.shift();
      if (c > cost.get(k)) continue;
      if (k === goal) break;
      const x = k % W;
      const y = Math.floor(k / W);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + dx;
        const ny = y + dy;
        if (this.roomAt(nx + 0.5, ny + 0.5) !== ri && !(nx === geo.door.x && ny === geo.door.y)) continue;
        const t = this.tile(nx, ny);
        if (t !== 'r' && t !== 'D') continue;
        let w = step;
        const ce = this.cellAt.get(`${nx},${ny}`);
        const item = ce && r.cells[ce[1]];
        if (item) w += item.hp / gd;
        const nk = ny * W + nx;
        if (!cost.has(nk) || c + w < cost.get(nk)) {
          cost.set(nk, c + w);
          prev.set(nk, k);
          open.push([c + w, nk]);
        }
      }
    }
    if (!cost.has(goal)) return null;
    const tiles = [];
    for (let k = goal; k !== start && k !== undefined; k = prev.get(k)) tiles.push([k % W, Math.floor(k / W)]);
    tiles.reverse();
    return { cost: cost.get(goal), tiles };
  }

  planInside(r) {
    const g = this.ghost;
    const geo = this.geo[r.i];
    const plan = this.interior(r.i, g);
    g.smash = null;
    const path = [];
    if (plan) {
      for (const [x, y] of plan.tiles) {
        const ce = this.cellAt.get(`${x},${y}`);
        if (ce && r.cells[ce[1]]) {
          g.smash = ce[1];
          break;
        }
        path.push({ x: x + 0.5, y: y + 0.5 });
      }
    }
    if (g.smash === null) path.push({ x: geo.atkBed.x, y: geo.atkBed.y });
    g.state = 'hunt';
    g.path = path;
    if (!path.length) this.arrive();
  }

  attack(dt) {
    const g = this.ghost;
    const r = this.rooms[g.target];
    if (!r || r.dead) return this.pickTarget();
    if (this.D.scream) {
      g.screamCd -= dt;
      if (g.screamCd <= 0) {
        g.screamCd = this.D.scream;
        r.stunUntil = this.t + 3;
        this.emit({ type: 'scream', room: r.i });
      }
    }
    if (this.D.smart >= 2 && g.state === 'door' && this.playT - g.targetSince > 8) {
      const cur = this.evalRoom(r);
      const elapsed = this.playT - g.targetSince;
      if (!cur.feasible || (g.dmgTaken > g.max * 0.25 && cur.ttk > elapsed)) {
        const others = this.rooms.filter((x) => x.owner && !x.dead && x !== r);
        if (others.length) {
          const best = others.reduce((a, b) => (this.scoreRoom(b) < this.scoreRoom(a) ? b : a));
          if (this.scoreRoom(best) < this.scoreRoom(r) * 0.6) {
            this.setTarget(best.i);
            return;
          }
        }
      }
    }
    g.hitCd -= dt * (1 - g.slow);
    if (g.hitCd > 0) return;
    g.hitCd += GHOST.hitEvery;
    const dmg = this.ghostDmg();
    if (g.state === 'door') {
      r.door.hp = Math.max(0, r.door.hp - dmg);
      this.emit({ type: 'hitDoor', room: r.i, dmg });
      const ref = this.reflectOf(r);
      if (ref > 0) {
        const back = Math.round(dmg * ref);
        this.hurtGhost(back, this.P(r.owner));
        this.emit({ type: 'reflect', room: r.i, dmg: back });
        if (this.phase === 'ended') return;
      }
      if (r.door.hp <= 0) {
        r.ver++;
        this.emit({ type: 'doorBroken', room: r.i });
        g.state = 'hunt';
        g.path = this.pathTo(r.i);
      }
    } else if (g.state === 'smash') {
      const c = r.cells[g.smash];
      if (!c) return this.planInside(r);
      c.hp = Math.max(0, c.hp - dmg);
      r.ver++;
      this.emit({ type: 'hitCell', room: r.i, cell: g.smash, dmg });
      if (c.hp <= 0) {
        r.cells[g.smash] = null;
        this.emit({ type: 'wreck', room: r.i, cell: g.smash, btype: c.type });
        if (c.type === 'altar') this.recalcItems(r);
        this.planInside(r);
      }
    } else {
      // 床没有血量：一下就淘汰
      this.emit({ type: 'hitBed', room: r.i, dmg });
      this.killRoom(r);
    }
  }

  killRoom(r) {
    const g = this.ghost;
    const p = this.P(r.owner);
    r.dead = true;
    r.ver++;
    if (p) {
      p.alive = false;
      p.diedAt = this.playT;
    }
    this.kills++;
    this.emit({ type: 'kill', room: r.i, pid: r.owner });
    g.hp = Math.min(g.max, g.hp + g.max * GHOST.healAfterKill);
    this.levelUp();
    if (!this.alivePlayers().length) return this.finish(false, 'allDead');
    this.pickTarget();
  }

  hurtGhost(dmg, by) {
    const g = this.ghost;
    if (this.phase !== 'play') return;
    g.hp -= dmg;
    g.dmgTaken += dmg;
    if (by) by.stats.dmg += dmg;
    if (g.hp <= 0) {
      g.hp = 0;
      this.emit({ type: 'ghostDie' });
      this.finish(true, 'ghostDead');
    }
  }

  burnStep(dt) {
    const b = this.ghost.burn;
    if (!b) return;
    if (b.until <= this.t || this.ghost.state === 'heal') {
      this.ghost.burn = null;
      return;
    }
    this.hurtGhost(b.dps * dt, b.by);
  }

  towers(dt) {
    const g = this.ghost;
    const canHit = g.state !== 'heal' && g.state !== 'sleep';
    for (const r of this.rooms) {
      if (!r.owner || r.dead) continue;
      const stunned = r.stunUntil > this.t;
      const owner = this.P(r.owner);
      for (let idx = 0; idx < r.cells.length; idx++) {
        const c = r.cells[idx];
        if (!c) continue;
        const type = c.type;
        if (!ATTACKERS.includes(type) && type !== 'bell') continue;
        if (c.cd > 0) c.cd -= dt;
        if (c.cd > 0 || stunned || !canHit) continue;
        const b = BUILD[type];
        const from = this.cellCenter(r.i, idx);
        if (dist(from, g) > b.range) continue;
        if (type === 'bell') {
          if (this.t < g.stunImmune) continue;
          const st = b.stun[c.lv - 1];
          g.stunUntil = this.t + st;
          g.stunImmune = this.t + st + 2.5;
          c.cd = b.cd[c.lv - 1];
          this.emit({ type: 'bell', room: r.i, cell: idx, dur: st });
          continue;
        }
        c.cd += b.cd;
        if (c.cd < 0) c.cd = b.cd;
        const k = 1 + this.boostOf(r.i, idx);
        const dmg = Math.round(this.effDmg(b.dmg[c.lv - 1] * k));
        this.emit({ type: 'shot', room: r.i, cell: idx, kind: type, dmg, x: +g.x.toFixed(2), y: +g.y.toFixed(2), boost: k > 1 });
        if (type === 'talisman') {
          const dps = b.burn[c.lv - 1] * k;
          if (!g.burn || g.burn.dps <= dps || g.burn.until < this.t) g.burn = { dps, until: this.t + b.burnTime, by: owner };
          else g.burn.until = Math.max(g.burn.until, this.t + b.burnTime);
        }
        if (type === 'trap') g.rootUntil = this.t + b.root;
        this.hurtGhost(dmg, owner);
        if (this.phase === 'ended') return;
      }
    }
  }

  finish(win, reason) {
    if (this.phase === 'ended') return;
    this.phase = 'ended';
    this.endedAt = Date.now();
    this.result = { win, reason };
    this.ghost.state = reason === 'ghostDead' ? 'dead' : win ? 'flee' : 'feast';
    this.emit({ type: 'end', win, reason });
  }

  ranking() {
    return this.players
      .map((p) => ({ p, alive: p.alive && p.room !== null, surv: p.alive ? this.playT : p.diedAt || 0 }))
      .sort((a, b) => b.alive - a.alive || b.surv - a.surv || b.p.stats.dmg - a.p.stats.dmg)
      .map((x) => x.p);
  }

  // ---------------- 同步给客户端 ----------------
  roomView(r) {
    return {
      i: r.i,
      owner: r.owner,
      dead: r.dead,
      door: [r.door.lv, Math.round(r.door.hp), r.door.max],
      bed: [r.bed.lv],
      // [类型, 等级, 耐久百分比（满的时候省略）]
      cells: r.cells.map((c) => (c ? (c.hp < c.max ? [c.type, c.lv, Math.max(1, Math.round((c.hp / c.max) * 100))] : [c.type, c.lv]) : 0)),
      stun: r.stunUntil > this.t ? +(r.stunUntil - this.t).toFixed(1) : 0,
      ver: r.ver,
    };
  }

  view() {
    const g = this.ghost;
    return {
      phase: this.phase,
      diff: this.diffKey,
      t: +this.t.toFixed(2),
      prepLeft: Math.max(0, +this.prepLeft.toFixed(1)),
      timeLeft: +this.timeLeft().toFixed(1),
      duration: this.duration,
      ghost: {
        x: +g.x.toFixed(2),
        y: +g.y.toFixed(2),
        lv: g.lv,
        hp: Math.round(g.hp),
        max: g.max,
        state: g.state,
        target: g.target,
        slow: g.slow,
        dmg: this.ghostDmg(),
        armor: Math.round(this.armor()),
        stun: g.stunUntil > this.t,
        root: g.rootUntil > this.t,
        burn: !!(g.burn && g.burn.until > this.t),
      },
      players: this.players.map((p) => ({
        id: p.id,
        room: p.room,
        x: +p.x.toFixed(2),
        y: +p.y.toFixed(2),
        st: p.state,
        gold: Math.floor(p.gold),
        energy: Math.floor(p.energy),
        income: this.income(p),
        eRate: +this.energyRate(p).toFixed(1),
        alive: p.alive,
        dmg: Math.round(p.stats.dmg),
      })),
      result: this.result,
    };
  }
}

module.exports = { DormGame, dist };
