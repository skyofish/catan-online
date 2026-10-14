'use strict';
// 卡坦岛联机服务器：静态文件 + WebSocket 房间管理。零第三方依赖。
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { attachWS } = require('./ws');
const { Game } = require('./game');
const { LAYOUTS, generateBoard } = require('./board');
const { botAction } = require('./bot');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, '..', 'public');
const BOT_DELAY = Number(process.env.BOT_DELAY_MS) || 900;
const AFK_TAKEOVER_MS = Number(process.env.AFK_TAKEOVER_MS) || 60000;
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 200;

const COLORS = ['#e53935', '#1e88e5', '#fb8c00', '#f5f5f5', '#43a047', '#8e24aa', '#6d4c41', '#00acc1'];
const BOT_NAMES = ['阿尔法', '贝塔', '伽马', '德尔塔', '艾普西隆', '泽塔', '伊塔', '西塔', '卡帕', '拉姆达'];

// ---------------- 静态文件 ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size, uptime: process.uptime() | 0 }));
  }
  if (url.pathname === '/api/demo') {
    const size = [4, 6, 8].includes(Number(url.searchParams.get('size'))) ? Number(url.searchParams.get('size')) : 6;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(generateBoard(size)));
  }
  let p;
  try {
    p = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  if (p === '/' || !path.extname(p)) p = '/index.html';
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
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
});

// ---------------- 房间 ----------------
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
const cleanName = (s, def = '玩家') => (String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16) || def);

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
  for (const p of room.players) for (const c of p.conns) sendRoom(room, c, p.id, events);
  for (const c of room.spectators) sendRoom(room, c, null, events);
}

function systemChat(room, text) {
  const msg = { id: rid(4), sys: true, text, t: Date.now() };
  room.chat.push(msg);
  if (room.chat.length > 100) room.chat.shift();
  sendAll(room, { t: 'chat', d: msg });
}
function sendAll(room, msg) {
  for (const p of room.players) for (const c of p.conns) c.send(msg);
  for (const c of room.spectators) c.send(msg);
}

function controlledByBot(p) {
  return p.isBot || p.autoBot;
}

function scheduleBots(room, delay = BOT_DELAY) {
  if (!room.game || room.game.phase === 'ended' || room.botTimer) return;
  const g = room.game;
  const anyBot = room.players.some((p) => controlledByBot(p) && botAction(g, p.id));
  if (!anyBot) return;
  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    if (!room.game || room.game !== g || g.phase === 'ended') return;
    for (const p of room.players) {
      if (!controlledByBot(p)) continue;
      const a = botAction(g, p.id);
      if (!a) continue;
      const r = g.act(p.id, a);
      if (!r.ok) {
        console.warn('[bot] 动作失败', a, r.error);
        // 兜底：结束回合避免卡死
        const fallback = g.sub === 'special' ? 'endSpecial' : 'endTurn';
        const r2 = g.act(p.id, { type: fallback });
        broadcast(room, r2.events);
      } else broadcast(room, r.events);
      const rolled = r.events && r.events.some((e) => e.type === 'roll' || e.type === 'robber' || e.type === 'turn');
      scheduleBots(room, rolled ? BOT_DELAY * 1.6 : BOT_DELAY);
      return;
    }
  }, delay);
}

function checkAfk(room) {
  const now = Date.now();
  // 房主离线则移交
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
    // 大厅：长时间离线的玩家移出
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
        p.token = null;
        systemChat(room, `${p.name.replace('(电脑)', '')} 退出了游戏，由电脑接管`);
      }
      if (room.host === p.id) {
        const nh = room.players.find((x) => !x.isBot);
        room.host = nh ? nh.id : null;
      }
    }
  }
  if (!room.players.some((x) => !x.isBot) && room.spectators.size === 0 && !room.game) {
    clearTimeout(room.botTimer);
    rooms.delete(room.code);
    return;
  }
  broadcast(room);
  scheduleBots(room);
}

// 清理长时间无人的房间
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    checkAfk(room);
    const online = room.players.some((p) => !p.isBot && p.conns.size) || room.spectators.size;
    if (!online && now - room.lastActive > 30 * 60 * 1000) {
      clearTimeout(room.botTimer);
      rooms.delete(room.code);
    }
  }
}, 10000).unref();

// ---------------- 消息处理 ----------------
const handlers = {
  hello(conn, d) {
    conn.token = typeof d.token === 'string' && d.token.length >= 16 && d.token.length <= 64 ? d.token : rid(16);
    conn.send({ t: 'hello', d: { token: conn.token } });
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
      }))
      .slice(0, 60);
    conn.send({ t: 'rooms', d: list });
  },

  create(conn, d) {
    if (rooms.size >= MAX_ROOMS) throw new Error('服务器房间已满，请稍后再试');
    const size = [4, 6, 8].includes(Number(d.size)) ? Number(d.size) : 4;
    if (conn.room) leaveRoom(conn);
    const code = newCode();
    const name = cleanName(d.name);
    const room = {
      code,
      title: cleanName(d.title, `${name} 的房间`).slice(0, 20),
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
      lastActive: Date.now(),
      botTimer: null,
    };
    rooms.set(code, room);
    handlers.join(conn, { code, name });
  },

  join(conn, d) {
    const code = String(d.code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) throw new Error('房间不存在');
    if (conn.room && conn.room !== code) leaveRoom(conn);
    conn.room = code;
    let p = room.players.find((x) => x.token && x.token === conn.token);
    if (p) {
      p.conns.add(conn);
      if (p.autoBot) {
        p.autoBot = false;
        systemChat(room, `${p.name} 回来了，恢复手动操作`);
      }
      if (d.name && !room.game) p.name = cleanName(d.name);
    } else if (!room.game && room.players.length < LAYOUTS[room.size].maxPlayers) {
      const used = new Set(room.players.map((x) => x.color));
      p = {
        id: rid(6),
        token: conn.token,
        name: cleanName(d.name),
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
    const { room, me } = ctx(conn, true);
    if (room.game) throw new Error('游戏已开始');
    if (d.size !== undefined && [4, 6, 8].includes(Number(d.size))) {
      const size = Number(d.size);
      if (room.players.length > LAYOUTS[size].maxPlayers) throw new Error(`当前人数超过 ${size} 人地图上限`);
      room.size = size;
    }
    if (d.targetVP !== undefined) room.targetVP = Math.max(5, Math.min(20, Number(d.targetVP) || 10));
    if (d.specialBuild !== undefined) room.specialBuild = !!d.specialBuild;
    if (d.title !== undefined) room.title = cleanName(d.title, room.title).slice(0, 20);
    broadcast(room);
    void me;
  },

  addBot(conn) {
    const { room } = ctx(conn, true);
    if (room.game) throw new Error('游戏已开始');
    if (room.players.length >= LAYOUTS[room.size].maxPlayers) throw new Error('房间已满');
    const used = new Set(room.players.map((x) => x.color));
    const usedNames = new Set(room.players.map((x) => x.name));
    const name = '🤖 ' + (BOT_NAMES.find((n) => !usedNames.has('🤖 ' + n)) || 'Bot');
    room.players.push({ id: rid(6), token: null, name, color: COLORS.find((c) => !used.has(c)), isBot: true, autoBot: false, conns: new Set() });
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

  rename(conn, d) {
    const { room, me } = ctx(conn);
    if (room.game || !me) throw new Error('现在不能改名');
    me.name = cleanName(d.name);
    broadcast(room);
  },

  start(conn) {
    const { room } = ctx(conn, true);
    if (room.game && room.game.phase !== 'ended') throw new Error('游戏已在进行中');
    const L = LAYOUTS[room.size];
    if (room.players.length < L.minPlayers) throw new Error(`至少需要 ${L.minPlayers} 名玩家（可添加电脑玩家）`);
    room.game = new Game({ size: room.size, targetVP: room.targetVP, specialBuild: room.specialBuild }, room.players.map((p) => ({ id: p.id, name: p.name, color: p.color })));
    room.gameId = rid(6);
    // 座位顺序与游戏一致
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
    room.players = room.players.filter((p) => p.isBot ? !/\(电脑\)$/.test(p.name) : true);
    for (const p of room.players) p.autoBot = false;
    // 观战者自动加入空位
    for (const c of [...room.spectators]) {
      if (room.players.length >= LAYOUTS[room.size].maxPlayers) break;
      room.spectators.delete(c);
      c.room = null;
      handlers.join(c, { code: room.code, name: c.lastName });
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
    const msg = { id: rid(4), pid: me ? me.id : null, name: me ? me.name : '观众', color: me ? me.color : '#999', text, t: now, emote: !!d.emote };
    room.chat.push(msg);
    if (room.chat.length > 100) room.chat.shift();
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
    if (conn.msgTimes.length > 30) return; // 简单限流
    conn.msgTimes.push(now);
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (!m || typeof m.t !== 'string') return;
    if (m.t !== 'hello' && !conn.token) return conn.send({ t: 'error', d: { msg: '请先握手' } });
    const h = handlers[m.t];
    if (!h) return;
    if (m.d && m.d.name) conn.lastName = m.d.name;
    try {
      h(conn, m.d || {});
    } catch (err) {
      conn.send({ t: 'error', d: { msg: err.message } });
    }
  });
  conn.on('close', () => leaveRoom(conn));
});

server.listen(PORT, HOST, () => {
  console.log(`🏝️  卡坦岛服务器已启动: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});

function shutdown() {
  console.log('正在关闭服务器…');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { server, rooms };
