// 雾夜追猎：3D 场景（Three.js）。哥特暗黑童话的人偶剧场质感：冷雾、月光、低饱和，角色是大头细肢的缝线人偶。
// 性能做法（手机上要稳 60 帧）：
//  - 多部件模型按"关节"烘焙成带顶点色的单个几何体（一个角色约 10 次绘制），顶点色里顺带压了一层由下到上的明暗；
//  - 墙、障碍、木板、铁笼、路灯、草丛、树全部用 InstancedMesh，一类一次绘制；
//  - 不开实时阴影：角色脚下用圆影，墙根用一层实例化的暗斑；
//  - 帧时间超标时自动降低渲染分辨率，恢复后再升回去。
import * as THREE from '/farm/vendor/three.module.min.js';

const TAU = Math.PI * 2;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const damp = (rate, dt) => 1 - Math.exp(-rate * dt);
const lerpAng = (a, b, t) => {
  let d = b - a;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  return a + d * t;
};
const hash = (x, z) => {
  const v = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return v - Math.floor(v);
};

const THEMES = {
  circus: { sky: 0x1c2740, fog: 0x3c4a62, fogD: 0.021, ground: ['#4a5440', '#5e5a44', '#3a4434'], wall: ['#8a343c', '#e0d4b8'], low: '#8a6440', hemi: [0xaec4e6, 0x4a4238], moon: 0xcfdcf6, lamp: 0xffc060, grass: '#55683c' },
  harbor: { sky: 0x18222e, fog: 0x3a4c58, fogD: 0.023, ground: ['#48525a', '#58646a', '#3a444c'], wall: ['#3a6a78', '#4c808a'], low: '#7a6248', hemi: [0xa6c6d8, 0x3a4048], moon: 0xc4dcea, lamp: 0xf0d090, grass: '#4c5a50' },
  garden: { sky: 0x1a2632, fog: 0x3e5050, fogD: 0.022, ground: ['#44543e', '#525e48', '#36463a'], wall: ['#2e6240', '#3c7a4e'], low: '#7c7c70', hemi: [0xb4d2c8, 0x3a463c], moon: 0xd4e8dc, lamp: 0xd8f0b0, grass: '#4f7a44' },
};

// ======================= 程序贴图 =======================
function canvasTex(size, draw, repeat = 1) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  return t;
}
function speckle(g, s, n, colors, rMin, rMax, alpha = 0.5) {
  for (let i = 0; i < n; i++) {
    g.fillStyle = colors[i % colors.length];
    g.globalAlpha = alpha * (0.4 + Math.random() * 0.6);
    const r = rMin + Math.random() * (rMax - rMin);
    g.beginPath();
    g.ellipse(Math.random() * s, Math.random() * s, r, r * (0.4 + Math.random() * 0.6), Math.random() * 3, 0, TAU);
    g.fill();
  }
  g.globalAlpha = 1;
}
function groundTex(theme, th) {
  return canvasTex(512, (g, s) => {
    g.fillStyle = th.ground[0];
    g.fillRect(0, 0, s, s);
    if (theme === 'harbor') {
      // 湿漉漉的石板路
      const n = 8;
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) {
          const w = s / n;
          const off = j % 2 ? w / 2 : 0;
          const v = 60 + Math.random() * 30;
          g.fillStyle = `rgb(${v},${v + 10},${v + 16})`;
          g.beginPath();
          g.roundRect(((i * w + off) % s) + 2, j * w + 2, w - 4, w - 4, 8);
          g.fill();
        }
      speckle(g, s, 500, ['#20282e', '#6a787e'], 1, 5, 0.35);
      g.globalAlpha = 0.18;
      g.fillStyle = '#9ab4c0';
      for (let i = 0; i < 14; i++) {
        g.beginPath();
        g.ellipse(Math.random() * s, Math.random() * s, 20 + Math.random() * 40, 8 + Math.random() * 14, Math.random() * 3, 0, TAU);
        g.fill();
      }
    } else {
      speckle(g, s, 2600, [th.ground[1], th.ground[2]], 1, 7, 0.5);
      // 踩出来的土路
      g.globalAlpha = 0.25;
      g.strokeStyle = theme === 'circus' ? '#6a5a40' : '#5a5a48';
      g.lineWidth = 46;
      g.lineCap = 'round';
      for (let i = 0; i < 3; i++) {
        g.beginPath();
        g.moveTo(Math.random() * s, -40);
        g.bezierCurveTo(Math.random() * s, s * 0.3, Math.random() * s, s * 0.7, Math.random() * s, s + 40);
        g.stroke();
      }
      g.globalAlpha = 1;
      speckle(g, s, 500, theme === 'circus' ? ['#8a7a4a', '#2a3020'] : ['#6a8a5a', '#2a3a2a'], 0.6, 2, 0.6);
    }
    g.globalAlpha = 1;
  }, 12);
}
function wallTex(theme, th) {
  return canvasTex(256, (g, s) => {
    if (theme === 'circus') {
      // 褪色的条纹篷布：布纹、水渍、底边的泥
      for (let i = 0; i < 4; i++) {
        g.fillStyle = th.wall[i % 2];
        g.fillRect((i * s) / 4, 0, s / 4, s);
        g.fillStyle = 'rgba(0,0,0,.18)';
        g.fillRect((i * s) / 4, 0, 3, s);
      }
      g.globalAlpha = 0.07;
      g.fillStyle = '#000';
      for (let y = 0; y < s; y += 3) g.fillRect(0, y, s, 1);
      g.globalAlpha = 1;
      for (let i = 0; i < 26; i++) {
        const x = Math.random() * s;
        const gr = g.createLinearGradient(0, 0, 0, s);
        gr.addColorStop(0, 'rgba(30,20,20,.3)');
        gr.addColorStop(0.4 + Math.random() * 0.5, 'rgba(30,20,20,0)');
        g.fillStyle = gr;
        g.fillRect(x, 0, 3 + Math.random() * 10, s);
      }
      const gr = g.createLinearGradient(0, s * 0.8, 0, s);
      gr.addColorStop(0, 'rgba(20,16,12,0)');
      gr.addColorStop(1, 'rgba(20,16,12,.75)');
      g.fillStyle = gr;
      g.fillRect(0, s * 0.8, s, s * 0.2);
      // 补丁
      g.fillStyle = 'rgba(90,80,60,.55)';
      g.fillRect(150, 90, 34, 28);
      g.strokeStyle = 'rgba(20,14,10,.8)';
      g.setLineDash([4, 3]);
      g.strokeRect(150, 90, 34, 28);
      g.setLineDash([]);
    } else if (theme === 'harbor') {
      // 生锈的波纹铁皮货柜
      g.fillStyle = th.wall[0];
      g.fillRect(0, 0, s, s);
      for (let i = 0; i < 12; i++) {
        const x = (i * s) / 12;
        const gr = g.createLinearGradient(x, 0, x + s / 12, 0);
        gr.addColorStop(0, 'rgba(0,0,0,.28)');
        gr.addColorStop(0.5, 'rgba(255,255,255,.1)');
        gr.addColorStop(1, 'rgba(0,0,0,.28)');
        g.fillStyle = gr;
        g.fillRect(x, 0, s / 12, s);
      }
      for (let i = 0; i < 90; i++) {
        g.fillStyle = `rgba(${130 + Math.random() * 60},${60 + Math.random() * 30},30,${0.12 + Math.random() * 0.3})`;
        const x = Math.random() * s;
        const y = Math.random() * s;
        g.fillRect(x, y, 3 + Math.random() * 10, 6 + Math.random() * 40);
      }
      g.fillStyle = 'rgba(0,0,0,.35)';
      g.fillRect(0, 0, s, 8);
      g.fillRect(0, s - 10, s, 10);
      g.fillStyle = 'rgba(230,230,220,.5)';
      g.font = 'bold 26px monospace';
      g.fillText('N° 7', 150, 70);
    } else {
      // 修剪过的树篱：层层叠叠的叶子
      g.fillStyle = '#1c3c28';
      g.fillRect(0, 0, s, s);
      for (let i = 0; i < 2600; i++) {
        const v = Math.random();
        g.fillStyle = v > 0.7 ? th.wall[1] : v > 0.35 ? th.wall[0] : v > 0.1 ? '#1a3424' : '#5a8a50';
        g.beginPath();
        g.ellipse(Math.random() * s, Math.random() * s, 4 + Math.random() * 4, 2.2, Math.random() * 3, 0, TAU);
        g.fill();
      }
      const gr = g.createLinearGradient(0, s * 0.7, 0, s);
      gr.addColorStop(0, 'rgba(8,16,10,0)');
      gr.addColorStop(1, 'rgba(8,16,10,.7)');
      g.fillStyle = gr;
      g.fillRect(0, s * 0.7, s, s * 0.3);
    }
  });
}
function crateTex(base) {
  return canvasTex(128, (g, s) => {
    g.fillStyle = base;
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < 5; i++) {
      g.fillStyle = `rgba(0,0,0,${0.05 + Math.random() * 0.12})`;
      g.fillRect(0, (i * s) / 5, s, s / 5 - 2);
      g.fillStyle = 'rgba(0,0,0,.45)';
      g.fillRect(0, (i * s) / 5 - 1, s, 2);
    }
    g.strokeStyle = 'rgba(40,26,14,.9)';
    g.lineWidth = 12;
    g.strokeRect(6, 6, s - 12, s - 12);
    g.beginPath();
    g.moveTo(10, 10);
    g.lineTo(s - 10, s - 10);
    g.stroke();
    g.fillStyle = 'rgba(200,200,190,.6)';
    for (const [x, y] of [[10, 10], [s - 10, 10], [10, s - 10], [s - 10, s - 10]]) {
      g.beginPath();
      g.arc(x, y, 3, 0, TAU);
      g.fill();
    }
  });
}
function textSprite(text, color = '#e8e4d0', size = 0.5) {
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  g.font = '600 40px system-ui, sans-serif';
  c.width = Math.ceil(g.measureText(text).width) + 24;
  c.height = 56;
  g.font = '600 40px system-ui, sans-serif';
  g.textBaseline = 'middle';
  g.lineWidth = 6;
  g.strokeStyle = 'rgba(0,0,0,.75)';
  g.strokeText(text, 12, 30);
  g.fillStyle = color;
  g.fillText(text, 12, 30);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true }));
  sp.scale.set((size * c.width) / c.height, size, 1);
  sp.renderOrder = 10;
  return sp;
}
function glowTex() {
  return canvasTex(64, (g, s) => {
    const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.3, 'rgba(255,255,255,.5)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, s, s);
  });
}

// ======================= 建模小工具 =======================
const GEO = {
  box: new THREE.BoxGeometry(1, 1, 1),
  sph: new THREE.SphereGeometry(1, 16, 11),
  sphLo: new THREE.SphereGeometry(1, 7, 5),
  cyl: new THREE.CylinderGeometry(1, 1, 1, 10),
  cylLo: new THREE.CylinderGeometry(1, 1, 1, 5),
  taper: new THREE.CylinderGeometry(0.72, 1, 1, 10),
  cone: new THREE.ConeGeometry(1, 1, 12),
  coneLo: new THREE.ConeGeometry(1, 1, 4),
  disc: new THREE.CircleGeometry(1, 20),
  plane: new THREE.PlaneGeometry(1, 1),
  tor: new THREE.TorusGeometry(1, 0.07, 5, 12),
  torFat: new THREE.TorusGeometry(1, 0.22, 6, 12),
};
// 所有烘焙出来的模型共用一个材质（顶点色）
const VCOL = new THREE.MeshLambertMaterial({ vertexColors: true });
const GHOST = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.3, depthWrite: false });
const COLORS = new Map();
const colorOf = (c) => {
  if (!COLORS.has(c)) COLORS.set(c, new THREE.Color(c));
  return COLORS.get(c);
};
// 建模时先用占位网格拼，userData.c 记颜色；glow 的部件（眼睛、灯）不参与烘焙
function part(parent, geo, color, sx, sy, sz, x = 0, y = 0, z = 0) {
  const glow = typeof color === 'object' && color.isMaterial;
  const m = new THREE.Mesh(GEO[geo], glow ? color : VCOL);
  if (glow) m.userData.glow = true;
  else m.userData.c = color;
  m.scale.set(sx, sy, sz);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}
function pivot(parent, x, y, z, joint = false) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  if (joint) g.userData.joint = true;
  parent.add(g);
  return g;
}
const _m = new THREE.Matrix4();
const _inv = new THREE.Matrix4();
const _nm = new THREE.Matrix3();
// 把 root 下（不跨过子关节）的占位网格合并成一个带顶点色的几何体
function bakeGeometry(root) {
  root.updateMatrixWorld(true);
  _inv.copy(root.matrixWorld).invert();
  const meshes = [];
  const walk = (n) => {
    for (const ch of n.children) {
      if (ch.userData.joint) continue;
      if (ch.isMesh && !ch.userData.glow && ch.userData.c !== undefined) meshes.push(ch);
      else if (!ch.isMesh) walk(ch);
    }
  };
  walk(root);
  if (!meshes.length) return null;
  let total = 0;
  const parts = meshes.map((m) => {
    const src = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    total += src.attributes.position.count;
    return src;
  });
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  let o = 0;
  const v = new THREE.Vector3();
  meshes.forEach((m, i) => {
    const g = parts[i];
    const p = g.attributes.position;
    const n = g.attributes.normal;
    g.computeBoundingBox();
    const y0 = g.boundingBox.min.y;
    const yr = Math.max(1e-4, g.boundingBox.max.y - y0);
    _m.multiplyMatrices(_inv, m.matrixWorld);
    _nm.getNormalMatrix(_m);
    const c = colorOf(m.userData.c);
    for (let k = 0; k < p.count; k++) {
      // 由下到上的明暗，朝下的面再暗一点
      const shade = (0.72 + 0.28 * ((p.getY(k) - y0) / yr)) * (n.getY(k) < -0.5 ? 0.82 : 1);
      v.fromBufferAttribute(p, k).applyMatrix4(_m);
      pos[o] = v.x;
      pos[o + 1] = v.y;
      pos[o + 2] = v.z;
      v.fromBufferAttribute(n, k).applyMatrix3(_nm).normalize();
      nor[o] = v.x;
      nor[o + 1] = v.y;
      nor[o + 2] = v.z;
      col[o] = c.r * shade;
      col[o + 1] = c.g * shade;
      col[o + 2] = c.b * shade;
      o += 3;
    }
    g.dispose();
    m.parent.remove(m);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.userData.baked = true;
  return geo;
}
// 烘焙一个关节（原地替换成一个网格）
function bakeJoint(j) {
  const geo = bakeGeometry(j);
  if (!geo) return null;
  const mesh = new THREE.Mesh(geo, VCOL);
  mesh.userData.baked = true;
  j.add(mesh);
  return mesh;
}
// 烘焙整个模型：每个关节各一个网格
function bakeModel(root) {
  const joints = [root];
  root.traverse((n) => n.userData.joint && joints.push(n));
  for (const j of joints) bakeJoint(j);
}

// ======================= 角色模型 =======================
// 两段的肢体：上臂 / 前臂、大腿 / 小腿
function limb(parent, x, y, z, lenU, lenL, r, colU, colL) {
  const up = pivot(parent, x, y, z, true);
  part(up, 'sph', colU, r * 1.15, r * 1.15, r * 1.15);
  part(up, 'taper', colU, r, lenU, r, 0, -lenU / 2, 0).rotation.x = Math.PI;
  const low = pivot(up, 0, -lenU, 0, true);
  part(low, 'sph', colL, r * 0.95, r * 0.95, r * 0.95);
  part(low, 'taper', colL, r * 0.85, lenL, r * 0.85, 0, -lenL / 2, 0).rotation.x = Math.PI;
  return { up, low };
}

// 求生者：约 1.55 米高的人偶，大头、细胳膊细腿，脖子上系着代表玩家颜色的围巾
function makeSurvivor(look, tint, key) {
  const g = new THREE.Group();
  const root = pivot(g, 0, 0, 0, true);
  const dark = '#241f1c';
  // 腿
  const legs = [-1, 1].map((s) => {
    const l = limb(root, s * 0.105, 0.52, 0, 0.25, 0.25, 0.062, look.pants || dark, look.sock || '#d8d0c0');
    part(l.low, 'sph', look.shoe || '#1a1614', 0.075, 0.055, 0.13, 0, -0.27, 0.035);
    part(l.low, 'cyl', look.shoe || '#1a1614', 0.07, 0.03, 0.09, 0, -0.3, 0.01);
    part(l.low, 'tor', look.accent, 0.06, 0.06, 0.06, 0, -0.14, 0).rotation.x = Math.PI / 2;
    return l;
  });
  // 身体
  const body = pivot(root, 0, 0.52, 0, true);
  part(body, 'cone', look.coat, 0.31, 0.5, 0.27, 0, 0.2, 0);
  part(body, 'cyl', look.coat2 || look.coat, 0.3, 0.035, 0.26, 0, -0.03, 0);
  part(body, 'taper', look.coat, 0.19, 0.3, 0.15, 0, 0.36, 0);
  part(body, 'sph', look.coat, 0.2, 0.1, 0.15, 0, 0.5, 0);
  part(body, 'cyl', look.accent, 0.2, 0.045, 0.165, 0, 0.24, 0);
  part(body, 'box', '#c8b070', 0.05, 0.05, 0.02, 0, 0.24, 0.165);
  for (let i = 0; i < 3; i++) part(body, 'sphLo', look.accent, 0.018, 0.018, 0.012, 0, 0.31 + i * 0.065, 0.155 - i * 0.012);
  part(body, 'tor', look.coat2 || look.accent, 0.13, 0.13, 0.2, 0, 0.53, 0).rotation.x = Math.PI / 2;
  // 围巾（玩家颜色）
  part(body, 'torFat', tint, 0.105, 0.105, 0.13, 0, 0.57, 0).rotation.x = Math.PI / 2;
  const tail = part(body, 'box', tint, 0.07, 0.24, 0.025, 0.07, 0.44, 0.15);
  tail.rotation.z = -0.12;
  part(body, 'cyl', look.skin, 0.06, 0.08, 0.06, 0, 0.6, 0);
  // 手臂
  const arms = [-1, 1].map((s) => {
    const a = limb(body, s * 0.215, 0.5, 0, 0.21, 0.2, 0.052, look.coat, look.sleeve || look.coat);
    part(a.low, 'tor', look.accent, 0.05, 0.05, 0.05, 0, -0.17, 0).rotation.x = Math.PI / 2;
    part(a.low, 'sph', look.skin, 0.055, 0.06, 0.055, 0, -0.235, 0);
    part(a.low, 'sphLo', look.skin, 0.022, 0.03, 0.022, s * -0.04, -0.24, 0.03);
    return a;
  });
  // 头
  const head = pivot(body, 0, 0.84, 0, true);
  part(head, 'sph', look.skin, 0.27, 0.255, 0.25);
  for (const s of [-1, 1]) {
    part(head, 'sphLo', look.skin, 0.045, 0.06, 0.03, s * 0.265, -0.02, 0);
    part(head, 'sphLo', '#14110f', 0.042, 0.056, 0.022, s * 0.105, -0.005, 0.228);
    part(head, 'sphLo', '#f6f2e6', 0.013, 0.015, 0.008, s * 0.105 + 0.014, 0.018, 0.247);
    part(head, 'box', look.hair, 0.075, 0.014, 0.012, s * 0.105, 0.075, 0.232).rotation.z = s * -0.18;
    part(head, 'sphLo', '#d89a8a', 0.045, 0.03, 0.012, s * 0.155, -0.075, 0.2);
  }
  part(head, 'sphLo', look.skin, 0.022, 0.022, 0.026, 0, -0.045, 0.25);
  // 缝线的嘴
  part(head, 'box', '#5a2e2a', 0.085, 0.01, 0.008, 0, -0.118, 0.228);
  for (let i = -1; i <= 1; i++) part(head, 'box', '#5a2e2a', 0.008, 0.03, 0.008, i * 0.03, -0.118, 0.229);
  // 头发
  const hair = look.hair;
  part(head, 'sph', hair, 0.285, 0.235, 0.275, 0, 0.055, -0.035);
  for (let i = -2; i <= 2; i++) part(head, 'sphLo', hair, 0.075, 0.07, 0.05, i * 0.085, 0.16 - Math.abs(i) * 0.025, 0.2);
  if (look.style === 'bob') {
    for (const s of [-1, 1]) part(head, 'sph', hair, 0.08, 0.2, 0.14, s * 0.24, -0.08, -0.02);
  } else if (look.style === 'tail') {
    part(head, 'sph', hair, 0.09, 0.09, 0.09, 0, 0.1, -0.3);
    part(head, 'cone', hair, 0.08, 0.34, 0.08, 0, -0.1, -0.33).rotation.x = Math.PI + 0.25;
    part(head, 'tor', look.accent, 0.06, 0.06, 0.06, 0, 0.06, -0.29);
  } else if (look.style === 'curl') {
    for (let i = 0; i < 7; i++) part(head, 'sphLo', hair, 0.08, 0.08, 0.08, Math.sin((i / 7) * TAU) * 0.24, 0.02 + (i % 2) * 0.05, Math.cos((i / 7) * TAU) * 0.22 - 0.05);
  } else if (look.style === 'beard') {
    part(head, 'sph', hair, 0.17, 0.13, 0.1, 0, -0.17, 0.15);
    for (const s of [-1, 1]) part(head, 'sph', hair, 0.06, 0.13, 0.08, s * 0.22, -0.08, 0.06);
  }
  const R = arms[1].low;
  const L = arms[0].low;
  // 帽子与随身物件
  if (key === 'tinker') {
    part(head, 'tor', '#3a2a1c', 0.275, 0.275, 0.26, 0, 0.12, 0).rotation.x = Math.PI / 2;
    for (const s of [-1, 1]) {
      part(head, 'cyl', look.accent, 0.065, 0.04, 0.065, s * 0.105, 0.15, 0.225).rotation.x = Math.PI / 2;
      part(head, 'cyl', '#8ac0c8', 0.045, 0.045, 0.045, s * 0.105, 0.15, 0.235).rotation.x = Math.PI / 2;
    }
    // 背上的大齿轮
    const gear = pivot(body, 0, 0.32, -0.19);
    part(gear, 'cyl', look.accent, 0.16, 0.035, 0.16).rotation.x = Math.PI / 2;
    for (let i = 0; i < 8; i++) part(gear, 'box', look.accent, 0.05, 0.05, 0.035, Math.sin((i / 8) * TAU) * 0.18, Math.cos((i / 8) * TAU) * 0.18, 0).rotation.z = -(i / 8) * TAU;
    part(gear, 'cyl', '#3a2a1c', 0.05, 0.05, 0.05).rotation.x = Math.PI / 2;
    part(body, 'box', '#4a3420', 0.13, 0.15, 0.07, -0.22, 0.12, 0.05);
    part(body, 'box', '#3a2a1c', 0.025, 0.5, 0.01, 0.02, 0.32, 0.165).rotation.z = 0.75;
  } else if (key === 'nurse') {
    part(head, 'cyl', '#f4f0ea', 0.21, 0.09, 0.2, 0, 0.26, -0.02);
    part(head, 'cyl', '#f4f0ea', 0.24, 0.025, 0.23, 0, 0.215, -0.02);
    part(head, 'box', look.accent, 0.09, 0.028, 0.012, 0, 0.265, 0.185);
    part(head, 'box', look.accent, 0.028, 0.09, 0.012, 0, 0.265, 0.185);
    part(body, 'box', '#f6f2ea', 0.22, 0.34, 0.015, 0, 0.14, 0.2).rotation.x = -0.33;
    part(body, 'box', '#f6f2ea', 0.16, 0.14, 0.015, 0, 0.4, 0.158);
    part(body, 'box', '#6a4a30', 0.14, 0.11, 0.07, 0.24, 0.1, 0.02);
    part(body, 'box', look.accent, 0.05, 0.016, 0.01, 0.24, 0.1, 0.057);
    part(body, 'box', look.accent, 0.016, 0.05, 0.01, 0.24, 0.1, 0.057);
    // 手提的小灯
    part(L, 'cyl', '#3a3428', 0.045, 0.02, 0.045, 0, -0.32, 0.02);
    part(L, 'sph', new THREE.MeshBasicMaterial({ color: 0xffe0a0 }), 0.04, 0.05, 0.04, 0, -0.37, 0.02);
    part(L, 'cyl', '#3a3428', 0.045, 0.015, 0.045, 0, -0.42, 0.02);
  } else if (key === 'runner') {
    part(head, 'sph', look.accent, 0.29, 0.13, 0.28, 0, 0.19, -0.01);
    part(head, 'cyl', look.accent, 0.2, 0.02, 0.16, 0, 0.15, 0.22);
    part(head, 'sphLo', '#c8b070', 0.025, 0.025, 0.025, 0, 0.3, -0.01);
    part(body, 'box', '#5a4028', 0.04, 0.62, 0.012, 0, 0.32, 0.16).rotation.z = -0.7;
    part(body, 'box', '#6a4a2c', 0.2, 0.17, 0.09, 0.25, 0.08, 0);
    part(body, 'box', '#5a3e24', 0.21, 0.07, 0.1, 0.25, 0.15, 0);
    part(body, 'box', '#e8e0c8', 0.1, 0.07, 0.01, 0.25, 0.2, 0.03).rotation.z = 0.2;
  } else if (key === 'guard') {
    part(head, 'cyl', '#3a3428', 0.33, 0.025, 0.33, 0, 0.2, 0);
    part(head, 'cyl', '#3a3428', 0.2, 0.15, 0.2, 0, 0.28, 0);
    part(head, 'cyl', look.accent, 0.205, 0.035, 0.205, 0, 0.225, 0);
    // 披肩
    part(body, 'cone', look.coat2 || '#3a4030', 0.33, 0.26, 0.26, 0, 0.44, -0.02);
    // 信号枪
    part(R, 'box', '#2a2a2e', 0.035, 0.05, 0.2, 0, -0.26, 0.08);
    part(R, 'cyl', '#8a6a3a', 0.04, 0.1, 0.04, 0, -0.28, 0.2).rotation.x = Math.PI / 2;
    part(body, 'cyl', '#3a3428', 0.05, 0.14, 0.05, -0.23, 0.12, 0.03);
    part(body, 'sph', new THREE.MeshBasicMaterial({ color: 0xffc860 }), 0.04, 0.05, 0.04, -0.23, 0.12, 0.03);
  } else if (key === 'illusion') {
    part(head, 'cyl', '#16141c', 0.31, 0.022, 0.31, 0, 0.21, 0);
    part(head, 'cyl', '#16141c', 0.17, 0.3, 0.17, 0, 0.36, 0);
    part(head, 'cyl', look.accent, 0.175, 0.05, 0.175, 0, 0.25, 0);
    // 斗篷与领结
    const cape = part(body, 'cone', look.accent, 0.3, 0.62, 0.1, 0, 0.22, -0.16);
    cape.rotation.x = -0.12;
    part(body, 'cone', '#16141c', 0.29, 0.6, 0.09, 0, 0.23, -0.145).rotation.x = -0.12;
    for (const s of [-1, 1]) part(body, 'cone', look.accent, 0.035, 0.07, 0.02, s * 0.04, 0.52, 0.15).rotation.z = (s * Math.PI) / 2;
    part(R, 'cyl', '#16141c', 0.012, 0.34, 0.012, 0, -0.3, 0.12).rotation.x = 1.2;
    part(R, 'sphLo', '#f0f0f0', 0.02, 0.02, 0.02, 0, -0.36, 0.28);
  } else if (key === 'scout') {
    part(head, 'sph', look.coat, 0.31, 0.29, 0.3, 0, 0.03, -0.06);
    part(head, 'cone', look.coat, 0.11, 0.2, 0.11, 0, 0.3, -0.14).rotation.x = -0.5;
    // 背包与铺盖卷
    part(body, 'box', '#6a5030', 0.26, 0.3, 0.14, 0, 0.3, -0.2);
    part(body, 'cyl', '#8a8a6a', 0.07, 0.3, 0.07, 0, 0.5, -0.22).rotation.z = Math.PI / 2;
    for (const s of [-1, 1]) part(body, 'box', '#4a3820', 0.03, 0.34, 0.012, s * 0.11, 0.38, 0.14);
    part(body, 'cyl', look.accent, 0.02, 0.07, 0.02, 0.04, 0.45, 0.17).rotation.z = 0.5;
  }
  bakeModel(g);
  return { g, root, body, head, armL: arms[0].up, armR: arms[1].up, foreL: arms[0].low, foreR: arms[1].low, legL: legs[0].up, legR: legs[1].up, shinL: legs[0].low, shinR: legs[1].low, h: 1.6 };
}

// 追猎者：两米多高，三种体型
function makeHunter(look) {
  const g = new THREE.Group();
  const root = pivot(g, 0, 0, 0, true);
  const eye = new THREE.MeshBasicMaterial({ color: look.eye });
  const body = pivot(root, 0, 0.95, 0, true);
  let head;
  let arms;
  let legs;
  const dummyLeg = () => {
    const up = pivot(root, 0, 0, 0, true);
    return { up, low: pivot(up, 0, 0, 0, true) };
  };
  if (look.kind === 'scarecrow') {
    const straw = '#c8a850';
    legs = [-1, 1].map((s) => {
      const l = limb(root, s * 0.16, 0.95, 0, 0.46, 0.46, 0.075, '#4a3a22', '#3a2c18');
      part(l.low, 'box', '#2a2014', 0.14, 0.09, 0.26, 0, -0.5, 0.05);
      for (let i = 0; i < 4; i++) part(l.low, 'coneLo', straw, 0.025, 0.14, 0.025, Math.sin(i * 1.6) * 0.06, -0.4, Math.cos(i * 1.6) * 0.06).rotation.x = Math.PI + (i - 1.5) * 0.3;
      return l;
    });
    part(body, 'cone', look.body, 0.44, 0.95, 0.36, 0, 0.42, 0);
    // 破烂的衣摆
    for (let i = 0; i < 9; i++) part(body, 'coneLo', i % 2 ? look.body : '#3e2e18', 0.09, 0.34, 0.03, Math.sin((i / 9) * TAU) * 0.36, -0.15, Math.cos((i / 9) * TAU) * 0.3).rotation.x = Math.PI;
    part(body, 'tor', '#8a7a4a', 0.3, 0.3, 0.3, 0, 0.3, 0).rotation.x = Math.PI / 2;
    part(body, 'box', '#6a4a2a', 0.14, 0.14, 0.012, 0.12, 0.5, 0.24).rotation.z = 0.2;
    part(body, 'box', '#3a2c18', 1.25, 0.07, 0.07, 0, 0.88, -0.06);
    for (const s of [-1, 1]) for (let i = 0; i < 3; i++) part(body, 'coneLo', straw, 0.03, 0.2, 0.03, s * (0.3 + i * 0.05), 0.9, -0.02).rotation.z = s * (-1.2 - i * 0.2);
    arms = [-1, 1].map((s) => {
      const a = limb(body, s * 0.38, 0.86, 0, 0.42, 0.42, 0.07, look.body, '#4e3a20');
      for (let i = 0; i < 5; i++) part(a.low, 'coneLo', straw, 0.025, 0.2, 0.025, Math.sin(i * 1.3) * 0.05, -0.48, Math.cos(i * 1.3) * 0.05).rotation.x = Math.PI + (i - 2) * 0.22;
      return a;
    });
    // 镰刀：长柄 + 弯刃
    const sc = pivot(arms[1].low, 0, -0.42, 0);
    part(sc, 'cyl', '#3a2c18', 0.028, 1.7, 0.028, 0, 0.35, 0.12).rotation.x = 0.28;
    for (let i = 0; i < 6; i++) {
      const b = part(sc, 'box', '#c0c8cc', 0.02, 0.13 - i * 0.012, 0.17, 0, 1.12 - i * i * 0.012, 0.42 + i * 0.13);
      b.rotation.x = -0.25 - i * 0.14;
    }
    head = pivot(body, 0, 1.2, 0, true);
    part(head, 'sph', '#a89060', 0.3, 0.34, 0.29);
    part(head, 'cyl', '#8a7448', 0.2, 0.1, 0.19, 0, -0.3, 0);
    for (let i = 0; i < 8; i++) part(head, 'coneLo', straw, 0.03, 0.2, 0.03, Math.sin((i / 8) * TAU) * 0.2, -0.36, Math.cos((i / 8) * TAU) * 0.19).rotation.x = Math.PI;
    part(head, 'cone', look.accent, 0.5, 0.42, 0.5, 0, 0.36, 0);
    part(head, 'cyl', look.accent, 0.68, 0.025, 0.68, 0, 0.17, 0);
    part(head, 'tor', '#5a3a1c', 0.34, 0.34, 0.5, 0, 0.2, 0).rotation.x = Math.PI / 2;
    for (let i = 0; i < 10; i++) part(head, 'coneLo', straw, 0.03, 0.16, 0.03, Math.sin((i / 10) * TAU) * 0.66, 0.15, Math.cos((i / 10) * TAU) * 0.66).rotation.z = Math.sin((i / 10) * TAU) * -1.6;
    for (const s of [-1, 1]) {
      part(head, 'sph', '#1a1410', 0.075, 0.06, 0.03, s * 0.12, 0.03, 0.25);
      part(head, 'sph', eye, 0.045, 0.035, 0.03, s * 0.12, 0.03, 0.265);
    }
    part(head, 'box', '#2a2014', 0.24, 0.014, 0.01, 0, -0.13, 0.265);
    for (let i = -3; i <= 3; i++) part(head, 'box', '#2a2014', 0.012, 0.075, 0.01, i * 0.036, -0.13, 0.268);
    part(head, 'box', '#7a6238', 0.1, 0.1, 0.01, -0.14, 0.14, 0.255).rotation.z = 0.3;
  } else if (look.kind === 'weaver') {
    legs = [dummyLeg(), dummyLeg()];
    // 三层裙摆
    part(body, 'cone', look.body, 0.66, 1.1, 0.6, 0, -0.38, 0);
    part(body, 'cone', '#3a2c44', 0.56, 0.8, 0.5, 0, -0.2, 0);
    part(body, 'cone', look.accent, 0.42, 0.5, 0.38, 0, 0.0, 0);
    for (let i = 0; i < 12; i++) part(body, 'sphLo', '#e8e0e8', 0.05, 0.03, 0.05, Math.sin((i / 12) * TAU) * 0.63, -0.92, Math.cos((i / 12) * TAU) * 0.57);
    part(body, 'taper', look.body, 0.2, 0.55, 0.17, 0, 0.5, 0);
    part(body, 'cyl', look.accent, 0.215, 0.07, 0.185, 0, 0.3, 0);
    for (let i = 0; i < 4; i++) part(body, 'box', '#e8e0e8', 0.1, 0.012, 0.01, 0, 0.42 + i * 0.07, 0.165 - i * 0.008).rotation.z = i % 2 ? 0.4 : -0.4;
    part(body, 'tor', '#e8e0e8', 0.17, 0.17, 0.3, 0, 0.78, 0).rotation.x = Math.PI / 2;
    arms = [-1, 1].map((s) => {
      const a = limb(body, s * 0.25, 0.76, 0, 0.44, 0.44, 0.042, look.body, '#e0d8d0');
      for (let i = 0; i < 3; i++) part(a.low, 'coneLo', '#c8c8d4', 0.012, 0.3, 0.012, (i - 1) * 0.03, -0.58, 0.01).rotation.x = Math.PI + (i - 1) * 0.12;
      return a;
    });
    part(arms[1].low, 'cyl', '#d8d8e4', 0.012, 0.9, 0.012, 0, -0.55, 0.2).rotation.x = 1.0;
    // 背后的四条细肢，每条两节
    for (const [sx, sy] of [[-1, 0.7], [1, 0.7], [-1, 0.45], [1, 0.45]]) {
      const leg = pivot(body, sx * 0.14, sy, -0.14);
      leg.rotation.z = sx * -1.05;
      leg.rotation.y = sx * 0.45;
      part(leg, 'cylLo', '#16121a', 0.028, 0.95, 0.028, 0, 0.475, 0);
      part(leg, 'sphLo', '#16121a', 0.045, 0.045, 0.045, 0, 0.95, 0);
      const tip = pivot(leg, 0, 0.95, 0);
      tip.rotation.z = sx * 2.1;
      part(tip, 'coneLo', '#16121a', 0.026, 1.0, 0.026, 0, 0.5, 0);
    }
    head = pivot(body, 0, 1.05, 0, true);
    part(head, 'sph', '#ece4dc', 0.24, 0.29, 0.23);
    part(head, 'sph', '#16121a', 0.265, 0.21, 0.26, 0, 0.12, -0.05);
    part(head, 'sph', '#16121a', 0.17, 0.17, 0.17, 0, 0.38, -0.08);
    for (const s of [-1, 1]) {
      part(head, 'sph', '#16121a', 0.07, 0.24, 0.1, s * 0.22, -0.06, -0.04);
      part(head, 'cyl', '#d8d8e4', 0.01, 0.56, 0.01, s * 0.04, 0.42, -0.08).rotation.z = s * 0.95;
      part(head, 'sph', '#2a1a2a', 0.06, 0.075, 0.02, s * 0.09, 0.0, 0.2);
      part(head, 'sph', eye, 0.032, 0.05, 0.02, s * 0.09, 0.0, 0.215);
      part(head, 'sphLo', eye, 0.014, 0.014, 0.01, s * 0.15, 0.09, 0.19);
    }
    part(head, 'box', '#6a2a3a', 0.07, 0.012, 0.01, 0, -0.14, 0.2);
    // 面纱
    part(head, 'cone', '#2a2030', 0.3, 0.3, 0.3, 0, 0.02, -0.12).rotation.x = -0.5;
  } else {
    legs = [dummyLeg(), dummyLeg()];
    // 没有腿：大衣下面是一团收尖的雾
    part(body, 'cone', '#3a4656', 0.34, 1.0, 0.3, 0, -0.5, 0).rotation.x = Math.PI;
    part(body, 'cone', look.body, 0.44, 1.15, 0.38, 0, -0.05, 0);
    for (const s of [-1, 1]) part(body, 'cone', '#141a24', 0.2, 0.9, 0.06, s * 0.16, -0.25, -0.26).rotation.x = -0.18;
    part(body, 'taper', look.body, 0.23, 0.75, 0.19, 0, 0.6, 0);
    part(body, 'sph', look.body, 0.3, 0.12, 0.2, 0, 0.98, 0);
    for (const s of [-1, 1]) part(body, 'box', look.accent, 0.035, 0.6, 0.012, s * 0.07, 0.62, 0.19).rotation.z = s * 0.1;
    for (let i = 0; i < 4; i++) part(body, 'sphLo', '#c8d0d8', 0.02, 0.02, 0.012, 0, 0.36 + i * 0.14, 0.2);
    part(body, 'cone', '#e8e8e4', 0.07, 0.2, 0.03, 0, 0.9, 0.18).rotation.x = Math.PI;
    part(body, 'tor', '#0e1218', 0.17, 0.17, 0.3, 0, 1.04, 0).rotation.x = Math.PI / 2;
    arms = [-1, 1].map((s) => {
      const a = limb(body, s * 0.3, 0.98, 0, 0.46, 0.46, 0.058, look.body, look.body);
      part(a.low, 'tor', look.accent, 0.055, 0.055, 0.055, 0, -0.4, 0).rotation.x = Math.PI / 2;
      part(a.low, 'sph', '#ecece8', 0.06, 0.085, 0.06, 0, -0.5, 0);
      return a;
    });
    // 手杖剑
    const cane = pivot(arms[1].low, 0, -0.5, 0);
    part(cane, 'cyl', '#c8d0d8', 0.016, 1.15, 0.016, 0, 0.32, 0.32).rotation.x = 0.85;
    part(cane, 'sphLo', look.accent, 0.04, 0.04, 0.04, 0, -0.05, -0.1);
    head = pivot(body, 0, 1.27, 0, true);
    part(head, 'sph', '#14181e', 0.22, 0.27, 0.22, 0, 0, -0.03);
    part(head, 'sph', '#f0eee8', 0.19, 0.25, 0.1, 0, -0.01, 0.14);
    part(head, 'cyl', '#0e1218', 0.38, 0.022, 0.38, 0, 0.2, 0);
    part(head, 'cyl', '#0e1218', 0.21, 0.26, 0.2, 0, 0.33, 0);
    part(head, 'cyl', look.accent, 0.215, 0.05, 0.205, 0, 0.24, 0);
    for (const s of [-1, 1]) {
      part(head, 'sph', '#0a0c10', 0.055, 0.03, 0.02, s * 0.08, 0.025, 0.225).rotation.z = s * 0.25;
      part(head, 'sph', eye, 0.028, 0.016, 0.02, s * 0.08, 0.025, 0.238);
    }
    part(head, 'box', '#0a0c10', 0.003, 0.2, 0.01, 0.0, -0.1, 0.235).rotation.z = 0.05;
    part(head, 'box', '#b0b0a8', 0.1, 0.008, 0.01, 0, -0.14, 0.215);
  }
  bakeModel(g);
  return { g, root, body, head, armL: arms[0].up, armR: arms[1].up, foreL: arms[0].low, foreR: arms[1].low, legL: legs[0].up, legR: legs[1].up, shinL: legs[0].low, shinR: legs[1].low, h: 2.55, hover: look.kind !== 'scarecrow' };
}

// ======================= 道具模型（烘焙后实例化） =======================
function cageGeo() {
  const g = new THREE.Group();
  const iron = '#30343a';
  part(g, 'cyl', iron, 0.52, 0.09, 0.52, 0, 0.045, 0);
  part(g, 'cyl', '#1c1e22', 0.46, 0.02, 0.46, 0, 0.1, 0);
  for (let i = 0; i < 12; i++) part(g, 'cylLo', iron, 0.02, 1.8, 0.02, Math.sin((i / 12) * TAU) * 0.47, 1.0, Math.cos((i / 12) * TAU) * 0.47);
  for (const y of [0.7, 1.3, 1.9]) part(g, 'tor', iron, 0.47, 0.47, 0.47, 0, y, 0).rotation.x = Math.PI / 2;
  // 穹顶的肋条
  for (let i = 0; i < 6; i++) {
    const r = pivot(g, 0, 1.9, 0);
    r.rotation.y = (i / 6) * Math.PI;
    const arc = part(r, 'tor', iron, 0.47, 0.47, 0.47);
    arc.scale.y = 0.42;
  }
  part(g, 'sphLo', iron, 0.07, 0.07, 0.07, 0, 2.38, 0);
  part(g, 'tor', iron, 0.09, 0.09, 0.09, 0, 2.5, 0);
  part(g, 'box', '#5a4a30', 0.14, 0.18, 0.04, 0, 1.0, 0.49);
  return bakeGeometry(g);
}
function lampGeo() {
  const g = new THREE.Group();
  const iron = '#1e2024';
  part(g, 'taper', iron, 0.13, 0.3, 0.13, 0, 0.15, 0);
  part(g, 'cylLo', iron, 0.045, 3.2, 0.045, 0, 1.8, 0);
  part(g, 'tor', iron, 0.07, 0.07, 0.07, 0, 2.6, 0).rotation.x = Math.PI / 2;
  const arm = part(g, 'tor', iron, 0.22, 0.22, 0.22, 0.22, 3.4, 0);
  arm.scale.z = 0.5;
  part(g, 'cone', iron, 0.17, 0.12, 0.17, 0.45, 3.42, 0);
  part(g, 'cylLo', iron, 0.11, 0.02, 0.11, 0.45, 3.1, 0);
  for (let i = 0; i < 4; i++) part(g, 'box', iron, 0.012, 0.26, 0.012, 0.45 + Math.sin((i / 4) * TAU + 0.78) * 0.1, 3.23, Math.cos((i / 4) * TAU + 0.78) * 0.1);
  return bakeGeometry(g);
}
function machineGeo() {
  const g = new THREE.Group();
  const wood = '#4a3422';
  // 写字台
  part(g, 'box', wood, 0.86, 0.06, 0.66, 0, 0.78, 0);
  part(g, 'box', '#3a2818', 0.8, 0.26, 0.6, 0, 0.62, 0);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) part(g, 'box', '#2e2014', 0.07, 0.5, 0.07, sx * 0.36, 0.25, sz * 0.26);
  for (const sx of [-1, 1]) {
    part(g, 'box', '#2e2014', 0.32, 0.16, 0.02, sx * 0.19, 0.62, 0.305);
    part(g, 'sphLo', '#c8a850', 0.022, 0.022, 0.022, sx * 0.19, 0.62, 0.32);
  }
  // 发报机：底板、电键、线圈、纸带盘
  part(g, 'box', '#1c1814', 0.5, 0.03, 0.3, -0.08, 0.825, 0.05);
  part(g, 'box', '#c8a850', 0.2, 0.02, 0.04, -0.14, 0.87, 0.12).rotation.z = 0.12;
  part(g, 'cyl', '#16120e', 0.03, 0.03, 0.03, -0.05, 0.9, 0.12);
  for (const s of [-1, 1]) {
    part(g, 'cyl', '#a8642a', 0.05, 0.1, 0.05, -0.16 + s * 0.07, 0.89, -0.03);
    part(g, 'cyl', '#c8a850', 0.055, 0.012, 0.055, -0.16 + s * 0.07, 0.945, -0.03);
  }
  const reel = part(g, 'cyl', '#d8d0b8', 0.09, 0.03, 0.09, 0.12, 0.93, 0.02);
  reel.rotation.x = Math.PI / 2;
  part(g, 'cyl', '#c8a850', 0.02, 0.05, 0.02, 0.12, 0.93, 0.02).rotation.x = Math.PI / 2;
  part(g, 'box', '#d8d0b8', 0.03, 0.002, 0.3, 0.12, 0.84, 0.2);
  // 天线杆：横担、瓷瓶、拉线
  part(g, 'cylLo', '#5a4a30', 0.04, 2.9, 0.04, 0.3, 2.2, -0.2);
  for (const [y, w] of [[3.3, 0.7], [2.9, 0.5]]) {
    part(g, 'box', '#4a3a26', w, 0.05, 0.05, 0.3, y, -0.2);
    for (const s of [-1, 1]) part(g, 'cyl', '#d8e0e0', 0.03, 0.07, 0.03, 0.3 + s * (w / 2 - 0.05), y + 0.06, -0.2);
  }
  part(g, 'cylLo', '#2a2a2a', 0.008, 2.7, 0.008, 0.02, 2.0, -0.2).rotation.z = -0.2;
  part(g, 'sphLo', '#c8a850', 0.06, 0.06, 0.06, 0.3, 3.68, -0.2);
  return bakeGeometry(g);
}

// ======================= 场景 =======================
export class Scene {
  constructor(canvas) {
    this.canvas = canvas;
    this.low = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    this.r = new THREE.WebGLRenderer({ canvas, antialias: !this.low, powerPreference: 'high-performance', stencil: false });
    this.r.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.cam = new THREE.PerspectiveCamera(58, 1, 0.2, 260);
    // 镜头：yawT / pitchT 是手指给的目标，yaw / pitch 每帧平滑地跟过去；spin 是松手后的惯性
    this.yaw = this.yawT = 0;
    this.pitch = this.pitchT = 0.72;
    this.spin = 0;
    this.camDist = 7;
    this.curDist = 7;
    this.shake = 0;
    this.time = 0;
    this.world = null;
    this.chars = new Map();
    this.focus = { x: 32, z: 32 };
    this.glow = glowTex();
    // 自适应分辨率
    this.scale = 1;
    this.ft = { n: 0, sum: 0, good: 0 };
    this.fps = 60;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const cap = this.quality === 'low' ? 1 : 2;
    this.r.setPixelRatio(Math.min(window.devicePixelRatio || 1, cap) * this.scale);
    this.r.setSize(w, h, false);
    this.cam.aspect = w / h;
    this.cam.fov = w < h ? 68 : 56;
    this.cam.updateProjectionMatrix();
  }
  setQuality(q) {
    this.quality = q;
    this.scale = 1;
    this.resize();
    if (this.grass) this.grass.visible = q !== 'low';
    if (this.mistIM) this.mistIM.visible = q !== 'low';
  }
  setYaw(y) {
    this.yaw = this.yawT = y;
    this.spin = 0;
  }
  // 帧时间超标就降分辨率，宽裕了再慢慢升回来
  adapt(dt) {
    const f = this.ft;
    f.n++;
    f.sum += dt;
    if (f.n < 45) return;
    const avg = f.sum / f.n;
    this.fps = Math.round(1 / avg);
    f.n = 0;
    f.sum = 0;
    if (avg > 1 / 54 && this.scale > 0.55) {
      this.scale = Math.max(0.55, this.scale - (avg > 1 / 40 ? 0.15 : 0.08));
      f.good = 0;
      this.resize();
    } else if (avg < 1 / 58 && this.scale < 1 && ++f.good >= 4) {
      this.scale = Math.min(1, this.scale + 0.05);
      f.good = 0;
      this.resize();
    }
  }

  // ---------------- 搭建静态世界 ----------------
  build(setup, cfg, you) {
    if (this.world) {
      this.scene.remove(this.world);
      const shared = new Set(Object.values(GEO));
      this.world.traverse((o) => {
        if (o.geometry && !shared.has(o.geometry)) o.geometry.dispose();
        if (o.material && o.material.map && o.material.map !== this.glow) o.material.map.dispose();
      });
    }
    this.cfg = cfg;
    this.setup = setup;
    this.you = you;
    this.chars.clear();
    this.hunterC = null;
    const map = setup.map;
    const W = map.W;
    const th = (this.th = THEMES[map.theme] || THEMES.circus);
    const world = (this.world = new THREE.Group());
    this.scene.add(world);
    this.scene.background = new THREE.Color(th.fog);
    this.scene.fog = new THREE.FogExp2(th.fog, th.fogD);
    world.add(new THREE.HemisphereLight(th.hemi[0], th.hemi[1], 2.5));
    const moon = new THREE.DirectionalLight(th.moon, 2.1);
    moon.position.set(-30, 50, -20);
    world.add(moon);
    // 从背后打一道冷色的轮廓光，人偶的边缘会亮一圈
    const rim = new THREE.DirectionalLight(0x8fb4e0, 0.9);
    rim.position.set(25, 18, 30);
    world.add(rim);

    const dummy = new THREE.Object3D();
    const inst = (geo, material, list, fn) => {
      if (!list.length) return null;
      const im = new THREE.InstancedMesh(geo, material, list.length);
      list.forEach((it, i) => {
        dummy.position.set(0, 0, 0);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, 1, 1);
        fn(it, i);
        dummy.updateMatrix();
        im.setMatrixAt(i, dummy.matrix);
      });
      im.frustumCulled = false;
      world.add(im);
      return im;
    };
    const basic = (color, o = {}) => new THREE.MeshBasicMaterial({ color, ...o });
    const lambert = (o) => new THREE.MeshLambertMaterial(o);

    // 天空：穹顶渐变 + 星星 + 月亮
    {
      const geo = new THREE.SphereGeometry(200, 16, 10);
      const col = new Float32Array(geo.attributes.position.count * 3);
      const top = new THREE.Color(th.sky);
      const hor = new THREE.Color(th.fog);
      const c = new THREE.Color();
      for (let i = 0; i < geo.attributes.position.count; i++) {
        c.copy(hor).lerp(top, clamp(geo.attributes.position.getY(i) / 110, 0, 1));
        col.set([c.r, c.g, c.b], i * 3);
      }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const dome = new THREE.Mesh(geo, basic(0xffffff, { vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
      dome.position.set(W / 2, 0, W / 2);
      world.add(dome);
      const sp = new Float32Array(260 * 3);
      for (let i = 0; i < 260; i++) {
        const a = Math.random() * TAU;
        const e = 0.25 + Math.random() * 1.2;
        sp.set([W / 2 + Math.cos(a) * Math.cos(e) * 180, Math.sin(e) * 180, W / 2 + Math.sin(a) * Math.cos(e) * 180], i * 3);
      }
      const sg = new THREE.BufferGeometry();
      sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
      world.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xdfe8f4, size: 1.6, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.7, depthWrite: false })));
      const moonSp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: 0xf0f0dc, fog: false, transparent: true, depthWrite: false }));
      moonSp.scale.set(44, 44, 1);
      moonSp.position.set(W / 2 - 80, 80, W / 2 - 120);
      world.add(moonSp);
      const discTex = canvasTex(64, (g, s) => {
        g.fillStyle = '#f2efdc';
        g.beginPath();
        g.arc(s / 2, s / 2, s / 2 - 2, 0, TAU);
        g.fill();
        g.fillStyle = 'rgba(160,170,160,.35)';
        for (const [x, y, r] of [[22, 24, 7], [40, 36, 9], [28, 44, 4]]) {
          g.beginPath();
          g.arc(x, y, r, 0, TAU);
          g.fill();
        }
      });
      const disc = new THREE.Sprite(new THREE.SpriteMaterial({ map: discTex, fog: false, transparent: true, depthWrite: false }));
      disc.scale.set(13, 13, 1);
      disc.position.copy(moonSp.position);
      world.add(disc);
    }

    // 地面
    const gtex = groundTex(map.theme, th);
    gtex.anisotropy = Math.min(4, this.r.capabilities.getMaxAnisotropy());
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(W, W), lambert({ map: gtex }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(W / 2, 0, W / 2);
    world.add(ground);
    const outer = new THREE.Mesh(new THREE.PlaneGeometry(500, 500), lambert({ color: th.ground[2] }));
    outer.rotation.x = -Math.PI / 2;
    outer.position.set(W / 2, -0.05, W / 2);
    world.add(outer);

    // 墙、矮障碍、窗
    const cells = { wall: [], border: [], low: [], win: [] };
    const winAt = new Map(map.windows.map((w) => [w.z * W + w.x, w]));
    for (let z = 0; z < W; z++)
      for (let x = 0; x < W; x++) {
        const c = map.rows[z].charCodeAt(x) - 48;
        if (c === 1) (x === 0 || z === 0 || x === W - 1 || z === W - 1 ? cells.border : cells.wall).push([x, z]);
        else if (c === 2) cells.low.push([x, z]);
        else if (c === 3) cells.win.push(winAt.get(z * W + x));
      }
    const wallMat = lambert({ map: wallTex(map.theme, th) });
    const wallH = ([x, z]) => (map.theme === 'garden' ? 2.6 + hash(x, z) * 0.35 : 3);
    inst(GEO.box, wallMat, cells.wall, (c) => {
      const h = wallH(c);
      dummy.position.set(c[0] + 0.5, h / 2, c[1] + 0.5);
      dummy.scale.set(1, h, 1);
    });
    inst(GEO.box, lambert({ color: map.theme === 'garden' ? '#1c3a26' : map.theme === 'harbor' ? '#2a343c' : '#2c2a32' }), cells.border, ([x, z]) => {
      const h = 4.2 + hash(x, z) * 0.6;
      dummy.position.set(x + 0.5, h / 2, z + 0.5);
      dummy.scale.set(1, h, 1);
    });
    // 墙顶：马戏团是木梁，船坞是货柜的铁框，花园是修成圆弧的树冠
    if (map.theme === 'garden')
      inst(GEO.sphLo, lambert({ color: '#3a7448' }), cells.wall, (c) => {
        dummy.position.set(c[0] + 0.5, wallH(c) - 0.05, c[1] + 0.5);
        dummy.scale.set(0.62, 0.3, 0.62);
      });
    else
      inst(GEO.box, lambert({ color: map.theme === 'harbor' ? '#22343c' : '#3a2a22' }), cells.wall, ([x, z]) => {
        dummy.position.set(x + 0.5, 3.04, z + 0.5);
        dummy.scale.set(1.05, 0.1, 1.05);
      });
    // 墙根和障碍脚下的暗斑（假的环境光遮蔽）
    const ao = new THREE.MeshBasicMaterial({ map: this.glow, color: 0x000000, transparent: true, opacity: 0.55, depthWrite: false });
    const aoGeo = GEO.plane.clone().rotateX(-Math.PI / 2);
    inst(aoGeo, ao, cells.wall.concat(cells.low, cells.win.map((w) => [w.x, w.z])), ([x, z]) => {
      dummy.position.set(x + 0.5, 0.02, z + 0.5);
      dummy.scale.set(2.5, 1, 2.5);
    });
    // 矮障碍：木箱和木桶（花园里是石花坛）
    const crates = cells.low.filter(([x, z]) => hash(x + 3, z) > 0.38);
    const barrels = cells.low.filter(([x, z]) => hash(x + 3, z) <= 0.38);
    inst(GEO.box, lambert({ map: crateTex(th.low) }), crates, ([x, z]) => {
      const h = 0.95 + hash(x, z) * 0.45;
      dummy.position.set(x + 0.5, h / 2, z + 0.5);
      dummy.scale.set(0.92, h, 0.92);
      dummy.rotation.set(0, hash(z, x) * 0.5 - 0.25, 0);
    });
    {
      const g = new THREE.Group();
      if (map.theme === 'garden') {
        part(g, 'taper', '#8a8a80', 0.46, 0.7, 0.46, 0, 0.35, 0).rotation.x = Math.PI;
        part(g, 'cyl', '#9a9a8e', 0.5, 0.08, 0.5, 0, 0.72, 0);
        part(g, 'sph', '#2e6240', 0.44, 0.34, 0.44, 0, 0.95, 0);
        for (let i = 0; i < 5; i++) part(g, 'sphLo', i % 2 ? '#c86a7a' : '#e0d8a0', 0.06, 0.06, 0.06, Math.sin(i * 1.3) * 0.3, 1.12 + (i % 2) * 0.08, Math.cos(i * 1.3) * 0.3);
      } else {
        part(g, 'cyl', '#6a4a2c', 0.4, 1.1, 0.4, 0, 0.55, 0);
        part(g, 'cyl', '#7a5632', 0.44, 0.5, 0.44, 0, 0.55, 0);
        for (const y of [0.15, 0.4, 0.7, 0.95]) part(g, 'cyl', '#2a2c30', 0.445, 0.04, 0.445, 0, y, 0);
        part(g, 'cyl', '#4a3420', 0.36, 0.02, 0.36, 0, 1.1, 0);
      }
      inst(bakeGeometry(g), VCOL, barrels, ([x, z]) => {
        dummy.position.set(x + 0.5, 0, z + 0.5);
        dummy.rotation.set(0, hash(x, z) * 6, 0);
        const s = 0.9 + hash(z, x) * 0.2;
        dummy.scale.set(s, s, s);
      });
    }
    // 窗：窗台 + 窗楣 + 木框
    inst(GEO.box, wallMat, cells.win, (w) => {
      dummy.position.set(w.x + 0.5, 0.45, w.z + 0.5);
      dummy.scale.set(1, 0.9, 1);
    });
    inst(GEO.box, wallMat, cells.win, (w) => {
      dummy.position.set(w.x + 0.5, 2.7, w.z + 0.5);
      dummy.scale.set(1, 0.6, 1);
    });
    {
      const g = new THREE.Group();
      part(g, 'box', '#5a4228', 1.12, 0.09, 1.04, 0, 0.94, 0);
      part(g, 'box', '#5a4228', 1.04, 0.09, 1.04, 0, 2.38, 0);
      for (const s of [-1, 1]) part(g, 'box', '#4a3622', 1.04, 1.4, 0.07, 0, 1.66, s * 0.485);
      inst(bakeGeometry(g), VCOL, cells.win, (w) => {
        dummy.position.set(w.x + 0.5, 0, w.z + 0.5);
        dummy.rotation.set(0, w.axis === 'x' ? 0 : Math.PI / 2, 0);
      });
    }

    // 木板（一个 InstancedMesh，状态变化时才更新矩阵）
    {
      const g = new THREE.Group();
      for (let i = -1; i <= 1; i++) part(g, 'box', i ? '#8a6a40' : '#7a5a34', 0.3, 1.5, 0.09, i * 0.31, 0.75, 0);
      for (const y of [0.35, 1.15]) {
        part(g, 'box', '#4a3420', 0.98, 0.1, 0.12, 0, y, 0);
        for (let i = -1; i <= 1; i++) part(g, 'sphLo', '#b0b0a8', 0.02, 0.02, 0.02, i * 0.31, y, 0.065);
      }
      this.palletIM = new THREE.InstancedMesh(bakeGeometry(g), VCOL, Math.max(1, map.pallets.length));
      this.palletIM.frustumCulled = false;
      world.add(this.palletIM);
      this.palP = new THREE.Object3D();
      this.palB = new THREE.Object3D();
      this.palP.add(this.palB);
      this.pallets = map.pallets.map((p) => ({ x: p.x + 0.5, z: p.z + 0.5, axis: p.axis, st: 0, k: 0, dirty: true }));
    }

    // 发报机：机身烘焙成一个网格；进度灯所有机器共用一个 InstancedMesh
    const mGeo = machineGeo();
    this.lampIM = new THREE.InstancedMesh(GEO.sphLo, basic(0xffffff), setup.machines.length * 5);
    this.lampIM.frustumCulled = false;
    world.add(this.lampIM);
    this.lampKey = '';
    this.machines = setup.machines.map((m, mi) => {
      const g = new THREE.Group();
      g.position.set(m.x, 0, m.z);
      g.rotation.y = hash(m.x, m.z) * 0.6 - 0.3;
      g.add(new THREE.Mesh(mGeo, VCOL));
      g.updateMatrixWorld(true);
      for (let i = 0; i < 5; i++) {
        dummy.position.set(0.3, 1.2 + i * 0.36, -0.2).applyMatrix4(g.matrixWorld);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.setScalar(0.075);
        dummy.updateMatrix();
        this.lampIM.setMatrixAt(mi * 5 + i, dummy.matrix);
        this.lampIM.setColorAt(mi * 5 + i, colorOf('#2a2620'));
      }
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: th.lamp, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      halo.position.set(0.3, 3.7, -0.2);
      halo.scale.set(1.8, 1.8, 1);
      g.add(halo);
      // 高处的光柱：隔着墙也能看到哪里有发报机
      const beam = new THREE.Mesh(GEO.cylLo, new THREE.MeshBasicMaterial({ color: th.lamp, transparent: true, opacity: 0.1, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false }));
      beam.scale.set(0.12, 15, 0.12);
      beam.position.set(0.3, 11.5, -0.2);
      g.add(beam);
      world.add(g);
      return { g, halo, beam, p: 0, done: false, busy: false };
    });

    // 铁笼（实例化）+ 有人时亮起的红光
    inst(cageGeo(), VCOL, setup.cages, (c) => {
      dummy.position.set(c.x, 0, c.z);
      dummy.rotation.set(0, hash(c.x, c.z) * 6, 0);
    });
    this.cages = setup.cages.map((c) => {
      const warn = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: 0xff4030, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, fog: false }));
      warn.position.set(c.x, 3, c.z);
      warn.scale.set(1.4, 1.4, 1);
      warn.visible = false;
      world.add(warn);
      return { warn, who: null };
    });

    // 大门：砖柱、拱梁、带尖刺的铁栅门
    this.gates = map.gates.map((gt) => {
      const g = new THREE.Group();
      g.position.set(gt.x, 0, gt.z);
      if (gt.side === 'w' || gt.side === 'e') g.rotation.y = Math.PI / 2;
      const frame = pivot(g, 0, 0, 0);
      for (const s of [-1, 1]) {
        part(frame, 'box', '#4a4648', 0.7, 5, 1.3, s * 1.85, 2.5, 0);
        part(frame, 'box', '#5a5658', 0.86, 0.22, 1.46, s * 1.85, 5.1, 0);
        part(frame, 'box', '#5a5658', 0.86, 0.3, 1.46, s * 1.85, 0.15, 0);
        part(frame, 'cone', '#3a3638', 0.4, 0.6, 0.4, s * 1.85, 5.5, 0);
        for (let i = 0; i < 6; i++) part(frame, 'box', '#3e3a3c', 0.72, 0.04, 1.32, s * 1.85, 0.8 + i * 0.75, 0);
      }
      part(frame, 'box', '#4a4648', 4.3, 0.5, 1.2, 0, 4.75, 0);
      part(frame, 'box', '#2a2c30', 1.6, 0.36, 0.1, 0, 4.75, 0.62);
      g.add(new THREE.Mesh(bakeGeometry(frame), VCOL));
      const door = (s) => {
        const d = pivot(g, s * 1.5, 0, 0);
        const tmp = new THREE.Group();
        part(tmp, 'box', '#23262c', 1.5, 0.12, 0.1, -s * 0.75, 0.3, 0);
        part(tmp, 'box', '#23262c', 1.5, 0.12, 0.1, -s * 0.75, 3.6, 0);
        part(tmp, 'box', '#23262c', 1.5, 0.1, 0.08, -s * 0.75, 2.0, 0);
        for (let i = 0; i < 6; i++) {
          const x = -s * (0.12 + i * 0.255);
          part(tmp, 'cylLo', '#2c3038', 0.035, 4.0, 0.035, x, 2.1, 0);
          part(tmp, 'coneLo', '#3a3e48', 0.06, 0.26, 0.06, x, 4.22, 0);
        }
        const tor = part(tmp, 'tor', '#3a3e48', 0.3, 0.3, 0.3, -s * 0.75, 2.8, 0);
        tor.scale.z = 0.4;
        d.add(new THREE.Mesh(bakeGeometry(tmp), VCOL));
        return d;
      };
      const dl = door(-1);
      const dr = door(1);
      const lamp = part(g, 'sph', new THREE.MeshBasicMaterial({ color: 0x802018 }), 0.18, 0.18, 0.18, 0, 5.3, 0.6);
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: 0xff3020, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
      halo.position.set(0, 5.3, 0.6);
      halo.scale.set(3, 3, 1);
      g.add(halo);
      world.add(g);
      // 电闸
      const pg = new THREE.Group();
      pg.position.set(gt.panel.x, 0, gt.panel.z);
      const pb = pivot(pg, 0, 0, 0);
      part(pb, 'cylLo', '#3a3a40', 0.06, 1.3, 0.06, 0, 0.65, 0);
      part(pb, 'box', '#5a4a30', 0.44, 0.56, 0.2, 0, 1.3, 0);
      part(pb, 'box', '#2a2420', 0.34, 0.44, 0.02, 0, 1.3, 0.1);
      for (const s of [-1, 1]) part(pb, 'cyl', '#c8a850', 0.03, 0.02, 0.03, s * 0.1, 1.44, 0.11).rotation.x = Math.PI / 2;
      pg.add(new THREE.Mesh(bakeGeometry(pb), VCOL));
      const lever = pivot(pg, 0, 1.26, 0.11);
      const lv = new THREE.Group();
      part(lv, 'cylLo', '#b8a060', 0.025, 0.3, 0.025, 0, 0.15, 0);
      part(lv, 'sphLo', '#a03028', 0.055, 0.055, 0.055, 0, 0.3, 0);
      lever.add(new THREE.Mesh(bakeGeometry(lv), VCOL));
      lever.rotation.x = 0.9;
      world.add(pg);
      return { g, dl, dr, lamp, halo, lever, open: 0, target: 0, p: 0 };
    });

    // 地窖
    {
      const g = new THREE.Group();
      g.position.set(setup.hatch.x, 0, setup.hatch.z);
      const base = pivot(g, 0, 0, 0);
      part(base, 'box', '#2a2622', 1.3, 0.1, 1.3, 0, 0.05, 0);
      part(base, 'box', '#050505', 1.0, 0.11, 1.0, 0, 0.05, 0);
      for (const s of [-1, 1]) part(base, 'box', '#4a4640', 1.3, 0.14, 0.14, 0, 0.07, s * 0.58);
      g.add(new THREE.Mesh(bakeGeometry(base), VCOL));
      const lid = pivot(g, 0, 0.12, -0.5);
      const lt = new THREE.Group();
      for (let i = -2; i <= 2; i++) part(lt, 'box', i % 2 ? '#4a3a2a' : '#3e3024', 0.2, 0.07, 1.0, i * 0.2, 0, 0.5);
      for (const z of [0.2, 0.8]) part(lt, 'box', '#2a2c30', 1.02, 0.03, 0.08, 0, 0.045, z);
      part(lt, 'tor', '#2a2c30', 0.08, 0.08, 0.08, 0, 0.06, 0.88).rotation.x = Math.PI / 2;
      lid.add(new THREE.Mesh(bakeGeometry(lt), VCOL));
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: 0x80c0ff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      halo.position.y = 0.6;
      halo.scale.set(2.4, 2.4, 1);
      halo.visible = false;
      g.add(halo);
      world.add(g);
      this.hatch = { g, lid, halo, open: false };
    }

    // 路灯：灯杆实例化，灯泡和光晕合成一个 Points，地上的光斑实例化
    const posts = map.blocks.map((b, i) => ({ x: b.x + 0.5, z: b.z + 0.5, r: (i % 4) * (Math.PI / 2) + 0.4 }));
    const bulb = (p) => ({ x: p.x + Math.cos(p.r) * 0.45, z: p.z - Math.sin(p.r) * 0.45 });
    inst(lampGeo(), VCOL, posts, (p) => {
      dummy.position.set(p.x, 0, p.z);
      dummy.rotation.set(0, p.r, 0);
    });
    {
      const pos = new Float32Array(posts.length * 3);
      posts.forEach((p, i) => pos.set([bulb(p).x, 3.22, bulb(p).z], i * 3));
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const halos = new THREE.Points(geo, new THREE.PointsMaterial({ map: this.glow, color: th.lamp, size: 2.6, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending }));
      halos.frustumCulled = false;
      world.add(halos);
      const core = new THREE.Points(geo, new THREE.PointsMaterial({ map: this.glow, color: 0xfff4d8, size: 0.5, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      core.frustumCulled = false;
      world.add(core);
      inst(aoGeo, new THREE.MeshBasicMaterial({ map: this.glow, color: th.lamp, transparent: true, opacity: 0.2, depthWrite: false, blending: THREE.AdditiveBlending }), posts, (p) => {
        dummy.position.set(bulb(p).x, 0.035, bulb(p).z);
        dummy.scale.set(7.5, 1, 7.5);
      });
    }
    // 马戏团：帐篷上的小旗和串在灯杆间的三角彩旗
    if (map.theme === 'circus') {
      const fg = new THREE.Group();
      part(fg, 'cylLo', '#2a2420', 0.04, 2.4, 0.04, 0, 1.2, 0);
      part(fg, 'coneLo', '#a03a44', 0.22, 0.6, 0.04, 0.32, 2.15, 0).rotation.z = -Math.PI / 2;
      part(fg, 'sphLo', '#c8a850', 0.07, 0.07, 0.07, 0, 2.44, 0);
      inst(bakeGeometry(fg), VCOL, map.blocks.filter((b) => b.name === 'shack' || b.name === 'big'), (b) => {
        dummy.position.set(b.x + 5.5, 3, b.z + 5.5);
        dummy.rotation.set(0, hash(b.x, b.z) * 6, 0);
      });
      const flags = [];
      for (let j = 0; j < 5; j++)
        for (let i = 0; i < 4; i++) {
          if (hash(i * 7, j * 3) > 0.55) continue;
          const a = posts[j * 5 + i];
          const b = posts[j * 5 + i + 1];
          for (let k = 1; k < 12; k++) {
            const t = k / 12;
            flags.push([lerp(a.x, b.x, t), 3.0 - Math.sin(t * Math.PI) * 0.7, lerp(a.z, b.z, t), k]);
          }
        }
      const tri = new THREE.ConeGeometry(0.16, 0.34, 3).rotateX(Math.PI);
      const im = inst(tri, lambert({ color: 0xffffff }), flags, ([x, y, z]) => {
        dummy.position.set(x, y, z);
        dummy.scale.set(1, 1, 0.15);
      });
      if (im) flags.forEach((f, i) => im.setColorAt(i, colorOf(['#a03a44', '#d8cdb0', '#3f6a8a', '#c8a850'][f[3] % 4])));
    }
    // 草丛
    {
      const tg = new THREE.Group();
      for (let i = 0; i < 4; i++) {
        const b = part(tg, 'coneLo', i % 2 ? th.grass : '#3c4a30', 0.045, 0.34 + i * 0.05, 0.02, Math.sin(i * 1.7) * 0.08, 0.17, Math.cos(i * 1.7) * 0.08);
        b.rotation.z = Math.sin(i * 2.3) * 0.35;
        b.rotation.x = Math.cos(i * 1.9) * 0.3;
      }
      const tufts = [];
      for (let i = 0; i < 900 && tufts.length < 420; i++) {
        const x = 1 + hash(i, 11) * (W - 2);
        const z = 1 + hash(i, 23) * (W - 2);
        if (map.rows[Math.floor(z)][Math.floor(x)] !== '0') continue;
        if (map.theme === 'harbor' && hash(i, 5) > 0.35) continue;
        tufts.push([x, z, 0.7 + hash(i, 31) * 0.9]);
      }
      this.grass = inst(bakeGeometry(tg), VCOL, tufts, ([x, z, s]) => {
        dummy.position.set(x, 0, z);
        dummy.rotation.set(0, hash(x, z) * 6, 0);
        dummy.scale.set(s, s, s);
      });
      if (this.grass) this.grass.visible = this.quality !== 'low';
    }
    // 场外的枯树林
    {
      const tg = new THREE.Group();
      part(tg, 'taper', '#16181c', 0.3, 5, 0.3, 0, 2.5, 0).rotation.x = Math.PI;
      for (let i = 0; i < 4; i++) {
        const br = pivot(tg, 0, 2.6 + i * 0.6, 0);
        br.rotation.y = i * 1.7;
        br.rotation.z = 0.8;
        part(br, 'coneLo', '#16181c', 0.09, 2.2 - i * 0.3, 0.09, 0, 1.0, 0);
      }
      part(tg, 'cone', '#121a1c', 1.9, 4.2, 1.9, 0, 5.4, 0);
      part(tg, 'cone', '#101618', 1.4, 3.4, 1.4, 0, 7.2, 0);
      const trees = [];
      for (let i = 0; i < 80; i++) {
        const a = (i / 80) * TAU + hash(i, 3);
        const rr = (W * 0.5 + 5 + hash(i, 7) * 24) * 1.25;
        trees.push([W / 2 + Math.sin(a) * rr, W / 2 + Math.cos(a) * rr, 0.8 + hash(i, 1) * 0.9]);
      }
      inst(bakeGeometry(tg), VCOL, trees, ([x, z, s]) => {
        dummy.position.set(x, 0, z);
        dummy.rotation.set(0, hash(x, z) * 6, (hash(z, x) - 0.5) * 0.14);
        dummy.scale.set(s, s, s);
      });
    }

    // 角色
    for (const p of setup.players) {
      const def = (p.role === 'hunter' ? cfg.HUNTERS : cfg.SURVIVORS)[p.char];
      const m = p.role === 'hunter' ? makeHunter(def.look) : makeSurvivor(def.look, p.color, p.char);
      const shadow = new THREE.Mesh(GEO.disc, new THREE.MeshBasicMaterial({ map: this.glow, color: 0x000000, transparent: true, opacity: 0.6, depthWrite: false }));
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.y = 0.03;
      shadow.scale.setScalar(p.role === 'hunter' ? 1.1 : 0.62);
      m.g.add(shadow);
      const label = textSprite(p.name, p.role === 'hunter' ? '#ff8a70' : p.color, 0.34);
      label.position.y = m.h + 0.35;
      m.g.add(label);
      // 隔墙可见的标记（探路人的铜哨 / 踩到丝网 / 校准失败）
      const mark = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: p.role === 'hunter' ? 0xff3020 : 0xffd060, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
      mark.position.y = m.h * 0.6;
      mark.scale.set(2.2, 2.2, 1);
      mark.visible = false;
      mark.renderOrder = 9;
      m.g.add(mark);
      // 眩晕时头顶转的星星
      const stars = pivot(m.g, 0, m.h + 0.15, 0);
      const sm = new THREE.MeshBasicMaterial({ color: 0xffe070 });
      for (let i = 0; i < 3; i++) part(stars, 'sphLo', sm, 0.07, 0.07, 0.07, Math.sin((i / 3) * TAU) * 0.35, 0, Math.cos((i / 3) * TAU) * 0.35);
      stars.visible = false;
      m.g.visible = false;
      world.add(m.g);
      const c = { ...m, shadow, label, mark, stars, info: p, x: 0, z: 0, d: 0, y: 0, phase: Math.random() * 6, has: false, swing: 0, ghost: 1 };
      this.chars.set(p.id, c);
      if (p.role === 'hunter') this.hunterC = c;
    }

    // 丝网、假人
    this.webs = new Map();
    this.decoys = new Map();
    this.webTex = canvasTex(128, (g, s) => {
      g.strokeStyle = 'rgba(230,230,240,.9)';
      g.lineWidth = 1.5;
      g.translate(s / 2, s / 2);
      for (let i = 0; i < 8; i++) {
        g.beginPath();
        g.moveTo(0, 0);
        g.lineTo(Math.cos((i / 8) * TAU) * 60, Math.sin((i / 8) * TAU) * 60);
        g.stroke();
      }
      for (let r = 14; r < 60; r += 12) {
        g.beginPath();
        for (let i = 0; i <= 8; i++) g.lineTo(Math.cos((i / 8) * TAU) * r, Math.sin((i / 8) * TAU) * r);
        g.stroke();
      }
    });

    // 粒子
    const mk = (additive, size) => {
      const N = 400;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3).fill(-999), 3));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
      const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size, map: this.glow, vertexColors: true, transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, opacity: additive ? 1 : 0.55 }));
      pts.frustumCulled = false;
      world.add(pts);
      return { pts, N, list: [], next: 0 };
    };
    this.pa = mk(true, 0.3);
    this.pn = mk(false, 0.7);
    // 贴着地面飘的雾（实例化的水平薄片，一次绘制）
    this.mist = [];
    for (let i = 0; i < 22; i++) this.mist.push({ x: Math.random() * W, z: Math.random() * W, y: 0.5 + Math.random() * 0.9, s: 10 + Math.random() * 10, v: 0.25 + Math.random() * 0.45 });
    this.mistIM = new THREE.InstancedMesh(aoGeo, new THREE.MeshBasicMaterial({ map: this.glow, color: th.fog, transparent: true, opacity: 0.28, depthWrite: false }), this.mist.length);
    this.mistIM.frustumCulled = false;
    this.mistIM.visible = this.quality !== 'low';
    world.add(this.mistIM);
    this.dummy = dummy;
    this.W = W;
  }

  // ---------------- 粒子 ----------------
  burst(x, y, z, n, color, { speed = 3, up = 2, life = 0.7, additive = true, grav = -6 } = {}) {
    if (!this.pa) return;
    const sys = additive ? this.pa : this.pn;
    const c = colorOf(color);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const s = speed * (0.3 + Math.random() * 0.7);
      const p = { i: sys.next, x, y, z, vx: Math.sin(a) * s, vy: up * (0.3 + Math.random()), vz: Math.cos(a) * s, life: life * (0.6 + Math.random() * 0.6), t: 0, r: c.r, g: c.g, b: c.b, grav };
      sys.next = (sys.next + 1) % sys.N;
      for (let k = 0; k < sys.list.length; k++)
        if (sys.list[k].i === p.i) {
          sys.list.splice(k, 1);
          break;
        }
      sys.list.push(p);
    }
  }
  stepParticles(sys, dt) {
    if (!sys.list.length && !sys.dirty) return;
    const pos = sys.pts.geometry.attributes.position;
    const col = sys.pts.geometry.attributes.color;
    let alive = 0;
    for (let k = 0; k < sys.list.length; k++) {
      const p = sys.list[k];
      p.t += dt;
      p.vy += p.grav * dt;
      p.x += p.vx * dt;
      p.y = Math.max(0.03, p.y + p.vy * dt);
      p.z += p.vz * dt;
      const done = p.t >= p.life;
      const f = done ? 0 : 1 - p.t / p.life;
      pos.setXYZ(p.i, p.x, done ? -999 : p.y, p.z);
      col.setXYZ(p.i, p.r * f, p.g * f, p.b * f);
      if (!done) sys.list[alive++] = p;
    }
    sys.list.length = alive;
    sys.dirty = alive > 0;
    pos.needsUpdate = col.needsUpdate = true;
  }

  // ---------------- 同步服务器状态 ----------------
  sync(st, meRole) {
    if (!this.world) return;
    this.state = st;
    this.meRole = meRole;
    st.machines.forEach((m, i) => {
      const o = this.machines[i];
      o.p = m[0];
      o.done = !!m[1];
      o.busy = !!m[2];
    });
    for (let i = 0; i < this.pallets.length; i++) this.pallets[i].st = Number(st.pallets[i]);
    st.gates.forEach((g, i) => {
      const o = this.gates[i];
      o.target = g[1] ? 1 : 0;
      o.p = g[0];
    });
    st.cages.forEach((who, i) => (this.cages[i].who = who));
    this.hatch.open = !!st.hatch;
    // 丝网
    if (st.webs.length || this.webs.size) {
      const seen = new Set();
      for (const [id, x, z] of st.webs) {
        seen.add(id);
        if (this.webs.has(id)) continue;
        const m = new THREE.Mesh(GEO.disc, new THREE.MeshBasicMaterial({ map: this.webTex, transparent: true, depthWrite: false, opacity: 0.8 }));
        m.rotation.x = -Math.PI / 2;
        m.position.set(x, 0.04, z);
        m.scale.setScalar(0.1);
        this.world.add(m);
        this.webs.set(id, m);
      }
      for (const [id, m] of this.webs)
        if (!seen.has(id)) {
          this.world.remove(m);
          this.webs.delete(id);
        }
    }
    // 假人
    if (st.decoys.length || this.decoys.size) {
      const seenD = new Set();
      for (const [id, x, z, d, color] of st.decoys) {
        seenD.add(id);
        if (this.decoys.has(id)) continue;
        const m = makeSurvivor(this.cfg.SURVIVORS.illusion.look, color, 'illusion');
        m.g.position.set(x, 0, z);
        m.g.rotation.y = d;
        this.world.add(m.g);
        this.decoys.set(id, m);
      }
      for (const [id, m] of this.decoys)
        if (!seenD.has(id)) {
          this.burst(m.g.position.x, 1, m.g.position.z, 20, 0xb090ff, { additive: false, speed: 1.5, up: 1, grav: 1 });
          this.world.remove(m.g);
          m.g.traverse((o) => o.geometry && o.geometry.userData.baked && o.geometry.dispose());
          this.decoys.delete(id);
        }
    }
    for (const p of st.players) {
      const c = this.chars.get(p.id);
      if (!c) continue;
      c.pl = p;
      if (p.x !== null) {
        c.tx = p.x;
        c.tz = p.z;
        c.td = p.d;
        if (!c.has || Math.hypot(c.x - p.x, c.z - p.z) > 6) {
          c.x = p.x;
          c.z = p.z;
          c.d = p.d;
          c.has = true;
        }
      }
    }
  }

  // ---------------- 每帧 ----------------
  frame(dt, mePos) {
    if (!this.world || !this.state) return;
    this.adapt(dt);
    const t = (this.time += dt);
    const st = this.state;
    const meC = this.chars.get(this.you);
    const mePl = meC && meC.pl;
    const dummy = this.dummy;

    for (const [id, c] of this.chars) {
      const p = c.pl;
      if (!p) continue;
      const hidden = p.st === 'escaped' || p.st === 'dead' || p.hid;
      c.g.visible = !hidden;
      if (hidden) continue;
      // 位置：自己用本地预测，别人向服务器位置平滑靠拢
      const px = c.x;
      const pz = c.z;
      if (id === this.you && mePos) {
        c.x = mePos.x;
        c.z = mePos.z;
        c.d = lerpAng(c.d, mePos.d, damp(16, dt));
      } else if (c.tx !== undefined) {
        const k = damp(15, dt);
        c.x = lerp(c.x, c.tx, k);
        c.z = lerp(c.z, c.tz, k);
        c.d = lerpAng(c.d, c.td, damp(11, dt));
      }
      const moved = Math.hypot(c.x - px, c.z - pz);
      c.speed = lerp(c.speed || 0, moved / Math.max(dt, 1e-3), damp(12, dt));
      c.phase += moved * (c.info.role === 'hunter' ? 2.1 : 3.9);
      this.pose(c, p, t, dt, c.speed);
    }

    // 发报机的进度灯（只在亮灭有变化时写一次）
    let key = '';
    const blink = Math.sin(t * 10) > 0;
    for (const m of this.machines) key += m.done ? 'D' : Math.floor(m.p * 5 + 0.001) + (m.busy && blink ? 'b' : '');
    if (key !== this.lampKey) {
      this.lampKey = key;
      this.machines.forEach((m, mi) => {
        const lit = m.done ? 5 : Math.floor(m.p * 5 + 0.001);
        for (let i = 0; i < 5; i++) this.lampIM.setColorAt(mi * 5 + i, colorOf(m.done ? '#60ff90' : i < lit || (i === lit && m.busy && blink) ? '#ffc040' : '#2a2620'));
      });
      this.lampIM.instanceColor.needsUpdate = true;
    }
    for (const m of this.machines) {
      m.halo.material.color.setHex(m.done ? 0x60ff90 : this.th.lamp);
      m.halo.material.opacity = m.done ? 0.7 : 0.25 + m.p * 0.5 + (m.busy ? Math.sin(t * 12) * 0.1 : 0);
      m.beam.visible = !m.done && !st.powered;
      m.beam.material.opacity = 0.07 + m.p * 0.1;
    }
    // 木板
    let palDirty = false;
    for (let i = 0; i < this.pallets.length; i++) {
      const p = this.pallets[i];
      const target = p.st === 0 ? 0 : 1;
      if (!p.dirty && Math.abs(p.k - target) < 0.002 && p.shown === p.st) continue;
      p.k = Math.abs(p.k - target) < 0.004 ? target : lerp(p.k, target, damp(18, dt));
      p.dirty = false;
      p.shown = p.st;
      this.palP.position.set(p.x, 0, p.z);
      this.palP.rotation.y = p.axis === 'z' ? Math.PI / 2 : 0;
      this.palB.position.set(0, p.k * 0.25, lerp(0.42, 0.62, p.k));
      this.palB.rotation.x = -p.k * 1.25;
      this.palB.scale.setScalar(p.st === 2 ? 0.0001 : 1);
      this.palP.updateMatrixWorld(true);
      this.palletIM.setMatrixAt(i, this.palB.matrixWorld);
      palDirty = true;
    }
    if (palDirty) this.palletIM.instanceMatrix.needsUpdate = true;
    // 大门
    for (const g of this.gates) {
      g.open = lerp(g.open, g.target, damp(1.6, dt));
      g.dl.rotation.y = g.open * 1.9;
      g.dr.rotation.y = -g.open * 1.9;
      const c = g.target ? 0x40ff80 : st.powered ? (Math.sin(t * 6) > 0 ? 0xffc040 : 0x604010) : 0x802018;
      g.lamp.material.color.setHex(c);
      g.halo.material.color.setHex(c);
      g.lever.rotation.x = 0.9 - g.p * 1.8;
    }
    // 铁笼
    for (const c of this.cages) {
      c.warn.visible = !!c.who;
      if (c.who) c.warn.scale.setScalar(1.2 + Math.sin(t * 5) * 0.3);
    }
    // 地窖
    this.hatch.lid.rotation.x = lerp(this.hatch.lid.rotation.x, this.hatch.open ? -1.3 : 0, damp(3, dt));
    this.hatch.halo.visible = this.hatch.open;
    // 丝网：追猎者一直看得见，求生者走近了才看得见
    for (const m of this.webs.values()) {
      m.scale.setScalar(lerp(m.scale.x, 1.1, damp(5, dt)));
      const near = meC ? Math.hypot(m.position.x - meC.x, m.position.z - meC.z) : 0;
      m.material.opacity = this.meRole === 'hunter' || !mePl ? 0.85 : clamp((6 - near) / 3, 0, 0.6);
    }
    if (this.mistIM.visible) {
      for (let i = 0; i < this.mist.length; i++) {
        const m = this.mist[i];
        m.x += m.v * dt;
        if (m.x > this.W + 8) m.x = -8;
        dummy.position.set(m.x, m.y, m.z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(m.s, 1, m.s * 0.6);
        dummy.updateMatrix();
        this.mistIM.setMatrixAt(i, dummy.matrix);
      }
      this.mistIM.instanceMatrix.needsUpdate = true;
    }
    this.stepParticles(this.pa, dt);
    this.stepParticles(this.pn, dt);
    this.updateCamera(dt);
    this.r.render(this.scene, this.cam);
  }

  // 人偶的姿势
  pose(c, p, t, dt, speed) {
    const role = c.info.role;
    const hunterC = this.hunterC;
    const walking = speed > 0.4;
    const run = clamp(speed / 4, 0, 1.3);
    let y = 0;
    let rx = 0; // 身体前倾
    let la = 0;
    let ra = 0;
    let fl = -0.25; // 肘
    let fr = -0.25;
    let ll = 0;
    let rl = 0;
    let sl = 0; // 膝
    let sr = 0;
    let headX = 0;
    let rootRotX = 0;
    let rootY = 0;
    let twist = 0;
    const sw = Math.sin(c.phase);
    if (walking) {
      ll = sw * 0.85 * run;
      rl = -sw * 0.85 * run;
      sl = Math.max(0, sw) * 1.2 * run + 0.1;
      sr = Math.max(0, -sw) * 1.2 * run + 0.1;
      la = -sw * 0.75 * run;
      ra = sw * 0.75 * run;
      fl = fr = -0.3 - 0.75 * Math.min(1, run);
      y = Math.abs(Math.cos(c.phase)) * 0.07 * run;
      rx = 0.14 * run;
      twist = sw * 0.12 * run;
    } else {
      y = Math.sin(t * 2 + c.phase) * 0.012;
      la = Math.sin(t * 1.6 + c.phase) * 0.05;
      ra = -la;
      headX = Math.sin(t * 0.9 + c.phase) * 0.04;
    }
    if (c.hover) y += 0.08 + Math.sin(t * 2.4) * 0.05;
    const a = p.a;
    if (role === 'survivor') {
      if (p.hp === 1 && p.st === 'ok') {
        // 受伤：捂着肩膀、一瘸一拐
        la = -0.9;
        fl = -1.9;
        rx += 0.28;
        y -= Math.abs(sw) * 0.04;
        if (Math.random() < dt * 2) this.burst(c.x, 0.9, c.z, 1, 0x901818, { additive: false, speed: 0.3, up: 0, life: 0.8 });
      }
      if (a === 'decode') {
        la = -0.9 + Math.sin(t * 18) * 0.12;
        ra = -0.9 + Math.cos(t * 15) * 0.12;
        fl = -0.9 + Math.sin(t * 22) * 0.3;
        fr = -0.9 + Math.cos(t * 19) * 0.3;
        rx = 0.22;
        headX = 0.25;
      } else if (a === 'heal' || a === 'rescue' || a === 'gate') {
        la = -1.2 + Math.sin(t * 8) * 0.25;
        ra = -1.0 + Math.cos(t * 8) * 0.25;
        fl = fr = -0.7;
        rx = 0.25;
      } else if (a === 'selfheal') {
        la = -1.2;
        fl = -1.8;
        ra = -0.6 + Math.sin(t * 6) * 0.3;
        fr = -1.4;
        rootY = -0.26;
        ll = rl = -1.5;
        sl = sr = 1.6;
      } else if (a === 'vault') {
        y = Math.sin(clamp(p.ap, 0, 1) * Math.PI) * 1.0;
        rx = 0.7;
        la = ra = -2.4;
        fl = fr = -0.3;
        ll = -1.2;
        sl = 1.3;
        rl = 0.5;
      }
      if (p.st === 'down') {
        rootRotX = Math.PI / 2 - 0.1;
        rootY = 0.2;
        la = -2.7 + (walking ? sw * 0.6 : 0);
        ra = -2.7 - (walking ? sw * 0.6 : 0);
        fl = fr = -0.5;
        ll = walking ? sw * 0.3 : 0;
        rl = -ll;
        sl = sr = 0.3;
        y = 0;
        rx = 0;
        twist = 0;
      } else if (p.st === 'carried' && hunterC) {
        // 被扛在肩上，挣扎
        rootRotX = Math.PI / 2;
        rootY = hunterC.h * 0.7;
        la = Math.sin(t * 14) * 0.8 - 2;
        ra = Math.cos(t * 14) * 0.8 - 2;
        ll = Math.sin(t * 12) * 0.6;
        rl = -ll;
        sl = sr = 0.6;
        c.x = hunterC.x - Math.cos(hunterC.d) * 0.38;
        c.z = hunterC.z + Math.sin(hunterC.d) * 0.38;
        c.d = hunterC.d + Math.PI / 2;
        y = 0;
      } else if (p.st === 'caged') {
        // 抱膝坐在笼里，抓着栏杆
        rootY = -0.3;
        ll = rl = -1.5;
        sl = sr = 1.7;
        la = -1.5 + Math.sin(t * 5 + c.phase) * 0.15;
        ra = -1.5 + Math.cos(t * 5 + c.phase) * 0.15;
        fl = fr = -0.6;
        y = 0;
        rx = 0.1;
        twist = 0;
        c.g.rotation.y += dt * 0.4;
      }
      c.shadow.visible = p.st !== 'carried';
      const ghost = p.inv ? 0.3 : 1;
      if (c.ghost !== ghost) {
        c.ghost = ghost;
        c.g.traverse((o) => {
          if (o.isMesh && o.userData.baked) o.material = ghost < 1 ? GHOST : VCOL;
        });
      }
      c.mark.visible = this.meRole === 'hunter' && !!p.shown && p.st === 'ok';
      c.label.visible = this.meRole !== 'hunter' && c.info.id !== this.you && p.st !== 'carried';
    } else {
      rx *= 0.6;
      if (a === 'wind') {
        c.swing = lerp(c.swing, 1, damp(16, dt));
        ra = -2.9 * c.swing;
        fr = -0.9 * c.swing;
        rx = -0.2 * c.swing;
        twist = -0.5 * c.swing;
      } else if (a === 'wipe' || a === 'rec') {
        c.swing = lerp(c.swing, 0, damp(a === 'wipe' ? 3 : 6, dt));
        ra = 0.7 - c.swing * 3.4;
        fr = -0.15;
        rx = 0.4 * (1 - c.swing) + 0.1;
        twist = 0.5 - c.swing;
        if (a === 'wipe') {
          la = -1.0 + Math.sin(t * 9) * 0.25;
          fl = -1.3;
        }
      } else {
        c.swing = 0;
        ra += -0.2;
      }
      if (a === 'dash') {
        rx = 0.85;
        la = ra = 1.2;
        fl = fr = -0.1;
        if (Math.random() < dt * 60) this.burst(c.x, 1, c.z, 1, 0xffb040, { speed: 0.6, up: 0.5, life: 0.4 });
      } else if (a === 'cast') {
        rootY = -0.6 - Math.sin(t * 9) * 0.1;
        la = ra = -2.6;
        if (Math.random() < dt * 40) this.burst(c.x, 0.8, c.z, 1, 0x90b8e0, { additive: false, speed: 1.2, up: 1.5, life: 0.9, grav: 0.5 });
      } else if (a === 'break' || a === 'pickup' || a === 'cage') {
        la = -1.4 + Math.sin(t * 12) * 0.5;
        ra = -1.4 + Math.cos(t * 12) * 0.5;
        fl = fr = -0.8;
        rx = 0.45;
      } else if (a === 'vault') {
        y += Math.sin(clamp(p.ap, 0, 1) * Math.PI) * 0.7;
        rx = 0.5;
        ll = -1.0;
        sl = 1.0;
      }
      if (p.carry) {
        la = -2.6;
        fl = -0.9;
      }
      if (p.stun > 0) {
        rx = 0.5 + Math.sin(t * 5) * 0.1;
        la = ra = -0.4;
        headX = 0.5;
        twist = Math.sin(t * 7) * 0.15;
      }
      c.mark.visible = this.meRole !== 'hunter' && !!this.state.reveal;
      c.label.visible = false;
    }
    c.stars.visible = p.stun > 0;
    if (p.stun > 0) c.stars.rotation.y = t * 6;
    const k = damp(18, dt);
    c.armL.rotation.x = lerp(c.armL.rotation.x, la, k);
    c.armR.rotation.x = lerp(c.armR.rotation.x, ra, k);
    c.foreL.rotation.x = lerp(c.foreL.rotation.x, fl, k);
    c.foreR.rotation.x = lerp(c.foreR.rotation.x, fr, k);
    c.legL.rotation.x = lerp(c.legL.rotation.x, ll, k);
    c.legR.rotation.x = lerp(c.legR.rotation.x, rl, k);
    c.shinL.rotation.x = lerp(c.shinL.rotation.x, sl, k);
    c.shinR.rotation.x = lerp(c.shinR.rotation.x, sr, k);
    c.body.rotation.x = lerp(c.body.rotation.x, rx, k);
    c.body.rotation.y = lerp(c.body.rotation.y, twist, k);
    c.head.rotation.x = lerp(c.head.rotation.x, headX - rx * 0.6, k);
    c.head.rotation.y = lerp(c.head.rotation.y, -twist * 0.8, k);
    c.root.rotation.x = lerp(c.root.rotation.x, rootRotX, damp(10, dt));
    c.root.position.y = lerp(c.root.position.y, rootY, damp(10, dt));
    c.y = lerp(c.y, y, damp(22, dt));
    c.g.position.set(c.x, c.y, c.z);
    if (p.st !== 'caged') c.g.rotation.y = c.d;
  }

  // ---------------- 镜头 ----------------
  updateCamera(dt) {
    // 手指给的是目标角度；实际角度按帧率无关的指数平滑跟过去，松手后带一点惯性
    if (this.spin) {
      this.yawT += this.spin * dt;
      this.spin *= Math.exp(-7 * dt);
      if (Math.abs(this.spin) < 0.02) this.spin = 0;
    }
    const k = damp(26, dt);
    this.yaw += (this.yawT - this.yaw) * k;
    this.pitch += (this.pitchT - this.pitch) * k;
    const f = this.focus;
    const tx = f.x;
    const ty = this.meRole === 'hunter' ? 1.95 : 1.3;
    const tz = f.z;
    // 镜头与角色之间有墙：先把镜头抬高（从墙头上方看过去），实在不行再拉近
    const map = this.setup.map;
    const W = map.W;
    const sy = Math.sin(this.yaw);
    const cy = Math.cos(this.yaw);
    const blockedAt = (pitch) => {
      const c = Math.cos(pitch);
      const s = Math.sin(pitch);
      for (let d = 0.5; d <= this.camDist; d += 0.3) {
        const cx = Math.floor(tx + sy * c * d);
        const cz = Math.floor(tz + cy * c * d);
        if (cx < 0 || cz < 0 || cx >= W || cz >= W) return d;
        const border = cx === 0 || cz === 0 || cx === W - 1 || cz === W - 1;
        if (map.rows[cz].charCodeAt(cx) === 49 && ty + s * d < (border ? 5 : 3.3)) return d;
      }
      return -1;
    };
    let pitch = this.pitch;
    let want = this.camDist;
    let hit = blockedAt(pitch);
    while (hit >= 0 && pitch < 1.3) {
      pitch = Math.min(1.3, pitch + 0.06);
      hit = blockedAt(pitch);
    }
    if (hit >= 0) want = Math.max(2.6, hit - 0.4);
    // 抬高要快（不能让墙挡住人），落回去要慢（避免贴墙走时上下晃）
    const cur = this.effPitch === undefined ? pitch : this.effPitch;
    this.effPitch = cur + (pitch - cur) * damp(pitch > cur ? 9 : 2.2, dt);
    const cp = Math.cos(this.effPitch);
    const sp = Math.sin(this.effPitch);
    this.curDist += (want - this.curDist) * damp(want < this.curDist ? 12 : 3.5, dt);
    const d = this.curDist;
    let ox = 0;
    let oy = 0;
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt * 2.5);
      ox = (Math.random() - 0.5) * this.shake * 0.5;
      oy = (Math.random() - 0.5) * this.shake * 0.5;
    }
    this.cam.position.set(tx + sy * cp * d + ox, ty + sp * d + oy, tz + cy * cp * d);
    this.cam.lookAt(tx, ty, tz);
  }
}
