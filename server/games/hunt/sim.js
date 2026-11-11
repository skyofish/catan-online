'use strict';
// 雾夜追猎：规则引擎。固定步长（0.05 秒）推进；服务器权威，客户端只发送输入。
// 1 名追猎者对 4 名求生者：求生者修好 5 台发报机给大门通电，开门逃走；追猎者把人打倒、关进铁笼直到淘汰。
const { RULES: R, SURVIVORS, HUNTERS } = require('./data');
const { W, buildMap, publicMap, hits, moveCircle, los, rng } = require('./maps');

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const angDiff = (a, b) => {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d);
};
const CHANNEL = new Set(['decode', 'heal', 'gate', 'selfheal', 'rescue']);
const SHOCK = new Set(['vault', 'rescue', 'heal', 'gate', 'decode', 'selfheal']);

class HuntGame {
  constructor(opts, players) {
    this.mapKey = opts.map;
    this.map = buildMap(opts.map);
    this.grid = this.map.grid;
    this.rand = rng(opts.seed || (Math.random() * 2 ** 31) | 0);
    this.dyn = new Uint8Array(W * W);
    this.gateCell = new Int8Array(W * W).fill(-1);
    this.t = 0;
    this.phase = 'prep';
    this.events = [];
    this.startedAt = Date.now();
    this.result = null;
    this.revealUntil = 0;
    this.powered = false;
    this.webs = [];
    this.decoys = [];
    this.seq = 1;

    const shuffle = (arr) => {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(this.rand() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };
    this.machines = shuffle(this.map.slots)
      .slice(0, R.machinesOnMap)
      .map((s, id) => ({ id, x: s.x + 0.5, z: s.z + 0.5, p: 0, done: false, lastAt: -99 }));
    for (const m of this.machines) this.dyn[Math.floor(m.z) * W + Math.floor(m.x)] = 1;
    // 铁笼：离发报机太近的不要，取 9 个尽量分散的
    const cages = [];
    for (const c of shuffle(this.map.cages)) {
      if (cages.length >= 9) break;
      if (cages.some((o) => Math.hypot(o.x - c.x, o.z - c.z) < 9)) continue;
      cages.push(c);
    }
    this.cages = cages.map((c, id) => ({ id, x: c.x + 0.5, z: c.z + 0.5, who: null }));
    for (const c of this.cages) this.dyn[Math.floor(c.z) * W + Math.floor(c.x)] = 1;
    this.pallets = this.map.pallets.map((p, id) => ({ id, x: p.x + 0.5, z: p.z + 0.5, axis: p.axis, st: 0 }));
    this.gates = this.map.gates.map((g) => ({ id: g.id, x: g.x, z: g.z, panel: g.panel, cells: g.cells, p: 0, open: false }));
    for (const g of this.gates)
      for (const c of g.cells) {
        this.dyn[c.z * W + c.x] = 1;
        this.gateCell[c.z * W + c.x] = g.id;
      }
    const hs = this.map.hatchSpots[Math.floor(this.rand() * this.map.hatchSpots.length)];
    this.hatch = { x: hs.x, z: hs.z, open: false };

    // 出生点：求生者分散，追猎者离所有人尽量远
    const spawns = shuffle(this.map.spawnS);
    const surv = players.filter((p) => p.role !== 'hunter');
    const sPos = surv.map((_, i) => spawns[i % spawns.length]);
    let hPos = spawns[spawns.length - 1];
    let bestD = -1;
    for (const s of this.map.spawnS) {
      const d = Math.min(...sPos.map((o) => Math.hypot(o.x - s.x, o.z - s.z)));
      if (d > bestD) {
        bestD = d;
        hPos = s;
      }
    }
    let si = 0;
    this.players = players.map((p) => {
      const hunter = p.role === 'hunter';
      const pos = hunter ? hPos : sPos[si++];
      return {
        id: p.id,
        name: p.name,
        color: p.color,
        role: hunter ? 'hunter' : 'survivor',
        char: p.char,
        x: pos.x,
        z: pos.z,
        d: Math.atan2(32 - pos.x, 32 - pos.z),
        mx: 0,
        mz: 0,
        st: 'ok',
        hp: 2,
        act: null,
        atk: null,
        dash: null,
        cast: null,
        cd: R.prep + (hunter ? 12 : 6),
        stun: 0,
        boostUntil: 0,
        boostMul: 1,
        slowUntil: 0,
        slowMul: 1,
        shownUntil: 0,
        invisUntil: 0,
        overUntil: 0,
        safeUntil: 0,
        pauseUntil: 0,
        cageT: 0,
        cageN: 0,
        cage: null,
        carrying: null,
        carriedBy: null,
        struggle: 0,
        downAt: 0,
        healP: 0,
        qte: null,
        nextQte: 0,
        autoQte: null,
        speedMul: 1,
        hint: null,
        moving: false,
        endAt: null,
        stats: { decode: 0, heal: 0, rescue: 0, stun: 0, hits: 0, downs: 0, cages: 0, kills: 0, chased: 0 },
      };
    });
    this.hunter = this.players.find((p) => p.role === 'hunter');
    this.survivors = this.players.filter((p) => p.role === 'survivor');
    this.solidS = (cx, cz) => cx < 0 || cz < 0 || cx >= W || cz >= W || this.grid[cz * W + cx] !== 0 || this.dyn[cz * W + cx] !== 0;
    // 追猎者永远进不了大门
    this.solidH = (cx, cz) => this.solidS(cx, cz) || this.gateCell[cz * W + cx] >= 0;
  }

  P(id) {
    return this.players.find((p) => p.id === id);
  }
  emit(type, d = {}) {
    this.events.push({ type, ...d });
  }
  solidFor(p) {
    return p.role === 'hunter' ? this.solidH : this.solidS;
  }
  doneCount() {
    return this.machines.filter((m) => m.done).length;
  }
  inPlay(s) {
    return s.st === 'ok' || s.st === 'down' || s.st === 'carried' || s.st === 'caged';
  }
  canSee(a, b, range = 99) {
    return dist(a, b) <= range && los(this.grid, a.x, a.z, b.x, b.z);
  }

  // ======================= 可交互对象 =======================
  sideCells(o, p) {
    // 翻越：从哪一侧来，落到另一侧
    const ax = o.axis === 'x';
    const cx = Math.floor(o.x);
    const cz = Math.floor(o.z);
    const s = (ax ? p.x - o.x : p.z - o.z) >= 0 ? 1 : -1;
    return { fx: ax ? cx + s + 0.5 : cx + 0.5, fz: ax ? cz + 0.5 : cz + s + 0.5, tx: ax ? cx - s + 0.5 : cx + 0.5, tz: ax ? cz + 0.5 : cz - s + 0.5 };
  }

  hintFor(p) {
    if (this.phase !== 'play' || p.stun > this.t || p.atk || p.dash || p.cast) return null;
    if (p.act && !CHANNEL.has(p.act.type)) return null;
    const near = (o, r) => Math.hypot(o.x - p.x, o.z - p.z) <= r;
    if (p.role === 'hunter') {
      if (p.st !== 'ok') return null;
      if (p.carrying) {
        const c = this.cages.find((c) => !c.who && near(c, 2.4));
        return c ? { type: 'cage', id: c.id } : null;
      }
      const s = this.survivors.find((s) => s.st === 'down' && near(s, 2));
      if (s) return { type: 'pickup', id: s.id };
      const pl = this.pallets.find((o) => o.st === 1 && near(o, 1.7));
      if (pl) return { type: 'break', id: pl.id };
      const w = this.map.windows.find((o) => near({ x: o.x + 0.5, z: o.z + 0.5 }, 1.6));
      if (w) return { type: 'vault', kind: 'w', id: this.map.windows.indexOf(w) };
      return null;
    }
    if (p.st !== 'ok') return null;
    const caged = this.survivors.find((s) => s.st === 'caged' && near(s, 2.1));
    if (caged) return { type: 'rescue', id: caged.id };
    const down = this.survivors.find((s) => s !== p && s.st === 'down' && near(s, 1.7));
    if (down) return { type: 'heal', id: down.id };
    const up = this.pallets.find((o) => o.st === 0 && near(o, 1.35));
    if (up) return { type: 'drop', id: up.id };
    const dn = this.pallets.find((o) => o.st === 1 && near(o, 1.6));
    if (dn) return { type: 'vault', kind: 'p', id: dn.id };
    const w = this.map.windows.find((o) => near({ x: o.x + 0.5, z: o.z + 0.5 }, 1.5));
    if (w) return { type: 'vault', kind: 'w', id: this.map.windows.indexOf(w) };
    const m = this.machines.find((o) => !o.done && near(o, 1.75));
    if (m && !this.powered) return { type: 'decode', id: m.id };
    if (this.powered) {
      const g = this.gates.find((o) => !o.open && near(o.panel, 2));
      if (g) return { type: 'gate', id: g.id };
    }
    if (this.hatch.open && near(this.hatch, 1.6)) return { type: 'hatch' };
    const hurt = this.survivors.find((s) => s !== p && s.st === 'ok' && s.hp === 1 && !s.moving && near(s, 1.7));
    if (hurt) return { type: 'heal', id: hurt.id };
    return null;
  }

  // ======================= 玩家操作 =======================
  act(pid, a) {
    const p = this.P(pid);
    if (!p) return { ok: false, error: '你不在这局游戏里' };
    if (a.type === 'move') {
      let x = Number(a.x) || 0;
      let z = Number(a.z) || 0;
      const l = Math.hypot(x, z);
      if (l > 1) {
        x /= l;
        z /= l;
      }
      p.mx = x;
      p.mz = z;
      return { ok: true };
    }
    if (this.phase !== 'play') return { ok: false, error: '还没开始' };
    // 站着不动时，出刀 / 放技能朝镜头方向
    if ((a.type === 'attack' || a.type === 'skill') && Number.isFinite(a.d) && !p.moving) p.d = Number(a.d);
    if (a.type === 'use') return this.use(p);
    if (a.type === 'cancel') {
      if (p.act && CHANNEL.has(p.act.type)) p.act = null;
      return { ok: true };
    }
    if (a.type === 'attack') return this.attack(p);
    if (a.type === 'skill') return this.skill(p, a);
    if (a.type === 'qte') return this.qteAnswer(p, Number(a.f));
    return { ok: false, error: '未知操作' };
  }

  use(p) {
    const h = this.hintFor(p);
    if (!h) return { ok: false, error: '附近没有可以互动的东西' };
    const speedV = p.role === 'hunter' ? R.vaultH : R.vaultS * (p.char === 'runner' ? 0.75 : 1);
    switch (h.type) {
      case 'vault': {
        const o = h.kind === 'w' ? { ...this.map.windows[h.id], x: this.map.windows[h.id].x + 0.5, z: this.map.windows[h.id].z + 0.5 } : this.pallets[h.id];
        const sc = this.sideCells(o, p);
        const solid = this.solidFor(p);
        if (solid(Math.floor(sc.tx), Math.floor(sc.tz)) || solid(Math.floor(sc.fx), Math.floor(sc.fz))) return { ok: false, error: '翻不过去' };
        p.act = { type: 'vault', t: 0, dur: speedV, x0: p.x, z0: p.z, mx: o.x, mz: o.z, x1: sc.tx, z1: sc.tz };
        p.d = Math.atan2(sc.tx - p.x, sc.tz - p.z);
        this.emit('vault', { pid: p.id });
        break;
      }
      case 'drop':
        this.dropPallet(p, this.pallets[h.id]);
        break;
      case 'decode':
        p.act = { type: 'decode', id: h.id };
        if (p.nextQte < this.t) p.nextQte = this.t + R.qteEvery[0] * (0.5 + this.rand());
        break;
      case 'gate':
        p.act = { type: 'gate', id: h.id };
        break;
      case 'heal':
        p.act = { type: 'heal', id: h.id };
        break;
      case 'rescue':
        p.act = { type: 'rescue', id: h.id, t: 0, dur: R.rescueTime * (p.char === 'guard' ? 0.6 : 1) };
        break;
      case 'hatch':
        this.escape(p, 'hatch');
        break;
      case 'pickup':
        p.act = { type: 'pickup', id: h.id, t: 0, dur: R.pickupTime };
        break;
      case 'cage':
        p.act = { type: 'cage', id: h.id, t: 0, dur: R.cagePutTime };
        break;
      case 'break':
        p.act = { type: 'break', id: h.id, t: 0, dur: R.breakTime };
        break;
    }
    return { ok: true };
  }

  dropPallet(p, pl) {
    pl.st = 1;
    const cx = Math.floor(pl.x);
    const cz = Math.floor(pl.z);
    this.dyn[cz * W + cx] = 1;
    let stunned = false;
    for (const o of this.players) {
      if (o.st === 'carried' || o.st === 'caged' || o.st === 'dead' || o.st === 'escaped') continue;
      if (o.act && o.act.type === 'vault') continue;
      const inCell = Math.abs(o.x - pl.x) < 0.5 + R.radius && Math.abs(o.z - pl.z) < 0.5 + R.radius;
      if (o.role === 'hunter' && (inCell || dist(o, pl) < 1.15) && o.stun < this.t) {
        o.stun = this.t + R.palletStun;
        o.atk = null;
        o.dash = null;
        o.act = null;
        stunned = true;
        p.stats.stun++;
      }
      if (inCell) {
        const s = (pl.axis === 'x' ? o.x - pl.x : o.z - pl.z) >= 0 ? 1 : -1;
        if (pl.axis === 'x') o.x = pl.x + s * (0.5 + R.radius + 0.03);
        else o.z = pl.z + s * (0.5 + R.radius + 0.03);
      }
    }
    this.emit('pallet', { id: pl.id, pid: p.id, stun: stunned });
  }

  attack(p) {
    if (p.role !== 'hunter' || p.atk || p.dash || p.cast || p.act || p.carrying || p.stun > this.t) return { ok: false, error: '现在不能出刀' };
    // 辅助瞄准：附近正前方有人就转向他
    let best = null;
    for (const s of this.survivors) {
      if (s.st !== 'ok') continue;
      const d = dist(p, s);
      if (d > 3.4) continue;
      const a = Math.atan2(s.x - p.x, s.z - p.z);
      if (angDiff(a, p.d) < 1.3 && (!best || d < best.d)) best = { d, a };
    }
    if (best) p.d = best.a;
    p.atk = { ph: 'wind', until: this.t + R.attackWind };
    this.emit('swing', { pid: p.id });
    return { ok: true };
  }

  resolveAttack(p) {
    let victim = null;
    let vd = 99;
    for (const s of this.survivors) {
      if (s.st !== 'ok') continue;
      const d = dist(p, s);
      if (d > R.attackRange || d >= vd) continue;
      if (d > 0.9 && angDiff(Math.atan2(s.x - p.x, s.z - p.z), p.d) > R.attackCone) continue;
      if (!los(this.grid, p.x, p.z, s.x, s.z)) continue;
      victim = s;
      vd = d;
    }
    const k = p.char === 'reaper' ? 0.85 : 1;
    if (victim && this.hit(victim, p)) {
      p.atk = { ph: 'rec', until: this.t + R.hitRecover * k, hit: true };
      return;
    }
    // 砍到假人
    const dc = this.decoys.find((o) => dist(p, o) < R.attackRange);
    if (dc) {
      this.decoys = this.decoys.filter((o) => o !== dc);
      this.emit('decoyPop', { x: dc.x, z: dc.z });
    }
    p.atk = { ph: 'rec', until: this.t + R.missRecover * k, hit: false };
    this.emit('miss', { pid: p.id });
  }

  hit(s, h) {
    if (s.safeUntil > this.t || s.st !== 'ok') return false;
    const shock = !!(s.act && SHOCK.has(s.act.type));
    s.hp -= shock ? 2 : 1;
    s.act = null;
    s.qte = null;
    s.healP = 0;
    h.stats.hits++;
    for (const o of this.survivors) if (o.act && (o.act.type === 'heal' || o.act.type === 'rescue') && o.act.id === s.id) o.act = null;
    if (s.hp <= 0) {
      s.hp = 0;
      s.st = 'down';
      s.downAt = this.t;
      s.mx = s.mz = 0;
      h.stats.downs++;
    } else {
      s.boostUntil = this.t + R.hitBoost[0] * (s.char === 'illusion' ? 1.5 : 1);
      s.boostMul = R.hitBoost[1];
    }
    this.emit('hit', { pid: s.id, by: h.id, shock, down: s.st === 'down' });
    return true;
  }

  freeCarried(h, stun) {
    const s = this.P(h.carrying);
    h.carrying = null;
    if (!s) return;
    s.st = 'ok';
    s.hp = 1;
    s.carriedBy = null;
    s.struggle = 0;
    s.safeUntil = this.t + 2;
    s.boostUntil = this.t + 2;
    s.boostMul = 1.3;
    if (stun) h.stun = Math.max(h.stun, this.t + stun);
    this.emit('free', { pid: s.id });
  }

  skill(p, a) {
    if (p.cd > this.t) return { ok: false, error: '技能冷却中' };
    if (p.stun > this.t || p.atk || p.dash || p.cast || (p.act && !CHANNEL.has(p.act.type))) return { ok: false, error: '现在不能用技能' };
    const def = (p.role === 'hunter' ? HUNTERS : SURVIVORS)[p.char];
    if (p.role === 'hunter') {
      if (p.carrying) return { ok: false, error: '扛着人不能用技能' };
      if (p.char === 'reaper') {
        p.dash = { until: this.t + 0.56 };
      } else if (p.char === 'weaver') {
        this.webs.push({ id: this.seq++, x: p.x, z: p.z, armAt: this.t + 1.5 });
        if (this.webs.length > 6) this.webs.shift();
      } else if (p.char === 'phantom') {
        let m = this.machines.find((o) => o.id === a.target && !o.done);
        if (!m) m = this.machines.filter((o) => !o.done).sort((x, y) => (y.lastAt > this.t - 6 ? 2 : 0) + y.p - ((x.lastAt > this.t - 6 ? 2 : 0) + x.p))[0];
        if (!m) return { ok: false, error: '没有可去的发报机' };
        p.cast = { type: 'blink', until: this.t + 1.5, m: m.id };
        p.mx = p.mz = 0;
      }
    } else {
      if (p.st !== 'ok') return { ok: false, error: '现在不能用技能' };
      if (p.char === 'tinker') p.overUntil = this.t + 10;
      else if (p.char === 'nurse') {
        if (p.hp !== 1) return { ok: false, error: '没有受伤' };
        p.act = { type: 'selfheal', t: 0, dur: 10 };
      } else if (p.char === 'runner') {
        p.boostUntil = this.t + 3;
        p.boostMul = 1.5;
      } else if (p.char === 'guard') {
        const h = this.hunter;
        if (h && dist(p, h) < 6 && angDiff(Math.atan2(h.x - p.x, h.z - p.z), p.d) < 0.75 && los(this.grid, p.x, p.z, h.x, h.z)) {
          h.stun = Math.max(h.stun, this.t + 2.2);
          h.atk = null;
          h.dash = null;
          h.act = null;
          h.cast = null;
          if (h.carrying) this.freeCarried(h, 0);
          p.stats.stun++;
          this.emit('stun', { pid: h.id });
        }
      } else if (p.char === 'illusion') {
        p.invisUntil = this.t + 4;
        this.decoys.push({ id: this.seq++, x: p.x, z: p.z, d: p.d, char: p.char, color: p.color, until: this.t + 7 });
      } else if (p.char === 'scout') {
        this.revealUntil = this.t + 8;
      }
    }
    p.cd = this.t + def.skill.cd;
    this.emit('skill', { pid: p.id, char: p.char });
    return { ok: true };
  }

  qteAnswer(p, f) {
    const q = p.qte;
    if (!q) return { ok: true };
    const real = (this.t - q.start) / R.qteDur;
    if (!(f >= 0 && f <= 1.05) || Math.abs(f - real) > 0.35) f = real;
    this.qteResolve(p, f >= q.a && f <= q.b);
    return { ok: true };
  }

  qteResolve(p, ok) {
    const q = p.qte;
    p.qte = null;
    p.nextQte = this.t + R.qteEvery[0] + this.rand() * (R.qteEvery[1] - R.qteEvery[0]);
    const m = q && this.machines[q.m];
    if (!m || m.done) return;
    if (ok) {
      m.p = Math.min(1, m.p + 0.012);
      this.emit('qteOk', { pid: p.id });
    } else {
      m.p = Math.max(0, m.p - R.qteFail);
      m.lastAt = this.t;
      p.pauseUntil = this.t + 2;
      p.shownUntil = this.t + 3;
      this.emit('spark', { pid: p.id, m: m.id, x: m.x, z: m.z });
    }
  }

  escape(s, how) {
    s.st = 'escaped';
    s.act = null;
    s.endAt = this.t;
    this.emit('escape', { pid: s.id, how });
  }

  kill(s) {
    if (s.st === 'caged') {
      const c = this.cages[s.cage];
      if (c) c.who = null;
    }
    if (s.st === 'carried' && this.hunter) this.hunter.carrying = null;
    s.st = 'dead';
    s.act = null;
    s.endAt = this.t;
    if (this.hunter) this.hunter.stats.kills++;
    this.emit('dead', { pid: s.id });
  }

  // ======================= 推进 =======================
  step(dt) {
    if (this.phase === 'ended') return this.events.splice(0);
    this.t += dt;
    if (this.phase === 'prep') {
      if (this.t >= R.prep) {
        this.phase = 'play';
        this.emit('go');
      }
      return this.events.splice(0);
    }
    const t = this.t;
    for (const p of this.players) (p.role === 'hunter' ? this.stepHunter : this.stepSurvivor).call(this, p, dt);

    // 发报机
    for (const m of this.machines) {
      if (m.done) continue;
      const ds = this.survivors.filter((s) => s.act && s.act.type === 'decode' && s.act.id === m.id);
      if (!ds.length) continue;
      m.lastAt = t;
      const eff = R.decodeTeam[Math.min(4, ds.length)];
      for (const s of ds) {
        if (s.pauseUntil > t) continue;
        const rate = (s.char === 'tinker' ? 1.2 : 1) * (s.overUntil > t ? 1.6 : 1) * eff;
        m.p += (rate * dt) / R.decodeTime;
        s.stats.decode += rate * dt;
        // 校准
        if (!s.qte && t >= s.nextQte) {
          const w = s.char === 'tinker' ? 0.2 : 0.14;
          const a = 0.45 + this.rand() * 0.35;
          s.qte = { id: this.seq++, m: m.id, start: t, a, b: a + w };
          if (s.autoQte !== null) s.qte.auto = this.rand() >= s.autoQte;
        }
      }
      if (m.p >= 1) {
        m.p = 1;
        m.done = true;
        for (const s of ds) {
          s.act = null;
          s.qte = null;
        }
        this.emit('machine', { m: m.id, left: Math.max(0, R.machinesNeed - this.doneCount()) });
        if (!this.powered && this.doneCount() >= R.machinesNeed) {
          this.powered = true;
          for (const s of this.survivors) if (s.act && s.act.type === 'decode') s.act = null;
          this.emit('power');
        }
      }
    }
    for (const s of this.survivors) {
      if (!s.qte) continue;
      if (!s.act || s.act.type !== 'decode') s.qte = null;
      else if (s.qte.auto !== undefined && t - s.qte.start > R.qteDur * 0.6) this.qteResolve(s, s.qte.auto);
      else if (t - s.qte.start > R.qteDur) this.qteResolve(s, false);
    }

    // 丝网
    for (const w of this.webs.slice()) {
      if (w.armAt > t) continue;
      const s = this.survivors.find((s) => s.st === 'ok' && !(s.act && s.act.type === 'vault') && dist(s, w) < 0.95);
      if (!s) continue;
      s.slowUntil = t + 3.5;
      s.slowMul = 0.55;
      s.shownUntil = t + 5;
      this.webs = this.webs.filter((o) => o !== w);
      this.emit('web', { pid: s.id, x: w.x, z: w.z });
    }
    this.decoys = this.decoys.filter((d) => d.until > t);

    // 地窖：只剩一名求生者且至少修好两台
    const alive = this.survivors.filter((s) => this.inPlay(s));
    if (!this.hatch.open && alive.length === 1 && this.survivors.length > 1 && this.doneCount() >= 2) {
      this.hatch.open = true;
      this.emit('hatch');
    }
    // 没有人还能行动：倒地和笼中的直接淘汰
    if (alive.length && !alive.some((s) => s.st === 'ok' || s.st === 'carried')) {
      this.stuck = (this.stuck || 0) + dt;
      if (this.stuck > 3) for (const s of alive) this.kill(s);
    } else this.stuck = 0;
    if (t > R.maxTime) for (const s of alive) this.kill(s);

    if (!this.survivors.some((s) => this.inPlay(s))) this.finish();
    for (const p of this.players) p.hint = this.hintFor(p);
    return this.events.splice(0);
  }

  finish() {
    const esc = this.survivors.filter((s) => s.st === 'escaped').length;
    const n = this.survivors.length;
    const winner = esc * 2 > n ? 'survivors' : esc * 2 === n ? 'draw' : 'hunter';
    this.phase = 'ended';
    this.endedAt = Date.now();
    this.result = { winner, escaped: esc, total: n };
    this.emit('end', this.result);
  }

  speedOf(p) {
    const t = this.t;
    if (p.role === 'hunter') {
      let v = (p.carrying ? R.carrySpeed : R.hunterSpeed) * p.speedMul * (p.char === 'phantom' ? 1.03 : 1);
      if (p.atk) v *= p.atk.ph === 'wind' ? 1.3 : 0.25;
      return v;
    }
    if (p.st === 'down') return R.crawlSpeed;
    let v = R.survivorSpeed;
    if (p.boostUntil > t) v *= p.boostMul;
    if (p.slowUntil > t) v *= p.slowMul;
    if (p.invisUntil > t) v *= 1.15;
    return v;
  }

  moveBy(p, dt) {
    const l = Math.hypot(p.mx, p.mz);
    p.moving = l > 0.15;
    if (!p.moving) return;
    const v = this.speedOf(p) * Math.min(1, l);
    p.d = Math.atan2(p.mx, p.mz);
    moveCircle(this.solidFor(p), p, (p.mx / l) * v * dt, (p.mz / l) * v * dt, R.radius);
  }

  stepVault(p, dt) {
    const a = p.act;
    a.t += dt;
    const k = Math.min(1, a.t / a.dur);
    // 先到障碍上方，再落到另一侧
    if (k < 0.5) {
      p.x = a.x0 + (a.mx - a.x0) * (k * 2);
      p.z = a.z0 + (a.mz - a.z0) * (k * 2);
    } else {
      p.x = a.mx + (a.x1 - a.mx) * (k * 2 - 1);
      p.z = a.mz + (a.z1 - a.mz) * (k * 2 - 1);
    }
    if (k >= 1) p.act = null;
  }

  stepHunter(p, dt) {
    const t = this.t;
    p.moving = false;
    if (p.carrying) {
      const s = this.P(p.carrying);
      s.struggle += dt;
      if (s.struggle >= R.struggleTime) this.freeCarried(p, 1.6);
    }
    if (p.stun > t) return;
    if (p.cast) {
      if (t >= p.cast.until) {
        const m = this.machines[p.cast.m];
        let best = null;
        for (let a = 0; a < 8; a++) {
          const x = m.x + Math.sin((a * Math.PI) / 4) * 1.5;
          const z = m.z + Math.cos((a * Math.PI) / 4) * 1.5;
          if (!hits(this.solidH, x, z, R.radius) && (!best || Math.hypot(x - p.x, z - p.z) < best.d)) best = { x, z, d: Math.hypot(x - p.x, z - p.z) };
        }
        if (best) {
          p.x = best.x;
          p.z = best.z;
        }
        p.cast = null;
        this.emit('blink', { pid: p.id, x: p.x, z: p.z });
      }
      return;
    }
    if (p.dash) {
      const moved = moveCircle(this.solidH, p, Math.sin(p.d) * 16 * dt, Math.cos(p.d) * 16 * dt, R.radius);
      p.moving = true;
      const s = this.survivors.find((s) => s.st === 'ok' && dist(p, s) < 1.15);
      if (s && this.hit(s, p)) {
        p.dash = null;
        p.atk = { ph: 'rec', until: t + R.hitRecover * 0.8, hit: true };
      } else if (!moved || t >= p.dash.until) {
        p.dash = null;
        p.atk = { ph: 'rec', until: t + 0.6, hit: false };
      }
      return;
    }
    if (p.atk) {
      if (p.atk.ph === 'wind') {
        moveCircle(this.solidH, p, Math.sin(p.d) * this.speedOf(p) * dt, Math.cos(p.d) * this.speedOf(p) * dt, R.radius);
        if (t >= p.atk.until) this.resolveAttack(p);
        return;
      }
      if (t >= p.atk.until) p.atk = null;
    }
    const a = p.act;
    if (a) {
      if (a.type === 'vault') return this.stepVault(p, dt);
      a.t += dt;
      if (a.t < a.dur) return;
      p.act = null;
      if (a.type === 'break') {
        const pl = this.pallets[a.id];
        pl.st = 2;
        this.dyn[Math.floor(pl.z) * W + Math.floor(pl.x)] = 0;
        this.emit('break', { id: pl.id });
      } else if (a.type === 'pickup') {
        const s = this.P(a.id);
        if (s && s.st === 'down' && dist(p, s) < 3) {
          s.st = 'carried';
          s.carriedBy = p.id;
          s.struggle = 0;
          p.carrying = s.id;
          for (const o of this.survivors) if (o.act && o.act.type === 'heal' && o.act.id === s.id) o.act = null;
          this.emit('pickup', { pid: s.id });
        }
      } else if (a.type === 'cage') {
        const c = this.cages[a.id];
        const s = this.P(p.carrying);
        if (s && c && !c.who) {
          p.carrying = null;
          s.carriedBy = null;
          s.st = 'caged';
          s.cage = c.id;
          s.x = c.x;
          s.z = c.z;
          s.cageN++;
          c.who = s.id;
          p.stats.cages++;
          if (s.cageN === 2) s.cageT = Math.max(s.cageT, R.cageTime / 2);
          this.emit('caged', { pid: s.id, cage: c.id, n: s.cageN });
          if (s.cageN >= 3) this.kill(s);
        }
      }
      return;
    }
    this.moveBy(p, dt);
  }

  stepSurvivor(s, dt) {
    const t = this.t;
    s.moving = false;
    if (s.st === 'escaped' || s.st === 'dead') return;
    if (s.st === 'carried') {
      const h = this.hunter;
      s.x = h.x;
      s.z = h.z;
      s.d = h.d;
      return;
    }
    if (s.st === 'caged') {
      s.cageT += dt;
      if (s.cageT >= R.cageTime) this.kill(s);
      return;
    }
    if (s.st === 'down') {
      if (t - s.downAt > R.bleedTime) return this.kill(s);
      this.moveBy(s, dt);
      this.checkExit(s);
      return;
    }
    const a = s.act;
    if (a && a.type === 'vault') return this.stepVault(s, dt);
    if (a && Math.hypot(s.mx, s.mz) > 0.3) s.act = null;
    else if (a) {
      if (a.type === 'heal') {
        const o = this.P(a.id);
        const okT = o && ((o.st === 'down' && true) || (o.st === 'ok' && o.hp === 1 && !o.moving)) && dist(s, o) < 2.2;
        if (!okT) s.act = null;
        else {
          const need = o.st === 'down' ? R.healDownTime : R.healTime;
          const rate = s.char === 'nurse' ? 1.5 : 1;
          o.healP += (rate * dt) / need;
          s.stats.heal += dt;
          if (o.healP >= 1) {
            o.healP = 0;
            if (o.st === 'down') {
              o.st = 'ok';
              o.hp = 1;
            } else o.hp = 2;
            s.act = null;
            this.emit('healed', { pid: o.id, by: s.id });
          }
        }
      } else if (a.type === 'selfheal') {
        a.t += dt;
        if (a.t >= a.dur) {
          s.hp = 2;
          s.act = null;
          this.emit('healed', { pid: s.id, by: s.id });
        }
      } else if (a.type === 'rescue') {
        const o = this.P(a.id);
        if (!o || o.st !== 'caged' || dist(s, o) > 2.6) s.act = null;
        else {
          a.t += dt;
          if (a.t >= a.dur) {
            const c = this.cages[o.cage];
            if (c) c.who = null;
            o.st = 'ok';
            o.hp = 1;
            o.cage = null;
            o.x = s.x;
            o.z = s.z;
            o.safeUntil = t + 2.5;
            o.boostUntil = t + 2.5;
            o.boostMul = 1.3;
            s.act = null;
            s.stats.rescue++;
            this.emit('rescued', { pid: o.id, by: s.id });
          }
        }
      } else if (a.type === 'gate') {
        const g = this.gates[a.id];
        if (!g || g.open) s.act = null;
        else {
          g.p += dt / R.gateTime;
          if (g.p >= 1) {
            g.p = 1;
            g.open = true;
            for (const c of g.cells) this.dyn[c.z * W + c.x] = 0;
            for (const o of this.survivors) if (o.act && o.act.type === 'gate' && o.act.id === g.id) o.act = null;
            this.emit('gateOpen', { g: g.id });
          }
        }
      } else if (a.type === 'decode') {
        const m = this.machines[a.id];
        if (!m || m.done || dist(s, m) > 2.2) s.act = null;
        else s.d = Math.atan2(m.x - s.x, m.z - s.z);
      }
    }
    if (!s.act) {
      this.moveBy(s, dt);
      this.checkExit(s);
    }
    if (this.hunter && dist(s, this.hunter) < 9 && s.st === 'ok') s.stats.chased += dt;
  }

  checkExit(s) {
    const g = this.gateCell[Math.floor(s.z) * W + Math.floor(s.x)];
    if (g >= 0 && this.gates[g].open) this.escape(s, 'gate');
  }

  // ======================= 视图 =======================
  setup() {
    return {
      map: publicMap(this.map),
      machines: this.machines.map((m) => ({ x: m.x, z: m.z })),
      cages: this.cages.map((c) => ({ x: c.x, z: c.z })),
      hatch: { x: this.hatch.x, z: this.hatch.z },
      players: this.players.map((p) => ({ id: p.id, name: p.name, color: p.color, role: p.role, char: p.char })),
    };
  }

  view(pid) {
    const t = this.t;
    const me = this.P(pid);
    const r2 = (v) => Math.round(v * 100) / 100;
    const hunterView = me && me.role === 'hunter';
    return {
      t: r2(t),
      phase: this.phase,
      left: Math.max(0, R.machinesNeed - this.doneCount()),
      powered: this.powered,
      reveal: this.revealUntil > t,
      players: this.players.map((p) => {
        const a = p.act;
        const o = {
          id: p.id,
          x: r2(p.x),
          z: r2(p.z),
          d: r2(p.d),
          st: p.st,
          hp: p.hp,
          mv: p.moving ? 1 : 0,
          a: a ? a.type : p.atk ? (p.atk.ph === 'wind' ? 'wind' : p.atk.hit ? 'wipe' : 'rec') : p.dash ? 'dash' : p.cast ? 'cast' : null,
          ap: a && a.dur ? r2(a.t / a.dur) : a && a.type === 'heal' ? r2((this.P(a.id) || {}).healP || 0) : 0,
          ai: a && a.id !== undefined ? a.id : null,
          stun: p.stun > t ? r2(p.stun - t) : 0,
          cd: p.cd > t ? r2(p.cd - t) : 0,
          // 结束时刻（对局时间）：增量协议只发这两个，客户端自己算剩余时间，不用每一帧都发倒计时
          stunE: p.stun > t ? r2(p.stun) : 0,
          cdE: p.cd > t ? r2(p.cd) : 0,
          v: r2(this.speedOf(p)),
        };
        if (p.role === 'survivor') {
          o.cg = r2(p.cageT / R.cageTime);
          o.cn = p.cageN;
          o.hl = r2(p.healP);
          o.sg = p.st === 'carried' ? r2(p.struggle / R.struggleTime) : 0;
          o.inv = p.invisUntil > t ? 1 : 0;
          o.slow = p.slowUntil > t ? 1 : 0;
          o.fast = p.boostUntil > t || p.overUntil > t ? 1 : 0;
          o.shown = p.shownUntil > t ? 1 : 0;
          if (o.inv && hunterView) {
            o.hid = 1;
            o.x = o.z = null;
          }
        } else o.carry = p.carrying;
        if (p === me) {
          o.hint = p.hint;
          if (p.qte && p.qte.auto === undefined) o.qte = { id: p.qte.id, e: r2(t - p.qte.start), a: r2(p.qte.a), b: r2(p.qte.b) };
        }
        return o;
      }),
      machines: this.machines.map((m) => [Math.round(m.p * 200) / 200, m.done ? 1 : 0, m.lastAt > t - 0.3 ? 1 : 0]),
      pallets: this.pallets.map((p) => p.st).join(''),
      gates: this.gates.map((g) => [r2(g.p), g.open ? 1 : 0]),
      cages: this.cages.map((c) => c.who),
      hatch: this.hatch.open ? 1 : 0,
      webs: this.webs.map((w) => [w.id, r2(w.x), r2(w.z)]),
      decoys: this.decoys.map((d) => [d.id, r2(d.x), r2(d.z), r2(d.d), d.color]),
      result: this.result,
      scores: this.result ? this.players.map((p) => this.score(p)) : undefined,
    };
  }

  score(p) {
    const s = p.stats;
    if (p.role === 'hunter') return Math.round(s.hits * 20 + s.downs * 30 + s.cages * 40 + s.kills * 90);
    return Math.round(s.decode * 1.2 + s.heal * 2 + s.rescue * 50 + s.stun * 30 + s.chased * 0.8 + (p.st === 'escaped' ? 100 : 0));
  }
}

module.exports = { HuntGame, dist, angDiff };
