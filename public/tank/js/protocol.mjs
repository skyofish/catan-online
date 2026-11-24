// 游戏状态的动态对象用定长数组传输，省去每帧重复的字段名。
export function pack({ players, enemies, shots, events, ...state }) {
  return {
    ...state,
    players: players.map((p) => [p.id, p.x, p.y, p.dir, p.hp, p.color, p.lives, +p.shield, p.respawn, p.kills, p.score, p.inputSeq, p.drive]),
    enemies: enemies.map((e) => [e.id, e.x, e.y, e.dir, e.hp, e.type, e.maxHp]),
    shots: shots.map((b) => [b.id, b.x, b.y, b.dir, +b.enemy]),
    events: events.map((e) => e.owner === undefined ? [e.type, e.x, e.y] : [e.type, e.x, e.y, e.owner]),
  };
}

export function unpack({ players, enemies, shots, events, ...state }) {
  return {
    ...state,
    players: players.map(([id, x, y, dir, hp, color, lives, shield, respawn, kills, score, inputSeq, drive]) =>
      ({ id, x, y, dir, hp, color, lives, shield: !!shield, respawn, kills, score, inputSeq, drive })),
    enemies: enemies.map(([id, x, y, dir, hp, type, maxHp]) => ({ id, x, y, dir, hp, type, maxHp })),
    shots: shots.map(([id, x, y, dir, enemy]) => ({ id, x, y, dir, enemy: !!enemy })),
    events: events.map(([type, x, y, owner]) => ({ type, x, y, owner })),
  };
}
