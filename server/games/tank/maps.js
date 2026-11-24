'use strict';

const TILE = 48;
const COLS = 20;
const ROWS = 14;
const BASE = { x: 10, y: 12 };
const ENTRY = [2, 9, 17];
const DOCKS = [8, 11, 6, 13];
const MAPS = {
  depot: {
    name: '零号机库',
    theme: 'depot',
    walls: [
      [4, 2, 2, 3], [14, 2, 2, 3], [8, 5, 4, 1], [2, 8, 3, 1],
      [15, 8, 3, 1], [6, 10, 1, 2], [13, 10, 1, 2],
    ],
    crates: [
      [7, 2, 1, 2], [12, 2, 1, 2], [5, 6, 2, 2], [13, 6, 2, 2],
      [9, 8, 2, 1], [3, 11, 2, 1], [15, 11, 2, 1], [9, 11, 3, 1],
    ],
  },
  canyon: {
    name: '赤砂峡谷',
    theme: 'canyon',
    walls: [
      [3, 2, 4, 1], [13, 2, 4, 1], [2, 5, 2, 2], [16, 5, 2, 2],
      [7, 5, 2, 2], [11, 5, 2, 2], [4, 9, 3, 1], [13, 9, 3, 1],
    ],
    crates: [
      [9, 3, 2, 1], [5, 5, 1, 3], [14, 5, 1, 3], [9, 8, 2, 2],
      [2, 11, 2, 1], [16, 11, 2, 1], [8, 11, 1, 1], [11, 11, 1, 1],
    ],
  },
  foundry: {
    name: '冷潮铸造厂',
    theme: 'foundry',
    walls: [
      [5, 2, 1, 4], [14, 2, 1, 4], [8, 3, 4, 1], [8, 7, 4, 1],
      [2, 7, 2, 2], [16, 7, 2, 2], [4, 10, 2, 1], [14, 10, 2, 1],
    ],
    crates: [
      [2, 3, 2, 1], [16, 3, 2, 1], [6, 6, 2, 1], [12, 6, 2, 1],
      [6, 9, 1, 2], [13, 9, 1, 2], [8, 10, 4, 1],
    ],
  },
};

function terrain(key) {
  const map = MAPS[key];
  const grid = Array(COLS * ROWS).fill(0);
  for (const [value, areas] of [[-1, map.walls], [2, map.crates]]) {
    for (const [x, y, w, h] of areas) {
      for (let row = y; row < y + h; row++) {
        for (let col = x; col < x + w; col++) grid[row * COLS + col] = value;
      }
    }
  }
  return grid;
}

module.exports = { TILE, COLS, ROWS, BASE, ENTRY, DOCKS, MAPS, terrain };
