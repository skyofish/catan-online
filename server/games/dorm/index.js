'use strict';
// 猛鬼宿舍游戏模块：房间、实时对局循环、电脑与 AI 玩家、邀请、战绩。
// 由平台（server/index.js）加载，平台负责登录鉴权、WebSocket 连接与在线状态。
// 对局是实时的（每 100 毫秒推进一次），只保存在内存里：服务器重启后进行中的对局会结束。
const crypto = require('crypto');
const { DormGame } = require('./sim');
const { botAction } = require('./bot');
const ai = require('./ai');
const { DIFFICULTY, DIFF_KEYS, BOT_LEVELS, ROOMS, publicConfig } = require('./config');

const TICK_MS = 100;
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 200;
const AFK_TAKEOVER_MS = Number(process.env.DORM_AFK_MS) || 15000;
const AI_EVERY_S = 20;
// 仅用于测试：加速对局（例如 DORM_SPEED=20）
const SPEED = Math.max(0.1, Math.min(100, Number(process.env.DORM_SPEED) || 1));
const MAX_PLAYERS = ROOMS;

const COLORS = ['#e53935', '#1e88e5', '#fdd835', '#eceff1', '#43a047', '#ab47bc', '#ff7043', '#26c6da'];
const BOT_NAMES = ['阿飘', '小红鞋', '学霸', '宿管阿姨', '夜猫子', '胆小鬼', '老油条', '睡神', '室长', '转学生'];
const AI_NAMES = ['小智', '小谱', '青言', '清影', '星火', '墨白'];
const BOT_TAG = { easy: '菜鸟', normal: '老手', hard: '大神', ai: 'AI' };

module.exports = function createDorm(platform) {
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

  // ======================= 战绩 =======================
  function recordIfEnded(room) {
    const g = room.game;
    if (!g || g.phase !== 'ended' || room.recorded) return;
    room.recorded = true;
    try {
      const order = g.ranking();
      const players = g.players.map((gp, seat) => {
        const rp = room.players.find((x) => x.id === gp.id) || {};
        const survived = gp.alive ? g.playT : gp.diedAt || 0;
        return {
          seat,
          userId: rp.userId || null,
          name: gp.name,
          color: gp.color,
          isBot: !rp.userId,
          vp: Math.round(survived),
          rank: order.indexOf(gp) + 1,
          isWinner: !!(g.result && g.result.win && gp.alive),
          stats: { dmg: Math.round(gp.stats.dmg), earned: Math.round(gp.stats.earned), built: gp.stats.built, room: gp.room, alive: gp.alive },
        };
      });
      if (players.some((p) => p.userId)) {
        db.recordMatch(
          { game: 'dorm', roomCode: room.code, size: g.players.length, targetVP: DIFF_KEYS.indexOf(g.diffKey), turns: Math.round(g.playT), startedAt: g.startedAt, endedAt: g.endedAt || Date.now() },
          players
        );
      }
    } catch (e) {
      console.error('[db] 猛鬼宿舍记录战绩失败', e.message);
    }
  }

  // ======================= 广播 =======================
  function roomInfo(room) {
    return {
      code: room.code,
      title: room.title,
      diff: room.diff,
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
      conn.roomVers = null; // 下次状态里带上完整的宿舍信息
      sendState(room, conn, []);
    }
  }

  function broadcastRoom(room) {
    room.lastActive = Date.now();
    for (const p of room.players) for (const c of p.conns) sendRoom(room, c, p.id);
    for (const c of room.spectators) sendRoom(room, c, null);
  }

  // 对局状态：宿舍里的建筑只在有变化时下发，其余每次都发（数据量很小）
  function sendState(room, conn, events) {
    const g = room.game;
    const v = g.view();
    v.gameId = room.gameId;
    // 地图每局随机：第一次（或重连后）把整张地图带上
    if (!conn.roomVers || conn.roomVersFor !== room.gameId) {
      conn.roomVers = new Array(ROOMS).fill(-1);
      conn.roomVersFor = room.gameId;
      v.map = g.map;
    }
    v.rooms = g.rooms.map((r) => {
      if (conn.roomVers[r.i] === r.ver) return { i: r.i, door: [r.door.lv, Math.round(r.door.hp), r.door.max], bed: [r.bed.lv], stun: r.stunUntil > g.t ? 1 : 0 };
      conn.roomVers[r.i] = r.ver;
      return g.roomView(r);
    });
    if (events && events.length) v.events = events;
    conn.send({ t: 'state', d: v });
  }

  function broadcastState(room, events) {
    for (const p of room.players) for (const c of p.conns) sendState(room, c, events);
    for (const c of room.spectators) sendState(room, c, events);
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

  function botsThink(room, dt) {
    const g = room.game;
    for (const p of room.players) {
      if (!controlledByBot(p)) continue;
      const gp = g.P(p.id);
      if (!gp || !gp.alive) continue;
      const level = p.autoBot ? 'normal' : p.botLevel === 'ai' ? 'hard' : p.botLevel;
      p.think = (p.think === undefined ? Math.random() : p.think) - dt;
      if (p.think > 0) continue;
      p.think = (BOT_LEVELS[level] || BOT_LEVELS.normal).think * (0.8 + Math.random() * 0.4);
      // 选宿舍时稍等一下，看起来更像真人
      if (gp.state !== 'bed' && g.t < 1.5 + Math.random() * 2.5) continue;
      const focus = p.botLevel === 'ai' && !p.autoBot && p.aiPlan ? p.aiPlan.weights : {};
      for (let k = 0; k < 3; k++) {
        const a = botAction(g, p.id, level, focus);
        if (!a) break;
        const r = g.act(p.id, a);
        if (!r.ok) break;
      }
      if (p.botLevel === 'ai' && !p.autoBot && ai.enabled() && g.phase === 'play') askAi(room, p);
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
      if (e.type === 'wake') systemChat(room, '猛鬼醒了……锁好门。');
      else if (e.type === 'doorBroken') systemChat(room, `${e.room + 1} 号宿舍的门被砸烂了！`);
      else if (e.type === 'kill') systemChat(room, `${nameOf(e.pid)} 没能活过今晚。`);
      else if (e.type === 'end') systemChat(room, e.win ? (e.reason === 'ghostDead' ? '猛鬼被消灭了！天亮了。' : '天亮了，猛鬼退散。') : '宿舍楼一片死寂……猛鬼赢了。');
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
        botsThink(room, dt);
        // 按 0.1 秒的固定步长推进，保证结果与模拟测试一致
        room.acc = (room.acc || 0) + dt;
        let events = room.pending || [];
        room.pending = [];
        while (room.acc >= 0.1 - 1e-9 && g.phase !== 'ended') {
          room.acc -= 0.1;
          events = events.concat(g.step(0.1));
        }
        narrate(room, events);
        broadcastState(room, events);
        if (g.phase === 'ended') {
          recordIfEnded(room);
          broadcastRoom(room);
        }
      } catch (e) {
        console.error('[dorm] 对局循环出错', room.code, e);
      }
    }
  }, TICK_MS);
  loop.unref();

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
        } else if (room.game.phase !== 'ended' && !p.conns.size && room.game.P(p.id).alive) {
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
        d: { id: rid(4), game: 'dorm', gameName: '猛鬼宿舍', path: '/dorm/', from: me.name, fromUser: conn.user.id, code: room.code, title: room.title, detail: `${DIFFICULTY[room.diff].name}难度`, players: room.players.length, max: MAX_PLAYERS },
      };
      for (const c of targets) c.send(msg);
      conn.send({ t: 'toast', d: { msg: `已邀请 ${[...targets][0].user.username}` } });
    },

    inviteReply(conn, d) {
      if (d.accept) return;
      const set = userConns.get(Number(d.fromUser));
      if (!set) return;
      for (const c of set) if (c.room === String(d.code || '') && c.game && c.game.id === 'dorm') c.send({ t: 'toast', d: { msg: `${conn.user.username} 暂时不能加入` } });
    },

    list(conn) {
      const list = [...rooms.values()]
        .filter((r) => !r.private)
        .map((r) => ({
          code: r.code,
          title: r.title,
          diff: r.diff,
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
        title: cleanName(d.title, `${conn.user.username} 的宿舍楼`),
        diff: DIFFICULTY[d.diff] ? d.diff : 'normal',
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
      } else if (!room.game && room.players.length < MAX_PLAYERS) {
        const used = new Set(room.players.map((x) => x.color));
        p = { id: rid(6), userId: conn.user.id, name: conn.user.username, color: COLORS.find((c) => !used.has(c)), isBot: false, botLevel: null, autoBot: false, conns: new Set([conn]) };
        room.players.push(p);
        if (!room.host || !room.players.some((x) => x.id === room.host && !x.isBot)) room.host = p.id;
        systemChat(room, `${p.name} 走进了宿舍楼`);
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
      if (d.diff !== undefined && DIFFICULTY[d.diff]) room.diff = d.diff;
      if (d.title !== undefined) room.title = cleanName(d.title, room.title);
      if (d.private !== undefined) room.private = !!d.private;
      broadcastRoom(room);
    },

    addBot(conn, d) {
      const { room } = ctx(conn, true);
      if (room.game) throw new Error('游戏已开始');
      if (room.players.length >= MAX_PLAYERS) throw new Error('房间已满');
      const level = ['easy', 'normal', 'hard', 'ai'].includes(d.level) ? d.level : 'normal';
      if (level === 'ai' && !ai.enabled()) throw new Error('服务器还没有配置智谱 API Key');
      const used = new Set(room.players.map((x) => x.color));
      const usedNames = new Set(room.players.map((x) => x.name));
      const prefix = level === 'ai' ? '🧠 ' : '🤖 ';
      const pool = level === 'ai' ? AI_NAMES : BOT_NAMES;
      const base = pool.find((n) => !usedNames.has(prefix + n)) || 'Bot';
      room.players.push({ id: rid(6), userId: null, name: prefix + base, color: COLORS.find((c) => !used.has(c)), isBot: true, botLevel: level, autoBot: false, conns: new Set() });
      systemChat(room, `${prefix}${base}（${BOT_TAG[level]}）加入了`);
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
      systemChat(room, `${p.name} 被请出了宿舍楼`);
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
      room.game = new DormGame({ difficulty: room.diff }, room.players.map((p) => ({ id: p.id, name: p.name, color: p.color })));
      room.gameId = rid(6);
      room.recorded = false;
      room.acc = 0;
      room.pending = [{ type: 'start' }];
      for (const p of room.players) {
        p.think = undefined;
        p.aiPlan = null;
        p.aiAt = 0;
      }
      systemChat(room, `熄灯了。${DIFFICULTY[room.diff].name}难度，${Math.round(room.game.D.prep)} 秒后猛鬼醒来，快选一间宿舍躺下！`);
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
      if (!r.ok) throw new Error(r.error);
      // 操作产生的事件随下一次状态一起下发
      room.pending = (room.pending || []).concat(room.game.events.splice(0));
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
    const s = userId ? db.userSummary(userId, 0, 'dorm').stats : null;
    return { rooms: rooms.size, open, playing, myRoom: mine, stats: s };
  }

  function shutdown() {
    clearInterval(loop);
  }

  const routes = {
    'GET /api/dorm/config': async () => publicConfig(),
    'GET /api/dorm/me': async (req) => {
      const user = requireUser(req);
      return { user, ...db.userSummary(user.id, 10, 'dorm') };
    },
    'GET /api/dorm/leaderboard': async (req) => {
      requireUser(req);
      return { rows: db.leaderboard(50, 'dorm') };
    },
  };

  return {
    id: 'dorm',
    handlers,
    routes,
    onConnect() {},
    onClose: leaveRoom,
    kickUser,
    summary,
    presence,
    shutdown,
    rateKey: () => null,
    rooms,
  };
};
