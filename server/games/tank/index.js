'use strict';

const crypto = require('node:crypto');
const { MAPS, TILE, COLS, ROWS, ENTRY, DOCKS } = require('./maps');
const { TankMatch, STEP, WAVE_COUNT } = require('./sim');
const { pack } = require('../../../public/tank/js/protocol.mjs');

const ID = 'tank';
const NAME = '坦克大战：铁线防卫';
const LIMIT = 4;
const COLORS = ['#45d7bb', '#72aaff', '#ffcb72', '#d59af7'];
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 200;
const EXPIRE_MS = 2 * 60_000;
const INPUT_MS = 250;
const MAX_UNACKED = 8;
const maps = Object.entries(MAPS).map(([id, { name, theme }]) => ({ id, name, theme }));
const uuid = () => crypto.randomBytes(6).toString('base64url');
const clean = (s) => typeof s === 'string' ? s.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24) : '';

module.exports = function createTank(platform) {
  const { db, userConns, requireUser } = platform;
  const rooms = new Map();
  const onlineCount = (room) => room.seats.filter((seat) => seat.conns.size).length;

  function newCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
      code = Array.from({ length: 5 }, () => chars[crypto.randomInt(chars.length)]).join('');
    } while (rooms.has(code));
    return code;
  }

  function roomInfo(r) {
    return {
      code: r.code, title: r.title, map: r.map, private: r.private, max: LIMIT, host: r.host, matchId: r.matchId,
      phase: r.match ? (r.match.result ? 'ended' : 'playing') : 'lobby',
      players: r.seats.map(({ id, name, color, conns }) => ({ id, name, color, online: conns.size > 0 })),
    };
  }

  function broadcastRoom(room) {
    const data = roomInfo(room);
    for (const seat of room.seats) {
      const driver = [...seat.conns].at(-1);
      for (const conn of seat.conns) conn.send({ t: 'room', d: { room: data, you: seat.id, control: conn === driver } });
    }
  }

  function resetStream(conn) {
    conn.tankRevision = 0;
    conn.tankGrid = null;
    conn.tankSeen = conn.tankSeq;
  }

  function pushState(room, events = [], only = null) {
    const match = room.match;
    if (!match) return;
    const payload = { ...match.snapshot(), id: room.matchId, events };
    let normal, full, packed;
    for (const seat of room.seats) {
      for (const conn of seat.conns) {
        if (only && conn !== only) continue;
        if (!match.result && conn.socket.writableLength > 12 * 1024) continue;
        if (conn.tankCompact) {
          // 代理和内核可能先接收大量数据，应用层确认才能判断浏览器是否收到。
          if (!match.result && conn.tankSeq - conn.tankSeen >= MAX_UNACKED) continue;
          const d = { ...(packed ??= pack(payload)), n: ++conn.tankSeq };
          if (conn.tankRevision !== match.revision) {
            if (!conn.tankGrid) d.grid = match.grid;
            else {
              d.tiles = [];
              for (const [i, v] of match.grid.entries()) if (v !== conn.tankGrid[i]) d.tiles.push([i, v]);
            }
            conn.tankGrid = match.grid.slice();
          }
          conn.send({ t: 'frame', d });
        } else if (conn.tankRevision === match.revision) {
          conn.send(normal ??= JSON.stringify({ t: 'state', d: payload }));
        } else {
          conn.send(full ??= JSON.stringify({ t: 'state', d: { ...payload, grid: match.grid } }));
        }
        if (conn.tankRevision !== match.revision) {
          conn.tankRevision = match.revision;
        }
      }
    }
  }

  function clearInput(room, seat, resetSeq = false) {
    seat.lastInput = 0;
    room.match?.clearInput(seat.id, resetSeq);
  }

  function chooseHost(room) {
    if (!room.seats.some((p) => p.id === room.host && p.conns.size)) {
      room.host = (room.seats.find((p) => p.conns.size) || room.seats[0])?.id ?? null;
    }
  }

  function removeSeat(room, seat) {
    room.seats = room.seats.filter((p) => p !== seat);
  }

  function leave(conn, explicit = false) {
    const room = rooms.get(conn.tankRoom);
    conn.tankRoom = null;
    if (!room) return;
    const seat = room.seats.find((p) => p.conns.has(conn));
    if (!seat) return;
    const controlling = [...seat.conns].at(-1) === conn;
    seat.conns.delete(conn);
    if (controlling) clearInput(room, seat, true);
    if (!seat.conns.size) seat.offlineSince = Date.now();
    if (!seat.conns.size && explicit && !room.match) removeSeat(room, seat);
    if (!onlineCount(room)) room.emptySince = Date.now();
    if (!room.seats.length) {
      rooms.delete(room.code);
      return;
    }
    chooseHost(room);
    broadcastRoom(room);
  }

  function context(conn, hostOnly = false) {
    const room = rooms.get(conn.tankRoom);
    const seat = room?.seats.find((p) => p.conns.has(conn));
    if (!seat) throw new Error('请先加入编队');
    if (hostOnly && room.host !== seat.id) throw new Error('只有房主可以执行此操作');
    return { room, seat };
  }

  function joinRoom(conn, room) {
    let seat = room.seats.find((p) => p.id === conn.user.id);
    if (!seat && room.match) throw new Error('这支编队已出发，请等待下一局');
    if (!seat && room.seats.length >= LIMIT) throw new Error('编队已满，最多四人');
    if (conn.tankRoom !== room.code) leave(conn, true);
    if (!seat) {
      seat = { id: conn.user.id, name: conn.user.username, conns: new Set(), lastInput: 0,
        color: COLORS.find((color) => !room.seats.some((p) => p.color === color)) };
      room.seats.push(seat);
    }
    if (!seat.conns.has(conn)) {
      seat.conns.add(conn);
      clearInput(room, seat, true);
    }
    conn.tankRoom = room.code;
    resetStream(conn);
    room.emptySince = null;
    chooseHost(room);
    broadcastRoom(room);
    pushState(room, [], conn);
  }

  function record(room) {
    const match = room.match;
    const ordered = match.players.slice().sort((a, b) => b.score - a.score);
    const players = match.players.map((p, seat) => {
      const member = room.seats.find(({ id }) => id === p.id);
      return {
        seat, userId: p.id, name: member.name, color: p.color, isBot: false, vp: p.score,
        rank: ordered.findIndex((player) => player.score === p.score) + 1,
        isWinner: match.result.won, stats: { kills: p.kills, damage: p.damage, wave: match.wave, core: match.core.hp },
      };
    });
    db.recordMatch({
      game: ID, roomCode: room.code, size: players.length, targetVP: WAVE_COUNT,
      turns: Math.round(match.elapsed), startedAt: match.startedAt, endedAt: Date.now(),
    }, players);
  }

  const handlers = {
    sync(conn, d) {
      if (d.v === 2 && !conn.tankCompact) {
        conn.tankCompact = true;
        resetStream(conn);
      }
    },

    ack(conn, d) {
      const room = rooms.get(conn.tankRoom);
      if (room?.match && d.id === room.matchId && Number.isSafeInteger(d.n) && d.n > conn.tankSeen && d.n <= conn.tankSeq) {
        conn.tankSeen = d.n;
      }
    },

    ping(conn, d) {
      if (Number.isFinite(d.n)) conn.send({ t: 'pong', d: { n: d.n } });
    },

    list(conn) {
      const available = [];
      for (const room of rooms.values()) {
        const mine = room.seats.some((p) => p.id === conn.user.id);
        if (!mine && (room.private || !onlineCount(room))) continue;
        available.push({ code: room.code, title: room.title, map: room.map, players: room.seats.length,
          max: LIMIT, mine, started: !!room.match, private: room.private });
      }
      available.sort((a, b) => Number(b.mine) - Number(a.mine) || Number(a.started) - Number(b.started));
      conn.send({ t: 'rooms', d: available.slice(0, 60) });
    },

    create(conn, d) {
      if (rooms.size >= MAX_ROOMS) throw new Error('服务器房间已满，请稍后再试');
      const code = newCode();
      const room = {
        code, title: clean(d.title) || `${conn.user.username} 的编队`, map: Object.hasOwn(MAPS, d.map) ? d.map : 'depot',
        private: d.private === true, host: null, seats: [], match: null, matchId: null, invited: new Map(), emptySince: null, acc: 0,
      };
      rooms.set(code, room);
      joinRoom(conn, room);
    },

    join(conn, d) {
      const room = rooms.get(clean(d.code).toUpperCase());
      if (!room) throw new Error('房间不存在或已关闭');
      joinRoom(conn, room);
    },

    leave(conn) {
      leave(conn, true);
      conn.send({ t: 'left' });
    },

    configure(conn, d) {
      const { room } = context(conn, true);
      if (room.match || !Object.hasOwn(MAPS, d.map)) return;
      room.map = d.map;
      broadcastRoom(room);
    },

    start(conn) {
      const { room } = context(conn, true);
      if (room.match) throw new Error('请先返回编队');
      room.seats = room.seats.filter((p) => p.conns.size);
      room.acc = 0;
      room.match = new TankMatch(room.map, room.seats);
      room.matchId = uuid();
      for (const p of room.seats) for (const c of p.conns) resetStream(c);
      broadcastRoom(room);
      pushState(room);
    },

    rematch(conn) {
      const { room } = context(conn, true);
      if (!room.match?.result) return;
      room.match = null;
      room.matchId = null;
      room.seats = room.seats.filter((p) => p.conns.size);
      room.invited.clear();
      broadcastRoom(room);
    },

    input(conn, d) {
      const room = rooms.get(conn.tankRoom);
      if (!room?.match || room.match.result) return;
      const seat = room.seats.find((p) => p.conns.has(conn));
      if (!seat || [...seat.conns].at(-1) !== conn) return;
      const dir = Number.isInteger(d.dir) && d.dir >= 0 && d.dir < 4 ? d.dir : -1;
      const seq = conn.tankCompact && Number.isSafeInteger(d.n) && d.n > 0 ? d.n : 0;
      room.match.setInput(seat.id, { dir, fire: d.fire === true, seq });
      seat.lastInput = Date.now();
    },

    online(conn) {
      const { room } = context(conn);
      const now = Date.now();
      const users = [];
      for (const [uid, set] of userConns) {
        if (room.seats.some((p) => p.id === uid)) continue;
        users.push({ id: uid, username: set.values().next().value.user.username,
          status: platform.presence(uid), invited: now - (room.invited.get(uid)?.at || 0) < 30_000 });
      }
      const order = { idle: 0, room: 1, playing: 2 };
      users.sort((a, b) => order[a.status] - order[b.status] || a.username.localeCompare(b.username, 'zh'));
      conn.send({ t: 'online', d: users });
    },

    invite(conn, d) {
      const { room, seat } = context(conn);
      if (room.match || room.seats.length >= LIMIT) throw new Error('当前无法邀请更多队友');
      const uid = Number(d.userId);
      const targets = userConns.get(uid);
      if (!targets?.size) throw new Error('对方已离线');
      if (room.seats.some((p) => p.id === uid)) throw new Error('对方已在编队中');
      const now = Date.now();
      if (now - (room.invited.get(uid)?.at || 0) < 30_000) throw new Error('刚刚邀请过，请稍后再试');
      for (const [key, invite] of room.invited) if (now - invite.at >= 30_000) room.invited.delete(key);
      const id = uuid();
      room.invited.set(uid, { id, at: now, from: seat.id, answered: false });
      const message = { t: 'invite', d: {
        id, game: ID, gameName: NAME, path: '/tank/', from: seat.name, fromUser: seat.id,
        title: room.title, code: room.code, detail: MAPS[room.map].name, players: room.seats.length, max: LIMIT,
      } };
      for (const target of targets) target.send(message);
      conn.send({ t: 'toast', d: { msg: `已邀请 ${targets.values().next().value.user.username}` } });
    },

    inviteReply(conn, d) {
      const room = rooms.get(clean(d.code).toUpperCase());
      const invite = room?.invited.get(conn.user.id);
      if (!invite || invite.answered || Date.now() - invite.at >= 30_000 || Number(d.fromUser) !== invite.from) return;
      invite.answered = true;
      if (d.accept) return;
      const sender = room.seats.find((seat) => seat.id === invite.from);
      if (sender) for (const c of sender.conns) c.send({ t: 'toast', d: { msg: `${conn.user.username} 暂时不能加入` } });
    },
  };

  let previousTick = Date.now();
  const loop = setInterval(() => {
    const now = Date.now();
    const dt = Math.min(0.15, (now - previousTick) / 1000);
    previousTick = now;
    for (const room of rooms.values()) {
      if (room.emptySince !== null && now - room.emptySince > EXPIRE_MS) {
        rooms.delete(room.code);
        continue;
      }
      const match = room.match;
      if (!match && room.emptySince === null) {
        const seats = room.seats.filter((p) => p.conns.size || now - p.offlineSince < 25_000);
        if (seats.length !== room.seats.length) {
          room.seats = seats;
          broadcastRoom(room);
        }
      }
      if (!match || match.result || room.emptySince !== null) continue;
      for (const seat of room.seats) {
        if (seat.lastInput && now - seat.lastInput > INPUT_MS) clearInput(room, seat);
      }
      room.acc += dt;
      while (room.acc >= STEP && !match.result) {
        room.acc -= STEP;
        match.step();
      }
      if (match.result) {
        try {
          record(room);
        } catch (error) {
          console.error('[tank] 无法记录战绩', room.code, error);
        }
        broadcastRoom(room);
      }
      pushState(room, match.events.splice(0));
    }
  }, 50);
  loop.unref();

  function kickUser(userId) {
    for (const room of rooms.values()) {
      const seat = room.seats.find((p) => p.id === userId);
      if (!seat) continue;
      for (const conn of [...seat.conns]) leave(conn, true);
      if (!room.match) {
        removeSeat(room, seat);
        chooseHost(room);
        if (room.seats.length) broadcastRoom(room);
        else rooms.delete(room.code);
      }
    }
  }

  function presence(userId) {
    let status = null;
    for (const room of rooms.values()) {
      if (!room.seats.some((p) => p.id === userId && p.conns.size)) continue;
      if (room.match && !room.match.result) return 'playing';
      status = 'room';
    }
    return status;
  }

  function summary(userId) {
    let open = 0;
    let playing = 0;
    let myRoom = null;
    for (const room of rooms.values()) {
      const running = room.match && !room.match.result;
      if (running && room.seats.some((p) => p.id === userId)) myRoom = room.code;
      if (room.private) continue;
      if (running) playing += onlineCount(room);
      else if (!room.match && onlineCount(room) && room.seats.length < LIMIT) open++;
    }
    return { rooms: rooms.size, open, playing, myRoom, stats: db.userSummary(userId, 0, ID).stats };
  }

  const routes = {
    'GET /api/tank/config': async () => ({ maps, tile: TILE, cols: COLS, rows: ROWS, entry: ENTRY, docks: DOCKS, waves: WAVE_COUNT, max: LIMIT }),
    'GET /api/tank/me': async (req) => {
      const user = requireUser(req);
      return { user, ...db.userSummary(user.id, 10, ID) };
    },
  };

  return {
    id: ID, rooms, handlers, routes, summary, presence, kickUser, onClose: leave,
    onConnect(conn) { conn.tankSeq = conn.tankSeen = 0; },
    shutdown: () => clearInterval(loop),
    rateKey: (type) => type === 'input' || type === 'ack' || type === 'ping',
  };
};
