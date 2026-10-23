'use strict';
// 卡坦岛游戏模块：房间、对局、电脑与 AI 玩家、房间语音、战绩。
// 由平台（server/index.js）加载，平台负责登录鉴权、WebSocket 连接与在线状态。
const crypto = require('crypto');
const { Game } = require('./game');
const { LAYOUTS, generateBoard } = require('./board');
const { botAction } = require('./bot');
const ai = require('./ai');
const { RtcTokenBuilder, Role: AgoraRole } = require('./vendor/agora/src/RtcTokenBuilder2');

const BOT_DELAY = Number(process.env.BOT_DELAY_MS) || 900;
const AFK_TAKEOVER_MS = Number(process.env.AFK_TAKEOVER_MS) || 60000;
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 200;
// 语音：TURN 中继（coturn）。TURN_HOST 为服务器公网 IP 或域名，TURN_SECRET 与 coturn 的 static-auth-secret 一致
const TURN_HOST = process.env.TURN_HOST || '';
const TURN_PORT = Number(process.env.TURN_PORT) || 3478;
const TURN_SECRET = process.env.TURN_SECRET || '';
// 语音：声网 Agora（配置后优先使用；否则使用内置的 WebRTC 点对点）
const AGORA_APP_ID = (process.env.AGORA_APP_ID || '').trim();
const AGORA_APP_CERTIFICATE = (process.env.AGORA_APP_CERTIFICATE || '').trim();
const STUN_URLS = (process.env.STUN_URLS || 'stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302').split(',').map((x) => x.trim()).filter(Boolean);

const COLORS = ['#e53935', '#1e88e5', '#fb8c00', '#f5f5f5', '#43a047', '#8e24aa', '#6d4c41', '#00acc1'];
const AI_NAMES = ['小智', '小谱', '青言', '清影', '星火', '墨白', '知远', '若谷'];
const BOT_NAMES = ['阿尔法', '贝塔', '伽马', '德尔塔', '艾普西隆', '泽塔', '伊塔', '西塔', '卡帕', '拉姆达'];

/**
 * @param {object} platform 平台提供的能力
 *   db         数据库模块
 *   userConns  Map<userId, Set<conn>>，所有在线连接（含平台大厅）
 *   HttpError  HTTP 错误类
 *   requireUser(req) 校验登录，返回 { id, username }
 */
module.exports = function createCatan(platform) {
  const { db, userConns, HttpError, requireUser } = platform;
  console.log(ai.enabled() ? `卡坦岛 AI 玩家：智谱 ${ai.CFG.model}${ai.CFG.thinking ? '（深度思考）' : ''}` : '卡坦岛 AI 玩家：未配置（只有内置电脑）');
  console.log(AGORA_APP_ID ? `卡坦岛语音：声网 Agora${AGORA_APP_CERTIFICATE ? '（Token 鉴权）' : '（仅 App ID，测试模式）'}` : '卡坦岛语音：内置 WebRTC 点对点');

  // ======================= 语音（WebRTC 信令） =======================
  function iceServers(userId) {
    const list = [];
    if (TURN_HOST) list.push({ urls: [`stun:${TURN_HOST}:${TURN_PORT}`] });
    else if (STUN_URLS.length) list.push({ urls: STUN_URLS });
    if (TURN_HOST && TURN_SECRET) {
      // TURN REST API 临时凭证：24 小时有效
      const username = `${Math.floor(Date.now() / 1000) + 86400}:${userId}`;
      const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
      list.push({ urls: [`turn:${TURN_HOST}:${TURN_PORT}?transport=udp`, `turn:${TURN_HOST}:${TURN_PORT}?transport=tcp`], username, credential });
    }
    return list;
  }

  function agoraInfo(room, conn) {
    if (!AGORA_APP_ID) return null;
    const channel = `catan_${room.code}`;
    // 有 App 证书时生成 24 小时有效的 Token；仅有 App ID（测试模式项目）时不需要 Token
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
    conn.voiceMuted = true; // 麦克风默认关闭
    sendVoiceRoster(room, conn);
  }

  function voiceRemove(conn) {
    const room = conn.voiceRoom && rooms.get(conn.voiceRoom);
    conn.voiceRoom = null;
    if (!room || !room.voice || !room.voice.delete(conn)) return;
    conn.send({ t: 'voice', d: { self: conn.cid, peers: [], initiate: [] } });
    sendVoiceRoster(room);
  }

  // 让连接离开房间（不触发离开逻辑），同时退出语音
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
      players: room.players.map((p) => ({ id: p.id, userId: p.userId, name: p.name, color: p.color, isBot: p.isBot, ai: !!p.ai, autoBot: p.autoBot })),
      game: room.game ? room.game.toJSON() : null,
      board: room.game ? null : room.board,
      boardId: room.game ? null : room.boardId,
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
      players: d.players.map((p) => {
        const q = { ...p, conns: new Set(), lastSeen: now };
        // 旧版本中主动离开的玩家被永久换成电脑；迁移为可接回的代管状态
        if (q.isBot && q.userId) {
          q.isBot = false;
          q.autoBot = true;
          q.name = q.name.replace(/\(电脑\)$/, '');
        }
        return q;
      }),
      spectators: new Set(),
      game: d.game ? Game.fromJSON(d.game) : null,
      board: d.board || null,
      boardId: d.boardId || null,
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

  // 大厅预览用的地图：开局时直接使用
  function newLobbyBoard(room) {
    room.board = generateBoard(room.size);
    room.boardId = rid(4);
  }

  function removeRoom(room) {
    clearTimeout(room.botTimer);
    for (const c of room.voice || []) c.voiceRoom = null;
    rooms.delete(room.code);
    dirty.delete(room.code);
    db.deleteRoom(room.code);
  }

  function restoreRooms() {
    let n = 0;
    for (const d of db.loadRooms()) {
      // 同一张表里还有其他游戏（如伯明翰）的房间
      if (d && d.kind && d.kind !== 'catan') continue;
      try {
        const room = roomFromJSON(d);
        if (!room.game && !room.board) newLobbyBoard(room);
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
        db.recordMatch({ game: 'catan', roomCode: room.code, size: g.size, targetVP: g.targetVP, turns: g.turnCount, startedAt: g.startedAt, endedAt: g.endedAt || Date.now() }, players);
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
        ai: !!p.ai,
        autoBot: p.autoBot,
        connected: p.isBot || p.conns.size > 0,
      })),
      thinking: room.aiThinking || null,
      aiAvailable: ai.enabled(),
      spectators: room.spectators.size,
    };
  }

  function sendRoom(room, conn, pid, events, forceFull) {
    const payload = { room: roomInfo(room), you: pid };
    if (!room.game && room.board && conn.lobbyBoardFor !== room.boardId) {
      payload.lobbyBoard = room.board;
      conn.lobbyBoardFor = room.boardId;
    }
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
    if (!room.game || room.game.phase === 'ended' || room.botTimer || room.aiBusy) return;
    const g = room.game;
    const anyBot = room.players.some((p) => controlledByBot(p) && botAction(g, p.id));
    if (!anyBot) return;
    room.botTimer = setTimeout(() => {
      room.botTimer = null;
      runBot(room, g).catch((e) => {
        room.aiBusy = false;
        console.error('[bot]', e);
      });
    }, delay);
  }

  // 房间与这局游戏仍然存在（游戏可能已经结束，结束时仍要广播结果）
  const alive = (room, g) => room.game === g && rooms.has(room.code);

  // 内置策略走一步；失败时兜底结束回合，避免卡死
  function heuristicStep(room, g, p) {
    const a = botAction(g, p.id);
    if (!a) return null;
    let r = g.act(p.id, a);
    if (!r.ok) {
      console.warn('[bot] 动作失败', a, r.error);
      r = g.act(p.id, { type: g.sub === 'special' ? 'endSpecial' : 'endTurn' });
    }
    return r;
  }

  // 智谱 AI 走一步：模型给出的动作不合法时依次尝试计划中的下一个，最后回退到内置策略
  async function aiStep(room, g, p) {
    room.aiMem = room.aiMem || new Map();
    const mem = room.aiMem.get(p.id) || {};
    room.aiMem.set(p.id, mem);
    let r = null;
    room.aiBusy = true;
    try {
      for (let i = 0; i < 12; i++) {
        let a = null;
        try {
          a = await ai.decide(g, p.id, mem, () => {
            if (room.aiThinking !== p.id) {
              room.aiThinking = p.id;
              broadcast(room);
            }
          });
        } catch (e) {
          a = null;
        }
        if (!alive(room, g) || g.phase === 'ended') return null;
        if (!a) break;
        r = g.act(p.id, a);
        if (r.ok) break;
        if (!(g.sub === 'main' && mem.queue && mem.queue.length)) break;
      }
    } finally {
      room.aiBusy = false;
      room.aiThinking = null;
    }
    if (!alive(room, g)) return null;
    if ((!r || !r.ok) && g.phase !== 'ended') r = heuristicStep(room, g, p);
    return r;
  }

  async function runBot(room, g) {
    if (!alive(room, g) || g.phase === 'ended') return;
    for (const p of room.players) {
      if (!controlledByBot(p) || !botAction(g, p.id)) continue;
      const r = p.ai && !p.autoBot && ai.enabled() ? await aiStep(room, g, p) : heuristicStep(room, g, p);
      if (!alive(room, g)) return;
      if (r) broadcast(room, r.events);
      else broadcast(room);
      const slow = r && r.events && r.events.some((e) => e.type === 'roll' || e.type === 'robber' || e.type === 'turn');
      scheduleBots(room, slow ? BOT_DELAY * 1.6 : BOT_DELAY);
      return;
    }
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
        if (!room.game) {
          room.players = room.players.filter((x) => x !== p);
          systemChat(room, `${p.name} 离开了房间`);
        } else if (room.game.phase !== 'ended' && !p.conns.size) {
          // 主动离开：电脑临时代管，玩家随时可以回来接手
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
      if (!online && now - room.lastActive > 30 * 60 * 1000) removeRoom(room);
    }
  }, 10000).unref();

  // ======================= WebSocket 消息 =======================
  const handlers = {
    // 在线玩家（供房间内邀请）：状态为 空闲 / 在房间中 / 对局中
    online(conn) {
      const room = conn.room && rooms.get(conn.room);
      const inRoom = new Set(room ? room.players.filter((p) => p.userId).map((p) => p.userId) : []);
      const out = [];
      for (const [uid, set] of userConns) {
        if (uid === conn.user.id || inRoom.has(uid)) continue;
        let status = 'idle';
        let username = '';
        for (const c of set) {
          username = c.user.username;
          const r = c.room && rooms.get(c.room);
          if (!r) continue;
          const pl = r.players.find((p) => p.userId === uid);
          const st = r.game && r.game.phase !== 'ended' && pl ? 'playing' : 'room';
          if (st === 'playing' || status === 'idle') status = st;
        }
        const cool = room && room.invited && room.invited.get(uid);
        // 平台汇总各游戏的状态（在别的游戏里对局也算「对局中」）
        if (platform.presence) status = platform.presence(uid);
        out.push({ id: uid, username, status, invited: !!(cool && Date.now() - cool < 30000) });
      }
      const order = { idle: 0, room: 1, playing: 2 };
      out.sort((a, b) => order[a.status] - order[b.status] || a.username.localeCompare(b.username, 'zh'));
      conn.send({ t: 'online', d: out });
    },

    invite(conn, d) {
      const { room, me } = ctx(conn);
      if (!me) throw new Error('观战者不能邀请');
      if (room.game && room.game.phase !== 'ended') throw new Error('对局已开始，不能再邀请');
      if (room.players.length >= LAYOUTS[room.size].maxPlayers) throw new Error('房间已满');
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
        d: { id: rid(4), game: 'catan', gameName: '卡坦岛', path: '/catan/', from: me.name, fromUser: conn.user.id, code: room.code, title: room.title, size: room.size, detail: `${room.size} 人地图`, players: room.players.length, max: LAYOUTS[room.size].maxPlayers },
      };
      for (const c of targets) c.send(msg);
      const name = [...targets][0].user.username;
      conn.send({ t: 'toast', d: { msg: `已邀请 ${name}` } });
    },

    // 被邀请者拒绝时通知邀请人
    inviteReply(conn, d) {
      if (d.accept) return;
      const set = userConns.get(Number(d.fromUser));
      if (!set) return;
      for (const c of set) if (c.room === String(d.code || '') && c.game && c.game.id === 'catan') c.send({ t: 'toast', d: { msg: `${conn.user.username} 暂时不能加入` } });
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
      newLobbyBoard(room);
      rooms.set(code, room);
      handlers.join(conn, { code });
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
      conn.lobbyBoardFor = null;
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
      if (room.game) throw new Error('游戏已开始');
      if (d.size !== undefined && [4, 6, 8].includes(Number(d.size))) {
        const size = Number(d.size);
        if (room.players.length > LAYOUTS[size].maxPlayers) throw new Error(`当前人数超过 ${size} 人地图上限`);
        if (size !== room.size) {
          room.size = size;
          newLobbyBoard(room);
        }
      }
      if (d.targetVP !== undefined) room.targetVP = Math.max(5, Math.min(20, Number(d.targetVP) || 10));
      if (d.specialBuild !== undefined) room.specialBuild = !!d.specialBuild;
      if (d.title !== undefined) room.title = cleanName(d.title, room.title);
      broadcast(room);
    },

    rerollMap(conn) {
      const { room } = ctx(conn, true);
      if (room.game && room.game.phase !== 'ended') throw new Error('对局已开始');
      newLobbyBoard(room);
      broadcast(room);
    },

    addBot(conn, d) {
      const { room } = ctx(conn, true);
      if (room.game) throw new Error('游戏已开始');
      if (room.players.length >= LAYOUTS[room.size].maxPlayers) throw new Error('房间已满');
      const wantAi = !!d.ai;
      if (wantAi && !ai.enabled()) throw new Error('服务器还没有配置智谱 API Key');
      const used = new Set(room.players.map((x) => x.color));
      const usedNames = new Set(room.players.map((x) => x.name));
      const prefix = wantAi ? '🧠 ' : '🤖 ';
      const pool = wantAi ? AI_NAMES : BOT_NAMES;
      const name = prefix + (pool.find((n) => !usedNames.has(prefix + n)) || (wantAi ? 'AI' : 'Bot'));
      room.players.push({ id: rid(6), userId: null, name, color: COLORS.find((c) => !used.has(c)), isBot: true, ai: wantAi, autoBot: false, conns: new Set() });
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
      const L = LAYOUTS[room.size];
      if (room.players.length < L.minPlayers) throw new Error(`至少需要 ${L.minPlayers} 名玩家（可添加电脑玩家）`);
      if (!room.board || room.board.size !== room.size) newLobbyBoard(room);
      room.game = new Game({ size: room.size, targetVP: room.targetVP, specialBuild: room.specialBuild, board: room.board }, room.players.map((p) => ({ id: p.id, name: p.name, color: p.color })));
      room.board = null;
      room.boardId = null;
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
      newLobbyBoard(room);
      room.players = room.players.filter((p) => (p.isBot ? !p.userId : true));
      for (const p of room.players) p.autoBot = false;
      for (const c of [...room.spectators]) {
        if (room.players.length >= LAYOUTS[room.size].maxPlayers) break;
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
      scheduleBots(room, r.events.some((e) => e.type === 'roll') ? BOT_DELAY * 1.6 : BOT_DELAY);
    },

    // WebRTC 信令转发：只在同一房间的语音成员之间
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

    // 声网 Token 即将过期时续期
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
  // ======================= 对平台的接口 =======================
  // 禁用 / 删除账号：大厅中移出，对局中交给电脑代管（连接由平台断开）
  function kickUser(userId) {
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

  // 该玩家在卡坦岛中的状态：playing 对局中 / room 在房间里 / null
  function presence(userId) {
    let st = null;
    for (const r of rooms.values()) {
      const pl = r.players.find((p) => p.userId === userId && p.conns.size);
      if (!pl) continue;
      if (r.game && r.game.phase !== 'ended') return 'playing';
      st = 'room';
    }
    return st;
  }

  // 平台大厅上显示的概况
  function summary(userId) {
    let open = 0;
    let playing = 0;
    let mine = null;
    for (const r of rooms.values()) {
      if (r.private) continue;
      const live = r.game && r.game.phase !== 'ended';
      if (live) playing += r.players.filter((p) => p.userId && p.conns.size).length;
      else open++;
      if (userId && r.players.some((p) => p.userId === userId && !p.isBot) && live) mine = r.code;
    }
    const s = userId ? db.userSummary(userId, 0, 'catan').stats : null;
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
    'GET /api/catan/me': async (req) => {
      const user = requireUser(req);
      return { user, ...db.userSummary(user.id, 10, 'catan') };
    },
    'GET /api/catan/leaderboard': async (req) => {
      requireUser(req);
      return { rows: db.leaderboard(50, 'catan') };
    },
    'GET /api/catan/demo': async (req, id, url) => {
      const size = [4, 6, 8].includes(Number(url.searchParams.get('size'))) ? Number(url.searchParams.get('size')) : 6;
      return generateBoard(size);
    },
  };

  restoreRooms();

  return {
    id: 'catan',
    handlers,
    routes,
    onConnect,
    onClose,
    kickUser,
    summary,
    presence,
    shutdown,
    rateKey: (t) => (t === 'rtc' ? 'rtc' : null),
    aiStats: () => ai.publicStats(),
    rooms,
  };
};
