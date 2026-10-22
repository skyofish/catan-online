'use strict';
// 猛鬼宿舍规则引擎：服务器权威的实时模拟（固定步长推进）。
// 玩家在宿舍里躺平赚金币，造防御、升级床和门；猛鬼不断升级，挑一间宿舍砸门，门破后攻击床，床毁则该玩家出局。
// 坚持到时间结束（或打死猛鬼）即胜利。
const { GEOM, ROOMS, CELLS, BED, DOOR, BUILD, BUILD_TYPES, SELL_RATE, GHOST, DIFFICULTY, MAP } = require('./config');

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const LAIR = { x: MAP.lair.cx, y: MAP.lair.cy };

function afford(p, c) {
  return p.gold >= (c.g || 0) && p.energy >= (c.e || 0);
}
function pay(p, c) {
  p.gold -= c.g || 0;
  p.energy -= c.e || 0;
}

// 坐标所在宿舍（走廊和血池返回 null）
function roomAt(x, y) {
  if (x < 7 || x > 30) return null;
  const c = Math.floor((x - 6) / 6);
  if (c < 0 || c > 3) return null;
  if (y < 5.2) return c;
  if (y > 9.8) return 4 + c;
  return null;
}

class DormGame {
  /**
   * @param {object} opts { difficulty, rng }
   * @param {Array} players [{ id, name, color }]
   */
  constructor(opts, players) {
    this.diffKey = DIFFICULTY[opts.difficulty] ? opts.difficulty : 'normal';
    this.D = DIFFICULTY[this.diffKey];
    this.rng = opts.rng || Math.random;
    this.phase = 'prep';
    this.t = 0; // 开局后的总秒数（含准备阶段）
    this.playT = 0; // 猛鬼醒来后的秒数
    this.prepLeft = this.D.prep;
    this.duration = this.D.duration;
    this.startedAt = Date.now();
    this.endedAt = null;
    this.result = null; // { win: bool, reason }
    this.kills = 0;
    this.rooms = GEOM.map((g) => ({
      i: g.i,
      owner: null,
      dead: false,
      door: { lv: 1, hp: DOOR.hp[0], max: DOOR.hp[0] },
      bed: { lv: 1, hp: BED.hp[0], max: BED.hp[0] },
      cells: new Array(CELLS).fill(null),
      stunUntil: 0,
      ver: 1,
    }));
    this.players = players.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      room: null,
      gold: this.D.startGold,
      energy: 0,
      alive: true,
      diedAt: null,
      stats: { dmg: 0, earned: 0, built: 0 },
    }));
    this.hpMul = this.D.hpMul * (1 + GHOST.perPlayer * Math.max(0, this.players.length - 1));
    this.dmgMul = this.D.dmgMul * GHOST.dmgByPlayers[Math.min(this.players.length, GHOST.dmgByPlayers.length) - 1];
    const lv = 1;
    this.ghost = {
      x: LAIR.x,
      y: LAIR.y,
      lv,
      hp: Math.round(GHOST.hp(lv) * this.hpMul),
      max: Math.round(GHOST.hp(lv) * this.hpMul),
      state: 'sleep',
      target: null,
      path: [],
      hitCd: 0,
      inRoom: null,
      slow: 0,
      screamCd: this.D.scream || 0,
      targetSince: 0,
      dmgTaken: 0, // 当前目标期间受到的伤害（用于聪明的猛鬼判断是否换目标）
    };
    this.events = [];
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

  // ---------------- 数值查询 ----------------
  income(p) {
    const r = this.roomOf(p);
    return r && p.alive ? BED.income[r.bed.lv - 1] : 0;
  }
  energyRate(p) {
    const r = this.roomOf(p);
    if (!r || !p.alive) return 0;
    let s = 0;
    for (const c of r.cells) if (c && c.type === 'generator') s += BUILD.generator.energy[c.lv - 1];
    return s;
  }
  armor() {
    return GHOST.armor(this.ghost.lv) * this.D.armorMul;
  }
  // 防御塔一发打在猛鬼身上的实际伤害
  effDmg(dmg, armor = this.armor()) {
    return Math.max(dmg * 0.2, dmg - armor);
  }
  ghostDmg() {
    return Math.round(GHOST.dmg(this.ghost.lv) * this.dmgMul);
  }
  // 某个位置受到的防御塔每秒伤害（用于 AI 估算）
  dpsAt(pt, now = this.t) {
    let s = 0;
    for (const r of this.rooms) {
      if (!r.owner || r.dead || r.stunUntil > now) continue;
      const g = GEOM[r.i];
      r.cells.forEach((c, idx) => {
        if (!c || (c.type !== 'turret' && c.type !== 'thunder')) return;
        const b = BUILD[c.type];
        if (dist(g.cellCenter(idx), pt) <= b.range) s += this.effDmg(b.dmg[c.lv - 1]) / b.cd;
      });
    }
    return s;
  }
  slowAt(pt) {
    let s = 0;
    for (const r of this.rooms) {
      if (!r.owner || r.dead) continue;
      const g = GEOM[r.i];
      r.cells.forEach((c, idx) => {
        if (c && c.type === 'frost' && dist(g.cellCenter(idx), pt) <= BUILD.frost.range) s = Math.max(s, BUILD.frost.slow[c.lv - 1]);
      });
    }
    return s;
  }
  reflectOf(r) {
    let s = 0;
    for (const c of r.cells) if (c && c.type === 'mirror') s += BUILD.mirror.reflect[c.lv - 1];
    return Math.min(0.75, s);
  }
  repairOf(r) {
    let s = 0;
    for (const c of r.cells) if (c && c.type === 'repair') s += BUILD.repair.heal[c.lv - 1];
    return s;
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
      const r = fn.call(this, p, a);
      return r || { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  a_claim(p, a) {
    if (this.phase !== 'prep') throw new Error('猛鬼已经醒了，不能再换宿舍');
    const i = Number(a.room);
    const r = this.rooms[i];
    if (!r) throw new Error('没有这间宿舍');
    if (p.room === i) return;
    if (r.owner) throw new Error('这间宿舍已经有人了');
    const old = this.roomOf(p);
    if (old) {
      if (old.cells.some(Boolean) || old.bed.lv > 1 || old.door.lv > 1) throw new Error('你已经在这间宿舍里布置过了，不能再换');
      old.owner = null;
      old.ver++;
    }
    r.owner = p.id;
    r.ver++;
    p.room = i;
    this.emit({ type: 'claim', room: i, pid: p.id });
  }

  myRoom(p) {
    const r = this.roomOf(p);
    if (!r) throw new Error('先选一间宿舍躺下');
    if (r.dead) throw new Error('你的宿舍已经被攻破');
    return r;
  }

  a_build(p, a) {
    const r = this.myRoom(p);
    const idx = Number(a.cell);
    const b = BUILD[a.btype];
    if (!b) throw new Error('未知建筑');
    if (!(idx >= 0 && idx < CELLS) || GEOM[r.i].bedCells.includes(idx)) throw new Error('这里不能建造');
    if (r.cells[idx]) throw new Error('这里已经有建筑了');
    const c = b.cost[0];
    if (!afford(p, c)) throw new Error(c.e && p.energy < c.e ? '电力不足' : '金币不足');
    pay(p, c);
    r.cells[idx] = { type: a.btype, lv: 1, cd: 0, spent: { g: c.g || 0, e: c.e || 0 } };
    r.ver++;
    p.stats.built++;
    this.emit({ type: 'build', room: r.i, cell: idx, btype: a.btype, lv: 1, pid: p.id });
  }

  a_upgrade(p, a) {
    const r = this.myRoom(p);
    const idx = Number(a.cell);
    const cell = r.cells[idx];
    if (!cell) throw new Error('这里没有建筑');
    const b = BUILD[cell.type];
    if (cell.lv >= b.cost.length) throw new Error('已经是最高级');
    const c = b.cost[cell.lv];
    if (!afford(p, c)) throw new Error(c.e && p.energy < c.e ? '电力不足' : '金币不足');
    pay(p, c);
    cell.lv++;
    cell.spent.g += c.g || 0;
    cell.spent.e += c.e || 0;
    r.ver++;
    this.emit({ type: 'build', room: r.i, cell: idx, btype: cell.type, lv: cell.lv, pid: p.id });
  }

  a_sell(p, a) {
    const r = this.myRoom(p);
    const idx = Number(a.cell);
    const cell = r.cells[idx];
    if (!cell) throw new Error('这里没有建筑');
    p.gold += Math.floor(cell.spent.g * SELL_RATE);
    p.energy += Math.floor(cell.spent.e * SELL_RATE);
    r.cells[idx] = null;
    r.ver++;
    this.emit({ type: 'sell', room: r.i, cell: idx, pid: p.id });
  }

  a_bed(p) {
    const r = this.myRoom(p);
    if (r.bed.lv >= BED.income.length) throw new Error('床已经是最高级');
    const c = BED.cost[r.bed.lv - 1];
    if (!afford(p, c)) throw new Error(c.e && p.energy < c.e ? '电力不足' : '金币不足');
    pay(p, c);
    r.bed.lv++;
    const max = BED.hp[r.bed.lv - 1];
    r.bed.hp = Math.min(max, r.bed.hp + (max - r.bed.max));
    r.bed.max = max;
    r.ver++;
    this.emit({ type: 'bed', room: r.i, lv: r.bed.lv, pid: p.id });
  }

  a_door(p) {
    const r = this.myRoom(p);
    if (r.door.hp <= 0) throw new Error('门已经被砸烂了');
    if (r.door.lv >= DOOR.hp.length) throw new Error('门已经是最高级');
    const c = DOOR.cost[r.door.lv - 1];
    if (!afford(p, c)) throw new Error(c.e && p.energy < c.e ? '电力不足' : '金币不足');
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
      this.economy(dt);
      if (this.prepLeft <= 0) this.wake();
    } else {
      this.playT += dt;
      this.economy(dt);
      this.levelUp();
      this.repairs(dt);
      this.ghostStep(dt);
      if (this.phase !== 'ended') this.towers(dt);
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
    // 没选宿舍的玩家随机分配
    const free = this.rooms.filter((r) => !r.owner);
    for (const p of this.players) {
      if (p.room !== null) continue;
      const r = free.splice(Math.floor(this.rng() * free.length), 1)[0];
      if (!r) {
        p.alive = false;
        continue;
      }
      r.owner = p.id;
      r.ver++;
      p.room = r.i;
      this.emit({ type: 'claim', room: r.i, pid: p.id, auto: true });
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
      if (!r.owner || r.dead || r.door.hp <= 0 || r.door.hp >= r.door.max) continue;
      const h = this.repairOf(r);
      if (h) r.door.hp = Math.min(r.door.max, r.door.hp + h * dt);
    }
  }

  alivePlayers() {
    return this.players.filter((p) => p.alive && p.room !== null);
  }

  // ---------------- 猛鬼 ----------------
  // 估算猛鬼攻下某个房间要多久、要挨多少伤害
  evalRoom(r) {
    const g = GEOM[r.i];
    const gd = this.ghostDmg() / GHOST.hitEvery;
    const slow = this.slowAt(g.atkDoor);
    const eff = gd * (1 - slow);
    const repair = r.door.hp > 0 ? this.repairOf(r) : 0;
    const doorTime = r.door.hp > 0 ? r.door.hp / Math.max(1, eff - repair) : 0;
    const bedTime = r.bed.hp / Math.max(1, gd * (1 - this.slowAt(g.atkBed)));
    const travel = dist(this.ghost, g.hallPt) / GHOST.speed(this.ghost.lv);
    const dps = this.dpsAt(g.atkDoor) + eff * this.reflectOf(r);
    const dpsIn = this.dpsAt(g.atkBed);
    const taken = dps * doorTime + dpsIn * bedTime;
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
      // 随机，偏向近的
      const w = list.map((r) => 1 / (1 + dist(g, GEOM[r.i].hallPt) / 6));
      let x = this.rng() * w.reduce((a, b) => a + b, 0);
      pick = list[list.length - 1];
      for (let i = 0; i < list.length; i++) if ((x -= w[i]) <= 0) {
        pick = list[i];
        break;
      }
    } else if (smart === 1) {
      pick = this.rng() < 0.6 ? list.reduce((a, b) => (b.door.hp + b.bed.hp < a.door.hp + a.bed.hp ? b : a)) : list[Math.floor(this.rng() * list.length)];
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

  pathTo(target) {
    const g = this.ghost;
    const pts = [];
    if (g.inRoom !== null && g.inRoom === target) {
      pts.push(GEOM[target].atkBed);
      return pts;
    }
    if (g.inRoom !== null) {
      const h = GEOM[g.inRoom];
      pts.push(h.door, h.atkDoor, h.hallPt);
    }
    if (target === 'lair') {
      pts.push(LAIR);
      return pts;
    }
    const t = GEOM[target];
    pts.push(t.hallPt, t.atkDoor);
    if (this.rooms[target].door.hp <= 0) pts.push(t.door, t.atkBed);
    return pts;
  }

  ghostStep(dt) {
    const g = this.ghost;
    const here = { x: g.x, y: g.y };
    g.slow = this.slowAt(here);
    const spd = GHOST.speed(g.lv) * (1 - g.slow) * (g.state === 'retreat' ? GHOST.retreatSpeed : 1);

    if (g.state === 'hunt' || g.state === 'retreat') {
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
      g.inRoom = roomAt(g.x, g.y);
      if (!g.path.length) this.arrive();
    } else if (g.state === 'heal') {
      g.hp = Math.min(g.max, g.hp + g.max * this.D.healRate * dt);
      if (g.hp >= g.max * 0.95) this.pickTarget();
    } else if (g.state === 'door' || g.state === 'bed') {
      this.attack(dt);
    }

    // 血量过低：撤回血池
    // 聪明的猛鬼还会估算回去路上要挨的伤害，提前撤退
    const danger = this.D.smart >= 1 && g.state !== 'sleep' ? this.dpsAt(here) * (2 + this.D.smart) : 0;
    if (g.state !== 'retreat' && g.state !== 'heal' && (g.hp < g.max * this.D.retreatAt || g.hp < danger)) {
      g.state = 'retreat';
      g.path = this.pathTo('lair');
      g.target = null;
      this.emit({ type: 'retreat' });
    }
  }

  arrive() {
    const g = this.ghost;
    if (g.state === 'retreat') {
      g.state = 'heal';
      g.inRoom = null;
      return;
    }
    const r = this.rooms[g.target];
    if (!r || r.dead || !r.owner) return this.pickTarget();
    const geo = GEOM[r.i];
    if (dist(g, geo.atkBed) < 0.05) {
      g.state = 'bed';
      g.hitCd = 0.4;
    } else if (r.door.hp > 0) {
      g.state = 'door';
      g.hitCd = 0.4;
    } else {
      g.path = [geo.door, geo.atkBed];
    }
  }

  attack(dt) {
    const g = this.ghost;
    const r = this.rooms[g.target];
    if (!r || r.dead) return this.pickTarget();
    // 鬼哭：让目标房间的防御停摆
    if (this.D.scream) {
      g.screamCd -= dt;
      if (g.screamCd <= 0) {
        g.screamCd = this.D.scream;
        r.stunUntil = this.t + 3;
        this.emit({ type: 'scream', room: r.i });
      }
    }
    // 聪明的猛鬼：砸不动或伤亡太大时换目标
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
        g.path = [GEOM[r.i].door, GEOM[r.i].atkBed];
      }
    } else {
      r.bed.hp = Math.max(0, r.bed.hp - dmg);
      this.emit({ type: 'hitBed', room: r.i, dmg });
      if (r.bed.hp <= 0) this.killRoom(r);
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

  towers(dt) {
    const g = this.ghost;
    const canHit = g.state !== 'heal' && g.state !== 'sleep';
    for (const r of this.rooms) {
      if (!r.owner || r.dead) continue;
      const geo = GEOM[r.i];
      const stunned = r.stunUntil > this.t;
      const owner = this.P(r.owner);
      for (let idx = 0; idx < CELLS; idx++) {
        const c = r.cells[idx];
        if (!c || (c.type !== 'turret' && c.type !== 'thunder')) continue;
        if (c.cd > 0) c.cd -= dt;
        if (c.cd > 0 || stunned || !canHit) continue;
        const b = BUILD[c.type];
        if (dist(geo.cellCenter(idx), g) > b.range) continue;
        c.cd += b.cd;
        if (c.cd < 0) c.cd = b.cd;
        const dmg = Math.round(this.effDmg(b.dmg[c.lv - 1]));
        this.emit({ type: 'shot', room: r.i, cell: idx, kind: c.type, dmg });
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

  // 结算排名：活着的在前，其次按存活时间、对猛鬼造成的伤害
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
      bed: [r.bed.lv, Math.round(r.bed.hp), r.bed.max],
      cells: r.cells.map((c) => (c ? [BUILD_TYPES.indexOf(c.type), c.lv] : 0)),
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
      ghost: { x: +g.x.toFixed(2), y: +g.y.toFixed(2), lv: g.lv, hp: Math.round(g.hp), max: g.max, state: g.state, target: g.target, slow: g.slow, dmg: this.ghostDmg(), armor: Math.round(this.armor()) },
      players: this.players.map((p) => ({
        id: p.id,
        room: p.room,
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

module.exports = { DormGame, roomAt, dist };
