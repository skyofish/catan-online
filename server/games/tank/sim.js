'use strict';

const { TILE, COLS, ROWS, BASE, ENTRY, DOCKS, terrain } = require('./maps');

const STEP = 1 / 40;
const WIDTH = COLS * TILE;
const HEIGHT = ROWS * TILE;
const RADIUS = 15;
const WAVE_COUNT = 3;
const MATCH_TIME = 240;
const CORE_HP = 12;
const DIR = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const ENEMIES = {
  scout: { hp: 1, speed: 112, delay: 1.8 },
  raider: { hp: 2, speed: 82, delay: 1.35 },
  siege: { hp: 4, speed: 58, delay: 1.85 },
};
const center = (v) => (v + 0.5) * TILE;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const index = (x, y) => Math.floor(y / TILE) * COLS + Math.floor(x / TILE);
const idle = () => ({ dir: -1, fire: false });

function waveTypes(wave, size) {
  const types = wave === 1 ? ['scout', 'scout', 'raider']
    : wave === 2 ? ['scout', 'raider', 'scout', 'siege']
      : ['raider', 'scout', 'siege', 'raider', 'siege'];
  return Array.from({ length: 3 + wave * 2 + (size - 1) * 2 }, (_, i) => types[i % types.length]);
}

class TankMatch {
  constructor(map, seats) {
    this.map = map;
    this.grid = terrain(map);
    this.revision = 1;
    this.core = { x: center(BASE.x), y: center(BASE.y), hp: CORE_HP, maxHp: CORE_HP };
    this.players = seats.map((seat, i) => ({
      id: seat.id, color: seat.color, x: center(DOCKS[i]), y: center(12), dir: 0,
      hp: 3, lives: 3, respawn: 0, shield: 2, cooldown: 0, input: idle(), kills: 0, damage: 0, score: 0,
    }));
    this.startedAt = Date.now();
    this.wave = 1;
    this.countdown = 3;
    this.phase = 'ready';
    this.elapsed = 0;
    this.spawnIn = 0;
    this.spawned = 0;
    this.queue = waveTypes(this.wave, seats.length);
    this.enemies = [];
    this.shots = [];
    this.events = [];
    this.nextId = 1;
    this.totalKills = 0;
    this.result = null;
    this.updatePaths();
  }

  setInput(id, input) {
    const p = this.players.find((player) => player.id === id);
    if (p) p.input = input;
  }

  updatePaths() {
    // 从信标反向求路。经过货箱有代价，敌人优先绕路，也能打穿封锁。
    const width = this.grid.length;
    const cost = Array(width).fill(Infinity);
    const visited = new Uint8Array(width);
    const route = new Int8Array(width).fill(-1);
    cost[BASE.y * COLS + BASE.x] = 0;
    for (;;) {
      let current = -1;
      for (let i = 0; i < width; i++) {
        if (!visited[i] && Number.isFinite(cost[i]) && (current < 0 || cost[i] < cost[current])) current = i;
      }
      if (current < 0) break;
      visited[current] = 1;
      const x = current % COLS;
      const y = Math.floor(current / COLS);
      for (const [dir, [dx, dy]] of DIR.entries()) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) continue;
        const next = ny * COLS + nx;
        const moveCost = cost[current] + 1 + 5 * Math.max(0, this.grid[current]);
        if (this.grid[next] < 0 || cost[next] <= moveCost) continue;
        cost[next] = moveCost;
        route[next] = (dir + 2) % 4;
      }
    }
    this.route = route;
  }

  blocked(x, y) {
    for (const dx of [-RADIUS, RADIUS]) {
      for (const dy of [-RADIUS, RADIUS]) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || xx >= WIDTH || yy < 0 || yy >= HEIGHT || this.grid[index(xx, yy)] !== 0) return true;
      }
    }
    return Math.abs(x - this.core.x) < 35 && Math.abs(y - this.core.y) < 35;
  }

  move(tank, x, y) {
    if (this.blocked(x, y)) return false;
    tank.x = x;
    tank.y = y;
    return true;
  }

  event(type, x, y) {
    this.events.push({ type, x: Math.round(x), y: Math.round(y) });
  }

  fire(tank, enemy, dir = tank.dir) {
    const [dx, dy] = DIR[dir];
    const speed = enemy ? 260 : 465;
    this.shots.push({ id: this.nextId++, x: tank.x, y: tank.y, dx: dx * speed, dy: dy * speed, enemy, owner: tank });
    this.event(enemy ? 'enemyFire' : 'fire', tank.x + dx * 23, tank.y + dy * 23);
  }

  spawn() {
    for (let attempt = 0; attempt < ENTRY.length; attempt++) {
      const lane = (this.spawned + this.wave - 1 + attempt) % ENTRY.length;
      const x = center(ENTRY[lane]);
      const y = center(0);
      if (this.enemies.some((e) => distance(e, { x, y }) < TILE)) continue;
      const type = this.queue.shift();
      const kind = ENEMIES[type];
      this.enemies.push({ id: this.nextId++, type, x, y, dir: 2, hp: kind.hp, cooldown: 0.9, target: null });
      this.spawned++;
      this.event('spawn', x, y);
      return;
    }
  }

  updatePlayer(p, dt) {
    if (p.hp === 0) {
      if (!p.lives) return;
      p.respawn -= dt;
      if (p.respawn > 0) return;
      p.x = center(DOCKS[this.players.indexOf(p)]);
      p.y = center(12);
      p.hp = 3;
      p.shield = 2;
      p.dir = 0;
      this.event('spawn', p.x, p.y);
    }
    p.shield = Math.max(0, p.shield - dt);
    p.cooldown -= dt;
    if (p.input.dir >= 0) {
      p.dir = p.input.dir;
      const [dx, dy] = DIR[p.dir];
      const amount = 185 * dt;
      if (!this.move(p, p.x + dx * amount, p.y + dy * amount)) {
        // 进窄巷时把车身轻推向当前格中心。
        const coord = dx ? p.y : p.x;
        const offset = center(Math.floor(coord / TILE)) - coord;
        const nudge = Math.sign(offset) * Math.min(Math.abs(offset), amount);
        this.move(p, p.x + dy * nudge, p.y + dx * nudge);
      }
    }
    if (p.input.fire && p.cooldown <= 0) {
      p.cooldown = 0.29;
      this.fire(p, false);
    }
  }

  updateEnemy(e, dt) {
    const kind = ENEMIES[e.type];
    e.cooldown -= dt;
    if (!e.target) {
      const dir = this.route[index(e.x, e.y)];
      if (dir < 0) return;
      e.dir = dir;
      const [dx, dy] = DIR[dir];
      e.target = { x: e.x + dx * TILE, y: e.y + dy * TILE };
    }
    const [dx, dy] = DIR[e.dir];
    const nearCore = distance(e, this.core) <= TILE * 2;
    const canShootPlayer = this.players.some((p) => {
      if (!p.hp) return false;
      const x = p.x - e.x;
      const y = p.y - e.y;
      const ahead = x * dx + y * dy;
      return ahead > 0 && ahead < TILE * 6 && Math.abs(x * dy - y * dx) < RADIUS;
    });
    const remaining = distance(e, e.target);
    const amount = Math.min(remaining, kind.speed * dt);
    const moved = this.move(e, e.x + dx * amount, e.y + dy * amount);
    if (moved && remaining <= amount + 0.0001) {
      e.x = e.target.x;
      e.y = e.target.y;
      e.target = null;
    }
    if (e.cooldown <= 0 && (!moved || nearCore || canShootPlayer)) {
      e.cooldown = kind.delay;
      this.fire(e, true);
    }
  }

  updateShot(b, dt) {
    b.x += b.dx * dt;
    b.y += b.dy * dt;
    if (b.x < 0 || b.x >= WIDTH || b.y < 0 || b.y >= HEIGHT) return false;
    const cell = index(b.x, b.y);
    if (this.grid[cell] !== 0) {
      if (this.grid[cell] > 0) {
        this.grid[cell]--;
        this.revision++;
        if (!this.grid[cell]) this.updatePaths();
      }
      this.event('spark', b.x, b.y);
      return false;
    }
    if (Math.abs(b.x - this.core.x) < 19 && Math.abs(b.y - this.core.y) < 19) {
      if (b.enemy) {
        this.core.hp = Math.max(0, this.core.hp - 1);
        this.event('coreHit', b.x, b.y);
      }
      return false;
    }
    const target = (b.enemy ? this.players : this.enemies).find((t) => t.hp > 0 && distance(t, b) < RADIUS + 2);
    if (!target) return true;
    if (b.enemy && target.shield > 0) {
      this.event('spark', b.x, b.y);
      return false;
    }
    target.hp--;
    if (!b.enemy) {
      b.owner.damage++;
      b.owner.score += 10;
    }
    if (target.hp > 0) {
      this.event('spark', b.x, b.y);
      return false;
    }
    this.event('blast', target.x, target.y);
    if (b.enemy) {
      target.lives--;
      target.respawn = 2.8;
    } else {
      b.owner.kills++;
      b.owner.score += target.type === 'siege' ? 150 : 100;
      this.totalKills++;
    }
    return false;
  }

  finish(won, reason) {
    this.phase = 'ended';
    this.result = { won, reason, kills: this.totalKills, wave: this.wave };
  }

  step(dt = STEP) {
    if (this.phase === 'ended') return;
    for (const p of this.players) this.updatePlayer(p, dt);
    if (this.phase === 'ready') {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.phase = 'wave';
        this.spawnIn = 0.25;
      }
    }
    if (this.phase === 'wave') {
      this.elapsed += dt;
      this.spawnIn -= dt;
      if (this.queue.length && this.spawnIn <= 0 && this.enemies.length < 5 + this.players.length) {
        this.spawn();
        this.spawnIn = 0.85;
      }
      for (const e of this.enemies) this.updateEnemy(e, dt);
    }
    this.shots = this.shots.filter((b) => this.updateShot(b, dt));
    this.enemies = this.enemies.filter((e) => e.hp > 0);
    if (this.core.hp === 0) this.finish(false, 'core');
    else if (this.players.every((p) => p.lives === 0)) this.finish(false, 'crew');
    else if (this.elapsed >= MATCH_TIME) this.finish(false, 'time');
    else if (this.phase === 'wave' && !this.queue.length && !this.enemies.length) {
      if (this.wave === WAVE_COUNT) this.finish(true, 'cleared');
      else {
        this.wave++;
        this.phase = 'ready';
        this.countdown = 4.5;
        this.queue = waveTypes(this.wave, this.players.length);
        this.core.hp = Math.min(this.core.maxHp, this.core.hp + 2);
        for (const p of this.players) if (p.hp > 0) p.hp = 3;
        this.shots = this.shots.filter((b) => !b.enemy);
        this.event('wave', this.core.x, this.core.y);
      }
    }
  }

  snapshot() {
    const tank = (p) => ({ id: p.id, x: Math.round(p.x), y: Math.round(p.y), dir: p.dir, hp: p.hp });
    return {
      phase: this.phase, wave: this.wave, waves: WAVE_COUNT, remaining: this.queue.length + this.enemies.length,
      countdown: Math.max(0, Math.ceil(this.countdown)), time: Math.max(0, Math.ceil(MATCH_TIME - this.elapsed)),
      core: this.core, result: this.result,
      players: this.players.map((p) => ({ ...tank(p), color: p.color, lives: p.lives, shield: p.shield > 0, respawn: Math.max(0, Math.ceil(p.respawn)), kills: p.kills, score: p.score })),
      enemies: this.enemies.map((e) => ({ ...tank(e), type: e.type, maxHp: ENEMIES[e.type].hp })),
      shots: this.shots.map((s) => ({ id: s.id, x: Math.round(s.x), y: Math.round(s.y), dir: s.dx ? (s.dx > 0 ? 1 : 3) : (s.dy > 0 ? 2 : 0), enemy: s.enemy })),
    };
  }
}

module.exports = { TankMatch, STEP, WAVE_COUNT };
