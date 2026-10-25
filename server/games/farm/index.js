'use strict';
// 青野牧歌游戏模块：农场的加载与存档、实时同步、邀请、聊天。
// 由平台（server/index.js）加载，平台负责登录鉴权、WebSocket 连接与在线状态。
// 农场是长期存档：有人在线时才加载到内存、时钟才走；没人在线一段时间后存回数据库并卸载。
const crypto = require('crypto');
const { FarmWorld } = require('./world');
const data = require('./data');

const TICK_MS = 100;
const MAX_FARMS_LOADED = Number(process.env.MAX_ROOMS) || 200;
const MAX_MEMBERS = 8;
const MAX_OWNED = 5;
const SAVE_EVERY_MS = 10000;
const UNLOAD_AFTER_MS = 90000;
// 仅用于测试：加速时钟（例如 FARM_SPEED=50）
const SPEED = Math.max(0.1, Math.min(500, Number(process.env.FARM_SPEED) || 1));

const COLORS = ['#e8604c', '#3f8fd8', '#f2c14e', '#7bc67b', '#b07ad8', '#f08ab0', '#4fc0c0', '#e89a4c'];

module.exports = function createFarm(platform) {
  const { db, userConns, requireUser } = platform;
  const farms = new Map(); // code -> { code, world, ownerId, public, conns: Map<uid, Set<conn>>, chat, sentMeta, lastActive, emptySince, lastSave }
  const rid = (n = 6) => crypto.randomBytes(n).toString('base64url');
  const cleanName = (s, def) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20) || def;

  function newCode() {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (;;) {
      let c = '';
      for (let i = 0; i < 5; i++) c += A[crypto.randomInt(A.length)];
      if (!farms.has(c) && !db.getFarm(c)) return c;
    }
  }

  // ======================= 存档 =======================
  function save(farm) {
    const w = farm.world;
    try {
      db.saveFarm({ code: farm.code, name: w.name, ownerId: farm.ownerId, public: farm.public, data: w.toJSON(), earned: w.stats.earned, days: w.stats.days, createdAt: w.createdAt });
      w.dirty = false;
      farm.lastSave = Date.now();
    } catch (e) {
      console.error('[db] 青野牧歌保存农场失败', farm.code, e.message);
    }
  }

  function load(code) {
    let farm = farms.get(code);
    if (farm) return farm;
    const row = db.getFarm(code);
    if (!row) return null;
    if (farms.size >= MAX_FARMS_LOADED) throw new Error('服务器太忙了，请稍后再试');
    let world;
    try {
      world = FarmWorld.fromJSON(JSON.parse(row.data));
    } catch (e) {
      console.error('[db] 青野牧歌读取农场失败', code, e.message);
      throw new Error('农场存档损坏了');
    }
    farm = { code, world, ownerId: row.owner_id, public: !!row.public, conns: new Map(), chat: [], sentMeta: 0, lastActive: Date.now(), emptySince: Date.now(), lastSave: Date.now() };
    farms.set(code, farm);
    return farm;
  }

  function unload(farm) {
    save(farm);
    farms.delete(farm.code);
  }

  // ======================= 广播 =======================
  function eachConn(farm, fn) {
    for (const set of farm.conns.values()) for (const c of set) fn(c);
  }
  const sendAll = (farm, msg) => eachConn(farm, (c) => c.send(msg));
  function sendUser(farm, uid, msg) {
    const set = farm.conns.get(String(uid));
    if (set) for (const c of set) c.send(msg);
  }

  function pushChat(farm, msg) {
    farm.chat.push(msg);
    if (farm.chat.length > 80) farm.chat.shift();
    sendAll(farm, { t: 'chat', d: msg });
  }
  const systemChat = (farm, text) => pushChat(farm, { id: rid(4), sys: true, text, t: Date.now() });

  function farmInfo(farm) {
    return { code: farm.code, owner: farm.ownerId, public: farm.public, max: MAX_MEMBERS };
  }

  // 新的一天：写进聊天记录
  function narrate(farm, events) {
    const w = farm.world;
    const nameOf = (pid) => (w.members[pid] || {}).name || '?';
    for (const e of events) {
      if (e.type === 'day') {
        const r = e.report;
        const S = data.SEASONS[r.season].name;
        let s = `第 ${r.year} 年 ${S} ${r.day} 日。`;
        if (r.total) s += `昨天出货收入 ${r.total} 金。`;
        if (r.newSeason) s += `${S}天来了！`;
        if (e.passedOut.length) s += `${e.passedOut.join('、')} 累倒了，被扶回了家。`;
        if (r.hungry.length) s += `${r.hungry.join('、')} 饿了一天，记得备干草。`;
        systemChat(farm, s);
      } else if (e.type === 'build') systemChat(farm, `${nameOf(e.pid)} 订了${data.BUILDINGS[e.id].name}，明早完工`);
      else if (e.type === 'animalNew') systemChat(farm, `${nameOf(e.pid)} 带回一只${data.ANIMALS[e.kind].name}「${e.name}」`);
      else if (e.type === 'bundle') {
        const b = data.BUNDLES.find((x) => x.id === e.bundle);
        systemChat(farm, `${nameOf(e.pid)} 交齐了「${b.name}」，一根古代石柱亮了起来`);
        if (e.awake) systemChat(farm, '古代祭坛完全苏醒了！所有人体力上限提高。');
      } else if (e.type === 'fishEnd' && e.why === 'catch' && data.FISH[e.fish] && data.FISH[e.fish].diff >= 4) systemChat(farm, `${nameOf(e.pid)} 钓到了稀有的${data.ITEMS[e.fish].name}！`);
    }
  }

  function tickFarm(farm, dt) {
    const w = farm.world;
    let events = w.step(dt);
    if (!farm.conns.size) return;
    narrate(farm, events);
    const msg = { p: w.playersView(), a: w.animalsView() };
    const ch = w.flushChanges();
    if (ch) msg.ch = ch;
    if (events.length) msg.ev = events;
    if (w.metaVer !== farm.sentMeta) {
      farm.sentMeta = w.metaVer;
      msg.meta = w.metaView();
    }
    sendAll(farm, { t: 'tick', d: msg });
    for (const uid of w.meDirty) if (w.members[uid]) sendUser(farm, uid, { t: 'me', d: w.meView(uid) });
    w.meDirty.clear();
    if (events.some((e) => e.type === 'day')) save(farm);
  }

  let lastTick = Date.now();
  const loop = setInterval(() => {
    const now = Date.now();
    const dt = Math.min(0.5, (now - lastTick) / 1000) * SPEED;
    lastTick = now;
    for (const farm of farms.values()) {
      try {
        tickFarm(farm, dt);
      } catch (e) {
        console.error('[farm] 农场循环出错', farm.code, e);
      }
    }
  }, TICK_MS);
  loop.unref();

  // 定时存档、卸载没人的农场
  const saver = setInterval(() => {
    const now = Date.now();
    for (const farm of [...farms.values()]) {
      if (farm.conns.size) farm.emptySince = now;
      if (farm.world.dirty && now - farm.lastSave > SAVE_EVERY_MS) save(farm);
      if (!farm.conns.size && now - farm.emptySince > UNLOAD_AFTER_MS) unload(farm);
    }
  }, 2000);
  saver.unref();

  // ======================= 进出农场 =======================
  function leaveFarm(conn) {
    const farm = conn.farm && farms.get(conn.farm);
    conn.farm = null;
    if (!farm || !conn.user) return;
    const k = String(conn.user.id);
    const set = farm.conns.get(k);
    if (!set) return;
    set.delete(conn);
    if (!set.size) {
      farm.conns.delete(k);
      farm.world.leave(k);
      const m = farm.world.members[k];
      if (m) systemChat(farm, `${m.name} 回去休息了`);
      if (!farm.conns.size) {
        farm.emptySince = Date.now();
        save(farm);
      }
    }
  }

  function enter(conn, farm) {
    const w = farm.world;
    const uid = conn.user.id;
    const k = String(uid);
    if (conn.farm && conn.farm !== farm.code) leaveFarm(conn);
    if (!w.members[k]) {
      if (Object.keys(w.members).length >= MAX_MEMBERS) throw new Error(`农场最多 ${MAX_MEMBERS} 位成员`);
      const used = new Set(Object.values(w.members).map((m) => m.color));
      w.addMember(k, conn.user.username, COLORS.find((c) => !used.has(c)) || COLORS[0]);
      systemChat(farm, `欢迎新伙伴 ${conn.user.username} 加入农场！`);
    } else w.members[k].name = conn.user.username;
    db.addFarmMember(farm.code, uid);
    const first = !farm.conns.has(k);
    if (first) farm.conns.set(k, new Set());
    farm.conns.get(k).add(conn);
    conn.farm = farm.code;
    if (first) {
      w.join(k);
      systemChat(farm, `${conn.user.username} 来到了农场`);
    }
    farm.lastActive = Date.now();
    conn.send({ t: 'init', d: { farm: farmInfo(farm), you: k, world: w.fullView(), me: w.meView(k), chat: farm.chat } });
    w.bumpMeta();
  }

  function ctx(conn) {
    const farm = conn.farm && farms.get(conn.farm);
    if (!farm) throw new Error('你不在农场里');
    return farm;
  }

  // ======================= WebSocket 消息 =======================
  const handlers = {
    online(conn) {
      const farm = conn.farm && farms.get(conn.farm);
      const inFarm = new Set(farm ? [...farm.conns.keys()].map(Number) : []);
      const out = [];
      for (const [uid, set] of userConns) {
        if (uid === conn.user.id || inFarm.has(uid)) continue;
        const username = [...set][0].user.username;
        const cool = farm && farm.invited && farm.invited.get(uid);
        out.push({ id: uid, username, status: platform.presence ? platform.presence(uid) : 'idle', invited: !!(cool && Date.now() - cool < 30000) });
      }
      const order = { idle: 0, room: 1, playing: 2 };
      out.sort((a, b) => order[a.status] - order[b.status] || a.username.localeCompare(b.username, 'zh'));
      conn.send({ t: 'online', d: out });
    },

    invite(conn, d) {
      const farm = ctx(conn);
      const uid = Number(d.userId);
      const targets = userConns.get(uid);
      if (!targets || !targets.size) throw new Error('对方已离线');
      if (farm.conns.has(String(uid))) throw new Error('对方已在农场里');
      farm.invited = farm.invited || new Map();
      const last = farm.invited.get(uid);
      if (last && Date.now() - last < 30000) throw new Error('刚刚邀请过，请稍等再试');
      farm.invited.set(uid, Date.now());
      const w = farm.world;
      const msg = {
        t: 'invite',
        d: { id: rid(4), game: 'farm', gameName: '青野牧歌', path: '/farm/', from: conn.user.username, fromUser: conn.user.id, code: farm.code, title: w.name, detail: `第 ${w.year} 年${data.SEASONS[w.season].name} ${w.day} 日`, players: farm.conns.size, max: MAX_MEMBERS },
      };
      for (const c of targets) c.send(msg);
      conn.send({ t: 'toast', d: { msg: `已邀请 ${[...targets][0].user.username}` } });
    },

    inviteReply(conn, d) {
      if (d.accept) return;
      const set = userConns.get(Number(d.fromUser));
      if (!set) return;
      for (const c of set) if (c.farm === String(d.code || '') && c.game && c.game.id === 'farm') c.send({ t: 'toast', d: { msg: `${conn.user.username} 暂时不能来` } });
    },

    list(conn) {
      const mine = db.farmsOfUser(conn.user.id).map((r) => {
        const f = farms.get(r.code);
        return { code: r.code, name: r.name, owner: r.owner, ownerId: r.owner_id, members: r.members, earned: r.earned, days: r.day_count, public: !!r.public, online: f ? f.conns.size : 0, lastAt: r.last_at };
      });
      const mineSet = new Set(mine.map((f) => f.code));
      const open = [...farms.values()]
        .filter((f) => f.public && f.conns.size && !mineSet.has(f.code))
        .map((f) => ({ code: f.code, name: f.world.name, online: f.conns.size, members: Object.keys(f.world.members).length, days: f.world.stats.days, earned: f.world.stats.earned }))
        .slice(0, 30);
      conn.send({ t: 'farms', d: { mine, open, max: MAX_MEMBERS } });
    },

    create(conn, d) {
      const owned = db.farmsOfUser(conn.user.id).filter((f) => f.owner_id === conn.user.id).length;
      if (owned >= MAX_OWNED) throw new Error(`每人最多开 ${MAX_OWNED} 座农场`);
      if (farms.size >= MAX_FARMS_LOADED) throw new Error('服务器太忙了，请稍后再试');
      const code = newCode();
      const world = new FarmWorld({ name: cleanName(d.name, `${conn.user.username}的农场`) });
      const farm = { code, world, ownerId: conn.user.id, public: !!d.public, conns: new Map(), chat: [], sentMeta: 0, lastActive: Date.now(), emptySince: Date.now(), lastSave: 0 };
      farms.set(code, farm);
      world.addMember(String(conn.user.id), conn.user.username, COLORS[0]);
      save(farm);
      db.addFarmMember(code, conn.user.id);
      systemChat(farm, `${world.name} 开张了！春天的第一天，先把屋前的空地翻一翻吧。`);
      enter(conn, farm);
    },

    join(conn, d) {
      const code = String(d.code || '').toUpperCase().trim();
      const farm = load(code);
      if (!farm) throw new Error('农场不存在');
      enter(conn, farm);
    },

    leave(conn) {
      leaveFarm(conn);
      conn.send({ t: 'left' });
    },

    // 从「我的农场」列表里移除（不是农场主）；农场主可以删除整座农场
    forget(conn, d) {
      const code = String(d.code || '');
      const row = db.getFarm(code);
      if (!row) throw new Error('农场不存在');
      if (row.owner_id === conn.user.id) {
        const f = farms.get(code);
        if (f) {
          eachConn(f, (c) => {
            c.farm = null;
            c.send({ t: 'left', d: { deleted: true } });
          });
          farms.delete(code);
        }
        db.deleteFarm(code);
      } else db.removeFarmMember(code, conn.user.id);
      handlers.list(conn);
    },

    settings(conn, d) {
      const farm = ctx(conn);
      if (farm.ownerId !== conn.user.id) throw new Error('只有农场主可以修改');
      if (d.name !== undefined) farm.world.name = cleanName(d.name, farm.world.name);
      if (d.public !== undefined) farm.public = !!d.public;
      farm.world.bumpMeta();
      sendAll(farm, { t: 'farm', d: farmInfo(farm) });
      save(farm);
    },

    mv(conn, d) {
      const farm = ctx(conn);
      const r = farm.world.move(conn.user.id, d || {});
      if (r.corr) conn.send({ t: 'corr', d: r.corr });
    },

    act(conn, d) {
      const farm = ctx(conn);
      farm.lastActive = Date.now();
      const r = farm.world.act(conn.user.id, d || {});
      conn.send({ t: 'ack', d: { seq: d.seq, ok: r.ok, error: r.error, msg: r.msg, fish: r.fish, diff: r.diff } });
    },

    chat(conn, d) {
      const farm = ctx(conn);
      const now = Date.now();
      conn.chatTimes = (conn.chatTimes || []).filter((t) => now - t < 10000);
      if (conn.chatTimes.length >= 8) throw new Error('发言太快了');
      conn.chatTimes.push(now);
      const text = String(d.text || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 200);
      if (!text) return;
      const m = farm.world.members[String(conn.user.id)];
      pushChat(farm, { id: rid(4), pid: String(conn.user.id), name: conn.user.username, color: m ? m.color : '#999', text, t: now });
    },

    emote(conn, d) {
      const farm = ctx(conn);
      const e = String(d.e || '').slice(0, 4);
      if (!['❤', '👋', '😆', '❗', '❓', '🎵', '😴', '👍'].includes(e)) return;
      sendAll(farm, { t: 'emote', d: { pid: String(conn.user.id), e } });
    },
  };

  // ======================= 对平台的接口 =======================
  function kickUser(userId) {
    for (const farm of farms.values()) {
      const set = farm.conns.get(String(userId));
      if (!set) continue;
      for (const c of [...set]) leaveFarm(c);
    }
  }

  function presence(userId) {
    for (const f of farms.values()) if (f.conns.has(String(userId))) return 'playing';
    return null;
  }

  function summary(userId) {
    let playing = 0;
    let open = 0;
    let mine = null;
    for (const f of farms.values()) {
      playing += f.conns.size;
      if (f.public && f.conns.size) open++;
      if (userId && f.conns.has(String(userId))) mine = f.code;
    }
    let mineText = null;
    if (userId) {
      const s = db.farmUserStats(userId);
      mineText = s.farms ? `你有 ${s.farms} 座农场，累计出货 ${s.earned} 金` : '你还没有农场';
    }
    return { rooms: farms.size, open, playing, myRoom: mine, stats: null, mineText, openLabel: '座农场正在营业' };
  }

  function shutdown() {
    clearInterval(loop);
    clearInterval(saver);
    for (const farm of farms.values()) save(farm);
  }

  const routes = {
    'GET /api/farm/config': async () => data.publicConfig(),
    'GET /api/farm/me': async (req) => {
      const user = requireUser(req);
      return { user, farms: db.farmsOfUser(user.id), stats: db.farmUserStats(user.id) };
    },
    'GET /api/farm/leaderboard': async (req) => {
      requireUser(req);
      return { rows: db.farmLeaderboard(30).map((r) => ({ ...r, code: r.public ? r.code : null })) };
    },
  };

  return {
    id: 'farm',
    handlers,
    routes,
    onConnect() {},
    onClose: leaveFarm,
    kickUser,
    summary,
    presence,
    shutdown,
    rateKey: (t) => t === 'mv',
    rooms: farms,
  };
};
