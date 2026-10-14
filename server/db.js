'use strict';
// SQLite 数据层（使用 Node 22 内置的 node:sqlite，无第三方依赖）。
// 所有数据库读写集中在这里，以后要换 PostgreSQL 只需改这个文件。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const USER_SESSION_DAYS = 180;
const ADMIN_SESSION_HOURS = 12;

let db = null;
const st = {}; // 预编译语句

function open(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 3000;
  `);
  migrate();
  prepare();
  // 清理过期会话
  st.purgeSessions.run(Date.now());
  return db;
}

function migrate() {
  const v = db.prepare('PRAGMA user_version').get().user_version;
  if (v < 1) {
    db.exec(`
      BEGIN;
      CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
        enabled       INTEGER NOT NULL DEFAULT 1,
        created_at    INTEGER NOT NULL,
        last_login_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token      TEXT PRIMARY KEY,
        kind       TEXT NOT NULL CHECK (kind IN ('user', 'admin')),
        user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE TABLE IF NOT EXISTS rooms (
        code       TEXT PRIMARY KEY,
        data       TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS matches (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        room_code  TEXT NOT NULL,
        size       INTEGER NOT NULL,
        target_vp  INTEGER NOT NULL,
        turns      INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at   INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS match_players (
        match_id  INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
        seat      INTEGER NOT NULL,
        user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        name      TEXT NOT NULL,
        color     TEXT NOT NULL,
        is_bot    INTEGER NOT NULL,
        vp        INTEGER NOT NULL,
        rank      INTEGER NOT NULL,
        is_winner INTEGER NOT NULL,
        stats     TEXT,
        PRIMARY KEY (match_id, seat)
      );
      CREATE INDEX IF NOT EXISTS idx_mp_user ON match_players(user_id);
      PRAGMA user_version = 1;
      COMMIT;
    `);
  }
}

function prepare() {
  st.purgeSessions = db.prepare('DELETE FROM sessions WHERE expires_at < ?');
  st.userByName = db.prepare('SELECT * FROM users WHERE username = ?');
  st.userById = db.prepare('SELECT * FROM users WHERE id = ?');
  st.insertUser = db.prepare('INSERT INTO users (username, enabled, created_at) VALUES (?, 1, ?)');
  st.setEnabled = db.prepare('UPDATE users SET enabled = ? WHERE id = ?');
  st.deleteUser = db.prepare('DELETE FROM users WHERE id = ?');
  st.touchLogin = db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?');
  st.insertSession = db.prepare('INSERT INTO sessions (token, kind, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)');
  st.session = db.prepare('SELECT * FROM sessions WHERE token = ? AND expires_at > ?');
  st.deleteSession = db.prepare('DELETE FROM sessions WHERE token = ?');
  st.deleteUserSessions = db.prepare('DELETE FROM sessions WHERE user_id = ?');
  st.listUsers = db.prepare(`
    SELECT u.id, u.username, u.enabled, u.created_at, u.last_login_at,
           COUNT(mp.match_id) AS games, COALESCE(SUM(mp.is_winner), 0) AS wins
    FROM users u LEFT JOIN match_players mp ON mp.user_id = u.id
    GROUP BY u.id ORDER BY u.created_at DESC, u.id DESC`);
  st.upsertRoom = db.prepare(`INSERT INTO rooms (code, data, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`);
  st.deleteRoom = db.prepare('DELETE FROM rooms WHERE code = ?');
  st.allRooms = db.prepare('SELECT code, data FROM rooms');
  st.insertMatch = db.prepare('INSERT INTO matches (room_code, size, target_vp, turns, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)');
  st.insertMP = db.prepare(`INSERT INTO match_players (match_id, seat, user_id, name, color, is_bot, vp, rank, is_winner, stats)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  st.leaderboard = db.prepare(`
    SELECT u.id, u.username, COUNT(*) AS games, SUM(mp.is_winner) AS wins,
           ROUND(AVG(mp.vp), 1) AS avg_vp, MAX(m.ended_at) AS last_played
    FROM match_players mp
    JOIN users u ON u.id = mp.user_id
    JOIN matches m ON m.id = mp.match_id
    WHERE u.enabled = 1
    GROUP BY u.id
    ORDER BY wins DESC, CAST(wins AS REAL) / COUNT(*) DESC, games DESC, u.username
    LIMIT ?`);
  st.userStats = db.prepare(`
    SELECT COUNT(*) AS games, COALESCE(SUM(is_winner), 0) AS wins, ROUND(AVG(vp), 1) AS avg_vp
    FROM match_players WHERE user_id = ?`);
  st.recentMatches = db.prepare(`
    SELECT m.id, m.size, m.target_vp, m.turns, m.started_at, m.ended_at,
           mp.vp, mp.rank, mp.is_winner,
           (SELECT COUNT(*) FROM match_players x WHERE x.match_id = m.id) AS players,
           (SELECT name FROM match_players w WHERE w.match_id = m.id AND w.is_winner = 1) AS winner
    FROM match_players mp JOIN matches m ON m.id = mp.match_id
    WHERE mp.user_id = ?
    ORDER BY m.ended_at DESC LIMIT ?`);
}

const token = () => crypto.randomBytes(24).toString('base64url');

// ---------------- 用户 ----------------
const USERNAME_RE = /^[\p{L}\p{N}_.\-]{1,16}$/u;

function validUsername(name) {
  return typeof name === 'string' && USERNAME_RE.test(name);
}

function createUser(username) {
  username = String(username || '').trim();
  if (!validUsername(username)) throw new Error('账号只能包含中英文、数字、_ . -，长度 1–16');
  if (st.userByName.get(username)) throw new Error('账号已存在');
  const r = st.insertUser.run(username, Date.now());
  return st.userById.get(Number(r.lastInsertRowid));
}

const getUser = (id) => st.userById.get(id) || null;
const getUserByName = (name) => st.userByName.get(String(name || '').trim()) || null;

function setUserEnabled(id, enabled) {
  st.setEnabled.run(enabled ? 1 : 0, id);
  if (!enabled) st.deleteUserSessions.run(id);
  return getUser(id);
}

function deleteUser(id) {
  return st.deleteUser.run(id).changes > 0; // 会话级联删除，战绩中的 user_id 置空、保留名字
}

function listUsers() {
  return st.listUsers.all();
}

// ---------------- 会话 ----------------
function loginUser(username) {
  const u = getUserByName(username);
  if (!u) throw new Error('账号不存在，请联系管理员开通');
  if (!u.enabled) throw new Error('该账号已被禁用');
  const t = token();
  const now = Date.now();
  st.insertSession.run(t, 'user', u.id, now, now + USER_SESSION_DAYS * 86400000);
  st.touchLogin.run(now, u.id);
  return { token: t, user: publicUser(u) };
}

function createAdminSession() {
  const t = token();
  const now = Date.now();
  st.insertSession.run(t, 'admin', null, now, now + ADMIN_SESSION_HOURS * 3600000);
  return t;
}

// 返回 { kind, user } 或 null；禁用的用户视为无效
function checkSession(t, kind) {
  if (typeof t !== 'string' || t.length < 20 || t.length > 64) return null;
  const s = st.session.get(t, Date.now());
  if (!s || s.kind !== kind) return null;
  if (kind === 'admin') return { kind };
  const u = getUser(s.user_id);
  if (!u || !u.enabled) return null;
  return { kind, user: publicUser(u) };
}

function logout(t) {
  if (typeof t === 'string') st.deleteSession.run(t);
}

const publicUser = (u) => ({ id: u.id, username: u.username });

// ---------------- 房间快照 ----------------
function saveRoom(code, data) {
  st.upsertRoom.run(code, JSON.stringify(data), Date.now());
}
function deleteRoom(code) {
  st.deleteRoom.run(code);
}
function loadRooms() {
  const out = [];
  for (const r of st.allRooms.all()) {
    try {
      out.push(JSON.parse(r.data));
    } catch {
      st.deleteRoom.run(r.code);
    }
  }
  return out;
}

// ---------------- 战绩 ----------------
// players: [{ seat, userId, name, color, isBot, vp, rank, isWinner, stats }]
function recordMatch(m, players) {
  db.exec('BEGIN');
  try {
    const r = st.insertMatch.run(m.roomCode, m.size, m.targetVP, m.turns, m.startedAt, m.endedAt);
    const id = Number(r.lastInsertRowid);
    for (const p of players) {
      const uid = p.userId && getUser(p.userId) ? p.userId : null;
      st.insertMP.run(id, p.seat, uid, p.name, p.color, p.isBot ? 1 : 0, p.vp, p.rank, p.isWinner ? 1 : 0, p.stats ? JSON.stringify(p.stats) : null);
    }
    db.exec('COMMIT');
    return id;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function leaderboard(limit = 50) {
  return st.leaderboard.all(limit);
}

function userSummary(userId, limit = 10) {
  return { stats: st.userStats.get(userId), recent: st.recentMatches.all(userId, limit) };
}

function close() {
  if (db) {
    try {
      db.close();
    } catch {}
    db = null;
  }
}

module.exports = {
  open,
  close,
  validUsername,
  createUser,
  getUser,
  getUserByName,
  setUserEnabled,
  deleteUser,
  listUsers,
  loginUser,
  createAdminSession,
  checkSession,
  logout,
  saveRoom,
  deleteRoom,
  loadRooms,
  recordMatch,
  leaderboard,
  userSummary,
};
