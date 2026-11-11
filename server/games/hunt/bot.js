'use strict';
// 雾夜追猎：内置电脑（求生者与追猎者）。每 0.05 秒调用一次：按水平的反应间隔做决定，其余时间沿路径走。
// focus 是智谱 AI 给的"侧重"（见 ai.js），用来调整内置策略的偏好。
const { RULES: R, BOT_LEVELS } = require('./data');
const { W, findPath, hits, los } = require('./maps');
const { dist, angDiff } = require('./sim');

function nav(g) {
  if (g._nav) return g._nav;
  const win = new Int16Array(W * W).fill(-1);
  const pal = new Int16Array(W * W).fill(-1);
  g.map.windows.forEach((w, i) => (win[w.z * W + w.x] = i));
  g.pallets.forEach((p, i) => (pal[Math.floor(p.z) * W + Math.floor(p.x)] = i));
  return (g._nav = { win, pal });
}

// 寻路代价：窗和倒下的木板只能沿轴穿过，并且有额外代价（翻越 / 砸板的时间）
function costFn(g, hunter) {
  const { win, pal } = nav(g);
  return (x, z, dx, dz) => {
    if (x < 0 || z < 0 || x >= W || z >= W) return Infinity;
    const i = z * W + x;
    const c = g.grid[i];
    if (c === 1 || c === 2) return Infinity;
    if (c === 3) {
      const w = g.map.windows[win[i]];
      return (w.axis === 'x' ? dx !== 0 && dz === 0 : dz !== 0 && dx === 0) ? (hunter ? 7 : 3) : Infinity;
    }
    if (g.gateCell[i] >= 0) return hunter || !g.gates[g.gateCell[i]].open ? Infinity : 0;
    if (g.dyn[i]) {
      const pi = pal[i];
      if (pi < 0 || g.pallets[pi].st !== 1) return Infinity;
      const p = g.pallets[pi];
      return (p.axis === 'x' ? dx !== 0 && dz === 0 : dz !== 0 && dx === 0) ? (hunter ? 8 : 3) : Infinity;
    }
    return 0;
  };
}

function goTo(g, p, mem, tx, tz) {
  const key = `${Math.floor(tx)},${Math.floor(tz)}`;
  if (mem.goalKey === key && mem.path && mem.path.length && g.t - mem.pathAt < 1.2) return;
  mem.goalKey = key;
  mem.pathAt = g.t;
  mem.path = findPath(costFn(g, p.role === 'hunter'), p.x, p.z, tx, tz);
  mem.goal = { x: tx, z: tz };
}

// 沿路径走；遇到窗 / 倒下的木板就翻越或砸掉
function follow(g, p, mem) {
  const path = mem.path;
  if (!path || !path.length) {
    // 最后一小段直接走过去
    if (mem.goal && Math.hypot(mem.goal.x - p.x, mem.goal.z - p.z) > 0.25 && Math.hypot(mem.goal.x - p.x, mem.goal.z - p.z) < 1.5) {
      p.mx = mem.goal.x - p.x;
      p.mz = mem.goal.z - p.z;
      const l = Math.hypot(p.mx, p.mz);
      p.mx /= l;
      p.mz /= l;
    } else p.mx = p.mz = 0;
    return;
  }
  const solid = g.solidFor(p);
  while (path.length && Math.hypot(path[0].x - p.x, path[0].z - p.z) < 0.3) path.shift();
  if (!path.length) return void (p.mx = p.mz = 0);
  let wp = path[0];
  if (solid(Math.floor(wp.x), Math.floor(wp.z))) {
    // 下一格是障碍：窗、木板
    const h = p.hint;
    if (h && (h.type === 'vault' || h.type === 'break') && Math.hypot(wp.x - p.x, wp.z - p.z) < 1.25) {
      const r = g.act(p.id, { type: 'use' });
      if (r.ok) {
        if (h.type === 'vault') path.splice(0, 2);
        p.mx = p.mz = 0;
        return;
      }
    }
    if (Math.hypot(wp.x - p.x, wp.z - p.z) < 0.9) {
      // 卡住了：重新规划
      mem.pathAt = -9;
      p.mx = p.mz = 0;
      return;
    }
  } else {
    // 往前看几格，能直走就抄近路
    for (let k = Math.min(4, path.length - 1); k > 0; k--) {
      const q = path[k];
      if (solid(Math.floor(q.x), Math.floor(q.z))) continue;
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      const n = Math.ceil(d / 0.3);
      let clear = true;
      for (let i = 1; i <= n && clear; i++) if (hits(solid, p.x + ((q.x - p.x) * i) / n, p.z + ((q.z - p.z) * i) / n, R.radius + 0.08)) clear = false;
      if (clear) {
        path.splice(0, k);
        wp = q;
        break;
      }
    }
  }
  const dx = wp.x - p.x;
  const dz = wp.z - p.z;
  const l = Math.hypot(dx, dz) || 1;
  p.mx = dx / l;
  p.mz = dz / l;
}

function stuckCheck(g, p, mem, dt) {
  if (Math.hypot(p.mx, p.mz) < 0.2 || p.act || p.atk || p.stun > g.t) {
    mem.stuckT = 0;
    mem.sx = p.x;
    mem.sz = p.z;
    return;
  }
  mem.stuckT = (mem.stuckT || 0) + dt;
  if (mem.stuckT > 1) {
    if (Math.hypot(p.x - (mem.sx || 0), p.z - (mem.sz || 0)) < 0.25) {
      mem.pathAt = -9;
      mem.goalKey = null;
      mem.fleeUntil = 0;
    }
    mem.stuckT = 0;
    mem.sx = p.x;
    mem.sz = p.z;
  }
}

// ======================= 求生者 =======================
function fleeTarget(g, p, h) {
  const away = Math.atan2(p.x - h.x, p.z - h.z);
  let best = null;
  const consider = (x, z, bonus) => {
    if (x < 1.5 || z < 1.5 || x > W - 1.5 || z > W - 1.5) return;
    if (g.solidS(Math.floor(x), Math.floor(z))) return;
    const dm = Math.hypot(x - p.x, z - p.z);
    const dh = Math.hypot(x - h.x, z - h.z);
    if (dh < dm + 1) return;
    const dir = angDiff(Math.atan2(x - p.x, z - p.z), away);
    const s = dh - dm * 0.5 - dir * 4 + bonus + g.rand() * 2;
    if (!best || s > best.s) best = { x, z, s };
  };
  for (let a = 0; a < 12; a++) {
    const ang = (a / 12) * Math.PI * 2;
    for (const r of [9, 15]) consider(p.x + Math.sin(ang) * r, p.z + Math.cos(ang) * r, 0);
  }
  // 板子和窗：跑到对面那一侧
  for (const o of g.pallets) {
    if (o.st === 2 || Math.hypot(o.x - p.x, o.z - p.z) > 16) continue;
    const s = (o.axis === 'x' ? h.x - o.x : h.z - o.z) >= 0 ? -1 : 1;
    consider(o.axis === 'x' ? o.x + s * 1.2 : o.x, o.axis === 'x' ? o.z : o.z + s * 1.2, o.st === 0 ? 7 : 4);
  }
  for (const w of g.map.windows) {
    const o = { x: w.x + 0.5, z: w.z + 0.5 };
    if (Math.hypot(o.x - p.x, o.z - p.z) > 14) continue;
    const s = (w.axis === 'x' ? h.x - o.x : h.z - o.z) >= 0 ? -1 : 1;
    consider(w.axis === 'x' ? o.x + s : o.x, w.axis === 'x' ? o.z : o.z + s, 5);
  }
  if (g.powered) for (const gt of g.gates) if (gt.open) consider(gt.x, gt.z, 30);
  return best;
}

function survivorBot(g, p, level, mem, focus = {}) {
  const L = BOT_LEVELS[level] || BOT_LEVELS.normal;
  const t = g.t;
  const h = g.hunter;
  if (p.st !== 'ok' && p.st !== 'down') return void (p.mx = p.mz = 0);
  if (p.act && p.act.type === 'vault') return;
  const dh = h ? dist(p, h) : 99;
  const sees = h && (g.revealUntil > t || dh < 5 || (dh < L.sight && los(g.grid, p.x, p.z, h.x, h.z)));
  if (sees) mem.seenAt = t;
  const fleeD = L.flee + (focus.safe ? 4 : 0) - (focus.decode ? 2 : 0);
  const hunterBusy = h && (h.stun > t || h.carrying || (h.atk && h.atk.ph === 'rec'));

  if (p.st === 'down') {
    const mate = g.survivors.filter((s) => s.st === 'ok').sort((a, b) => dist(p, a) - dist(p, b))[0];
    if (mate && dist(p, mate) > 1.5) {
      goTo(g, p, mem, mate.x, mate.z);
      follow(g, p, mem);
    } else p.mx = p.mz = 0;
    return;
  }

  // 技能
  if (p.cd <= t && g.rand() < L.skill * 0.2) {
    let use = false;
    if (p.char === 'runner' || p.char === 'illusion') use = sees && dh < 6 && !hunterBusy;
    else if (p.char === 'guard') {
      use = h && dh < 5 && los(g.grid, p.x, p.z, h.x, h.z) && (h.carrying || dh < 3.2);
      if (use) p.d = Math.atan2(h.x - p.x, h.z - p.z);
    } else if (p.char === 'scout') use = h && g.survivors.some((s) => s.st === 'ok' && dist(s, h) < 12);
    else if (p.char === 'tinker') use = p.act && p.act.type === 'decode';
    else if (p.char === 'nurse') use = p.hp === 1 && dh > 22 && t - (mem.seenAt || -99) > 5 && !p.act;
    if (use && g.act(p.id, { type: 'skill' }).ok && p.char === 'nurse') return;
  }
  if (p.act && p.act.type === 'selfheal' && dh > fleeD) return void (p.mx = p.mz = 0);

  // 逃跑
  const threatened = h && !hunterBusy && ((sees && dh < fleeD) || dh < 6.5);
  if (threatened) mem.fleeUntil = t + 2.5;
  if (h && mem.fleeUntil > t && !(hunterBusy && dh > 5)) {
    mem.mode = 'flee';
    if (!mem.flee || t - mem.fleeAt > 1.6 || Math.hypot(mem.flee.x - p.x, mem.flee.z - p.z) < 1) {
      mem.flee = fleeTarget(g, p, h) || mem.flee;
      mem.fleeAt = t;
      mem.goalKey = null;
    }
    // 放板：追猎者快到板子了，而我在板子另一侧
    const hint = p.hint;
    if (hint && hint.type === 'drop') {
      const pl = g.pallets[hint.id];
      if (mem.palRoll !== pl.id) {
        mem.palRoll = pl.id;
        mem.palOk = g.rand() < L.pallet;
      }
      const side = (o) => (pl.axis === 'x' ? o.x - pl.x : o.z - pl.z);
      if (mem.palOk && dist(h, pl) < 2.4 && side(h) * side(p) <= 0 && Math.abs(side(p)) > 0.35) g.act(p.id, { type: 'use' });
    }
    if (mem.flee) {
      goTo(g, p, mem, mem.flee.x, mem.flee.z);
      follow(g, p, mem);
    }
    return;
  }
  if (mem.mode === 'flee') {
    mem.mode = null;
    mem.goalKey = null;
  }

  if (mem.thinkAt > t && mem.job) return doJob(g, p, mem);
  mem.thinkAt = t + L.think * 2;

  const mates = g.survivors.filter((s) => s !== p);
  const okMates = g.survivors.filter((s) => s.st === 'ok');
  const closest = (target) => okMates.slice().sort((a, b) => dist(a, target) - dist(b, target))[0] === p;
  let job = null;

  // 救人
  const caged = mates.filter((s) => s.st === 'caged').sort((a, b) => b.cageT - a.cageT)[0];
  if (caged && closest(caged)) {
    const guard = h ? dist(h, caged) : 99;
    const cg = caged.cageT / R.cageTime;
    const urgent = (cg > 0.3 && cg < 0.5) || cg > 0.78;
    if (guard > 9 || urgent || focus.rescue || level === 'easy') job = { type: 'rescue', id: caged.id, x: caged.x, z: caged.z };
  }
  // 扶人 / 治疗
  if (!job && !focus.decode) {
    const down = mates.filter((s) => s.st === 'down' && (!h || dist(h, s) > 8)).sort((a, b) => dist(p, a) - dist(p, b))[0];
    if (down && closest(down)) job = { type: 'heal', id: down.id, x: down.x, z: down.z };
    if (!job) {
      const hurt = mates.filter((s) => s.st === 'ok' && s.hp === 1 && !s.moving && dist(p, s) < (p.char === 'nurse' || focus.heal ? 22 : 9)).sort((a, b) => dist(p, a) - dist(p, b))[0];
      if (hurt && dh > 14 && !mates.some((o) => o.act && o.act.type === 'heal' && o.act.id === hurt.id)) job = { type: 'heal', id: hurt.id, x: hurt.x, z: hurt.z };
    }
  }
  // 逃生
  const openGate = g.gates.filter((o) => o.open).sort((a, b) => dist(p, a) - dist(p, b))[0];
  if (!job && g.hatch.open && !(openGate && dist(p, openGate) < dist(p, g.hatch))) job = { type: 'hatch', x: g.hatch.x, z: g.hatch.z };
  if (!job && g.powered) {
    const open = openGate;
    if (open) job = { type: 'exit', x: open.x, z: open.z };
    else {
      const gt = g.gates.slice().sort((a, b) => dist(p, a.panel) - a.p * 30 + (h && dist(h, a.panel) < 12 ? 25 : 0) - (dist(p, b.panel) - b.p * 30 + (h && dist(h, b.panel) < 12 ? 25 : 0)))[0];
      job = { type: 'gate', id: gt.id, x: gt.panel.x, z: gt.panel.z };
    }
  }
  // 修机
  if (!job) {
    const score = (m) => {
      const n = mates.filter((s) => (s.act && s.act.type === 'decode' && s.act.id === m.id) || (s.botJob && s.botJob.type === 'decode' && s.botJob.id === m.id)).length;
      return dist(p, m) - m.p * 25 + (n >= 2 ? 40 : n * 4) + (h && dist(h, m) < 11 ? 30 : 0) - (mem.job && mem.job.type === 'decode' && mem.job.id === m.id ? 8 : 0);
    };
    const m = g.machines.filter((o) => !o.done).sort((a, b) => score(a) - score(b))[0];
    if (m) job = { type: 'decode', id: m.id, x: m.x, z: m.z };
  }
  mem.job = job;
  p.botJob = job;
  doJob(g, p, mem);
}

function doJob(g, p, mem) {
  const job = mem.job;
  if (!job) return void (p.mx = p.mz = 0);
  const hint = p.hint;
  if (p.act && p.act.type === job.type && (job.id === undefined || p.act.id === job.id)) return void (p.mx = p.mz = 0);
  if (job.type === 'heal') {
    const o = g.P(job.id);
    if (o) {
      job.x = o.x;
      job.z = o.z;
    }
  }
  if (hint && hint.type === job.type && (job.id === undefined || hint.id === job.id)) {
    p.mx = p.mz = 0;
    g.act(p.id, { type: 'use' });
    return;
  }
  // 发报机、铁笼占着格子：走到它旁边最近的空格
  let tx = job.x;
  let tz = job.z;
  if (job.type === 'decode' || job.type === 'rescue') {
    let best = null;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = job.x + dx;
      const z = job.z + dz;
      if (g.solidS(Math.floor(x), Math.floor(z))) continue;
      const d = Math.hypot(x - p.x, z - p.z);
      if (!best || d < best.d) best = { x, z, d };
    }
    if (best) {
      tx = best.x;
      tz = best.z;
    }
  }
  goTo(g, p, mem, tx, tz);
  follow(g, p, mem);
}

// ======================= 追猎者 =======================
function hunterBot(g, p, level, mem, focus = {}) {
  const L = BOT_LEVELS[level] || BOT_LEVELS.normal;
  const t = g.t;
  p.speedMul = L.hunterSpeed;
  if (p.stun > t || p.atk || p.dash || p.cast || p.act) return void (p.mx = p.mz = 0);

  if (p.carrying) {
    const c = g.cages.filter((c) => !c.who).sort((a, b) => dist(p, a) - dist(p, b))[0];
    if (!c) return;
    if (p.hint && p.hint.type === 'cage') return void g.act(p.id, { type: 'use' });
    approach(g, p, mem, c);
    mem.lastCage = { x: c.x, z: c.z, t };
    return;
  }
  if (p.hint && p.hint.type === 'pickup') return void g.act(p.id, { type: 'use' });

  // 找目标
  const visible = (s) => s.st === 'ok' && s.invisUntil <= t && (s.shownUntil > t || dist(p, s) < 4.5 || (dist(p, s) < L.sight && los(g.grid, p.x, p.z, s.x, s.z)));
  const cands = g.survivors.filter(visible);
  let target = null;
  let bs = Infinity;
  for (const s of cands) {
    const sc = dist(p, s) - (s.hp === 1 ? 5 : 0) - (mem.target === s.id ? 4 : 0) - (focus.decoder && s.act && s.act.type === 'decode' ? 6 : 0);
    if (sc < bs) {
      bs = sc;
      target = s;
    }
  }
  const down = g.survivors.filter((s) => s.st === 'down' && (dist(p, s) < 14 || mem.downed === s.id)).sort((a, b) => dist(p, a) - dist(p, b))[0];
  if (down && (!target || dist(p, down) < 8)) {
    goTo(g, p, mem, down.x, down.z);
    follow(g, p, mem);
    return;
  }
  if (target) {
    mem.target = target.id;
    mem.seen = { x: target.x, z: target.z, t };
    const d = dist(p, target);
    const clear = los(g.grid, p.x, p.z, target.x, target.z);
    if (p.cd <= t && g.rand() < L.skill) {
      if (p.char === 'reaper' && d > 3.5 && d < 8 && clear) {
        p.d = Math.atan2(target.x - p.x, target.z - p.z);
        if (g.act(p.id, { type: 'skill' }).ok) return;
      } else if (p.char === 'weaver' && d < 7) g.act(p.id, { type: 'skill' });
    }
    if (d < 2.05 && clear) {
      mem.atkWait = (mem.atkWait || 0) + R.tick;
      if (mem.atkWait >= L.atkDelay) {
        mem.atkWait = 0;
        p.d = Math.atan2(target.x - p.x, target.z - p.z);
        g.act(p.id, { type: 'attack' });
        mem.downed = target.id;
        return;
      }
    } else mem.atkWait = 0;
    // 贴身时直接冲过去，否则寻路
    if (d < 3 && clear) {
      p.mx = (target.x - p.x) / d;
      p.mz = (target.z - p.z) / d;
    } else {
      goTo(g, p, mem, target.x, target.z);
      follow(g, p, mem);
    }
    return;
  }
  // 丢了目标：去最后看到的位置
  if (mem.seen && t - mem.seen.t < 5 && Math.hypot(mem.seen.x - p.x, mem.seen.z - p.z) > 1.5) {
    goTo(g, p, mem, mem.seen.x, mem.seen.z);
    follow(g, p, mem);
    return;
  }
  mem.target = null;

  // 巡逻：守笼 / 压机
  const cagedS = g.survivors.find((s) => s.st === 'caged');
  if (cagedS && (focus.guard || level === 'easy') && dist(p, cagedS) > 7) {
    approach(g, p, mem, cagedS);
    return;
  }
  if (!mem.patrol || g.machines[mem.patrol.id].done || dist(p, g.machines[mem.patrol.id]) < 3.5 || t - mem.patrol.t > 25) {
    mem.visited = mem.visited || {};
    if (mem.patrol) mem.visited[mem.patrol.id] = t;
    const ms = g.machines.filter((m) => !m.done);
    let pick = null;
    if (ms.length) {
      const sc = (m) => (level === 'easy' ? g.rand() * 50 : -m.p * 40 - (m.lastAt > t - 5 && level === 'hard' ? 10 : 0)) + dist(p, m) * 0.5 + (t - (mem.visited[m.id] || -99) < 20 ? 60 : 0) + (cagedS && focus.guard ? dist(cagedS, m) : 0);
      pick = ms.slice().sort((a, b) => sc(a) - sc(b))[0];
    } else {
      // 机器都修完了：去守大门
      const gt = g.gates.slice().sort((a, b) => b.p - a.p)[0];
      return void approach(g, p, mem, gt.panel);
    }
    mem.patrol = { id: pick.id, t };
    if (p.char === 'phantom' && p.cd <= t && dist(p, pick) > 24 && g.rand() < L.skill) return void g.act(p.id, { type: 'skill', target: pick.id });
    if (p.char === 'weaver' && p.cd <= t && g.rand() < L.skill * 0.6) g.act(p.id, { type: 'skill' });
  }
  approach(g, p, mem, g.machines[mem.patrol.id]);
}

function approach(g, p, mem, o) {
  let tx = o.x;
  let tz = o.z;
  if (g.solidH(Math.floor(tx), Math.floor(tz))) {
    let best = null;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const x = o.x + dx;
      const z = o.z + dz;
      if (g.solidH(Math.floor(x), Math.floor(z))) continue;
      const d = Math.hypot(x - p.x, z - p.z);
      if (!best || d < best.d) best = { x, z, d };
    }
    if (best) {
      tx = best.x;
      tz = best.z;
    }
  }
  goTo(g, p, mem, tx, tz);
  follow(g, p, mem);
}

function botTick(g, p, level, mem, focus, dt = R.tick) {
  if (g.phase !== 'play') return void (p.mx = p.mz = 0);
  p.hint = g.hintFor(p);
  if (p.role === 'hunter') hunterBot(g, p, level, mem, focus);
  else {
    p.autoQte = (BOT_LEVELS[level] || BOT_LEVELS.normal).qteFail;
    survivorBot(g, p, level, mem, focus);
  }
  stuckCheck(g, p, mem, dt);
}

module.exports = { botTick, costFn };
