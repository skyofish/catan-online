// 程序绘制的图形：建筑、猛鬼、床、门。坐标单位为「格」，以 (0,0) 为中心，y 轴向下。

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
export { rr };

const ACCENT = { turret: '#c98a4b', thunder: '#e9cf63', frost: '#8fd3ff', mirror: '#d8b45a', repair: '#5fd4b0', generator: '#ffd84d' };
export { ACCENT };

function pips(ctx, lv) {
  const n = Math.min(lv, 10);
  const w = 0.075;
  const gap = 0.03;
  const total = n * w + (n - 1) * gap;
  let x = -total / 2;
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = i >= 5 ? '#ff5a5a' : '#f1d27a';
    ctx.fillRect(x, 0.33, w, 0.07);
    x += w + gap;
  }
}

/**
 * 画一个建筑（单位格，中心在原点）
 * o: { t 时间秒, aim 弩的朝向（弧度）, stunned, charge 0–1 天雷蓄力, plate 是否画底座 }
 */
export function drawBuilding(ctx, type, lv, o = {}) {
  const t = o.t || 0;
  ctx.save();
  if (o.plate !== false) {
    rr(ctx, -0.44, -0.44, 0.88, 0.88, 0.1);
    ctx.fillStyle = 'rgba(16,10,12,0.85)';
    ctx.fill();
    ctx.lineWidth = 0.03;
    ctx.strokeStyle = o.stunned ? '#5a2a8a' : 'rgba(255,255,255,0.08)';
    ctx.stroke();
  }
  const lvl = Math.max(1, lv);
  const s = 0.82 + Math.min(lvl, 8) * 0.025;
  ctx.scale(s, s);
  switch (type) {
    case 'turret': {
      ctx.rotate((o.aim || -Math.PI / 2) + Math.PI / 2);
      // 弩身
      ctx.fillStyle = lvl >= 5 ? '#7a3b1e' : '#8a5a2e';
      rr(ctx, -0.06, -0.3, 0.12, 0.6, 0.03);
      ctx.fill();
      // 弓
      ctx.strokeStyle = lvl >= 6 ? '#e0b44a' : '#b07a3e';
      ctx.lineWidth = 0.07;
      ctx.beginPath();
      ctx.arc(0, 0.05, 0.3, Math.PI * 1.12, Math.PI * 1.88);
      ctx.stroke();
      // 弦
      ctx.strokeStyle = 'rgba(240,230,210,0.8)';
      ctx.lineWidth = 0.015;
      ctx.beginPath();
      ctx.moveTo(-0.28, -0.04);
      ctx.lineTo(0, 0.12);
      ctx.lineTo(0.28, -0.04);
      ctx.stroke();
      // 箭头
      ctx.fillStyle = '#d9d0c0';
      ctx.beginPath();
      ctx.moveTo(0, -0.38);
      ctx.lineTo(-0.05, -0.28);
      ctx.lineTo(0.05, -0.28);
      ctx.fill();
      // 红穗
      ctx.fillStyle = '#c4161f';
      ctx.beginPath();
      ctx.arc(0, 0.3, 0.05, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'thunder': {
      const bob = Math.sin(t * 2.4) * 0.03;
      const glow = 0.3 + (o.charge || 0) * 0.7;
      ctx.shadowColor = `rgba(255,220,90,${glow})`;
      ctx.shadowBlur = 0.35 * 40;
      ctx.translate(0, bob);
      ctx.rotate(Math.sin(t * 1.3) * 0.06);
      ctx.fillStyle = '#e6cf74';
      ctx.fillRect(-0.17, -0.36, 0.34, 0.72);
      ctx.shadowBlur = 0;
      ctx.strokeStyle = '#a3170e';
      ctx.lineWidth = 0.035;
      ctx.strokeRect(-0.13, -0.32, 0.26, 0.64);
      ctx.lineWidth = 0.04;
      ctx.beginPath();
      ctx.moveTo(0, -0.26);
      ctx.lineTo(0, 0.2);
      ctx.moveTo(-0.09, -0.15);
      ctx.lineTo(0.09, -0.15);
      ctx.moveTo(-0.08, -0.02);
      ctx.quadraticCurveTo(0, 0.06, 0.08, -0.02);
      ctx.moveTo(-0.09, 0.12);
      ctx.lineTo(0.06, 0.08);
      ctx.lineTo(-0.04, 0.24);
      ctx.stroke();
      break;
    }
    case 'frost': {
      ctx.fillStyle = 'rgba(143,211,255,0.18)';
      ctx.beginPath();
      ctx.arc(0, 0, 0.42 + Math.sin(t * 1.7) * 0.02, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-0.12, -0.36);
      ctx.lineTo(0.12, -0.36);
      ctx.lineTo(0.22, -0.16);
      ctx.lineTo(0.14, 0.36);
      ctx.lineTo(-0.14, 0.36);
      ctx.lineTo(-0.22, -0.16);
      ctx.closePath();
      const g = ctx.createLinearGradient(-0.2, -0.3, 0.2, 0.3);
      g.addColorStop(0, '#d6f1ff');
      g.addColorStop(1, '#4f8fb8');
      ctx.fillStyle = g;
      ctx.fill();
      ctx.strokeStyle = '#e8f8ff';
      ctx.lineWidth = 0.025;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.beginPath();
      ctx.moveTo(-0.08, -0.22);
      ctx.lineTo(0.06, 0.2);
      ctx.moveTo(0.1, -0.12);
      ctx.lineTo(-0.02, -0.02);
      ctx.stroke();
      break;
    }
    case 'mirror': {
      ctx.rotate(t * 0.3);
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
        ctx.lineTo(Math.cos(a) * 0.38, Math.sin(a) * 0.38);
      }
      ctx.closePath();
      ctx.fillStyle = '#8a6a2a';
      ctx.fill();
      ctx.strokeStyle = '#e8c56a';
      ctx.lineWidth = 0.03;
      ctx.stroke();
      // 八卦短线
      ctx.strokeStyle = '#2a1a0a';
      ctx.lineWidth = 0.03;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * 0.27 - Math.sin(a) * 0.05, Math.sin(a) * 0.27 + Math.cos(a) * 0.05);
        ctx.lineTo(Math.cos(a) * 0.27 + Math.sin(a) * 0.05, Math.sin(a) * 0.27 - Math.cos(a) * 0.05);
        ctx.stroke();
      }
      ctx.rotate(-t * 0.3);
      const g = ctx.createRadialGradient(-0.06, -0.06, 0.02, 0, 0, 0.2);
      g.addColorStop(0, '#f4fbff');
      g.addColorStop(1, '#6f8ea0');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, 0.19, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'repair': {
      ctx.fillStyle = '#2b2326';
      ctx.beginPath();
      ctx.ellipse(0, 0.1, 0.34, 0.2, 0, 0, Math.PI);
      ctx.lineTo(-0.34, 0.1);
      ctx.fill();
      ctx.fillStyle = '#3d3236';
      ctx.beginPath();
      ctx.ellipse(0, 0.06, 0.34, 0.12, 0, 0, Math.PI * 2);
      ctx.fill();
      const g = ctx.createRadialGradient(0, 0.06, 0.02, 0, 0.06, 0.3);
      g.addColorStop(0, '#b8ffe6');
      g.addColorStop(1, '#1f8f74');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(0, 0.06, 0.28, 0.09, 0, 0, Math.PI * 2);
      ctx.fill();
      // 冒起的符灰
      ctx.fillStyle = 'rgba(180,255,230,0.6)';
      for (let i = 0; i < 3; i++) {
        const p = (t * 0.6 + i / 3) % 1;
        ctx.globalAlpha = 1 - p;
        ctx.fillRect(-0.12 + i * 0.12 + Math.sin(t * 3 + i) * 0.03, 0 - p * 0.4, 0.05, 0.05);
      }
      ctx.globalAlpha = 1;
      break;
    }
    case 'generator': {
      ctx.fillStyle = '#4a4f57';
      rr(ctx, -0.32, -0.28, 0.64, 0.58, 0.06);
      ctx.fill();
      ctx.strokeStyle = '#22252a';
      ctx.lineWidth = 0.03;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(-0.24, 0.08 + i * 0.07);
        ctx.lineTo(0.0, 0.08 + i * 0.07);
        ctx.stroke();
      }
      ctx.fillStyle = '#ffd84d';
      ctx.beginPath();
      ctx.moveTo(0.06, -0.22);
      ctx.lineTo(-0.1, 0.0);
      ctx.lineTo(0.0, 0.0);
      ctx.lineTo(-0.06, 0.18);
      ctx.lineTo(0.14, -0.06);
      ctx.lineTo(0.04, -0.06);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = Math.sin(t * 6) > 0 ? '#7dff7d' : '#1d5a1d';
      ctx.beginPath();
      ctx.arc(0.22, 0.18, 0.04, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
  }
  ctx.restore();
  if (lv > 0 && o.pips !== false) {
    ctx.save();
    pips(ctx, lv);
    ctx.restore();
  }
  if (o.stunned) {
    ctx.save();
    ctx.strokeStyle = 'rgba(170,80,255,0.9)';
    ctx.lineWidth = 0.04;
    for (let i = 0; i < 3; i++) {
      const a = t * 4 + (i * Math.PI * 2) / 3;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * 0.25, -0.3 + Math.sin(a) * 0.06, 0.05, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }
}

/**
 * 猛鬼：白衣、长黑发遮脸、血红的眼睛。单位约 1 格宽、1.5 格高，脚底在 (0, 0.5)
 * o: { t, state, hurt 0–1 受击闪白, alpha, attack 0–1 扑击 }
 */
export function drawGhost(ctx, o = {}) {
  const t = o.t || 0;
  ctx.save();
  ctx.globalAlpha = o.alpha === undefined ? 1 : o.alpha;
  const bob = Math.sin(t * 2.2) * 0.06;
  const lunge = (o.attack || 0) * 0.18;
  ctx.translate((o.hurt || 0) * (Math.random() - 0.5) * 0.08, bob - lunge);
  // 影子
  ctx.save();
  ctx.globalAlpha *= 0.45;
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.ellipse(0, 0.62 - bob + lunge, 0.42, 0.12, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // 裙摆（波浪下摆）
  const body = ctx.createLinearGradient(0, -0.6, 0, 0.6);
  // 受击时白衣泛红
  const h = o.hurt || 0;
  body.addColorStop(0, h > 0.3 ? '#ffd9d6' : '#e8e6e2');
  body.addColorStop(0.7, h > 0.3 ? '#d99894' : '#b9b6b2');
  body.addColorStop(1, 'rgba(160,156,152,0.2)');
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(-0.22, -0.45);
  ctx.quadraticCurveTo(-0.42, 0.0, -0.46, 0.5);
  for (let i = 0; i <= 6; i++) {
    const x = -0.46 + (i / 6) * 0.92;
    const y = 0.5 + Math.sin(t * 5 + i * 1.3) * 0.06 + (i % 2 ? 0.06 : -0.02);
    ctx.lineTo(x, y);
  }
  ctx.quadraticCurveTo(0.42, 0.0, 0.22, -0.45);
  ctx.closePath();
  ctx.fill();
  // 手臂（攻击时前伸）
  const arm = 0.12 + (o.attack || 0) * 0.25;
  ctx.strokeStyle = '#d8d5d0';
  ctx.lineWidth = 0.09;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-0.26, -0.18);
  ctx.quadraticCurveTo(-0.42, 0.0 - arm, -0.3, 0.12 - arm * 1.6);
  ctx.moveTo(0.26, -0.18);
  ctx.quadraticCurveTo(0.42, 0.0 - arm, 0.3, 0.12 - arm * 1.6);
  ctx.stroke();
  ctx.strokeStyle = '#8a8682';
  ctx.lineWidth = 0.025;
  for (const sx of [-1, 1]) {
    for (let k = -1; k <= 1; k++) {
      ctx.beginPath();
      ctx.moveTo(sx * 0.3, 0.12 - arm * 1.6);
      ctx.lineTo(sx * (0.3 + k * 0.04), 0.2 - arm * 1.6);
      ctx.stroke();
    }
  }
  // 脸
  ctx.fillStyle = '#d9d6d2';
  ctx.beginPath();
  ctx.ellipse(0, -0.5, 0.18, 0.22, 0, 0, Math.PI * 2);
  ctx.fill();
  // 长发：盖住大半张脸，垂到胸前
  ctx.fillStyle = '#060506';
  ctx.beginPath();
  ctx.moveTo(-0.22, -0.62);
  ctx.quadraticCurveTo(0, -0.86, 0.22, -0.62);
  ctx.lineTo(0.27, -0.1 + Math.sin(t * 3) * 0.03);
  for (let i = 0; i <= 8; i++) {
    const x = 0.27 - (i / 8) * 0.54;
    ctx.lineTo(x, -0.05 + (i % 2 ? 0.08 : 0) + Math.sin(t * 4 + i) * 0.03);
  }
  ctx.lineTo(-0.27, -0.1);
  ctx.closePath();
  ctx.fill();
  // 发缝里露出的脸
  ctx.fillStyle = '#cfcbc6';
  ctx.beginPath();
  ctx.moveTo(-0.05, -0.62);
  ctx.quadraticCurveTo(0.02, -0.45, -0.01, -0.28);
  ctx.quadraticCurveTo(0.06, -0.45, 0.04, -0.62);
  ctx.fill();
  // 眼睛
  const blink = Math.sin(t * 0.9) > 0.97 ? 0.2 : 1;
  ctx.fillStyle = '#ff1e24';
  ctx.shadowColor = '#ff0000';
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.ellipse(-0.06, -0.48, 0.035, 0.022 * blink, 0, 0, Math.PI * 2);
  ctx.ellipse(0.075, -0.48, 0.035, 0.022 * blink, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.restore();
}

// 床（世界坐标，矩形 w×h，横放或竖放都可以）：枕头靠墙
export function drawBed(ctx, r, o = {}) {
  const { x, y, w, h } = r;
  const horiz = w >= h;
  ctx.save();
  ctx.fillStyle = '#3a2618';
  rr(ctx, x + 0.04, y + 0.06, w - 0.08, h - 0.12, 0.08);
  ctx.fill();
  ctx.fillStyle = '#d8d0c4';
  rr(ctx, x + 0.1, y + 0.12, w - 0.2, h - 0.24, 0.06);
  ctx.fill();
  // 枕头在床的「左端」（靠近宿舍左墙那一端）
  const pw = horiz ? 0.42 : w - 0.3;
  const ph = horiz ? h - 0.3 : 0.42;
  const px = x + 0.15;
  const py = o.pillowAtEnd ? y + h - 0.15 - ph : y + 0.15;
  ctx.fillStyle = '#f0ece4';
  rr(ctx, px, py, pw, ph, 0.08);
  ctx.fill();
  if (o.color) {
    // 被子
    ctx.fillStyle = o.color;
    ctx.globalAlpha = o.dead ? 0.35 : 0.85;
    if (horiz) rr(ctx, x + 0.62, y + 0.1, w - 0.72, h - 0.2, 0.08);
    else rr(ctx, x + 0.1, o.pillowAtEnd ? y + 0.1 : y + 0.62, w - 0.2, h - 0.72, 0.08);
    ctx.fill();
    ctx.globalAlpha = 1;
    // 躺着的人：脑袋在枕头上
    ctx.fillStyle = o.dead ? '#6a5a52' : '#e8c8a8';
    ctx.beginPath();
    ctx.arc(px + pw / 2, py + ph / 2, 0.15, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1a1210';
    ctx.beginPath();
    ctx.arc(px + pw / 2, py + ph / 2, 0.15, horiz ? Math.PI * 0.5 : Math.PI, horiz ? Math.PI * 1.5 : Math.PI * 2);
    ctx.fill();
    if (o.dead) {
      ctx.fillStyle = 'rgba(140,0,8,0.8)';
      ctx.beginPath();
      ctx.ellipse(x + w * 0.55, y + h * 0.55, w * 0.32, h * 0.32, 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

// 小图标（UI 按钮用）：画在 size×size 的 canvas 上
export function iconCanvas(type, lv = 1, size = 40) {
  const c = document.createElement('canvas');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = c.height = size * dpr;
  const ctx = c.getContext('2d');
  ctx.scale(size * dpr, size * dpr);
  ctx.translate(0.5, 0.5);
  if (type === 'bed') {
    ctx.translate(-0.5, -0.5);
    drawBed(ctx, { x: 0.02, y: 0.3, w: 0.96, h: 0.42 }, { color: '#9c2a2f' });
  } else if (type === 'door') {
    ctx.fillStyle = '#5a3a24';
    rr(ctx, -0.28, -0.42, 0.56, 0.84, 0.04);
    ctx.fill();
    ctx.strokeStyle = '#2a170c';
    ctx.lineWidth = 0.04;
    ctx.strokeRect(-0.2, -0.34, 0.4, 0.3);
    ctx.strokeRect(-0.2, 0.02, 0.4, 0.32);
    ctx.fillStyle = '#d0b060';
    ctx.beginPath();
    ctx.arc(0.18, 0.02, 0.04, 0, Math.PI * 2);
    ctx.fill();
  } else {
    drawBuilding(ctx, type, lv, { plate: false, pips: false, t: 0.6 });
  }
  return c;
}
