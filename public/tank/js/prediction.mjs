import { blocked, drive, STEP } from './movement.mjs';

const MAX_LATENCY = 200;
const MAX_AFTER_FRAME = 125;
const MAX_AGE = 400;
const CORRECTION_MS = 85;

export function createPrediction() {
  let confirmed = null;
  let commands = [];
  let receivedAt = 0;
  let arena;
  let correction;
  let latency = 40;

  function reset() {
    confirmed = null;
    commands = [];
    correction = null;
  }

  function setLatency(ms) {
    latency = Math.max(0, Math.min(ms, MAX_LATENCY));
  }

  function input(dir, seq, now) {
    commands.push({ dir, seq, at: now });
    if (commands.length > 32) commands.shift();
  }

  function project(now) {
    if (!confirmed?.hp || now - receivedAt > MAX_AGE) return null;
    const tank = { x: confirmed.x, y: confirmed.y, dir: confirmed.dir };
    let cursor = receivedAt - latency;
    const end = Math.min(now, receivedAt + MAX_AFTER_FRAME);
    let direction = confirmed.drive;
    function advance(until) {
      if (direction >= 0) {
        let seconds = (until - cursor) / 1000;
        while (seconds > 1e-6) {
          const dt = Math.min(STEP, seconds);
          drive(tank, arena, direction, dt);
          seconds -= dt;
        }
        tank.dir = direction;
      }
      cursor = until;
    }
    for (const command of commands) {
      advance(Math.min(end, Math.max(cursor, command.at)));
      direction = command.dir;
    }
    advance(end);
    return tank;
  }

  function pose(now) {
    const tank = project(now);
    if (!tank || !correction) return tank;
    const weight = Math.max(0, 1 - (now - correction.at) / CORRECTION_MS);
    const x = tank.x + correction.x * weight;
    const y = tank.y + correction.y * weight;
    if (weight && !blocked(arena, x, y)) {
      tank.x = x;
      tank.y = y;
    }
    return tank;
  }

  function receive(player, nextArena, now) {
    const old = pose(now);
    const previous = confirmed;
    confirmed = player;
    arena = nextArena;
    receivedAt = now;
    commands = commands.filter(({ seq }) => seq > player.inputSeq);
    correction = null;
    // 跨障碍、复活或较大误差时直接跟随服务器位置，避免滑过墙体。
    const next = project(now);
    if (!old || !next || previous.lives !== player.lives) return;
    const x = old.x - next.x;
    const y = old.y - next.y;
    const distance = Math.hypot(x, y);
    if (distance >= 1 && distance < 32) correction = { x, y, at: now };
  }

  return { receive, input, pose, reset, setLatency };
}
