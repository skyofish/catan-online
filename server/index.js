'use strict';
// 卡坦岛联机服务器：静态文件 + HTTP API（登录 / 管理员 / 战绩）+ WebSocket 房间。
// 数据保存在 SQLite（Node 内置 node:sqlite），零第三方依赖。
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { attachWS } = require('./ws');
const { Game } = require('./game');
const { LAYOUTS, generateBoard } = require('./board');
const { botAction } = require('./bot');
const db = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, '..', 'public');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'catan.db');
const BOT_DELAY = Number(process.env.BOT_DELAY_MS) || 900;
const AFK_TAKEOVER_MS = Number(process.env.AFK_TAKEOVER_MS) || 60000;
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 200;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

const COLORS = ['#e53935', '#1e88e5', '#fb8c00', '#f5f5f5', '#43a047', '#8e24aa', '#6d4c41', '#00acc1'];
const BOT_NAMES = ['阿尔法', '贝塔', '伽马', '德尔塔', '艾普西隆', '泽塔', '伊塔', '西塔', '卡帕', '拉姆达'];

db.open(DB_PATH);
if (!ADMIN_USERNAME || !ADMIN_PASSWORD) console.warn('⚠️  未设置 ADMIN_USERNAME / ADMIN_PASSWORD，管理员后台无法登录。');

// ======================= HTTP =======================
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 16 * 1024) {
        reject(new HttpError(413, '请求过大'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, '请求格式错误'));
      }
    });
    req.on('error', reject);
  });
}

class HttpError extends Error {
  constructor(status, msg) {
    super(msg);
    this.status = status;
  }
}

const bearer = (req) => {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
};
function requireUser(req) {
  const s = db.checkSession(bearer(req), 'user');
  if (!s) throw new HttpError(401, '请先登录');
  return s.user;
}
function requireAdmin(req) {
  const s = db.checkSession(bearer(req), 'admin');
  if (!s) throw new HttpError(401, '管理员登录已过期，请重新登录');
}

// 简单的按 IP 限流
const hits = new Map();
function rateLimit(req, key, max, windowMs) {
  const ip = req.socket.remoteAddress || '?';
  const k = `${key}:${ip}`;
  const now = Date.now();
  const list = (hits.get(k) || []).filter((t) => now - t < windowMs);
  if (list.length >= max) throw new HttpError(429, '尝试次数过多，请稍后再试');
  list.push(now);
  hits.set(k, list);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, list] of hits) if (!list.some((t) => now - t < 15 * 60000)) hits.delete(k);
}, 60000).unref();

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const api = {
  // ---------- 玩家 ----------
  'POST /api/login': async (req) => {
    rateLimit(req, 'login', 20, 60000);
    const body = await readBody(req);
    try {
      return db.loginUser(body.username);
    } catch (e) {
      throw new HttpError(403, e.message);
    }
  },
  'POST /api/logout': async (req) => {
    db.logout(bearer(req));
    return { ok: true };
  },
  'GET /api/me': async (req) => {
    const user = requireUser(req);
    return { user, ...db.userSummary(user.id, 10) };
  },
  'GET /api/leaderboard': async (req) => {
    requireUser(req);
    return { rows: db.leaderboard(50) };
  },

  // ---------- 管理员 ----------
  'POST /api/admin/login': async (req) => {
    rateLimit(req, 'admin', 10, 10 * 60000);
    const body = await readBody(req);
    if (!ADMIN_USERNAME || !ADMIN_PASSWORD) throw new HttpError(503, '服务器未配置管理员账号');
    const ok = safeEqual(body.username || '', ADMIN_USERNAME) & safeEqual(body.password || '', ADMIN_PASSWORD);
    if (!ok) throw new HttpError(403, '账号或密码错误');
    return { token: db.createAdminSession() };
  },
  'POST /api/admin/logout': async (req) => {
    db.logout(bearer(req));
    return { ok: true };
  },
  'GET /api/admin/users': async (req) => {
    requireAdmin(req);
    return { users: db.listUsers().map((u) => ({ ...u, enabled: !!u.enabled, online: userConns.has(u.id) })) };
  },
  'POST /api/admin/users': async (req) => {
    requireAdmin(req);
    const body = await readBody(req);
    const names = String(body.usernames || '')
      .split(/[\s,，、;；]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!names.length) throw new HttpError(400, '请输入账号');
    if (names.length > 50) throw new HttpError(400, '一次最多添加 50 个账号');
    const created = [];
    const errors = [];
    for (const n of names) {
      try {
        created.push(db.createUser(n).username);
      } catch (e) {
        errors.push(`${n}：${e.message}`);
      }
    }
    return { created, errors };
  },
  'PATCH /api/admin/users/:id': async (req, id) => {
    requireAdmin(req);
    const body = await readBody(req);
    const u = db.getUser(id);
    if (!u) throw new HttpError(404, '账号不存在');
    db.setUserEnabled(id, !!body.enabled);
    if (!body.enabled) kickUser(id, '你的账号已被管理员禁用');
    return { ok: true };
  },
  'DELETE /api/admin/users/:id': async (req, id) => {
    requireAdmin(req);
    if (!db.getUser(id)) throw new HttpError(404, '账号不存在');
    kickUser(id, '你的账号已被管理员删除');
    db.deleteUser(id);
    return { ok: true };
  },
};

async function handleApi(req, res, url) {
  let key = `${req.method} ${url.pathname}`;
  let id = null;
  const m = url.pathname.match(/^\/api\/admin\/users\/(\d+)$/);
  if (m) {
    key = `${req.method} /api/admin/users/:id`;
    id = Number(m[1]);
  }
  const h = api[key];
  if (!h) return sendJSON(res, 404, { error: '接口不存在' });
  try {
    sendJSON(res, 200, await h(req, id));
  } catch (e) {
    if (!(e instanceof HttpError)) console.error('[api]', key, e);
    sendJSON(res, e.status || 500, { error: e instanceof HttpError ? e.message : '服务器错误' });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') return sendJSON(res, 200, { ok: true, rooms: rooms.size, uptime: process.uptime() | 0 });
  if (url.pathname === '/api/demo') {
    const size = [4, 6, 8].includes(Number(url.searchParams.get('size'))) ? Number(url.searchParams.get('size')) : 6;
    return sendJSON(res, 200, generateBoard(size));
  }
  if (url.pathname.startsWith('/api/')) return void handleApi(req, res, url);

  let p;
  try {
    p = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  if (p === '/admin' || p === '/admin/') p = '/admin.html';
  else if (p === '/' || !path.extname(p)) p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end();
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const ext = path.extname(file);
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    };
    if (ext === '.html') {
      headers['X-Frame-Options'] = 'DENY';
      headers['Referrer-Policy'] = 'same-origin';
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
});

// ======================= 在线连接 =======================
const userConns = new Map(); // userId -> Set<conn>
function trackConn(conn) {
  if (!conn.user) return;
  if (!userConns.has(conn.user.id)) userConns.set(conn.user.id, new Set());
  userConns.get(conn.user.id).add(conn);
}
function untrackConn(conn) {
  if (!conn.user) return;
  const set = userConns.get(conn.user.id);
  if (!set) return;
  set.delete(conn);
  if (!set.size) userConns.delete(conn.user.id);
}

// 禁用 / 删除账号：断开连接，大厅中移出，对局中交给电脑代管
function kickUser(userId, reason) {
  for (const room of rooms.values()) {
    const p = room.players.find((x) => x.userId === userId);
    if (!p) continue;
    if (!room.game) {
      room.players = room.players.filter((x) => x !== p);
      if (room.host === p.id) {
        const nh = room.players.find((x) => !x.isBot);
        room.host = nh ? nh.id : null;
      }
      systemChat(room, `${p.name} 已被移出房间`);
    } else if (room.game.phase !== 'ended') {
      p.autoBot = true;
      systemChat(room, `${p.name} 的账号已停用，由电脑接管`);
    }
    for (const c of p.conns) c.room = null;
    p.conns.clear();
    broadcast(room);
    scheduleBots(room);
  }
  const set = userConns.get(userId);
  if (set) {
    for (const c of [...set]) {
      c.send({ t: 'kicked', d: { reason } });
      c.close(4001);
    }
  }
  userConns.delete(userId);
}

// ======================= 房间 =======================
const rooms = new Map();
const rid = (n = 8) => crypto.randomBytes(n).toString('base64url');
function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let c = '';
    for (let i = 0; i < 5; i++) c += A[crypto.randomInt(A.length)];
    if (!rooms.has(c)) return c;
  }
}
const cleanName = (s, def = '玩家') => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20) || def;

// ---------- 持久化 ----------
const dirty = new Set();
const markDirty = (room) => dirty.add(room.code);

function roomToJSON(room) {
  return {
    v: 1,
    code: room.code,
    title: room.title,
    size: room.size,
    targetVP: room.targetVP,
    specialBuild: room.specialBuild,
    private: room.private,
    host: room.host,
    chat: room.chat.slice(-60),
    gameId: room.gameId,
    recorded: !!room.recorded,
    lastActive: room.lastActive,
    players: room.players.map((p) => ({ id: p.id, userId: p.userId, name: p.name, color: p.color, isBot: p.isBot, autoBot: p.autoBot })),
    game: room.game ? room.game.toJSON() : null,
  };
}

function roomFromJSON(d) {
  const now = Date.now();
  return {
    code: d.code,
    title: d.title,
    size: d.size,
    targetVP: d.targetVP,
    specialBuild: d.specialBuild,
    private: d.private,
    host: d.host,
    chat: d.chat || [],
    gameId: d.gameId,
    recorded: !!d.recorded,
    lastActive: now, // 重启后给 30 分钟的重连宽限
    players: d.players.map((p) => ({ ...p, conns: new Set(), lastSeen: now })),
    spectators: new Set(),
    game: d.game ? Game.fromJSON(d.game) : null,
    botTimer: null,
  };
}

function flushRooms() {
  for (const code of dirty) {
    const room = rooms.get(code);
    try {
      if (room) db.saveRoom(code, roomToJSON(room));
      else db.deleteRoom(code);
    } catch (e) {
      console.error('[db] 保存房间失败', code, e.message);
    }
  }
  dirty.clear();
}
setInterval(flushRooms, 1500).unref();

function removeRoom(room) {
  clearTimeout(room.botTimer);
  rooms.delete(room.code);
  dirty.delete(room.code);
  db.deleteRoom(room.code);
}

function restoreRooms() {
  let n = 0;
  for (const d of db.loadRooms()) {
    try {
      const room = roomFromJSON(d);
      rooms.set(room.code, room);
      n++;
    } catch (e) {
      console.error('[db] 恢复房间失败', d && d.code, e.message);
      if (d && d.code) db.deleteRoom(d.code);
    }
  }
  for (const room of rooms.values()) scheduleBots(room, 3000);
  if (n) console.log(`已恢复 ${n} 个房间`);
}

// ---------- 战绩 ----------
function recordIfEnded(room) {
  const g = room.game;
  if (!g || g.phase !== 'ended' || room.recorded) return;
  room.recorded = true;
  try {
    const ranked = g.players.slice().sort((a, b) => (b.id === g.winner) - (a.id === g.winner) || g.vp(b) - g.vp(a));
    const rankOf = new Map(ranked.map((p, i) => [p.id, i + 1]));
    const players = g.players.map((gp, seat) => {
      const rp = room.players.find((x) => x.id === gp.id) || {};
      return {
        seat,
        userId: rp.userId || null,
        name: rp.userId ? rp.name.replace(/\(电脑\)$/, '') : gp.name,
        color: gp.color,
        isBot: !rp.userId,
        vp: g.vp(gp),
        rank: rankOf.get(gp.id),
        isWinner: gp.id === g.winner,
        stats: { ...gp.stats, knights: gp.knights, roadLen: gp.roadLen },
      };
    });
    if (players.some((p) => p.userId)) {
      db.recordMatch({ roomCode: room.code, size: g.size, targetVP: g.targetVP, turns: g.turnCount, startedAt: g.startedAt, endedAt: g.endedAt || Date.now() }, players);
    }
  } catch (e) {
    console.error('[db] 记录战绩失败', e.message);
  }
}

// ---------- 广播 ----------
function roomInfo(room) {
  return {
    code: room.code,
    title: room.title,
    size: room.size,
    targetVP: room.targetVP,
    specialBuild: room.specialBuild,
    host: room.host,
    max: LAYOUTS[room.size].maxPlayers,
    started: !!room.game,
    gameId: room.gameId,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      isBot: p.isBot,
      autoBot: p.autoBot,
      connected: p.isBot || p.conns.size > 0,
    })),
    spectators: room.spectators.size,
  };
}

function sendRoom(room, conn, pid, events, forceFull) {
  const payload = { room: roomInfo(room), you: pid };
  if (room.game) {
    const full = forceFull || conn.boardFor !== room.gameId;
    conn.boardFor = room.gameId;
    payload.game = room.game.view(pid, full);
    if (events && events.length) {
      payload.events = events.map((e) => {
        if (!e.private || e.private.includes(pid)) return e;
        const copy = { ...e };
        delete copy.res;
        delete copy.card;
        return copy;
      });
    }
  }
  conn.send({ t: 'room', d: payload });
}

function broadcast(room, events = null) {
  room.lastActive = Date.now();
  recordIfEnded(room);
  markDirty(room);
  for (const p of room.players) for (const c of p.conns) sendRoom(room, c, p.id, events);
  for (const c of room.spectators) sendRoom(room, c, null, events);
}

function systemChat(room, text) {
  const msg = { id: rid(4), sys: true, text, t: Date.now() };
  room.chat.push(msg);
  if (room.chat.length > 100) room.chat.shift();
  markDirty(room);
  sendAll(room, { t: 'chat', d: msg });
}
function sendAll(room, msg) {
  for (const p of room.players) for (const c of p.conns) c.send(msg);
  for (const c of room.spectators) c.send(msg);
}

const controlledByBot = (p) => p.isBot || p.autoBot;

function scheduleBots(room, delay = BOT_DELAY) {
  if (!room.game || room.game.phase === 'ended' || room.botTimer) return;
  const g = room.game;
  const anyBot = room.players.some((p) => controlledByBot(p) && botAction(g, p.id));
  if (!anyBot) return;
  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    if (!room.game || room.game !== g || g.phase === 'ended' || !rooms.has(room.code)) return;
    for (const p of room.players) {
      if (!controlledByBot(p)) continue;
      const a = botAction(g, p.id);
      if (!a) continue;
      const r = g.act(p.id, a);
      if (!r.ok) {
        console.warn('[bot] 动作失败', a, r.error);
        const fallback = g.sub === 'special' ? 'endSpecial' : 'endTurn';
        const r2 = g.act(p.id, { type: fallback });
        broadcast(room, r2.events);
      } else broadcast(room, r.events);
      const slow = r.events && r.events.some((e) => e.type === 'roll' || e.type === 'robber' || e.type === 'turn');
      scheduleBots(room, slow ? BOT_DELAY * 1.6 : BOT_DELAY);
      return;
    }
  }, delay);
}

function checkAfk(room) {
  const now = Date.now();
  const host = room.players.find((p) => p.id === room.host);
  if (!host || (!host.conns.size && now - (host.lastSeen || now) > 15000)) {
    const nh = room.players.find((p) => !p.isBot && p.conns.size);
    if (nh && nh.id !== room.host) {
      room.host = nh.id;
      systemChat(room, `${nh.name} 成为新房主`);
      broadcast(room);
    }
  }
  if (!room.game) {
    const before = room.players.length;
    room.players = room.players.filter((p) => p.isBot || p.conns.size || now - (p.lastSeen || now) < 120000);
    if (room.players.length !== before) broadcast(room);
    return;
  }
  if (room.game.phase === 'ended') return;
  let changed = false;
  for (const p of room.players) {
    if (p.isBot || p.autoBot || p.conns.size) continue;
    if (now - (p.lastSeen || 0) > AFK_TAKEOVER_MS) {
      p.autoBot = true;
      changed = true;
      systemChat(room, `${p.name} 已离线，暂由电脑代管。重新连接后自动恢复。`);
    }
  }
  if (changed) {
    broadcast(room);
    scheduleBots(room);
  }
}

function leaveRoom(conn) {
  const room = conn.room && rooms.get(conn.room);
  conn.room = null;
  if (!room) return;
  room.spectators.delete(conn);
  const p = room.players.find((x) => x.conns.has(conn));
  if (p) {
    p.conns.delete(conn);
    p.lastSeen = Date.now();
    if (conn.explicitLeave) {
      if (!room.game) {
        room.players = room.players.filter((x) => x !== p);
        systemChat(room, `${p.name} 离开了房间`);
      } else if (room.game.phase !== 'ended') {
        p.isBot = true;
        p.name = p.name + '(电脑)';
        systemChat(room, `${p.name.replace('(电脑)', '')} 退出了游戏，由电脑接管`);
      }
      if (room.host === p.id) {
        const nh = room.players.find((x) => !x.isBot);
        room.host = nh ? nh.id : null;
      }
    }
  }
  if (!room.players.some((x) => !x.isBot) && room.spectators.size === 0 && !room.game) return removeRoom(room);
  broadcast(room);
  scheduleBots(room);
}

setInterval(() => {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    checkAfk(room);
    const online = room.players.some((p) => !p.isBot && p.conns.size) || room.spectators.size;
    if (!online && now - room.lastActive > 30 * 60 * 1000) removeRoom(room);
  }
}, 10000).unref();

// ======================= WebSocket 消息 =======================
const handlers = {
  hello(conn, d) {
    const s = db.checkSession(d.session, 'user');
    if (!s) {
      if (conn.user) {
        leaveRoom(conn);
        untrackConn(conn);
        conn.user = null;
      }
      return conn.send({ t: 'auth', d: { ok: false } });
    }
    if (conn.user && conn.user.id !== s.user.id) {
      leaveRoom(conn);
      untrackConn(conn);
    }
    conn.user = s.user;
    trackConn(conn);
    conn.send({ t: 'hello', d: { user: s.user } });
  },

  list(conn) {
    const list = [...rooms.values()]
      .filter((r) => !r.private)
      .map((r) => ({
        code: r.code,
        title: r.title,
        size: r.size,
        players: r.players.length,
        humans: r.players.filter((p) => !p.isBot).length,
        max: LAYOUTS[r.size].maxPlayers,
        started: !!r.game,
        ended: r.game ? r.game.phase === 'ended' : false,
        mine: r.players.some((p) => p.userId === conn.user.id),
      }))
      .sort((a, b) => b.mine - a.mine)
      .slice(0, 60);
    conn.send({ t: 'rooms', d: list });
  },

  create(conn, d) {
    if (rooms.size >= MAX_ROOMS) throw new Error('服务器房间已满，请稍后再试');
    const size = [4, 6, 8].includes(Number(d.size)) ? Number(d.size) : 4;
    if (conn.room) leaveRoom(conn);
    const code = newCode();
    const room = {
      code,
      title: cleanName(d.title, `${conn.user.username} 的房间`),
      size,
      targetVP: Math.max(5, Math.min(20, Number(d.targetVP) || (size === 8 ? 12 : 10))),
      specialBuild: d.specialBuild === undefined ? size > 4 : !!d.specialBuild,
      private: !!d.private,
      players: [],
      spectators: new Set(),
      game: null,
      gameId: null,
      chat: [],
      host: null,
      recorded: false,
      lastActive: Date.now(),
      botTimer: null,
    };
    rooms.set(code, room);
    handlers.join(conn, { code });
  },

  join(conn, d) {
    const code = String(d.code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) throw new Error('房间不存在');
    if (conn.room && conn.room !== code) leaveRoom(conn);
    room.spectators.delete(conn);
    conn.room = code;
    let p = room.players.find((x) => x.userId === conn.user.id && !x.isBot);
    if (p) {
      p.conns.add(conn);
      if (p.autoBot) {
        p.autoBot = false;
        systemChat(room, `${p.name} 回来了，恢复手动操作`);
      }
    } else if (!room.game && room.players.length < LAYOUTS[room.size].maxPlayers) {
      const used = new Set(room.players.map((x) => x.color));
      p = {
        id: rid(6),
        userId: conn.user.id,
        name: conn.user.username,
        color: COLORS.find((c) => !used.has(c)),
        isBot: false,
        autoBot: false,
        conns: new Set([conn]),
      };
      room.players.push(p);
      if (!room.host || !room.players.some((x) => x.id === room.host && !x.isBot)) room.host = p.id;
      systemChat(room, `${p.name} 加入了房间`);
    } else {
      room.spectators.add(conn);
      conn.send({ t: 'toast', d: { msg: room.game ? '游戏已开始，你正在观战' : '房间已满，你正在观战' } });
    }
    conn.send({ t: 'chatHistory', d: room.chat });
    conn.boardFor = null;
    broadcast(room);
    scheduleBots(room);
  },

  leave(conn) {
    conn.explicitLeave = true;
    leaveRoom(conn);
    conn.explicitLeave = false;
    conn.send({ t: 'left' });
  },

  settings(conn, d) {
    const { room } = ctx(conn, true);
    if (room.game) throw new Error('游戏已开始');
    if (d.size !== undefined && [4, 6, 8].includes(Number(d.size))) {
      const size = Number(d.size);
      if (room.players.length > LAYOUTS[size].maxPlayers) throw new Error(`当前人数超过 ${size} 人地图上限`);
      room.size = size;
    }
    if (d.targetVP !== undefined) room.targetVP = Math.max(5, Math.min(20, Number(d.targetVP) || 10));
    if (d.specialBuild !== undefined) room.specialBuild = !!d.specialBuild;
    if (d.title !== undefined) room.title = cleanName(d.title, room.title);
    broadcast(room);
  },

  addBot(conn) {
    const { room } = ctx(conn, true);
    if (room.game) throw new Error('游戏已开始');
    if (room.players.length >= LAYOUTS[room.size].maxPlayers) throw new Error('房间已满');
    const used = new Set(room.players.map((x) => x.color));
    const usedNames = new Set(room.players.map((x) => x.name));
    const name = '🤖 ' + (BOT_NAMES.find((n) => !usedNames.has('🤖 ' + n)) || 'Bot');
    room.players.push({ id: rid(6), userId: null, name, color: COLORS.find((c) => !used.has(c)), isBot: true, autoBot: false, conns: new Set() });
    broadcast(room);
  },

  kick(conn, d) {
    const { room } = ctx(conn, true);
    if (room.game) throw new Error('游戏已开始');
    const p = room.players.find((x) => x.id === d.pid);
    if (!p || p.id === room.host) return;
    room.players = room.players.filter((x) => x !== p);
    for (const c of p.conns) {
      c.room = null;
      c.send({ t: 'left', d: { kicked: true } });
    }
    systemChat(room, `${p.name} 被移出房间`);
    broadcast(room);
  },

  color(conn, d) {
    const { room, me } = ctx(conn);
    if (room.game || !me) throw new Error('现在不能更换颜色');
    if (!COLORS.includes(d.color)) throw new Error('无效颜色');
    if (room.players.some((x) => x !== me && x.color === d.color)) throw new Error('该颜色已被使用');
    me.color = d.color;
    broadcast(room);
  },

  start(conn) {
    const { room } = ctx(conn, true);
    if (room.game && room.game.phase !== 'ended') throw new Error('游戏已在进行中');
    const L = LAYOUTS[room.size];
    if (room.players.length < L.minPlayers) throw new Error(`至少需要 ${L.minPlayers} 名玩家（可添加电脑玩家）`);
    room.game = new Game({ size: room.size, targetVP: room.targetVP, specialBuild: room.specialBuild }, room.players.map((p) => ({ id: p.id, name: p.name, color: p.color })));
    room.gameId = rid(6);
    room.recorded = false;
    room.players.sort((a, b) => room.game.pIdx(a.id) - room.game.pIdx(b.id));
    systemChat(room, `游戏开始！`);
    broadcast(room, [{ type: 'start' }]);
    scheduleBots(room, 1800);
  },

  backToLobby(conn) {
    const { room } = ctx(conn, true);
    if (!room.game || room.game.phase !== 'ended') throw new Error('游戏尚未结束');
    clearTimeout(room.botTimer);
    room.botTimer = null;
    room.game = null;
    room.gameId = null;
    room.recorded = false;
    room.players = room.players.filter((p) => (p.isBot ? !p.userId : true));
    for (const p of room.players) p.autoBot = false;
    for (const c of [...room.spectators]) {
      if (room.players.length >= LAYOUTS[room.size].maxPlayers) break;
      room.spectators.delete(c);
      c.room = null;
      handlers.join(c, { code: room.code });
    }
    broadcast(room);
  },

  takeover(conn, d) {
    const { room } = ctx(conn, true);
    const p = room.players.find((x) => x.id === d.pid);
    if (!p || p.isBot) return;
    if (p.conns.size) throw new Error('该玩家在线');
    p.autoBot = !p.autoBot;
    systemChat(room, p.autoBot ? `房主让电脑代管 ${p.name}` : `取消代管 ${p.name}`);
    broadcast(room);
    scheduleBots(room);
  },

  act(conn, d) {
    const { room, me } = ctx(conn);
    if (!room.game) throw new Error('游戏未开始');
    if (!me) throw new Error('观战者不能操作');
    const r = room.game.act(me.id, d || {});
    if (!r.ok) throw new Error(r.error);
    broadcast(room, r.events);
    scheduleBots(room, r.events.some((e) => e.type === 'roll') ? BOT_DELAY * 1.6 : BOT_DELAY);
  },

  chat(conn, d) {
    const { room, me } = ctx(conn);
    const now = Date.now();
    conn.chatTimes = (conn.chatTimes || []).filter((t) => now - t < 10000);
    if (conn.chatTimes.length >= 8) throw new Error('发言太快了');
    conn.chatTimes.push(now);
    const text = String(d.text || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 200);
    if (!text) return;
    const msg = { id: rid(4), pid: me ? me.id : null, name: me ? me.name : conn.user.username, color: me ? me.color : '#999', text, t: now, emote: !!d.emote };
    room.chat.push(msg);
    if (room.chat.length > 100) room.chat.shift();
    markDirty(room);
    sendAll(room, { t: 'chat', d: msg });
  },
};

function ctx(conn, hostOnly = false) {
  const room = conn.room && rooms.get(conn.room);
  if (!room) throw new Error('你不在房间中');
  const me = room.players.find((p) => p.conns.has(conn)) || null;
  if (hostOnly && (!me || me.id !== room.host)) throw new Error('只有房主可以执行此操作');
  return { room, me };
}

attachWS(server, '/ws', (conn) => {
  conn.msgTimes = [];
  conn.on('message', (raw) => {
    const now = Date.now();
    conn.msgTimes = conn.msgTimes.filter((t) => now - t < 1000);
    if (conn.msgTimes.length > 30) return;
    conn.msgTimes.push(now);
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (!m || typeof m.t !== 'string') return;
    const h = handlers[m.t];
    if (!h) return;
    if (m.t !== 'hello' && !conn.user) return conn.send({ t: 'auth', d: { ok: false } });
    try {
      h(conn, m.d || {});
    } catch (err) {
      conn.send({ t: 'error', d: { msg: err.message } });
    }
  });
  conn.on('close', () => {
    if (shuttingDown) return;
    leaveRoom(conn);
    untrackConn(conn);
  });
});

let shuttingDown = false;
restoreRooms();
server.listen(PORT, HOST, () => {
  console.log(`🏝️  卡坦岛服务器已启动: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('正在保存对局并关闭服务器…');
  for (const room of rooms.values()) {
    clearTimeout(room.botTimer);
    markDirty(room);
  }
  flushRooms();
  db.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { server, rooms };
