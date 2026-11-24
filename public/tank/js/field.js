// 地形、车身和炮弹贴图复用，车辆与炮弹在服务器状态之间连续绘制。
const THEMES = {
  depot: { floor: '#263634', floorDark: '#121e20', line: '#70837a', steel: '#5c7370', edge: '#8fa39a', crate: '#8a6142', lamp: '#72c3a9' },
  canyon: { floor: '#44312a', floorDark: '#261d1b', line: '#99735b', steel: '#795a4a', edge: '#a7836b', crate: '#a86a43', lamp: '#f3af69' },
  foundry: { floor: '#273641', floorDark: '#141d28', line: '#708395', steel: '#576e81', edge: '#89a1b2', crate: '#80604c', lamp: '#78b4ef' },
};
const HOSTILE = { scout: '#ff885c', raider: '#f8757d', siege: '#ffb569' };
const ANGLE = Math.PI / 2;
const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;
const noise = (n) => ((Math.sin(n * 127.1 + 78.233) * 43758.5453) % 1 + 1) % 1;

function box(g, x, y, w, h, r, fill, stroke) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
  if (fill) {
    g.fillStyle = fill;
    g.fill();
  }
  if (stroke) {
    g.strokeStyle = stroke;
    g.stroke();
  }
}

function polygon(g, points, fill, stroke) {
  g.beginPath();
  g.moveTo(...points[0]);
  for (const point of points.slice(1)) g.lineTo(...point);
  g.closePath();
  g.fillStyle = fill;
  g.fill();
  if (stroke) {
    g.strokeStyle = stroke;
    g.stroke();
  }
}

function gradient(g, x, y, x2, y2, stops) {
  const grad = g.createLinearGradient(x, y, x2, y2);
  for (const [offset, color] of stops) grad.addColorStop(offset, color);
  return grad;
}

function glow(g, x, y, width, color) {
  const grad = g.createRadialGradient(x, y, 0, x, y, width);
  grad.addColorStop(0, color);
  grad.addColorStop(1, '#0000');
  g.fillStyle = grad;
  g.fillRect(x - width, y - width, 2 * width, 2 * width);
}

function stripe(g, x, y, w, h, color) {
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  g.strokeStyle = color;
  g.lineWidth = 4;
  for (let i = -h; i < w; i += 9) {
    g.beginPath();
    g.moveTo(x + i, y + h);
    g.lineTo(x + i + h, y);
    g.stroke();
  }
  g.restore();
}

function terrainTile(g, x, y, tile, kind, theme, seed) {
  const size = tile - 4;
  box(g, x + 5, y + 7, size, size, 4, '#070d11aa');
  if (kind < 0) {
    const face = gradient(g, x, y, x + 34, y + 38, [[0, theme.edge], [.22, theme.steel], [1, '#253435']]);
    box(g, x + 2, y + 1, size, size, 4, face, '#1a282a');
    box(g, x + 6, y + 5, size - 8, size - 9, 2, '#233638aa', '#b8d3c76b');
    g.fillStyle = '#151f21';
    g.fillRect(x + 8, y + 29, size - 12, 9);
    stripe(g, x + 8, y + 29, size - 12, 9, '#aeb78d8c');
    g.fillStyle = '#a7b1a1';
    for (const [dx, dy] of [[5, 4], [39, 4], [5, 40], [39, 40]]) g.fillRect(x + dx, y + dy, 2, 2);
  } else {
    const face = gradient(g, x, y, x + tile, y + tile, [[0, '#a88362'], [.35, theme.crate], [1, '#302922']]);
    box(g, x + 3, y + 2, size - 1, size - 1, 3, face, '#231c17');
    box(g, x + 6, y + 5, 36, 33, 2, '#704b32', '#deb58b74');
    g.strokeStyle = '#372a22';
    for (let dy = 12; dy <= 33; dy += 7) {
      g.beginPath();
      g.moveTo(x + 7, y + dy);
      g.lineTo(x + 41, y + dy);
      g.stroke();
    }
    polygon(g, [[x + 7, y + 5], [x + 12, y + 5], [x + 40, y + 33], [x + 40, y + 38], [x + 35, y + 38], [x + 7, y + 10]], '#ae8058');
    g.fillStyle = '#2d251e';
    for (const [dx, dy] of [[8, 7], [38, 7], [8, 37], [38, 37]]) g.fillRect(x + dx, y + dy, 2, 2);
    if (kind === 1) {
      polygon(g, [[x + 11, y + 3], [x + 21, y + 14], [x + 17, y + 22], [x + 29, y + 28], [x + 26, y + 41], [x + 22, y + 41], [x + 25, y + 30], [x + 12, y + 23], [x + 16, y + 13]], '#211c17');
      glow(g, x + 18 + noise(seed) * 10, y + 19, 12, '#df773252');
    }
  }
}

function drawGround(g, cfg, map) {
  const { tile, cols, rows, entry, docks } = cfg;
  const theme = THEMES[map] || THEMES.depot;
  const w = tile * cols;
  const h = tile * rows;
  g.fillStyle = gradient(g, 0, 0, w, h, [[0, theme.floorDark], [.42, theme.floor], [1, theme.floorDark]]);
  g.fillRect(0, 0, w, h);

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = col * tile;
      const y = row * tile;
      const n = row * cols + col + 1;
      if (noise(n * 2) > .47) {
        g.fillStyle = noise(n) < .5 ? '#e5fff407' : '#0011151e';
        g.fillRect(x + 1, y + 1, tile - 2, tile - 2);
      }
      if ((col + (row % 2) * 2) % 4 === 0) {
        g.strokeStyle = theme.line + '36';
        g.strokeRect(x + .5, y + .5, tile * 4, tile);
      }
      for (let i = 1; i <= 6; i++) {
        g.fillStyle = i % 2 ? '#09141445' : '#a3bdad18';
        g.fillRect(x + noise(n * i) * 45, y + noise(n + i * 109) * 45, 2 + noise(i + n) * 5, 1);
      }
      if (noise(n * 7) > .97) {
        box(g, x + 11, y + 14, 26, 20, 2, '#121d207c', theme.line + '48');
        g.fillStyle = '#84988a40';
        for (let i = 4; i < 24; i += 4) g.fillRect(x + 11 + i, y + 17, 2, 14);
      }
    }
  }
  g.strokeStyle = theme.line + '5c';
  g.setLineDash([25, 17]);
  g.beginPath();
  g.moveTo(7, h - 1.8 * tile);
  g.lineTo(w - 7, h - 1.8 * tile);
  g.stroke();
  g.setLineDash([]);
  g.strokeStyle = theme.line + '65';
  g.strokeRect(5.5, 5.5, w - 11, h - 11);
  for (const col of entry) {
    const x = col * tile;
    glow(g, x + tile / 2, 15, 80, '#e3763e45');
    stripe(g, x + 3, 6, tile - 6, 6, '#f0a058a6');
    g.fillStyle = '#f1ad7b80';
    g.font = '700 15px ui-monospace, monospace';
    g.textAlign = 'center';
    g.fillText('⌄', x + tile / 2, 29);
  }
  for (const col of docks) {
    const x = col * tile;
    const y = (rows - 2) * tile;
    box(g, x + 3, y + 3, tile - 6, tile - 6, 4, '#15272a', theme.lamp + '8e');
    g.fillStyle = theme.lamp + '9e';
    g.fillRect(x + 7, y + 7, tile - 14, 2);
    g.fillRect(x + 7, y + tile - 9, tile - 14, 2);
  }

  const edge = g.createRadialGradient(w / 2, h / 2, h * .25, w / 2, h / 2, w * .64);
  edge.addColorStop(0, '#0000');
  edge.addColorStop(1, '#050a10aa');
  g.fillStyle = edge;
  g.fillRect(0, 0, w, h);
}

function drawCore(g, core, now) {
  const x = core.x;
  const y = core.y;
  const pulse = (Math.sin(now / 235) + 1) * .5;
  g.save();
  g.translate(x, y);
  glow(g, 0, 0, 49 + pulse * 7, core.hp ? '#ffbe4f68' : '#d76d303b');
  g.rotate(Math.PI / 4);
  box(g, -24, -20, 49, 49, 8, '#061013b8');
  box(g, -22, -22, 44, 44, 6, '#344342', '#b7b49a');
  box(g, -17, -17, 34, 34, 5, '#252f2c', '#ab7e42');
  box(g, -11, -11, 22, 22, 4, core.hp ? '#714a27' : '#47312c', core.hp ? '#ffb85e' : '#b86743');
  box(g, -6, -6, 12, 12, 3, core.hp ? '#ffe7a7' : '#703e2d');
  g.restore();
  g.save();
  g.strokeStyle = '#ffce7480';
  g.setLineDash([4, 5]);
  g.beginPath();
  g.arc(x, y, 36 + pulse * 2, 0, TAU);
  g.stroke();
  g.restore();
}

function drawHull(g, color, phase) {
  box(g, -18, -15, 40, 39, 7, '#070b10a8');
  for (const side of [-1, 1]) {
    const offset = side < 0 ? -17 : 8;
    box(g, offset, -18, 9, 36, 3, '#101519', '#4d5757');
    g.fillStyle = '#737f796d';
    for (let j = -14 + phase; j < 16; j += 5) g.fillRect(offset + 1, j, 7, 1.4);
  }
  const hull = gradient(g, -12, -15, 12, 18, [[0, color], [.43, '#536866'], [1, '#1d2b2d']]);
  polygon(g, [[-10, -18], [10, -18], [13, -12], [13, 12], [9, 17], [-9, 17], [-13, 12], [-13, -12]], hull, '#a7b7ae97');
  box(g, -9, 9, 18, 6, 2, '#202e30', '#506466');
  g.fillStyle = '#94a9a186';
  for (let i = -6; i < 8; i += 3) g.fillRect(i, 10, 1, 4);
  box(g, -6, -26, 12, 6, 2, '#283639', '#91a4a1');
  box(g, -3.5, -25, 7, 18, 2, '#566c6b', '#172527');
  const turret = gradient(g, -8, -8, 11, 11, [[0, '#d8dfcd'], [.3, color], [1, '#324441']]);
  polygon(g, [[-6, -10], [6, -10], [10, -6], [10, 5], [5, 10], [-5, 10], [-10, 5], [-10, -6]], turret, '#1e2b2c');
  box(g, -3, -1, 6, 6, 1, '#26393b', '#bacfc255');
  box(g, -12, -15, 4, 4, 1, color);
  box(g, 8, -15, 4, 4, 1, color);
}

function bitmap(w, h = w) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

function drawTank(g, p, place, moving, now, own, label, cache) {
  const color = p.color || HOSTILE[p.type];
  const { x, y, angle } = place;
  const scale = p.type === 'scout' ? .84 : p.type === 'siege' ? 1.16 : 1;
  const phase = moving ? Math.abs(Math.floor((x + y) / 3)) % 5 : 0;
  const key = color + phase;
  let sprite = cache.get(key);
  if (!sprite) {
    sprite = bitmap(56);
    const context = sprite.getContext('2d');
    context.translate(28, 28);
    drawHull(context, color, phase);
    cache.set(key, sprite);
  }
  g.save();
  g.translate(x, y);
  if (p.shield) {
    g.strokeStyle = own ? '#98f6daa2' : '#b5dfe278';
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(0, 0, 22 + Math.sin(now / 140) * 1.4, 0, TAU);
    g.stroke();
  }
  g.rotate(angle);
  g.drawImage(sprite, -28 * scale, -28 * scale, 56 * scale, 56 * scale);
  g.restore();

  if (label) {
    box(g, x - 11, y + 22, 22, 15, 3, '#0b1517ef', color);
    g.fillStyle = color;
    g.textAlign = 'center';
    g.font = 'bold 10px ui-monospace, monospace';
    g.fillText(label, x, y + 33);
  } else if (p.maxHp > 1 && p.hp < p.maxHp) {
    box(g, x - 13, y + 20, 26, 4, 1, '#172023');
    box(g, x - 13, y + 20, 26 * p.hp / p.maxHp, 4, 1, color);
  }
}

function shotSprite(color) {
  const sprite = bitmap(30);
  const g = sprite.getContext('2d');
  g.translate(15, 15);
  glow(g, 0, 0, 13, color + '94');
  g.strokeStyle = gradient(g, 0, 13, 0, -4, [[0, color + '00'], [1, color]]);
  g.lineWidth = 4;
  g.beginPath();
  g.moveTo(0, 12);
  g.lineTo(0, -3);
  g.stroke();
  box(g, -2.5, -4, 5, 8, 2, '#fff9e2');
  return sprite;
}

export function createField(canvas) {
  const g = canvas.getContext('2d', { alpha: false });
  const ground = bitmap(1);
  const floor = bitmap(1);
  const fg = floor.getContext('2d');
  const hulls = new Map();
  const bullets = [shotSprite('#8df9de'), shotSprite('#ff9d62')];
  const flares = new Map();
  let cfg;
  let tiles = new Map();
  let frame;
  let previousPlayers;
  let previousEnemies;
  let previousShots;
  let updatedAt = 0;
  let period = 50;
  let displayWidth = 0;
  const motion = new Map();
  let effects = [];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  new ResizeObserver(([entry]) => { displayWidth = entry.contentRect.width; }).observe(canvas);

  function reset(config, key) {
    cfg = config;
    const theme = THEMES[key] || THEMES.depot;
    ground.width = floor.width = cfg.cols * cfg.tile;
    ground.height = floor.height = cfg.rows * cfg.tile;
    drawGround(ground.getContext('2d'), cfg, key);
    tiles = new Map([-1, 1, 2].map((kind) => {
      const sprite = bitmap(cfg.tile + 7);
      terrainTile(sprite.getContext('2d'), 0, 0, cfg.tile, kind, theme, 7);
      return [kind, sprite];
    }));
    fg.drawImage(ground, 0, 0);
    frame = null;
    updatedAt = 0;
    period = 50;
    motion.clear();
    effects = [];
  }

  const lookup = (list) => new Map(list?.map((item) => [item.id, item]));

  function update(state, grid = state.grid, events = state.events, now = performance.now()) {
    previousPlayers = lookup(frame?.players);
    previousEnemies = lookup(frame?.enemies);
    previousShots = lookup(frame?.shots);
    if (frame && now > updatedAt) period = clamp(period * .75 + (now - updatedAt) * .25, 35, 85);
    for (const id of motion.keys()) if (id[0] === 'e' && !previousEnemies.has(Number(id.slice(1)))) motion.delete(id);
    frame = state;
    updatedAt = now;
    if ((state.grid || state.tiles?.length) && grid) {
      fg.drawImage(ground, 0, 0);
      for (const [i, kind] of grid.entries()) {
        if (kind) fg.drawImage(tiles.get(kind), (i % cfg.cols) * cfg.tile, Math.floor(i / cfg.cols) * cfg.tile);
      }
    }
    for (const ev of events) {
      const duration = ev.type === 'blast' ? 540 : ev.type === 'spawn' || ev.type === 'wave' ? 500 : 220;
      effects.push({ ...ev, start: updatedAt, duration });
    }
  }

  function muzzle(x, y, now) {
    effects.push({ type: 'fire', x, y, start: now, duration: 220 });
  }

  function place(key, p, prev, t) {
    const last = motion.get(key);
    const snap = !prev?.hp || Math.hypot(prev.x - p.x, prev.y - p.y) > 60;
    const angle = p.dir * ANGLE;
    const old = snap ? angle : last?.angle ?? angle;
    const delta = Math.atan2(Math.sin(angle - old), Math.cos(angle - old));
    const result = { x: snap ? p.x : lerp(prev.x, p.x, t), y: snap ? p.y : lerp(prev.y, p.y, t), angle: old + delta * .38 };
    motion.set(key, result);
    return result;
  }

  function draw(now, me, pose) {
    if (!cfg) return;
    // 手机按实际显示宽度绘制，避免每帧合成一张比屏幕宽得多的画布。
    const width = Math.min(floor.width, Math.round((displayWidth || floor.width) * Math.min(devicePixelRatio || 1, 1.25)));
    const height = Math.round(width * floor.height / floor.width);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    g.setTransform(width / floor.width, 0, 0, height / floor.height, 0, 0);
    g.drawImage(floor, 0, 0);
    if (!frame) return;
    drawCore(g, frame.core, now);
    const t = clamp((now - updatedAt) / period, 0, 1);
    for (const [i, p] of frame.players.entries()) if (p.hp) {
      const ownPose = p.id === me ? pose : null;
      const prev = previousPlayers.get(p.id);
      const result = ownPose ? { ...ownPose, angle: ownPose.dir * ANGLE } : place('p' + p.id, p, prev, t);
      const moving = !!prev && (prev.x !== result.x || prev.y !== result.y);
      drawTank(g, p, result, moving, now, p.id === me, 'P' + (i + 1), hulls);
    }
    for (const p of frame.enemies) {
      const prev = previousEnemies.get(p.id);
      const result = place('e' + p.id, p, prev, t);
      drawTank(g, p, result, !!prev && (prev.x !== p.x || prev.y !== p.y), now, false, null, hulls);
    }
    for (const b of frame.shots) {
      const old = previousShots.get(b.id);
      g.save();
      g.translate(old ? lerp(old.x, b.x, t) : b.x, old ? lerp(old.y, b.y, t) : b.y);
      g.rotate(b.dir * ANGLE);
      g.drawImage(bullets[+b.enemy], -15, -15);
      g.restore();
    }
    effects = effects.filter((p) => now - p.start < p.duration);
    for (const p of effects) {
      const life = clamp((now - p.start) / p.duration, 0, 1);
      const entrance = p.type === 'spawn' || p.type === 'wave';
      const blast = p.type === 'blast' || p.type === 'coreHit';
      const color = entrance || p.type === 'fire' ? '#91f1c4' : '#ffc575';
      g.save();
      g.globalAlpha = (1 - life) * (reduced ? .46 : 1);
      let flare = flares.get(color);
      if (!flare) {
        flare = bitmap(48);
        glow(flare.getContext('2d'), 24, 24, 24, color + 'af');
        flares.set(color, flare);
      }
      const radius = (blast ? 34 : 17) * (1 + life);
      g.drawImage(flare, p.x - radius, p.y - radius, radius * 2, radius * 2);
      if (entrance || blast) {
        g.strokeStyle = color;
        g.beginPath();
        g.arc(p.x, p.y, 8 + life * (blast ? 43 : 27), 0, TAU);
        g.stroke();
      }
      if (!reduced && !entrance) {
        g.fillStyle = color;
        for (let i = 0; i < (blast ? 14 : 6); i++) {
          const a = noise(i + p.x * .17) * TAU;
          const r = 4 + life * (8 + noise(p.y + i) * (blast ? 52 : 25));
          g.fillRect(p.x + Math.cos(a) * r, p.y + Math.sin(a) * r, 2.5, 1.8);
        }
      }
      g.restore();
    }
  }

  return { reset, update, draw, muzzle };
}
