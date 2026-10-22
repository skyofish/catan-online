'use strict';
// 游戏平台服务器：统一登录、管理员后台、在线状态、静态文件与 WebSocket 路由。
// 每个游戏是 server/games/<id>/ 下的一个模块，由这里加载。数据保存在 SQLite（Node 内置 node:sqlite），零第三方依赖。
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { attachWS } = require('./ws');
const db = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, '..', 'public');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'catan.db');
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const PLATFORM_NAME = (process.env.PLATFORM_NAME || '朋友游戏厅').trim();
const TRUST_PROXY = !!process.env.TRUST_PROXY;

db.open(DB_PATH);
if (!ADMIN_USERNAME || !ADMIN_PASSWORD) console.warn('⚠️  未设置 ADMIN_USERNAME / ADMIN_PASSWORD，管理员后台无法登录。');

// ======================= 基础工具 =======================
class HttpError extends Error {
  constructor(status, msg) {
    super(msg);
    this.status = status;
  }
}

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
function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return req.socket.remoteAddress || '?';
}
function rateLimit(req, key, max, windowMs) {
  const k = `${key}:${clientIp(req)}`;
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

// ======================= 在线连接 =======================
const userConns = new Map(); // userId -> Set<conn>（平台大厅与各游戏的连接都算在线）
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

// ======================= 游戏模块 =======================
const platform = { db, userConns, HttpError, requireUser };
const catan = require('./games/catan')(platform);
const dorm = require('./games/dorm')(platform);
const GAMES = { catan, dorm };

// 玩家当前状态（供各游戏的「邀请在线玩家」列表）：idle 空闲 / room 在某个游戏的房间里 / playing 对局中
platform.presence = (userId) => {
  let st = 'idle';
  for (const g of Object.values(GAMES)) {
    const s = g.presence ? g.presence(userId) : null;
    if (s === 'playing') return 'playing';
    if (s === 'room') st = 'room';
  }
  return st;
};

// 平台大厅展示的游戏目录（以后加新游戏：在 server/games/ 下加模块，并在这里登记）
const CATALOG = [
  {
    id: 'catan',
    name: '卡坦岛',
    path: '/catan/',
    tagline: '在小岛上开拓、交易、建造，率先拿到胜利分',
    players: '2–8 人',
    minutes: '约 60 分钟',
    features: ['4 / 6 / 8 人地图', '内置电脑与 AI 玩家', '房间语音'],
  },
  {
    id: 'dorm',
    name: '猛鬼宿舍',
    path: '/dorm/',
    tagline: '熄灯后猛鬼出没。躺平发育、造塔守门，活到天亮',
    players: '1–8 人',
    minutes: '约 10 分钟',
    features: ['合作塔防', '四种难度', '电脑与 AI 队友'],
  },
];

// 禁用 / 删除账号：各游戏先处理房间里的座位，再断开该用户的所有连接
function kickUser(userId, reason) {
  for (const g of Object.values(GAMES)) g.kickUser(userId);
  const set = userConns.get(userId);
  if (set) {
    for (const c of [...set]) {
      c.send({ t: 'kicked', d: { reason } });
      c.close(4001);
    }
  }
  userConns.delete(userId);
}

// ======================= HTTP API =======================
const api = {
  // ---------- 账号 ----------
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
  'GET /api/session': async (req) => ({ user: requireUser(req), platform: PLATFORM_NAME }),

  // ---------- 平台大厅 ----------
  'GET /api/games': async (req) => {
    const user = requireUser(req);
    return {
      platform: PLATFORM_NAME,
      online: userConns.size,
      games: CATALOG.map((g) => ({ ...g, live: GAMES[g.id] ? GAMES[g.id].summary(user.id) : null })),
    };
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
    return { users: db.listUsers().map((u) => ({ ...u, enabled: !!u.enabled, online: userConns.has(u.id) })), ai: catan.aiStats() };
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
    if (!db.getUser(id)) throw new HttpError(404, '账号不存在');
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
// 各游戏自己的接口（如 /api/catan/me）
for (const g of Object.values(GAMES)) Object.assign(api, g.routes);
// 旧地址兼容
api['GET /api/demo'] = catan.routes['GET /api/catan/demo'];

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
    sendJSON(res, 200, await h(req, id, url));
  } catch (e) {
    if (!(e instanceof HttpError)) console.error('[api]', key, e);
    sendJSON(res, e.status || 500, { error: e instanceof HttpError ? e.message : '服务器错误' });
  }
}

// ======================= 静态文件 =======================
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
const gzCache = new Map();
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function redirect(res, to, code = 302) {
  res.writeHead(code, { Location: to });
  res.end();
}

function serveFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const ext = path.extname(file);
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    };
    if (ext === '.html') {
      headers['X-Frame-Options'] = 'DENY';
      headers['Referrer-Policy'] = 'same-origin';
    }
    // 页面里的 {{PLATFORM_NAME}} 替换为平台名称
    let body = null;
    if (ext === '.html') body = Buffer.from(fs.readFileSync(file, 'utf8').replaceAll('{{PLATFORM_NAME}}', escHtml(PLATFORM_NAME)));
    // 文本类文件 gzip 压缩（按修改时间缓存）
    const gz = /gzip/.test(req.headers['accept-encoding'] || '') && /\.(js|css|html|svg|json)$/.test(ext) && st.size > 1024;
    if (gz) {
      const key = `${file}:${st.mtimeMs}`;
      let buf = gzCache.get(key);
      if (!buf) {
        try {
          buf = zlib.gzipSync(body || fs.readFileSync(file), { level: 6 });
          gzCache.set(key, buf);
        } catch {
          buf = null;
        }
      }
      if (buf) {
        headers['Content-Encoding'] = 'gzip';
        headers['Content-Length'] = buf.length;
        headers['Vary'] = 'Accept-Encoding';
        res.writeHead(200, headers);
        return res.end(req.method === 'HEAD' ? undefined : buf);
      }
    }
    if (body) {
      headers['Content-Length'] = body.length;
      res.writeHead(200, headers);
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') return sendJSON(res, 200, { ok: true, online: userConns.size, rooms: catan.rooms.size, dormRooms: dorm.rooms.size, uptime: process.uptime() | 0 });
  if (url.pathname.startsWith('/api/')) return void handleApi(req, res, url);

  let p;
  try {
    p = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  // 旧版邀请链接 /?room=XXXXX → 卡坦岛
  if (p === '/' && url.searchParams.get('room')) return redirect(res, `/catan/?room=${encodeURIComponent(url.searchParams.get('room'))}`);
  if (p === '/admin' || p === '/admin/') p = '/admin.html';
  else if (p === '/') p = '/index.html';
  else if (/^\/[a-z0-9-]+$/.test(p) && GAMES[p.slice(1)]) return redirect(res, `${p}/${url.search}`, 301);
  else if (!path.extname(p)) {
    // 游戏内的前端路由回到该游戏的页面
    const game = p.split('/')[1];
    p = GAMES[game] ? `/${game}/index.html` : '/index.html';
  }
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end();
  }
  serveFile(req, res, file);
});

// ======================= WebSocket =======================
// /hub/ws：平台大厅（在线状态、接收邀请）；/catan/ws：卡坦岛；/dorm/ws：猛鬼宿舍；/ws：旧版卡坦岛地址
const WS_ROUTES = { '/hub/ws': null, '/catan/ws': catan, '/dorm/ws': dorm, '/ws': catan };

const platformHandlers = {
  hello(conn, d) {
    const s = db.checkSession(d.session, 'user');
    if (!s) {
      if (conn.user) {
        if (conn.game) conn.game.onClose(conn);
        untrackConn(conn);
        conn.user = null;
      }
      return conn.send({ t: 'auth', d: { ok: false } });
    }
    if (conn.user && conn.user.id !== s.user.id) {
      if (conn.game) conn.game.onClose(conn);
      untrackConn(conn);
    }
    conn.user = s.user;
    trackConn(conn);
    conn.send({ t: 'hello', d: { user: s.user, platform: PLATFORM_NAME } });
  },
};

// 平台大厅可转发给游戏的消息（例如拒绝邀请）
const HUB_FORWARD = new Set(['inviteReply']);

attachWS(server, Object.keys(WS_ROUTES), (conn, req) => {
  const pathname = new URL(req.url, 'http://x').pathname;
  conn.game = WS_ROUTES[pathname] || null;
  conn.msgTimes = [];
  conn.rtcTimes = [];
  if (conn.game) conn.game.onConnect(conn);
  conn.on('message', (raw) => {
    const now = Date.now();
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (!m || typeof m.t !== 'string') return;
    // 限流：语音信令（ICE 候选会在建立连接时集中到达）单独计数
    const heavy = conn.game && conn.game.rateKey(m.t);
    const bucket = heavy ? 'rtcTimes' : 'msgTimes';
    const limit = heavy ? 300 : 30;
    conn[bucket] = conn[bucket].filter((t) => now - t < 1000);
    if (conn[bucket].length > limit) return;
    conn[bucket].push(now);

    let h = platformHandlers[m.t];
    let target = null;
    // 回复邀请：交给发出邀请的那个游戏（在任何页面都可能收到别的游戏的邀请）
    const fwd = HUB_FORWARD.has(m.t) && m.d && GAMES[m.d.game];
    if (!h && fwd) {
      target = fwd;
      h = target.handlers[m.t];
    } else if (!h && conn.game) {
      h = conn.game.handlers[m.t];
      target = conn.game;
    } else if (!h && HUB_FORWARD.has(m.t)) {
      target = GAMES.catan;
      h = target && target.handlers[m.t];
    }
    if (!h) return;
    if (m.t !== 'hello' && !conn.user) return conn.send({ t: 'auth', d: { ok: false } });
    try {
      h(conn, m.d || {});
    } catch (err) {
      conn.send({ t: 'error', d: { msg: err.message } });
    }
    void target;
  });
  conn.on('close', () => {
    if (shuttingDown) return;
    if (conn.game) conn.game.onClose(conn);
    untrackConn(conn);
  });
});

let shuttingDown = false;
server.listen(PORT, HOST, () => {
  console.log(`🎲 ${PLATFORM_NAME} 已启动: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('正在保存对局并关闭服务器…');
  for (const g of Object.values(GAMES)) g.shutdown();
  db.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { server, GAMES };
