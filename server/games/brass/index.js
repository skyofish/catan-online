'use strict';
// 工业革命：伯明翰 游戏模块：房间、对局持久化、电脑与 AI 玩家、房间语音、邀请、新手教程、战绩。
// 由平台（server/index.js）加载，平台负责登录鉴权、WebSocket 连接与在线状态。
const crypto = require('crypto');
const { BrassGame } = require('./game');
const { botAction } = require('./bot');
const ai = require('./ai');
const { RtcTokenBuilder, Role: AgoraRole } = require('../catan/vendor/agora/src/RtcTokenBuilder2');

const BOT_DELAY = Number(process.env.BRASS_BOT_DELAY_MS) || Number(process.env.BOT_DELAY_MS) || 1300;
const AFK_TAKEOVER_MS = Number(process.env.AFK_TAKEOVER_MS) || 60000;
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 200;
const TURN_HOST = process.env.TURN_HOST || '';
const TURN_PORT = Number(process.env.TURN_PORT) || 3478;
const TURN_SECRET = process.env.TURN_SECRET || '';
const AGORA_APP_ID = (process.env.AGORA_APP_ID || '').trim();
const AGORA_APP_CERTIFICATE = (process.env.AGORA_APP_CERTIFICATE || '').trim();
const STUN_URLS = (process.env.STUN_URLS || 'stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302').split(',').map((x) => x.trim()).filter(Boolean);

const HINT_LIMIT = Number(process.env.BRASS_HINT_LIMIT) || 10; // 每 10 秒最多几次提示
const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2;
// 维多利亚时代的配色：深红、普鲁士蓝、芥末黄、墨绿、紫、石板灰
const COLORS = ['#b8322a', '#2c5f8d', '#d29b1c', '#3b7a4a', '#7a4b8f', '#5b6770'];
const BOT_NAMES = ['老约翰', '汉娜', '威廉', '伊莱莎', '托马斯', '玛莎', '爱德华', '阿米莉亚'];
const AI_NAMES = ['小智', '小谱', '青言', '清影', '星火', '墨白'];
const LEVEL_TAG = { easy: '学徒', normal: '工头', hard: '大亨', ai: 'AI' };

// 新手教程的固定开局：你的手牌、导师的手牌、商人
const TUTORIAL = {
  deckTop: [
    'loc:birmingham', 'loc:coventry', 'ind:pottery', 'ind:brewery', 'loc:redditch', 'ind:iron', 'loc:dudley', 'ind:coal',
    'loc:coalbrookdale', 'loc:wolverhampton', 'loc:kidderminster', 'ind:iron', 'loc:worcester', 'ind:coal', 'loc:stafford', 'loc:cannock',
  ],
  merchants: { shrewsbury: ['blank'], gloucester: ['pottery', 'all'], oxford: ['cotton', 'goods'] },
  avoid: ['birmingham', 'oxford', 'coventry', 'redditch', 'nuneaton', 'walsall', 'tamworth'],
  avoidRounds: 4,
};

module.exports = function createBrass(platform) {
  const { db, userConns, requireUser } = platform;
  console.log(ai.enabled() ? '伯明翰 AI 玩家：智谱（与卡坦岛共用配置）' : '伯明翰 AI 玩家：未配置（只有内置电脑）');

  // ======================= 语音（与卡坦岛相同：声网或 WebRTC 点对点） =======================
  function iceServers(userId) {
    const list = [];
    if (TURN_HOST) list.push({ urls: [`stun:${TURN_HOST}:${TURN_PORT}`] });
    else if (STUN_URLS.length) list.push({ urls: STUN_URLS });
    if (TURN_HOST && TURN_SECRET) {
      const username = `${Math.floor(Date.now() / 1000) + 86400}:${userId}`;
      const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
      list.push({ urls: [`turn:${TURN_HOST}:${TURN_PORT}?transport=udp`, `turn:${TURN_HOST}:${TURN_PORT}?transport=tcp`], username, credential });
    }
    return list;
  }
  function agoraInfo(room, conn) {
    if (!AGORA_APP_ID) return null;
    const channel = `brass_${room.code}`;
    const token = AGORA_APP_CERTIFICATE ? RtcTokenBuilder.buildTokenWithUid(AGORA_APP_ID, AGORA_APP_CERTIFICATE, channel, conn.voiceUid, AgoraRole.PUBLISHER, 86400, 86400) : null;
    return { appId: AGORA_APP_ID, channel, token, uid: conn.voiceUid };
  }
  function voiceEntry(room, conn) {
    const p = room.players.find((x) => x.conns.has(conn));
    return { cid: conn.cid, uid: conn.voiceUid, pid: p ? p.id : null, name: p ? p.name : conn.user.username, color: p ? p.color : '#999', muted: conn.voiceMuted !== false };
  }
  function sendVoiceRoster(room, initiator = null) {
    if (!room.voice) return;
    const peers = [...room.voice].map((c) => voiceEntry(room, c));
    for (const c of room.voice) {
      c.send({
        t: 'voice',
        d: AGORA_APP_ID
          ? { self: c.cid, peers, agora: c === initiator ? agoraInfo(room, c) : undefined }
          : { self: c.cid, peers, initiate: c === initiator ? peers.filter((x) => x.cid !== c.cid).map((x) => x.cid) : [], ice: c === initiator ? iceServers(c.user.id) : undefined },
      });
    }
  }
  function voiceAdd(room, conn) {
    if (conn.voiceRoom === room.code) return sendVoiceRoster(room);
    voiceRemove(conn);
    room.voice = room.voice || new Set();
    room.voice.add(conn);
    conn.voiceRoom = room.code;
    conn.voiceMuted = true;
    sendVoiceRoster(room, conn);
  }
  function voiceRemove(conn) {
    const room = conn.voiceRoom && rooms.get(conn.voiceRoom);
    conn.voiceRoom = null;
    if (!room || !room.voice || !room.voice.delete(conn)) return;
    conn.send({ t: 'voice', d: { self: conn.cid, peers: [], initiate: [] } });
    sendVoiceRoster(room);
  }
  function detach(conn) {
    voiceRemove(conn);
    conn.room = null;
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
  const dbKey = (code) => `brass:${code}`;

  // ---------- 持久化（与卡坦岛共用 rooms 表，键名加前缀） ----------
  const dirty = new Set();
  const markDirty = (room) => !room.tutorial && dirty.add(room.code);

  function roomToJSON(room) {
    return {
      v: 1,
      kind: 'brass',
      code: room.code,
      title: room.title,
      intro: room.intro,
      private: room.private,
      host: room.host,
      chat: room.chat.slice(-60),
      gameId: room.gameId,
      recorded: !!room.recorded,
      players: room.players.map((p) => ({ id: p.id, userId: p.userId, name: p.name, color: p.color, isBot: p.isBot, botLevel: p.botLevel || null, autoBot: p.autoBot })),
      game: room.game ? room.game.toJSON() : null,
    };
  }
  function roomFromJSON(d) {
    const now = Date.now();
    return {
      code: d.code,
      title: d.title,
      intro: !!d.intro,
      private: !!d.private,
      host: d.host,
      chat: d.chat || [],
      gameId: d.gameId,
      recorded: !!d.recorded,
      lastActive: now,
      players: d.players.map((p) => ({ ...p, conns: new Set(), lastSeen: now })),
      spectators: new Set(),
      game: d.game ? BrassGame.fromJSON(d.game) : null,
      botTimer: null,
    };
  }
  function flushRooms() {
    for (const code of dirty) {
      const room = rooms.get(code);
      try {
        if (room) db.saveRoom(dbKey(code), roomToJSON(room));
        else db.deleteRoom(dbKey(code));
      } catch (e) {
        console.error('[db] 伯明翰保存房间失败', code, e.message);
      }
    }
    dirty.clear();
  }
  setInterval(flushRooms, 1500).unref();

  function removeRoom(room) {
    clearTimeout(room.botTimer);
    for (const c of room.voice || []) c.voiceRoom = null;
    rooms.delete(room.code);
    dirty.delete(room.code);
    if (!room.tutorial) db.deleteRoom(dbKey(room.code));
  }

  function restoreRooms() {
    let n = 0;
    for (const d of db.loadRooms()) {
      if (!d || d.kind !== 'brass') continue;
      try {
        const room = roomFromJSON(d);
        rooms.set(room.code, room);
        n++;
      } catch (e) {
        console.error('[db] 伯明翰恢复房间失败', d.code, e.message);
        db.deleteRoom(dbKey(d.code));
      }
    }
    for (const room of rooms.values()) scheduleBots(room, 3000);
    if (n) console.log(`伯明翰：已恢复 ${n} 个房间`);
  }

  // ---------- 战绩 ----------
  function recordIfEnded(room) {
    const g = room.game;
    if (!g || g.phase !== 'ended' || room.recorded) return;
    room.recorded = true;
    if (room.tutorial) return;
    try {
      const ranked = g.ranking();
      const players = g.players.map((gp, seat) => {
        const rp = room.players.find((x) => x.id === gp.id) || {};
        return {
          seat,
          userId: rp.userId || null,
          name: gp.name,
          color: gp.color,
          isBot: !rp.userId,
          vp: gp.vp,
          rank: ranked.indexOf(gp) + 1,
          isWinner: gp.id === g.winner,
          stats: { ...gp.stats, income: g.level(gp), money: gp.money },
        };
      });
      const rounds = g.history.length;
      if (players.some((p) => p.userId)) db.recordMatch({ game: 'brass', roomCode: room.code, size: g.n, targetVP: g.intro ? 1 : 0, turns: rounds, startedAt: g.startedAt, endedAt: g.endedAt || Date.now() }, players);
    } catch (e) {
      console.error('[db] 伯明翰记录战绩失败', e.message);
    }
  }

  // ---------- 广播 ----------
  function roomInfo(room) {
    return {
      code: room.code,
      title: room.title,
      intro: room.intro,
      private: room.private,
      tutorial: !!room.tutorial,
      host: room.host,
      max: MAX_PLAYERS,
      min: MIN_PLAYERS,
      started: !!room.game,
      gameId: room.gameId,
      players: room.players.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        isBot: p.isBot,
        bot: p.isBot ? p.botLevel : null,
        autoBot: p.autoBot,
        connected: p.isBot || p.conns.size > 0,
      })),
      thinking: room.aiThinking || null,
      aiAvailable: ai.enabled(),
      tts: !!(platform.tts && platform.tts.enabled()),
      spectators: room.spectators.size,
    };
  }
  function sendRoom(room, conn, pid, events, forceFull) {
    const payload = { room: roomInfo(room), you: pid };
    if (room.game) {
      const full = forceFull || conn.mapFor !== room.gameId;
      conn.mapFor = room.gameId;
      payload.game = room.game.view(pid, full);
      if (events && events.length) {
        // 别人的手牌信息不下发：弃牌事件只给本人看到具体是哪张
        payload.events = events.map((e) => (e.type === 'discard' && e.pid !== pid ? { ...e, card: null } : e.type === 'scout' && e.pid !== pid ? { ...e, cards: null } : e));
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
  function sendAll(room, msg) {
    for (const p of room.players) for (const c of p.conns) c.send(msg);
    for (const c of room.spectators) c.send(msg);
  }
  function pushChat(room, msg) {
    room.chat.push(msg);
    if (room.chat.length > 100) room.chat.shift();
    markDirty(room);
    sendAll(room, { t: 'chat', d: msg });
  }
  const systemChat = (room, text) => pushChat(room, { id: rid(4), sys: true, text, t: Date.now() });

  // ---------- 电脑玩家 ----------
  const controlledByBot = (p) => p.isBot || p.autoBot;
  const alive = (room, g) => room.game === g && rooms.has(room.code);

  function botTurn(room) {
    const g = room.game;
    if (!g || g.phase === 'ended') return null;
    const p = room.players.find((x) => x.id === g.cur().id);
    return p && controlledByBot(p) ? p : null;
  }
  function scheduleBots(room, delay = BOT_DELAY) {
    if (!room.game || room.game.phase === 'ended' || room.botTimer || room.aiBusy) return;
    if (!botTurn(room)) return;
    const g = room.game;
    room.botTimer = setTimeout(() => {
      room.botTimer = null;
      runBot(room, g).catch((e) => {
        room.aiBusy = false;
        console.error('[brass bot]', e);
      });
    }, delay);
  }
  function heuristicStep(g, p) {
    const level = p.autoBot ? 'normal' : p.botLevel === 'ai' ? 'hard' : p.botLevel || 'normal';
    const a = botAction(g, p.id, level);
    if (!a) return null;
    let r = g.act(p.id, a);
    if (!r.ok) {
      console.warn('[brass bot] 动作失败', a, r.error);
      const me = g.P(p.id);
      r = g.act(p.id, { type: 'pass', card: me.hand[0] && me.hand[0].id });
    }
    return r;
  }
  async function runBot(room, g) {
    if (!alive(room, g) || g.phase === 'ended') return;
    const p = botTurn(room);
    if (!p) return;
    let r = null;
    if (p.isBot && p.botLevel === 'ai' && !p.autoBot && ai.enabled()) {
      room.aiBusy = true;
      room.aiThinking = p.id;
      broadcast(room);
      try {
        const res = await ai.decide(g, p.id);
        if (alive(room, g) && res && g.cur().id === p.id) {
          r = g.act(p.id, res.action);
          if (r.ok && res.say && Math.random() < 0.6) pushChat(room, { id: rid(4), pid: p.id, name: p.name, color: p.color, text: res.say, t: Date.now() });
          if (!r.ok) r = null;
        }
      } catch {
        r = null;
      } finally {
        room.aiBusy = false;
        room.aiThinking = null;
      }
      if (!alive(room, g)) return;
    }
    if (!r && g.cur().id === p.id && g.phase !== 'ended') r = heuristicStep(g, p);
    if (r) broadcast(room, r.events);
    else broadcast(room);
    const slow = r && r.events.some((e) => ['roundEnd', 'eraEnd', 'turn', 'sell'].includes(e.type));
    const eraEnd = r && r.events.some((e) => e.type === 'eraEnd');
    scheduleBots(room, eraEnd ? BOT_DELAY * 6 : slow ? BOT_DELAY * 1.7 : BOT_DELAY);
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
    detach(conn);
    if (!room) return;
    room.spectators.delete(conn);
    const p = room.players.find((x) => x.conns.has(conn));
    if (p) {
      p.conns.delete(conn);
      p.lastSeen = Date.now();
      if (conn.explicitLeave) {
        if (room.tutorial) return removeRoom(room);
        if (!room.game) {
          room.players = room.players.filter((x) => x !== p);
          systemChat(room, `${p.name} 离开了房间`);
        } else if (room.game.phase !== 'ended' && !p.conns.size) {
          p.autoBot = true;
          systemChat(room, `${p.name} 暂时离开，由电脑代管。回到对局后自动恢复。`);
        }
        if (room.host === p.id && !p.conns.size) {
          const nh = room.players.find((x) => !x.isBot && x.conns.size) || room.players.find((x) => !x.isBot);
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
      // 教程没人看 5 分钟就删；普通房间 30 分钟
      const idle = room.tutorial ? 5 * 60 * 1000 : 30 * 60 * 1000;
      if (!online && now - room.lastActive > idle) removeRoom(room);
    }
  }, 10000).unref();

  // ======================= WebSocket 消息 =======================
  function ctx(conn, hostOnly = false) {
    const room = conn.room && rooms.get(conn.room);
    if (!room) throw new Error('你不在房间中');
    const me = room.players.find((p) => p.conns.has(conn)) || null;
    if (hostOnly && (!me || me.id !== room.host)) throw new Error('只有房主可以执行此操作');
    return { room, me };
  }
  function newRoom(conn, d, extra = {}) {
    if (rooms.size >= MAX_ROOMS) throw new Error('服务器房间已满，请稍后再试');
    if (conn.room) {
      conn.explicitLeave = true;
      leaveRoom(conn);
      conn.explicitLeave = false;
    }
    const code = newCode();
    const room = {
      code,
      title: cleanName(d.title, `${conn.user.username} 的工厂`),
      intro: !!d.intro,
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
      ...extra,
    };
    rooms.set(code, room);
    return room;
  }
  function addBotTo(room, level) {
    const used = new Set(room.players.map((x) => x.color));
    const usedNames = new Set(room.players.map((x) => x.name));
    const prefix = level === 'ai' ? '🧠 ' : '🤖 ';
    const pool = level === 'ai' ? AI_NAMES : BOT_NAMES;
    const base = pool.find((n) => !usedNames.has(prefix + n)) || 'Bot';
    const p = { id: rid(6), userId: null, name: prefix + base, color: COLORS.find((c) => !used.has(c)), isBot: true, botLevel: level, autoBot: false, conns: new Set() };
    room.players.push(p);
    return p;
  }
  function startGame(room, opts = {}) {
    room.game = new BrassGame({ intro: room.intro, tutorial: opts.tutorial || null }, room.players.map((p) => ({ id: p.id, name: p.name, color: p.color })));
    room.gameId = rid(6);
    room.recorded = false;
    room.aiThinking = null;
    room.players.sort((a, b) => room.game.pIdx(a.id) - room.game.pIdx(b.id));
  }

  const handlers = {
    online(conn) {
      const room = conn.room && rooms.get(conn.room);
      const inRoom = new Set(room ? room.players.filter((p) => p.userId).map((p) => p.userId) : []);
      const out = [];
      for (const [uid, set] of userConns) {
        if (uid === conn.user.id || inRoom.has(uid)) continue;
        const username = [...set][0].user.username;
        const cool = room && room.invited && room.invited.get(uid);
        out.push({ id: uid, username, status: platform.presence ? platform.presence(uid) : 'idle', invited: !!(cool && Date.now() - cool < 30000) });
      }
      const order = { idle: 0, room: 1, playing: 2 };
      out.sort((a, b) => order[a.status] - order[b.status] || a.username.localeCompare(b.username, 'zh'));
      conn.send({ t: 'online', d: out });
    },

    invite(conn, d) {
      const { room, me } = ctx(conn);
      if (!me) throw new Error('观战者不能邀请');
      if (room.tutorial) throw new Error('教程里不能邀请');
      if (room.game && room.game.phase !== 'ended') throw new Error('对局已开始，不能再邀请');
      if (room.players.length >= MAX_PLAYERS) throw new Error('房间已满');
      const uid = Number(d.userId);
      const targets = userConns.get(uid);
      if (!targets || !targets.size) throw new Error('对方已离线');
      if (room.players.some((p) => p.userId === uid)) throw new Error('对方已在房间中');
      room.invited = room.invited || new Map();
      const last = room.invited.get(uid);
      if (last && Date.now() - last < 30000) throw new Error('刚刚邀请过，请稍等再试');
      room.invited.set(uid, Date.now());
      const msg = {
        t: 'invite',
        d: { id: rid(4), game: 'brass', gameName: '工业革命：伯明翰', path: '/brass/', from: me.name, fromUser: conn.user.id, code: room.code, title: room.title, detail: room.intro ? '入门短局' : '完整两个时代', players: room.players.length, max: MAX_PLAYERS },
      };
      for (const c of targets) c.send(msg);
      conn.send({ t: 'toast', d: { msg: `已邀请 ${[...targets][0].user.username}` } });
    },

    inviteReply(conn, d) {
      if (d.accept) return;
      const set = userConns.get(Number(d.fromUser));
      if (!set) return;
      for (const c of set) if (c.room === String(d.code || '') && c.game && c.game.id === 'brass') c.send({ t: 'toast', d: { msg: `${conn.user.username} 暂时不能加入` } });
    },

    list(conn) {
      const list = [...rooms.values()]
        .filter((r) => !r.private && !r.tutorial)
        .map((r) => ({
          code: r.code,
          title: r.title,
          intro: r.intro,
          players: r.players.length,
          humans: r.players.filter((p) => !p.isBot).length,
          max: MAX_PLAYERS,
          started: !!r.game,
          ended: r.game ? r.game.phase === 'ended' : false,
          era: r.game ? r.game.era : null,
          mine: r.players.some((p) => p.userId === conn.user.id),
        }))
        .concat(
          // 自己的私人房间也列出来，方便回到对局
          [...rooms.values()].filter((r) => (r.private || r.tutorial) && r.players.some((p) => p.userId === conn.user.id)).map((r) => ({ code: r.code, title: r.title, intro: r.intro, tutorial: !!r.tutorial, players: r.players.length, max: MAX_PLAYERS, started: !!r.game, ended: r.game ? r.game.phase === 'ended' : false, era: r.game ? r.game.era : null, mine: true }))
        )
        .sort((a, b) => b.mine - a.mine || a.started - b.started)
        .slice(0, 60);
      conn.send({ t: 'rooms', d: list });
    },

    create(conn, d) {
      const room = newRoom(conn, d);
      handlers.join(conn, { code: room.code });
    },

    // 新手教程：私人房间，你 + 一位电脑导师，固定开局，直接开始
    tutorial(conn) {
      const room = newRoom(conn, { title: '新手教程', private: true }, { tutorial: true });
      const p = { id: rid(6), userId: conn.user.id, name: conn.user.username, color: COLORS[0], isBot: false, autoBot: false, conns: new Set([conn]) };
      room.players.push(p);
      room.host = p.id;
      const bot = addBotTo(room, 'normal');
      bot.name = '🎩 导师老约翰';
      conn.room = room.code;
      startGame(room, { tutorial: TUTORIAL });
      conn.send({ t: 'chatHistory', d: room.chat });
      broadcast(room, [{ type: 'start', tutorial: true }]);
      voiceAdd(room, conn);
    },

    join(conn, d) {
      const code = String(d.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) throw new Error('房间不存在');
      if (conn.room && conn.room !== code) {
        conn.explicitLeave = true;
        leaveRoom(conn);
        conn.explicitLeave = false;
      }
      room.spectators.delete(conn);
      conn.room = code;
      let p = room.players.find((x) => x.userId === conn.user.id && !x.isBot);
      if (p) {
        p.conns.add(conn);
        if (p.autoBot) {
          p.autoBot = false;
          systemChat(room, `${p.name} 回来了，恢复手动操作`);
        }
      } else if (!room.game && !room.tutorial && room.players.length < MAX_PLAYERS) {
        const used = new Set(room.players.map((x) => x.color));
        p = { id: rid(6), userId: conn.user.id, name: conn.user.username, color: COLORS.find((c) => !used.has(c)), isBot: false, autoBot: false, conns: new Set([conn]) };
        room.players.push(p);
        if (!room.host || !room.players.some((x) => x.id === room.host && !x.isBot)) room.host = p.id;
        systemChat(room, `${p.name} 加入了房间`);
      } else {
        if (room.tutorial) throw new Error('这是别人的教程');
        room.spectators.add(conn);
        conn.send({ t: 'toast', d: { msg: room.game ? '游戏已开始，你正在观战' : '房间已满，你正在观战' } });
      }
      conn.send({ t: 'chatHistory', d: room.chat });
      conn.mapFor = null;
      broadcast(room);
      voiceAdd(room, conn);
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
      if (room.game && room.game.phase !== 'ended') throw new Error('游戏已开始');
      if (d.intro !== undefined) room.intro = !!d.intro;
      if (d.private !== undefined) room.private = !!d.private;
      if (d.title !== undefined) room.title = cleanName(d.title, room.title);
      broadcast(room);
    },

    addBot(conn, d) {
      const { room } = ctx(conn, true);
      if (room.game) throw new Error('游戏已开始');
      if (room.players.length >= MAX_PLAYERS) throw new Error('房间已满（最多 4 人）');
      const level = ['easy', 'normal', 'hard', 'ai'].includes(d.level) ? d.level : 'normal';
      if (level === 'ai' && !ai.enabled()) throw new Error('服务器还没有配置智谱 API Key');
      const p = addBotTo(room, level);
      systemChat(room, `${p.name}（${LEVEL_TAG[level]}）加入了`);
      broadcast(room);
    },

    kick(conn, d) {
      const { room } = ctx(conn, true);
      if (room.game) throw new Error('游戏已开始');
      const p = room.players.find((x) => x.id === d.pid);
      if (!p || p.id === room.host) return;
      room.players = room.players.filter((x) => x !== p);
      for (const c of p.conns) {
        detach(c);
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
      sendVoiceRoster(room);
    },

    start(conn) {
      const { room } = ctx(conn, true);
      if (room.game && room.game.phase !== 'ended') throw new Error('游戏已在进行中');
      if (room.players.length < MIN_PLAYERS) throw new Error('至少需要 2 名玩家（可添加电脑玩家）');
      startGame(room);
      systemChat(room, `游戏开始！${room.game.n} 人局，运河时代第 1 轮。`);
      broadcast(room, [{ type: 'start' }]);
      scheduleBots(room, 2600);
    },

    backToLobby(conn) {
      const { room } = ctx(conn, true);
      if (!room.game || room.game.phase !== 'ended') throw new Error('游戏尚未结束');
      if (room.tutorial) throw new Error('教程结束了，回首页开一局真正的游戏吧');
      clearTimeout(room.botTimer);
      room.botTimer = null;
      room.game = null;
      room.gameId = null;
      room.recorded = false;
      for (const p of room.players) p.autoBot = false;
      room.players = room.players.filter((p) => p.isBot || p.conns.size);
      for (const c of [...room.spectators]) {
        if (room.players.length >= MAX_PLAYERS) break;
        room.spectators.delete(c);
        detach(c);
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
      const eraEnd = r.events.some((e) => e.type === 'eraEnd');
      scheduleBots(room, eraEnd ? BOT_DELAY * 6 : BOT_DELAY * 1.4);
    },

    // 让电脑给我一个建议（教程与「提示」按钮）
    hint(conn) {
      const { room, me } = ctx(conn);
      const g = room.game;
      if (!g || !me || g.phase === 'ended' || g.cur().id !== me.id) throw new Error('现在不是你的回合');
      conn.hintTimes = (conn.hintTimes || []).filter((t) => Date.now() - t < 10000);
      if (conn.hintTimes.length >= HINT_LIMIT) throw new Error('提示用得太快了');
      conn.hintTimes.push(Date.now());
      const a = botAction(g, me.id, 'hard', { noAvoid: true });
      conn.send({ t: 'hint', d: a });
    },

    rtc(conn, d) {
      const room = conn.voiceRoom && rooms.get(conn.voiceRoom);
      if (!room || !room.voice) return;
      if (!['offer', 'answer', 'ice'].includes(d.kind)) return;
      const target = [...room.voice].find((c) => c.cid === d.to);
      if (!target) return;
      const data = JSON.stringify(d.data || null);
      if (data.length > 64 * 1024) return;
      target.send({ t: 'rtc', d: { from: conn.cid, kind: d.kind, data: d.data } });
    },
    voiceToken(conn) {
      const room = conn.voiceRoom && rooms.get(conn.voiceRoom);
      if (!room || !AGORA_APP_ID) return;
      conn.send({ t: 'voiceToken', d: agoraInfo(room, conn) });
    },
    voiceState(conn, d) {
      const room = conn.voiceRoom && rooms.get(conn.voiceRoom);
      if (!room) return;
      conn.voiceMuted = !!d.muted;
      sendVoiceRoster(room);
    },

    chat(conn, d) {
      const { room, me } = ctx(conn);
      const now = Date.now();
      conn.chatTimes = (conn.chatTimes || []).filter((t) => now - t < 10000);
      if (conn.chatTimes.length >= 8) throw new Error('发言太快了');
      conn.chatTimes.push(now);
      const text = String(d.text || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 200);
      if (!text) return;
      pushChat(room, { id: rid(4), pid: me ? me.id : null, name: me ? me.name : conn.user.username, color: me ? me.color : '#999', text, t: now, emote: !!d.emote });
    },
  };

  // ======================= 对平台的接口 =======================
  function kickUser(userId) {
    for (const room of [...rooms.values()]) {
      const p = room.players.find((x) => x.userId === userId);
      if (!p) continue;
      if (room.tutorial) {
        for (const c of p.conns) detach(c);
        removeRoom(room);
        continue;
      }
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
      for (const c of p.conns) detach(c);
      p.conns.clear();
      broadcast(room);
      scheduleBots(room);
    }
  }
  function onClose(conn) {
    leaveRoom(conn);
    voiceRemove(conn);
  }
  function onConnect(conn) {
    conn.cid = conn.cid || rid(6);
    conn.voiceUid = conn.voiceUid || crypto.randomInt(1, 2 ** 31 - 1);
  }
  function presence(userId) {
    let st = null;
    for (const r of rooms.values()) {
      const pl = r.players.find((p) => p.userId === userId && p.conns.size);
      if (!pl) continue;
      if (r.game && r.game.phase !== 'ended' && !r.tutorial) return 'playing';
      st = 'room';
    }
    return st;
  }
  function summary(userId) {
    let open = 0;
    let playing = 0;
    let mine = null;
    for (const r of rooms.values()) {
      if (r.private || r.tutorial) {
        if (userId && r.game && r.game.phase !== 'ended' && !r.tutorial && r.players.some((p) => p.userId === userId)) mine = r.code;
        continue;
      }
      const live = r.game && r.game.phase !== 'ended';
      if (live) playing += r.players.filter((p) => p.userId && p.conns.size).length;
      else open++;
      if (userId && live && r.players.some((p) => p.userId === userId && !p.isBot)) mine = r.code;
    }
    const s = userId ? db.userSummary(userId, 0, 'brass').stats : null;
    return { rooms: rooms.size, open, playing, myRoom: mine, stats: s };
  }
  function shutdown() {
    for (const room of rooms.values()) {
      clearTimeout(room.botTimer);
      markDirty(room);
    }
    flushRooms();
  }

  const routes = {
    'GET /api/brass/me': async (req) => {
      const user = requireUser(req);
      return { user, ...db.userSummary(user.id, 10, 'brass') };
    },
    'GET /api/brass/leaderboard': async (req) => {
      requireUser(req);
      return { rows: db.leaderboard(50, 'brass') };
    },
    'GET /api/brass/map': async () => require('./data').publicMap(),
  };

  restoreRooms();

  return {
    id: 'brass',
    handlers,
    routes,
    onConnect,
    onClose,
    kickUser,
    summary,
    presence,
    shutdown,
    rateKey: (t) => (t === 'rtc' ? 'rtc' : null),
    rooms,
  };
};
