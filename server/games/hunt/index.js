'use strict';
// 雾夜追猎游戏模块：房间、阵营与角色选择、实时对局循环、电脑与 AI 玩家、邀请、战绩。
// 由平台（server/index.js）加载。对局是实时的（每 50 毫秒推进一次），只保存在内存里：服务器重启后进行中的对局会结束。
const crypto = require('crypto');
const { HuntGame } = require('./sim');
const { botTick } = require('./bot');
const ai = require('./ai');
const { RULES, SURVIVORS, HUNTERS, MAP_KEYS, MAP_INFO, publicConfig } = require('./data');

const TICK_MS = 50;
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 200;
const AFK_TAKEOVER_MS = Number(process.env.HUNT_AFK_MS) || 15000;
const AI_EVERY_S = 20;
// 仅用于测试：加速对局（例如 HUNT_SPEED=20）
const SPEED = Math.max(0.1, Math.min(100, Number(process.env.HUNT_SPEED) || 1));
const MAX_PLAYERS = 5;
const SURV_KEYS = Object.keys(SURVIVORS);
const HUNT_KEYS = Object.keys(HUNTERS);

const COLORS = ['#e0b458', '#6fb3d9', '#e07a5f', '#8fc49a', '#b48ad6', '#e8e4d8', '#d96a8a', '#5fc4c0'];
const BOT_NAMES = ['阿默', '小满', '老周', '白露', '惊蛰', '谷雨', '夜莺', '灯芯', '铃铛', '半夏'];
const AI_NAMES = ['小智', '小谱', '青言', '清影', '星火', '墨白'];
const BOT_TAG = { easy: '菜鸟', normal: '老手', hard: '大神', ai: 'AI' };

module.exports = function createHunt(platform) {
  const { db, userConns, requireUser } = platform;

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
  const mapName = (k) => (MAP_INFO[k] ? MAP_INFO[k].name : '随机地图');

  // ======================= 战绩 =======================
  function recordIfEnded(room) {
    const g = room.game;
    if (!g || g.phase !== 'ended' || room.recorded) return;
    room.recorded = true;
    try {
      const order = g.players.slice().sort((a, b) => g.score(b) - g.score(a));
      const players = g.players.map((gp, seat) => {
        const rp = room.players.find((x) => x.id === gp.id) || {};
        return {
          seat,
          userId: rp.userId || null,
          name: gp.name,
          color: gp.color,
          isBot: !rp.userId,
          vp: g.score(gp),
          rank: order.indexOf(gp) + 1,
          isWinner: gp.role === 'hunter' ? g.result.winner === 'hunter' : g.result.winner === 'survivors',
          stats: { role: gp.role, char: gp.char, end: gp.st, escaped: g.result.escaped, result: g.result.winner, ...Object.fromEntries(Object.entries(gp.stats).map(([k, v]) => [k, Math.round(v)])) },
        };
      });
      if (players.some((p) => p.userId)) {
        db.recordMatch({ game: 'hunt', roomCode: room.code, size: g.players.length, targetVP: MAP_KEYS.indexOf(g.mapKey), turns: Math.round(g.t), startedAt: g.startedAt, endedAt: g.endedAt || Date.now() }, players);
      }
    } catch (e) {
      console.error('[db] 雾夜追猎记录战绩失败', e.message);
    }
  }

  // ======================= 广播 =======================
  function roomInfo(room) {
    return {
      code: room.code,
      title: room.title,
      map: room.map,
      private: room.private,
      host: room.host,
      max: MAX_PLAYERS,
      started: !!room.game,
      ended: !!(room.game && room.game.phase === 'ended'),
      gameId: room.gameId,
      players: room.players.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        role: p.role,
        char: p.char,
        isBot: p.isBot,
        bot: p.isBot ? p.botLevel : null,
        autoBot: p.autoBot,
        connected: p.isBot || p.conns.size > 0,
      })),
      aiAvailable: ai.enabled(),
      spectators: room.spectators.size,
    };
  }

  function sendRoom(room, conn, pid) {
    conn.send({ t: 'room', d: { room: roomInfo(room), you: pid } });
    if (room.game) {
      conn.setupFor = null; // 下次状态里带上完整的地图
      sendState(room, conn, pid, []);
    }
  }

  function broadcastRoom(room) {
    room.lastActive = Date.now();
    for (const p of room.players) for (const c of p.conns) sendRoom(room, c, p.id);
    for (const c of room.spectators) sendRoom(room, c, null);
  }

  function sendState(room, conn, pid, events) {
    const g = room.game;
    const v = g.view(pid);
    v.gameId = room.gameId;
    if (conn.setupFor !== room.gameId) {
      conn.setupFor = room.gameId;
      v.setup = g.setup();
    }
    if (events && events.length) v.events = events;
    conn.send({ t: 'state', d: v });
  }

  function broadcastState(room, events) {
    for (const p of room.players) for (const c of p.conns) sendState(room, c, p.id, events);
    for (const c of room.spectators) sendState(room, c, null, events);
  }

  function sendAll(room, msg) {
    for (const p of room.players) for (const c of p.conns) c.send(msg);
    for (const c of room.spectators) c.send(msg);
  }

  function pushChat(room, msg) {
    room.chat.push(msg);
    if (room.chat.length > 100) room.chat.shift();
    sendAll(room, { t: 'chat', d: msg });
  }
  const systemChat = (room, text) => pushChat(room, { id: rid(4), sys: true, text, t: Date.now() });

  // ======================= 对局循环 =======================
  const controlledByBot = (p) => p.isBot || p.autoBot;

  function botsThink(room) {
    const g = room.game;
    for (const p of room.players) {
      const gp = g.P(p.id);
      if (!gp) continue;
      if (!controlledByBot(p)) {
        gp.autoQte = null;
        gp.speedMul = 1;
        continue;
      }
      const level = p.autoBot ? 'normal' : p.botLevel === 'ai' ? 'hard' : p.botLevel;
      p.mem = p.mem || {};
      const focus = p.botLevel === 'ai' && !p.autoBot && p.aiPlan ? p.aiPlan.weights : {};
      botTick(g, gp, level, p.mem, focus);
      if (p.botLevel === 'ai' && !p.autoBot && ai.enabled() && g.phase === 'play' && (gp.role === 'hunter' || g.inPlay(gp))) askAi(room, p);
    }
  }

  function askAi(room, p) {
    const g = room.game;
    if (p.aiBusy || (p.aiAt && g.t - p.aiAt < AI_EVERY_S)) return;
    p.aiBusy = true;
    p.aiAt = g.t;
    ai.strategy(g, p.id)
      .then((plan) => {
        if (room.game !== g || g.phase === 'ended') return;
        const changed = !p.aiPlan || p.aiPlan.focus !== plan.focus;
        p.aiPlan = plan;
        if (plan.say && (changed || Math.random() < 0.35)) pushChat(room, { id: rid(4), pid: p.id, name: p.name, color: p.color, text: plan.say, t: Date.now() });
      })
      .catch(() => {})
      .finally(() => {
        p.aiBusy = false;
      });
  }

  // 系统消息：把关键事件写进聊天记录（客户端另外有动画与音效）
  function narrate(room, events) {
    const g = room.game;
    const nameOf = (pid) => (g.P(pid) || {}).name || '?';
    for (const e of events) {
      if (e.type === 'go') systemChat(room, '雾起来了……追猎者开始行动。');
      else if (e.type === 'machine') systemChat(room, e.left > 0 ? `一台发报机修好了，还差 ${e.left} 台。` : '最后一台发报机修好了！');
      else if (e.type === 'power') systemChat(room, '大门通电了！快去电闸开门。');
      else if (e.type === 'caged') systemChat(room, `${nameOf(e.pid)} 被关进了铁笼。`);
      else if (e.type === 'rescued') systemChat(room, `${nameOf(e.by)} 救出了 ${nameOf(e.pid)}。`);
      else if (e.type === 'dead') systemChat(room, `${nameOf(e.pid)} 被淘汰了。`);
      else if (e.type === 'escape') systemChat(room, `${nameOf(e.pid)} ${e.how === 'hatch' ? '从地窖' : '从大门'}逃脱了！`);
      else if (e.type === 'gateOpen') systemChat(room, '一扇大门打开了！');
      else if (e.type === 'hatch') systemChat(room, '地窖的盖子松动了……');
      else if (e.type === 'end') systemChat(room, e.winner === 'hunter' ? `追猎者获胜（${e.escaped} 人逃脱）。` : e.winner === 'draw' ? `平局（${e.escaped} 人逃脱）。` : `求生者获胜（${e.escaped} 人逃脱）！`);
    }
  }

  let lastTick = Date.now();
  const loop = setInterval(() => {
    const now = Date.now();
    const dt = Math.min(0.5, (now - lastTick) / 1000) * SPEED;
    lastTick = now;
    for (const room of rooms.values()) {
      const g = room.game;
      if (!g || g.phase === 'ended') continue;
      try {
        // 按 0.05 秒的固定步长推进，保证结果与模拟测试一致
        room.acc = (room.acc || 0) + dt;
        let events = room.pending || [];
        room.pending = [];
        while (room.acc >= RULES.tick - 1e-9 && g.phase !== 'ended') {
          room.acc -= RULES.tick;
          botsThink(room);
          events = events.concat(g.step(RULES.tick));
        }
        narrate(room, events);
        broadcastState(room, events);
        if (g.phase === 'ended') {
          recordIfEnded(room);
          broadcastRoom(room);
        }
      } catch (e) {
        console.error('[hunt] 对局循环出错', room.code, e);
      }
    }
  }, TICK_MS);
  loop.unref();

  // ======================= 座位与角色 =======================
  const seatFree = (room, role) => room.players.filter((p) => p.role === role).length < (role === 'hunter' ? 1 : 4);
  const freeColor = (room) => {
    const used = new Set(room.players.map((x) => x.color));
    return COLORS.find((c) => !used.has(c)) || COLORS[0];
  };
  function freeChar(room, role, self = null, avoid = []) {
    if (role === 'hunter') return HUNT_KEYS[crypto.randomInt(HUNT_KEYS.length)];
    const used = new Set(room.players.filter((x) => x !== self && x.role === 'survivor').map((x) => x.char).concat(avoid));
    const free = SURV_KEYS.filter((k) => !used.has(k));
    return free.length ? free[crypto.randomInt(free.length)] : SURV_KEYS[0];
  }
  function makeBot(room, role, level) {
    const usedNames = new Set(room.players.map((x) => x.name));
    const prefix = level === 'ai' ? '🧠 ' : '🤖 ';
    const pool = level === 'ai' ? AI_NAMES : BOT_NAMES;
    const base = pool.find((n) => !usedNames.has(prefix + n)) || 'Bot';
    const bot = { id: rid(6), userId: null, name: prefix + base, color: freeColor(room), role, char: freeChar(room, role), isBot: true, botLevel: level, autoBot: false, conns: new Set() };
    room.players.push(bot);
    return bot;
  }

  // ======================= 掉线与清理 =======================
  function checkAfk(room) {
    const now = Date.now();
    const host = room.players.find((p) => p.id === room.host);
    if (!host || (!host.conns.size && now - (host.lastSeen || now) > 15000)) {
      const nh = room.players.find((p) => !p.isBot && p.conns.size);
      if (nh && nh.id !== room.host) {
        room.host = nh.id;
        systemChat(room, `${nh.name} 成为新房主`);
        broadcastRoom(room);
      }
    }
    if (!room.game) {
      const before = room.players.length;
      room.players = room.players.filter((p) => p.isBot || p.conns.size || now - (p.lastSeen || now) < 120000);
      if (room.players.length !== before) broadcastRoom(room);
      return;
    }
    if (room.game.phase === 'ended') return;
    let changed = false;
    for (const p of room.players) {
      if (p.isBot || p.autoBot || p.conns.size) continue;
      if (now - (p.lastSeen || 0) > AFK_TAKEOVER_MS) {
        p.autoBot = true;
        changed = true;
        systemChat(room, `${p.name} 掉线了，暂由电脑代管。重新连接后自动恢复。`);
      }
    }
    if (changed) broadcastRoom(room);
  }

  function removeRoom(room) {
    rooms.delete(room.code);
  }

  setInterval(() => {
    const now = Date.now();
    for (const room of [...rooms.values()]) {
      checkAfk(room);
      const online = room.players.some((p) => !p.isBot && p.conns.size) || room.spectators.size;
      const running = room.game && room.game.phase !== 'ended';
      // 没人看的对局照常进行到结束（战绩照记）；结束且无人在线 10 分钟后删除
      if (!online && !running && now - room.lastActive > 10 * 60 * 1000) removeRoom(room);
      if (!online && running && !room.players.some((p) => p.userId)) removeRoom(room);
    }
  }, 5000).unref();

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
        } else if (room.game.phase !== 'ended' && !p.conns.size && room.game.inPlay(room.game.P(p.id))) {
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
    broadcastRoom(room);
  }

  // ======================= WebSocket 消息 =======================
  function ctx(conn, hostOnly = false) {
    const room = conn.room && rooms.get(conn.room);
    if (!room) throw new Error('你不在房间中');
    const me = room.players.find((p) => p.conns.has(conn)) || null;
    if (hostOnly && (!me || me.id !== room.host)) throw new Error('只有房主可以执行此操作');
    return { room, me };
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
        d: { id: rid(4), game: 'hunt', gameName: '雾夜追猎', path: '/hunt/', from: me.name, fromUser: conn.user.id, code: room.code, title: room.title, detail: mapName(room.map), players: room.players.length, max: MAX_PLAYERS },
      };
      for (const c of targets) c.send(msg);
      conn.send({ t: 'toast', d: { msg: `已邀请 ${[...targets][0].user.username}` } });
    },

    inviteReply(conn, d) {
      if (d.accept) return;
      const set = userConns.get(Number(d.fromUser));
      if (!set) return;
      for (const c of set) if (c.room === String(d.code || '') && c.game && c.game.id === 'hunt') c.send({ t: 'toast', d: { msg: `${conn.user.username} 暂时不能加入` } });
    },

    list(conn) {
      const list = [...rooms.values()]
        .filter((r) => !r.private)
        .map((r) => ({
          code: r.code,
          title: r.title,
          map: r.map,
          players: r.players.length,
          humans: r.players.filter((p) => !p.isBot).length,
          max: MAX_PLAYERS,
          started: !!r.game,
          ended: r.game ? r.game.phase === 'ended' : false,
          mine: r.players.some((p) => p.userId === conn.user.id),
        }))
        .sort((a, b) => b.mine - a.mine || a.started - b.started)
        .slice(0, 60);
      conn.send({ t: 'rooms', d: list });
    },

    create(conn, d) {
      if (rooms.size >= MAX_ROOMS) throw new Error('服务器房间已满，请稍后再试');
      if (conn.room) {
        conn.explicitLeave = true;
        leaveRoom(conn);
        conn.explicitLeave = false;
      }
      const code = newCode();
      const room = {
        code,
        title: cleanName(d.title, `${conn.user.username} 的雾夜`),
        map: MAP_INFO[d.map] ? d.map : 'random',
        private: !!d.private,
        players: [],
        spectators: new Set(),
        game: null,
        gameId: null,
        chat: [],
        host: null,
        recorded: false,
        lastActive: Date.now(),
      };
      rooms.set(code, room);
      handlers.join(conn, { code, role: d.role });
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
          const gp = room.game && room.game.P(p.id);
          if (gp) gp.mx = gp.mz = 0;
          systemChat(room, `${p.name} 回来了，恢复手动操作`);
        }
      } else if (!room.game && room.players.length < MAX_PLAYERS) {
        const want = d.role === 'hunter' ? 'hunter' : 'survivor';
        const role = seatFree(room, want) ? want : seatFree(room, 'survivor') ? 'survivor' : 'hunter';
        p = { id: rid(6), userId: conn.user.id, name: conn.user.username, color: freeColor(room), role, char: freeChar(room, role), isBot: false, botLevel: null, autoBot: false, conns: new Set([conn]) };
        room.players.push(p);
        if (!room.host || !room.players.some((x) => x.id === room.host && !x.isBot)) room.host = p.id;
        systemChat(room, `${p.name} 走进了雾里`);
      } else {
        room.spectators.add(conn);
        conn.send({ t: 'toast', d: { msg: room.game ? '游戏已开始，你正在观战' : '房间已满，你正在观战' } });
      }
      conn.send({ t: 'chatHistory', d: room.chat });
      broadcastRoom(room);
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
      if (d.map !== undefined && (MAP_INFO[d.map] || d.map === 'random')) room.map = d.map;
      if (d.title !== undefined) room.title = cleanName(d.title, room.title);
      if (d.private !== undefined) room.private = !!d.private;
      broadcastRoom(room);
    },

    addBot(conn, d) {
      const { room } = ctx(conn, true);
      if (room.game) throw new Error('游戏已开始');
      const level = ['easy', 'normal', 'hard', 'ai'].includes(d.level) ? d.level : 'normal';
      if (level === 'ai' && !ai.enabled()) throw new Error('服务器还没有配置智谱 API Key');
      const role = d.role === 'hunter' ? 'hunter' : 'survivor';
      if (!seatFree(room, role)) throw new Error(role === 'hunter' ? '已经有追猎者了' : '求生者已满');
      const bot = makeBot(room, role, level);
      systemChat(room, `${bot.name}（${BOT_TAG[level]}${role === 'hunter' ? '追猎者' : '求生者'}）加入了`);
      broadcastRoom(room);
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
      systemChat(room, `${p.name} 被请出了房间`);
      broadcastRoom(room);
    },

    // 换阵营
    role(conn, d) {
      const { room, me } = ctx(conn);
      if (room.game || !me) throw new Error('现在不能换阵营');
      const role = d.role === 'hunter' ? 'hunter' : 'survivor';
      if (me.role === role) return;
      if (!seatFree(room, role)) throw new Error(role === 'hunter' ? '已经有追猎者了' : '求生者已满');
      me.role = role;
      me.char = freeChar(room, role, me);
      broadcastRoom(room);
    },

    // 选角色（求生者不能重复）
    char(conn, d) {
      const { room, me } = ctx(conn);
      if (room.game || !me) throw new Error('现在不能换角色');
      const pool = me.role === 'hunter' ? HUNTERS : SURVIVORS;
      if (!pool[d.char]) throw new Error('没有这个角色');
      if (me.role === 'survivor') {
        const other = room.players.find((x) => x !== me && x.role === 'survivor' && x.char === d.char);
        if (other && !other.isBot) throw new Error('这个角色已经有人选了');
        if (other) other.char = freeChar(room, 'survivor', other, [d.char]);
      }
      me.char = d.char;
      broadcastRoom(room);
    },

    color(conn, d) {
      const { room, me } = ctx(conn);
      if (room.game || !me) throw new Error('现在不能更换颜色');
      if (!COLORS.includes(d.color)) throw new Error('无效颜色');
      if (room.players.some((x) => x !== me && x.color === d.color)) throw new Error('该颜色已被使用');
      me.color = d.color;
      broadcastRoom(room);
    },

    start(conn) {
      const { room } = ctx(conn, true);
      if (room.game && room.game.phase !== 'ended') throw new Error('游戏已在进行中');
      if (!room.players.length) throw new Error('没有玩家');
      // 空位自动补上"老手"电脑：1 名追猎者 + 4 名求生者
      const added = [];
      if (seatFree(room, 'hunter')) added.push(makeBot(room, 'hunter', 'normal'));
      while (seatFree(room, 'survivor')) added.push(makeBot(room, 'survivor', 'normal'));
      if (added.length) systemChat(room, `空位由电脑补上：${added.map((b) => b.name).join('、')}`);
      const mapKey = MAP_INFO[room.map] ? room.map : MAP_KEYS[crypto.randomInt(MAP_KEYS.length)];
      room.game = new HuntGame({ map: mapKey }, room.players.map((p) => ({ id: p.id, name: p.name, color: p.color, role: p.role, char: p.char })));
      room.gameId = rid(6);
      room.recorded = false;
      room.acc = 0;
      room.pending = [{ type: 'start' }];
      for (const p of room.players) {
        p.mem = {};
        p.aiPlan = null;
        p.aiAt = 0;
      }
      systemChat(room, `地图：${MAP_INFO[mapKey].name}。修好 ${RULES.machinesNeed} 台发报机，打开大门逃出去。`);
      broadcastRoom(room);
    },

    backToLobby(conn) {
      const { room } = ctx(conn, true);
      if (!room.game || room.game.phase !== 'ended') throw new Error('游戏尚未结束');
      room.game = null;
      room.gameId = null;
      room.recorded = false;
      for (const p of room.players) p.autoBot = false;
      // 游戏中掉线没回来的真人移出
      room.players = room.players.filter((p) => p.isBot || p.conns.size);
      for (const c of [...room.spectators]) {
        if (room.players.length >= MAX_PLAYERS) break;
        room.spectators.delete(c);
        c.room = null;
        handlers.join(c, { code: room.code });
      }
      broadcastRoom(room);
    },

        takeover(conn, d) {
      const { room } = ctx(conn, true);
      const p = room.players.find((x) => x.id === d.pid);
      if (!p || p.isBot) return;
      if (p.conns.size) throw new Error('该玩家在线');
      p.autoBot = !p.autoBot;
      systemChat(room, p.autoBot ? `房主让电脑代管 ${p.name}` : `取消代管 ${p.name}`);
      broadcastRoom(room);
    },

    act(conn, d) {
      const { room, me } = ctx(conn);
      if (!room.game) throw new Error('游戏未开始');
      if (!me) throw new Error('观战者不能操作');
      const r = room.game.act(me.id, d || {});
      if (!r.ok && d.type !== 'move' && d.type !== 'use' && d.type !== 'qte') throw new Error(r.error);
    },

        chat(conn, d) {
      const { room, me } = ctx(conn);
      const now = Date.now();
      conn.chatTimes = (conn.chatTimes || []).filter((t) => now - t < 10000);
      if (conn.chatTimes.length >= 8) throw new Error('发言太快了');
      conn.chatTimes.push(now);
      const text = String(d.text || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 200);
      if (!text) return;
      pushChat(room, { id: rid(4), pid: me ? me.id : null, name: me ? me.name : conn.user.username, color: me ? me.color : '#999', text, t: now });
    },
  };

  // ======================= 对平台的接口 =======================
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
      for (const c of p.conns) c.room = null;
      p.conns.clear();
      broadcastRoom(room);
    }
  }

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

  function summary(userId) {
    let open = 0;
    let playing = 0;
    let mine = null;
    for (const r of rooms.values()) {
      if (r.private) continue;
      const live = r.game && r.game.phase !== 'ended';
      if (live) playing += r.players.filter((p) => p.userId && p.conns.size).length;
      else open++;
      if (userId && live && r.players.some((p) => p.userId === userId)) mine = r.code;
    }
    const s = userId ? db.userSummary(userId, 0, 'hunt').stats : null;
    return { rooms: rooms.size, open, playing, myRoom: mine, stats: s };
  }

  function shutdown() {
    clearInterval(loop);
  }

  const routes = {
    'GET /api/hunt/config': async () => publicConfig(),
    'GET /api/hunt/me': async (req) => {
      const user = requireUser(req);
      return { user, ...db.userSummary(user.id, 10, 'hunt') };
    },
    'GET /api/hunt/leaderboard': async (req) => {
      requireUser(req);
      return { rows: db.leaderboard(50, 'hunt') };
    },
  };

  return {
    id: 'hunt',
    handlers,
    routes,
    onConnect() {},
    onClose: leaveRoom,
    kickUser,
    summary,
    presence,
    shutdown,
    rateKey: (t) => (t === 'act' ? 'act' : null),
    rooms,
  };
};
