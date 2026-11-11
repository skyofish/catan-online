// 雾夜追猎：3D 场景（Three.js）。哥特暗黑童话的人偶剧场质感：冷雾、月光、低饱和，角色是大头细肢的缝线人偶。
// 为了手机性能：墙和障碍用 InstancedMesh 一次画完，不开实时阴影（角色脚下用圆形影子），粒子用两个 Points。
import * as THREE from '/farm/vendor/three.module.min.js';

const TAU = Math.PI * 2;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerpAng = (a, b, t) => {
  let d = b - a;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  return a + d * t;
};

const THEMES = {
  circus: { sky: 0x27324a, fog: 0x3c4a62, fogD: 0.021, ground: ['#4a5440', '#5e5a44', '#3a4434'], wall: ['#8a343c', '#e0d4b8'], low: 0x8a6440, hemi: [0xaec4e6, 0x4a4238], moon: 0xcfdcf6, lamp: 0xffc060 },
  harbor: { sky: 0x202c3a, fog: 0x3a4c58, fogD: 0.023, ground: ['#48525a', '#58646a', '#3a444c'], wall: ['#3a6a78', '#4c808a'], low: 0x7a6248, hemi: [0xa6c6d8, 0x3a4048], moon: 0xc4dcea, lamp: 0xf0d090 },
  garden: { sky: 0x243240, fog: 0x3e5050, fogD: 0.022, ground: ['#44543e', '#525e48', '#36463a'], wall: ['#2e6240', '#3c7a4e'], low: 0x7c7c70, hemi: [0xb4d2c8, 0x3a463c], moon: 0xd4e8dc, lamp: 0xd8f0b0 },
};

// ---------------- 程序贴图 ----------------
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
function groundTex(th) {
  return canvasTex(256, (g, s) => {
    g.fillStyle = th.ground[0];
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < 1400; i++) {
      g.fillStyle = th.ground[1 + (i % 2)];
      g.globalAlpha = 0.25 + Math.random() * 0.4;
      const r = 1 + Math.random() * 5;
      g.beginPath();
      g.ellipse(Math.random() * s, Math.random() * s, r, r * (0.4 + Math.random() * 0.6), Math.random() * 3, 0, TAU);
      g.fill();
    }
    g.globalAlpha = 0.12;
    g.strokeStyle = '#000';
    for (let i = 0; i < 8; i++) {
      g.beginPath();
      g.moveTo(Math.random() * s, Math.random() * s);
      g.bezierCurveTo(Math.random() * s, Math.random() * s, Math.random() * s, Math.random() * s, Math.random() * s, Math.random() * s);
      g.stroke();
    }
  }, 16);
}
function wallTex(theme, th) {
  return canvasTex(128, (g, s) => {
    if (theme === 'circus') {
      // 褪色的条纹篷布
      for (let i = 0; i < 4; i++) {
        g.fillStyle = th.wall[i % 2];
        g.fillRect((i * s) / 4, 0, s / 4, s);
      }
      g.globalAlpha = 0.25;
      g.fillStyle = '#000';
      for (let i = 0; i < 300; i++) g.fillRect(Math.random() * s, Math.random() * s, 2, 6 + Math.random() * 20);
      g.globalAlpha = 0.5;
      g.fillRect(0, s - 10, s, 10);
    } else if (theme === 'harbor') {
      // 生锈的波纹铁皮
      g.fillStyle = th.wall[0];
      g.fillRect(0, 0, s, s);
      for (let i = 0; i < 8; i++) {
        g.fillStyle = i % 2 ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.2)';
        g.fillRect((i * s) / 8, 0, s / 16, s);
      }
      for (let i = 0; i < 60; i++) {
        g.fillStyle = `rgba(${120 + Math.random() * 60},${60 + Math.random() * 30},30,${0.15 + Math.random() * 0.3})`;
        g.fillRect(Math.random() * s, Math.random() * s, 4 + Math.random() * 14, 3 + Math.random() * 20);
      }
    } else {
      // 树篱
      g.fillStyle = th.wall[0];
      g.fillRect(0, 0, s, s);
      for (let i = 0; i < 900; i++) {
        const v = Math.random();
        g.fillStyle = v > 0.6 ? th.wall[1] : v > 0.3 ? '#1a3a26' : '#3a6a40';
        g.beginPath();
        g.ellipse(Math.random() * s, Math.random() * s, 3 + Math.random() * 3, 2, Math.random() * 3, 0, TAU);
        g.fill();
      }
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

// ---------------- 小工具 ----------------
const MATS = new Map();
function mat(color, opts = {}) {
  const key = color + JSON.stringify(opts);
  if (!MATS.has(key)) MATS.set(key, new THREE.MeshLambertMaterial({ color, ...opts }));
  return MATS.get(key);
}
const GEO = {
  box: new THREE.BoxGeometry(1, 1, 1),
  sph: new THREE.SphereGeometry(1, 14, 10),
  cyl: new THREE.CylinderGeometry(1, 1, 1, 10),
  cone: new THREE.ConeGeometry(1, 1, 10),
  disc: new THREE.CircleGeometry(1, 16),
  tor: new THREE.TorusGeometry(1, 0.06, 6, 16),
};
function part(parent, geo, color, sx, sy, sz, x = 0, y = 0, z = 0, opts) {
  const m = new THREE.Mesh(GEO[geo], typeof color === 'object' && color.isMaterial ? color : mat(color, opts));
  m.scale.set(sx, sy, sz);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}
function pivot(parent, x, y, z) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}

// ---------------- 角色模型 ----------------
// 求生者：约 1.5 米高的人偶，大头、细胳膊细腿，脖子和手腕有一圈缝线
function makeSurvivor(look, tint) {
  const g = new THREE.Group();
  const root = pivot(g, 0, 0, 0);
  const legL = pivot(root, -0.11, 0.5, 0);
  const legR = pivot(root, 0.11, 0.5, 0);
  for (const l of [legL, legR]) {
    part(l, 'cyl', '#2a2622', 0.06, 0.5, 0.06, 0, -0.25, 0);
    part(l, 'box', '#1a1614', 0.12, 0.08, 0.2, 0, -0.5, 0.04);
  }
  const body = pivot(root, 0, 0.5, 0);
  part(body, 'cone', look.coat, 0.3, 0.62, 0.26, 0, 0.3, 0);
  part(body, 'cyl', look.coat, 0.17, 0.3, 0.14, 0, 0.42, 0);
  part(body, 'cyl', look.accent, 0.18, 0.05, 0.15, 0, 0.3, 0);
  part(body, 'cyl', tint, 0.2, 0.04, 0.17, 0, 0.56, 0);
  const armL = pivot(body, -0.2, 0.52, 0);
  const armR = pivot(body, 0.2, 0.52, 0);
  for (const a of [armL, armR]) {
    part(a, 'cyl', look.coat, 0.05, 0.42, 0.05, 0, -0.21, 0);
    part(a, 'sph', look.skin, 0.06, 0.06, 0.06, 0, -0.44, 0);
  }
  const head = pivot(body, 0, 0.82, 0);
  part(head, 'sph', look.skin, 0.27, 0.25, 0.25);
  part(head, 'sph', look.hair, 0.285, 0.22, 0.27, 0, 0.06, -0.04);
  for (const s of [-1, 1]) {
    part(head, 'sph', '#14110f', 0.045, 0.055, 0.03, s * 0.1, -0.01, 0.23);
    part(head, 'sph', '#f4f0e0', 0.014, 0.014, 0.01, s * 0.1 + 0.012, 0.01, 0.255);
  }
  part(head, 'box', '#6a3a34', 0.07, 0.012, 0.01, 0, -0.11, 0.235);
  // 帽子 / 配饰
  if (look.hat === 'goggles') {
    for (const s of [-1, 1]) part(head, 'tor', look.accent, 0.06, 0.06, 0.06, s * 0.1, 0.13, 0.2);
  } else if (look.hat === 'cap') {
    part(head, 'cyl', '#f4f0ea', 0.2, 0.1, 0.2, 0, 0.25, 0);
    part(head, 'box', look.accent, 0.1, 0.03, 0.02, 0, 0.26, 0.2);
    part(head, 'box', look.accent, 0.03, 0.1, 0.02, 0, 0.26, 0.2);
  } else if (look.hat === 'flat') {
    part(head, 'cyl', look.accent, 0.27, 0.07, 0.27, 0, 0.22, 0.02);
    part(head, 'box', look.accent, 0.3, 0.03, 0.16, 0, 0.19, 0.24);
  } else if (look.hat === 'lantern') {
    part(head, 'cyl', '#3a3428', 0.3, 0.03, 0.3, 0, 0.2, 0);
    part(head, 'cyl', '#3a3428', 0.19, 0.16, 0.19, 0, 0.28, 0);
    const lamp = part(armL, 'sph', new THREE.MeshBasicMaterial({ color: 0xffc860 }), 0.07, 0.09, 0.07, 0, -0.55, 0.02);
    lamp.userData.glow = true;
  } else if (look.hat === 'top') {
    part(head, 'cyl', '#16141c', 0.3, 0.025, 0.3, 0, 0.21, 0);
    part(head, 'cyl', '#16141c', 0.17, 0.3, 0.17, 0, 0.36, 0);
    part(head, 'cyl', look.accent, 0.175, 0.05, 0.175, 0, 0.25, 0);
  } else if (look.hat === 'hood') {
    part(head, 'sph', look.coat, 0.31, 0.29, 0.3, 0, 0.03, -0.05);
    part(head, 'cone', look.coat, 0.12, 0.2, 0.12, 0, 0.3, -0.12);
  }
  return { g, root, body, head, armL, armR, legL, legR, h: 1.5 };
}

// 追猎者：两米多高，三种体型
function makeHunter(look) {
  const g = new THREE.Group();
  const root = pivot(g, 0, 0, 0);
  const eye = new THREE.MeshBasicMaterial({ color: look.eye });
  const legL = pivot(root, -0.16, 0.9, 0);
  const legR = pivot(root, 0.16, 0.9, 0);
  const body = pivot(root, 0, 0.9, 0);
  let head, armL, armR;
  if (look.kind === 'scarecrow') {
    for (const l of [legL, legR]) part(l, 'cyl', '#4a3a22', 0.07, 0.9, 0.07, 0, -0.45, 0);
    part(body, 'cone', look.body, 0.42, 1.0, 0.34, 0, 0.45, 0);
    part(body, 'cyl', '#6a5a30', 0.3, 0.12, 0.26, 0, 0.1, 0);
    part(body, 'box', '#3a2c18', 1.3, 0.07, 0.07, 0, 0.86, -0.05);
    armL = pivot(body, -0.36, 0.86, 0);
    armR = pivot(body, 0.36, 0.86, 0);
    for (const a of [armL, armR]) {
      part(a, 'cyl', look.body, 0.07, 0.75, 0.07, 0, -0.37, 0);
      part(a, 'cone', look.accent, 0.1, 0.2, 0.1, 0, -0.82, 0).rotation.x = Math.PI;
    }
    // 镰刀
    const sc = pivot(armR, 0, -0.75, 0);
    part(sc, 'cyl', '#3a2c18', 0.03, 1.5, 0.03, 0, 0.3, 0.1).rotation.x = 0.3;
    part(sc, 'box', '#b8c0c4', 0.03, 0.14, 0.7, 0, 1.0, 0.55).rotation.x = -0.4;
    head = pivot(body, 0, 1.2, 0);
    part(head, 'sph', '#a08a5a', 0.3, 0.33, 0.29);
    part(head, 'cone', look.accent, 0.62, 0.3, 0.62, 0, 0.3, 0);
    part(head, 'cyl', look.accent, 0.64, 0.02, 0.64, 0, 0.16, 0);
    for (const s of [-1, 1]) part(head, 'sph', eye, 0.06, 0.04, 0.03, s * 0.12, 0.02, 0.26).userData.glow = true;
    for (let i = -2; i <= 2; i++) part(head, 'box', '#2a2014', 0.012, 0.07, 0.01, i * 0.05, -0.13, 0.26);
  } else if (look.kind === 'weaver') {
    for (const l of [legL, legR]) part(l, 'cyl', '#16121a', 0.05, 0.9, 0.05, 0, -0.45, 0);
    part(body, 'cone', look.body, 0.62, 1.2, 0.56, 0, -0.25, 0);
    part(body, 'cyl', look.body, 0.2, 0.6, 0.17, 0, 0.55, 0);
    part(body, 'cyl', look.accent, 0.22, 0.06, 0.19, 0, 0.3, 0);
    armL = pivot(body, -0.25, 0.8, 0);
    armR = pivot(body, 0.25, 0.8, 0);
    for (const a of [armL, armR]) {
      part(a, 'cyl', '#d8d0c8', 0.04, 0.8, 0.04, 0, -0.4, 0);
      part(a, 'cone', '#c8c8d0', 0.025, 0.4, 0.025, 0, -0.95, 0).rotation.x = Math.PI;
    }
    // 背后的四条细肢
    for (const [sx, sy] of [[-1, 0.7], [1, 0.7], [-1, 0.45], [1, 0.45]]) {
      const leg = pivot(body, sx * 0.15, sy, -0.15);
      leg.rotation.z = sx * -1.0;
      leg.rotation.y = sx * 0.4;
      part(leg, 'cyl', '#16121a', 0.025, 0.9, 0.025, 0, 0.45, 0);
      const tip = pivot(leg, 0, 0.9, 0);
      tip.rotation.z = sx * 2.0;
      part(tip, 'cyl', '#16121a', 0.02, 0.8, 0.02, 0, 0.4, 0);
    }
    head = pivot(body, 0, 1.05, 0);
    part(head, 'sph', '#e8e0d8', 0.24, 0.28, 0.23);
    part(head, 'sph', '#16121a', 0.26, 0.2, 0.25, 0, 0.12, -0.05);
    part(head, 'sph', '#16121a', 0.16, 0.16, 0.16, 0, 0.36, -0.08);
    part(head, 'cyl', '#c8c8d0', 0.012, 0.5, 0.012, 0.05, 0.4, -0.08).rotation.z = 0.9;
    for (const s of [-1, 1]) part(head, 'sph', eye, 0.04, 0.06, 0.03, s * 0.09, 0, 0.21).userData.glow = true;
  } else {
    for (const l of [legL, legR]) part(l, 'cyl', '#0e1218', 0.06, 0.9, 0.06, 0, -0.45, 0);
    part(body, 'cyl', look.body, 0.22, 1.05, 0.18, 0, 0.5, 0);
    part(body, 'cone', look.body, 0.4, 1.3, 0.34, 0, -0.1, 0);
    part(body, 'box', look.accent, 0.1, 0.5, 0.02, 0, 0.72, 0.17);
    armL = pivot(body, -0.27, 0.98, 0);
    armR = pivot(body, 0.27, 0.98, 0);
    for (const a of [armL, armR]) {
      part(a, 'cyl', look.body, 0.055, 0.9, 0.055, 0, -0.45, 0);
      part(a, 'sph', '#e8e8e4', 0.06, 0.08, 0.06, 0, -0.93, 0);
    }
    part(pivot(armR, 0, -0.93, 0), 'cyl', '#c8d0d8', 0.02, 1.1, 0.02, 0, 0.3, 0.3).rotation.x = 0.9;
    head = pivot(body, 0, 1.25, 0);
    part(head, 'sph', '#14181e', 0.22, 0.26, 0.22, 0, 0, -0.03);
    part(head, 'sph', '#eceae4', 0.19, 0.25, 0.1, 0, -0.01, 0.14);
    part(head, 'cyl', '#0e1218', 0.36, 0.02, 0.36, 0, 0.2, 0);
    part(head, 'cyl', '#0e1218', 0.2, 0.22, 0.2, 0, 0.31, 0);
    for (const s of [-1, 1]) part(head, 'sph', eye, 0.035, 0.02, 0.02, s * 0.08, 0.02, 0.235).userData.glow = true;
  }
  return { g, root, body, head, armL, armR, legL, legR, h: 2.5 };
}

// ======================= 场景 =======================
export class Scene {
  constructor(canvas) {
    this.canvas = canvas;
    this.low = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    this.r = new THREE.WebGLRenderer({ canvas, antialias: !this.low, powerPreference: 'high-performance' });
    this.r.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.cam = new THREE.PerspectiveCamera(58, 1, 0.2, 140);
    this.yaw = 0;
    this.pitch = 0.72;
    this.camDist = 7;
    this.curDist = 7;
    this.shake = 0;
    this.time = 0;
    this.world = null;
    this.chars = new Map();
    this.focus = { x: 32, z: 32 };
    this.glow = glowTex();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.r.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.low ? 1.5 : 2) * (this.quality === 'low' ? 0.7 : 1));
    this.r.setSize(w, h, false);
    this.cam.aspect = w / h;
    this.cam.fov = w < h ? 68 : 56;
    this.cam.updateProjectionMatrix();
  }
  setQuality(q) {
    this.quality = q;
    this.resize();
  }

  // ---------------- 搭建静态世界 ----------------
  build(setup, cfg, you) {
    if (this.world) {
      this.scene.remove(this.world);
      this.world.traverse((o) => {
        if (o.geometry && !Object.values(GEO).includes(o.geometry)) o.geometry.dispose();
      });
    }
    this.cfg = cfg;
    this.setup = setup;
    this.you = you;
    this.chars.clear();
    const map = setup.map;
    const W = map.W;
    const th = (this.th = THEMES[map.theme] || THEMES.circus);
    const world = (this.world = new THREE.Group());
    this.scene.add(world);
    this.scene.background = new THREE.Color(th.sky);
    this.scene.fog = new THREE.FogExp2(th.fog, th.fogD);
    world.add(new THREE.HemisphereLight(th.hemi[0], th.hemi[1], 2.6));
    const moon = new THREE.DirectionalLight(th.moon, 2.2);
    moon.position.set(-30, 50, -20);
    world.add(moon);

    // 地面
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(W, W), new THREE.MeshLambertMaterial({ map: groundTex(th) }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(W / 2, 0, W / 2);
    world.add(ground);
    const outer = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), mat(th.ground[2]));
    outer.rotation.x = -Math.PI / 2;
    outer.position.set(W / 2, -0.05, W / 2);
    world.add(outer);
    // 月亮
    const moonSp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: 0xf0f0dc, fog: false, transparent: true }));
    moonSp.scale.set(26, 26, 1);
    moonSp.position.set(W / 2 - 60, 55, W / 2 - 90);
    world.add(moonSp);

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
    const wtex = wallTex(map.theme, th);
    const wallMat = new THREE.MeshLambertMaterial({ map: wtex });
    const dummy = new THREE.Object3D();
    const inst = (list, m, fn) => {
      if (!list.length) return;
      const im = new THREE.InstancedMesh(GEO.box, m, list.length);
      list.forEach((it, i) => {
        fn(it, i);
        dummy.updateMatrix();
        im.setMatrixAt(i, dummy.matrix);
      });
      world.add(im);
    };
    const hash = (x, z) => {
      const v = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
      return v - Math.floor(v);
    };
    inst(cells.wall, wallMat, ([x, z]) => {
      const h = map.theme === 'garden' ? 2.6 + hash(x, z) * 0.3 : 3;
      dummy.position.set(x + 0.5, h / 2, z + 0.5);
      dummy.scale.set(1, h, 1);
      dummy.rotation.set(0, 0, 0);
    });
    inst(cells.border, mat(map.theme === 'garden' ? '#1c3a26' : '#2a2a30'), ([x, z]) => {
      const h = 4.2 + hash(x, z) * 0.5;
      dummy.position.set(x + 0.5, h / 2, z + 0.5);
      dummy.scale.set(1, h, 1);
      dummy.rotation.set(0, 0, 0);
    });
    // 墙顶压一条深色的边，轮廓更清楚
    inst(cells.wall, mat('#2c343e'), ([x, z]) => {
      dummy.position.set(x + 0.5, map.theme === 'garden' ? 2.95 : 3.05, z + 0.5);
      dummy.scale.set(1.04, 0.1, 1.04);
      dummy.rotation.set(0, 0, 0);
    });
    inst(cells.low, mat(th.low), ([x, z]) => {
      const h = 0.9 + hash(x, z) * 0.5;
      dummy.position.set(x + 0.5, h / 2, z + 0.5);
      dummy.scale.set(0.92, h, 0.92);
      dummy.rotation.set(0, hash(z, x) * 0.5 - 0.25, 0);
    });
    inst(cells.low, mat('#1c1814'), ([x, z]) => {
      const h = 0.9 + hash(x, z) * 0.5;
      dummy.position.set(x + 0.5, h * 0.62, z + 0.5);
      dummy.scale.set(0.96, 0.06, 0.96);
      dummy.rotation.set(0, hash(z, x) * 0.5 - 0.25, 0);
    });
    // 窗：窗台 + 窗楣 + 木框
    inst(cells.win, wallMat, (w) => {
      dummy.position.set(w.x + 0.5, 0.45, w.z + 0.5);
      dummy.scale.set(1, 0.9, 1);
      dummy.rotation.set(0, 0, 0);
    });
    inst(cells.win, wallMat, (w) => {
      dummy.position.set(w.x + 0.5, 2.7, w.z + 0.5);
      dummy.scale.set(1, 0.6, 1);
      dummy.rotation.set(0, 0, 0);
    });
    inst(cells.win, mat('#4a3824'), (w) => {
      dummy.position.set(w.x + 0.5, 0.93, w.z + 0.5);
      dummy.scale.set(w.axis === 'x' ? 1.1 : 1.02, 0.08, w.axis === 'x' ? 1.02 : 1.1);
      dummy.rotation.set(0, 0, 0);
    });

    // 木板
    this.pallets = map.pallets.map((p) => {
      const g = new THREE.Group();
      g.position.set(p.x + 0.5, 0, p.z + 0.5);
      if (p.axis === 'z') g.rotation.y = Math.PI / 2;
      const board = pivot(g, 0, 0, 0.42);
      for (let i = -1; i <= 1; i++) part(board, 'box', i ? '#7a5a36' : '#6a4c2c', 0.3, 1.5, 0.1, i * 0.31, 0.75, 0);
      part(board, 'box', '#4a3420', 0.96, 0.1, 0.13, 0, 0.4, 0);
      part(board, 'box', '#4a3420', 0.96, 0.1, 0.13, 0, 1.1, 0);
      world.add(g);
      return { g, board, st: 0, k: 0 };
    });

    // 发报机
    this.machines = setup.machines.map((m) => {
      const g = new THREE.Group();
      g.position.set(m.x, 0, m.z);
      part(g, 'box', '#3a2a1c', 0.8, 0.75, 0.6, 0, 0.375, 0);
      part(g, 'box', '#241a12', 0.86, 0.06, 0.66, 0, 0.78, 0);
      part(g, 'cyl', '#b89a4a', 0.14, 0.12, 0.14, -0.2, 0.87, 0);
      part(g, 'box', '#1a1614', 0.22, 0.04, 0.1, 0.15, 0.83, 0.1);
      part(g, 'cyl', '#5a4a30', 0.035, 2.6, 0.035, 0.3, 2.0, -0.2);
      const lamps = [];
      for (let i = 0; i < 5; i++) lamps.push(part(g, 'sph', new THREE.MeshBasicMaterial({ color: 0x2a2620 }), 0.07, 0.07, 0.07, 0.3, 1.5 + i * 0.36, -0.2));
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: th.lamp, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      halo.position.set(0.3, 3.3, -0.2);
      halo.scale.set(1.6, 1.6, 1);
      g.add(halo);
      // 高处的光柱：隔着墙也能看到哪里有发报机
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.16, 15, 6, 1, true), new THREE.MeshBasicMaterial({ color: th.lamp, transparent: true, opacity: 0.1, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false }));
      beam.position.set(0.3, 11.5, -0.2);
      g.add(beam);
      world.add(g);
      return { g, lamps, halo, beam, p: 0, done: false, busy: false };
    });

    // 铁笼
    this.cages = setup.cages.map((c) => {
      const g = new THREE.Group();
      g.position.set(c.x, 0, c.z);
      const iron = mat('#2a2c30');
      part(g, 'cyl', iron, 0.5, 0.1, 0.5, 0, 0.05, 0);
      part(g, 'cyl', iron, 0.5, 0.06, 0.5, 0, 1.9, 0);
      part(g, 'cone', iron, 0.5, 0.4, 0.5, 0, 2.12, 0);
      for (let i = 0; i < 10; i++) part(g, 'cyl', iron, 0.022, 1.85, 0.022, Math.sin((i / 10) * TAU) * 0.46, 0.98, Math.cos((i / 10) * TAU) * 0.46);
      const tor = part(g, 'tor', iron, 0.47, 0.47, 0.47, 0, 1.0, 0);
      tor.rotation.x = Math.PI / 2;
      const warn = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: 0xff4030, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, fog: false }));
      warn.position.y = 3;
      warn.scale.set(1.4, 1.4, 1);
      warn.visible = false;
      g.add(warn);
      world.add(g);
      return { g, warn };
    });

    // 大门
    this.gates = map.gates.map((gt) => {
      const g = new THREE.Group();
      g.position.set(gt.x, 0, gt.z);
      const alongX = gt.side === 'n' || gt.side === 's';
      if (!alongX) g.rotation.y = Math.PI / 2;
      const iron = mat('#23262c');
      part(g, 'box', '#3a3a40', 0.6, 5, 1.2, -1.8, 2.5, 0);
      part(g, 'box', '#3a3a40', 0.6, 5, 1.2, 1.8, 2.5, 0);
      part(g, 'box', '#3a3a40', 4.2, 0.5, 1.2, 0, 4.9, 0);
      const dl = pivot(g, -1.5, 0, 0);
      const dr = pivot(g, 1.5, 0, 0);
      part(dl, 'box', iron, 1.5, 4.4, 0.16, 0.75, 2.2, 0);
      part(dr, 'box', iron, 1.5, 4.4, 0.16, -0.75, 2.2, 0);
      for (const d of [dl, dr]) for (let i = 0; i < 3; i++) part(d, 'box', '#4a4e58', 0.06, 4.2, 0.2, (d === dl ? 1 : -1) * (0.3 + i * 0.45), 2.2, 0);
      const lamp = part(g, 'sph', new THREE.MeshBasicMaterial({ color: 0x802018 }), 0.18, 0.18, 0.18, 0, 5.4, 0);
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: 0xff3020, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
      halo.position.set(0, 5.4, 0);
      halo.scale.set(3, 3, 1);
      g.add(halo);
      world.add(g);
      // 电闸
      const pg = new THREE.Group();
      pg.position.set(gt.panel.x, 0, gt.panel.z);
      part(pg, 'cyl', '#3a3a40', 0.06, 1.3, 0.06, 0, 0.65, 0);
      part(pg, 'box', '#5a4a30', 0.4, 0.5, 0.18, 0, 1.3, 0);
      const lever = pivot(pg, 0, 1.3, 0.1);
      part(lever, 'cyl', '#b8a060', 0.025, 0.3, 0.025, 0, 0.15, 0);
      part(lever, 'sph', '#a03028', 0.05, 0.05, 0.05, 0, 0.3, 0);
      lever.rotation.x = 0.9;
      world.add(pg);
      return { g, dl, dr, lamp, halo, lever, open: 0, target: 0 };
    });

    // 地窖
    {
      const g = new THREE.Group();
      g.position.set(setup.hatch.x, 0, setup.hatch.z);
      part(g, 'box', '#1c1a18', 1.2, 0.08, 1.2, 0, 0.04, 0);
      part(g, 'box', '#050505', 0.95, 0.09, 0.95, 0, 0.045, 0);
      const lid = pivot(g, 0, 0.1, -0.5);
      part(lid, 'box', '#3a3026', 1.0, 0.07, 1.0, 0, 0, 0.5);
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: 0x80c0ff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      halo.position.y = 0.6;
      halo.scale.set(2.4, 2.4, 1);
      halo.visible = false;
      g.add(halo);
      world.add(g);
      this.hatch = { g, lid, halo, open: false };
    }

    // 装饰：路灯、场外的枯树、马戏团的小旗
    const lampMat = new THREE.MeshBasicMaterial({ color: th.lamp });
    for (const b of map.blocks) {
      const lx = b.x + 0.5;
      const lz = b.z + 0.5;
      const g = new THREE.Group();
      g.position.set(lx, 0, lz);
      part(g, 'cyl', '#1c1e22', 0.05, 3.4, 0.05, 0, 1.7, 0);
      part(g, 'box', '#1c1e22', 0.5, 0.05, 0.05, 0.22, 3.4, 0);
      part(g, 'sph', lampMat, 0.11, 0.14, 0.11, 0.45, 3.25, 0);
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: th.lamp, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }));
      halo.position.set(0.45, 3.25, 0);
      halo.scale.set(3.2, 3.2, 1);
      g.add(halo);
      const pool = new THREE.Mesh(GEO.disc, new THREE.MeshBasicMaterial({ map: this.glow, color: th.lamp, transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending }));
      pool.rotation.x = -Math.PI / 2;
      pool.scale.set(3.5, 3.5, 1);
      pool.position.set(0.45, 0.03, 0);
      g.add(pool);
      world.add(g);
      if (map.theme === 'circus' && (b.name === 'shack' || b.name === 'big')) {
        // 帐篷尖顶上的小旗
        const f = new THREE.Group();
        f.position.set(b.x + 5.5, 3, b.z + 5.5);
        part(f, 'cyl', '#2a2420', 0.04, 2.4, 0.04, 0, 1.2, 0);
        part(f, 'cone', '#8a3038', 0.25, 0.5, 0.05, 0.28, 2.2, 0).rotation.z = -Math.PI / 2;
        world.add(f);
      }
    }
    const trunk = mat('#14161a');
    const trees = [];
    for (let i = 0; i < 70; i++) {
      const a = (i / 70) * TAU + hash(i, 3);
      const rr = W * 0.5 + 5 + hash(i, 7) * 22;
      trees.push([W / 2 + Math.sin(a) * rr * 1.25, W / 2 + Math.cos(a) * rr * 1.25, 5 + hash(i, 1) * 7]);
    }
    inst(trees, trunk, ([x, z, h]) => {
      dummy.position.set(x, h / 2, z);
      dummy.scale.set(0.5, h, 0.5);
      dummy.rotation.set(0, 0, (hash(x, z) - 0.5) * 0.2);
    });
    const crown = new THREE.InstancedMesh(GEO.cone, mat('#10161a'), trees.length);
    trees.forEach(([x, z, h], i) => {
      dummy.position.set(x, h + 1, z);
      dummy.scale.set(2.2 + hash(z, x) * 1.5, 5, 2.2 + hash(z, x) * 1.5);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      crown.setMatrixAt(i, dummy.matrix);
    });
    world.add(crown);

    // 角色
    for (const p of setup.players) {
      const def = (p.role === 'hunter' ? cfg.HUNTERS : cfg.SURVIVORS)[p.char];
      const m = p.role === 'hunter' ? makeHunter(def.look) : makeSurvivor(def.look, p.color);
      const shadow = new THREE.Mesh(GEO.disc, new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }));
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.y = 0.02;
      shadow.scale.setScalar(p.role === 'hunter' ? 0.6 : 0.36);
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
      for (let i = 0; i < 3; i++) part(stars, 'sph', new THREE.MeshBasicMaterial({ color: 0xffe070 }), 0.07, 0.07, 0.07, Math.sin((i / 3) * TAU) * 0.35, 0, Math.cos((i / 3) * TAU) * 0.35);
      stars.visible = false;
      m.g.visible = false;
      world.add(m.g);
      this.chars.set(p.id, { ...m, shadow, label, mark, stars, info: p, x: 0, z: 0, d: 0, y: 0, phase: Math.random() * 6, has: false, st: null, lean: 0, swing: 0 });
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
    // 飘在场上的雾团
    this.mist = [];
    for (let i = 0; i < 26; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: th.fog, transparent: true, opacity: 0.16, depthWrite: false }));
      sp.position.set(Math.random() * W, 0.8 + Math.random() * 1.2, Math.random() * W);
      const s = 9 + Math.random() * 9;
      sp.scale.set(s, s * 0.45, 1);
      world.add(sp);
      this.mist.push({ sp, v: 0.2 + Math.random() * 0.4 });
    }
  }

  // ---------------- 粒子 ----------------
  burst(x, y, z, n, color, { speed = 3, up = 2, life = 0.7, additive = true, grav = -6 } = {}) {
    if (!this.pa) return;
    const sys = additive ? this.pa : this.pn;
    const c = new THREE.Color(color);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const s = speed * (0.3 + Math.random() * 0.7);
      const p = { i: sys.next, x, y, z, vx: Math.sin(a) * s, vy: up * (0.3 + Math.random()), vz: Math.cos(a) * s, life: life * (0.6 + Math.random() * 0.6), t: 0, r: c.r, g: c.g, b: c.b, grav };
      sys.next = (sys.next + 1) % sys.N;
      sys.list = sys.list.filter((o) => o.i !== p.i);
      sys.list.push(p);
    }
  }
  stepParticles(sys, dt) {
    const pos = sys.pts.geometry.attributes.position;
    const col = sys.pts.geometry.attributes.color;
    for (const p of sys.list) {
      p.t += dt;
      p.vy += p.grav * dt;
      p.x += p.vx * dt;
      p.y = Math.max(0.03, p.y + p.vy * dt);
      p.z += p.vz * dt;
      const k = Math.max(0, 1 - p.t / p.life);
      pos.setXYZ(p.i, p.x, p.t >= p.life ? -999 : p.y, p.z);
      col.setXYZ(p.i, p.r * k, p.g * k, p.b * k);
    }
    sys.list = sys.list.filter((p) => p.t < p.life);
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
    // 假人
    const seenD = new Set();
    for (const [id, x, z, d, color] of st.decoys) {
      seenD.add(id);
      if (this.decoys.has(id)) continue;
      const m = makeSurvivor(this.cfg.SURVIVORS.illusion.look, color);
      m.g.position.set(x, 0, z);
      m.g.rotation.y = d;
      this.world.add(m.g);
      this.decoys.set(id, m);
    }
    for (const [id, m] of this.decoys)
      if (!seenD.has(id)) {
        this.burst(m.g.position.x, 1, m.g.position.z, 20, 0xb090ff, { additive: false, speed: 1.5, up: 1, grav: 1 });
        this.world.remove(m.g);
        this.decoys.delete(id);
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
    const t = (this.time += dt);
    const st = this.state;
    const meC = this.chars.get(this.you);
    const mePl = meC && meC.pl;
    const hunterC = [...this.chars.values()].find((c) => c.info.role === 'hunter');

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
        c.d = lerpAng(c.d, mePos.d, Math.min(1, dt * 14));
      } else if (c.tx !== undefined) {
        const k = Math.min(1, dt * 14);
        c.x = lerp(c.x, c.tx, k);
        c.z = lerp(c.z, c.tz, k);
        c.d = lerpAng(c.d, c.td, Math.min(1, dt * 10));
      }
      const moved = Math.hypot(c.x - px, c.z - pz);
      const speed = moved / Math.max(dt, 1e-3);
      c.phase += moved * (c.info.role === 'hunter' ? 2.2 : 3.6);
      this.pose(c, p, t, dt, speed, hunterC);
    }

    // 发报机
    for (const m of this.machines) {
      const lit = m.done ? 5 : Math.floor(m.p * 5 + 0.001);
      m.lamps.forEach((l, i) => l.material.color.setHex(m.done ? 0x60ff90 : i < lit ? 0xffc040 : i === lit && m.busy && Math.sin(t * 10) > 0 ? 0xffc040 : 0x2a2620));
      m.halo.material.color.setHex(m.done ? 0x60ff90 : this.th.lamp);
      m.halo.material.opacity = m.done ? 0.7 : 0.25 + m.p * 0.5 + (m.busy ? Math.sin(t * 12) * 0.1 : 0);
      m.beam.visible = !m.done && !st.powered;
      m.beam.material.opacity = 0.07 + m.p * 0.1;
      m.g.rotation.z = m.busy && !m.done ? Math.sin(t * 40) * 0.012 : 0;
    }
    // 木板
    for (const p of this.pallets) {
      const target = p.st === 0 ? 0 : 1;
      p.k = lerp(p.k, target, Math.min(1, dt * 16));
      p.board.visible = p.st !== 2;
      p.board.rotation.x = -p.k * 1.25;
      p.board.position.z = lerp(0.42, 0.62, p.k);
      p.board.position.y = p.k * 0.25;
    }
    // 大门
    for (const g of this.gates) {
      g.open = lerp(g.open, g.target, Math.min(1, dt * 1.6));
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
      c.g.rotation.y = c.who ? Math.sin(t * 3) * 0.05 : 0;
    }
    // 地窖
    this.hatch.lid.rotation.x = lerp(this.hatch.lid.rotation.x, this.hatch.open ? -1.3 : 0, Math.min(1, dt * 3));
    this.hatch.halo.visible = this.hatch.open;
    // 丝网：追猎者一直看得见，求生者走近了才看得见
    for (const m of this.webs.values()) {
      m.scale.setScalar(lerp(m.scale.x, 1.1, Math.min(1, dt * 5)));
      const near = meC ? Math.hypot(m.position.x - meC.x, m.position.z - meC.z) : 0;
      m.material.opacity = this.meRole === 'hunter' || !mePl ? 0.85 : clamp((6 - near) / 3, 0, 0.6);
    }
    for (const m of this.mist) {
      m.sp.position.x += m.v * dt;
      if (m.sp.position.x > 70) m.sp.position.x = -6;
    }
    this.stepParticles(this.pa, dt);
    this.stepParticles(this.pn, dt);
    this.updateCamera(dt);
    this.r.render(this.scene, this.cam);
  }

  // 人偶的姿势
  pose(c, p, t, dt, speed, hunterC) {
    const role = c.info.role;
    const walking = speed > 0.4;
    const run = clamp(speed / 4, 0, 1.3);
    let y = 0;
    let rx = 0; // 整体前倾
    let la = 0;
    let ra = 0;
    let ll = 0;
    let rl = 0;
    let headX = 0;
    let rootRotX = 0;
    let rootY = 0;
    const sw = Math.sin(c.phase);
    if (walking) {
      ll = sw * 0.9 * run;
      rl = -sw * 0.9 * run;
      la = -sw * 0.8 * run;
      ra = sw * 0.8 * run;
      y = Math.abs(Math.cos(c.phase)) * 0.06 * run;
      rx = 0.12 * run;
    } else {
      y = Math.sin(t * 2 + c.phase) * 0.012;
      la = ra = Math.sin(t * 1.6 + c.phase) * 0.04;
    }
    const a = p.a;
    if (role === 'survivor') {
      if (p.hp === 1 && p.st === 'ok') {
        // 受伤：捂着肩膀、一瘸一拐
        la = -1.2;
        rx += 0.25;
        y -= Math.abs(sw) * 0.04;
        if (Math.random() < dt * 2) this.burst(c.x, 0.9, c.z, 1, 0x901818, { additive: false, speed: 0.3, up: 0, life: 0.8 });
      }
      if (a === 'decode') {
        la = -1.3 + Math.sin(t * 18) * 0.25;
        ra = -1.3 + Math.cos(t * 15) * 0.25;
        rx = 0.2;
        headX = 0.2;
      } else if (a === 'heal' || a === 'rescue' || a === 'gate') {
        la = -1.5 + Math.sin(t * 8) * 0.3;
        ra = -1.2 + Math.cos(t * 8) * 0.3;
        rx = 0.25;
      } else if (a === 'selfheal') {
        la = -1.9;
        ra = -0.9 + Math.sin(t * 6) * 0.3;
        rootY = -0.25;
        ll = -1.2;
        rl = -1.2;
      } else if (a === 'vault') {
        y = Math.sin(clamp(p.ap, 0, 1) * Math.PI) * 1.0;
        rx = 0.7;
        la = ra = -2.2;
        ll = 0.8;
        rl = -0.6;
      }
      if (p.st === 'down') {
        rootRotX = Math.PI / 2 - 0.1;
        rootY = 0.22;
        la = -2.6 + (walking ? sw * 0.6 : 0);
        ra = -2.6 - (walking ? sw * 0.6 : 0);
        ll = walking ? sw * 0.3 : 0;
        rl = -ll;
        y = 0;
        rx = 0;
      } else if (p.st === 'carried' && hunterC) {
        // 被扛在肩上，挣扎
        rootRotX = Math.PI / 2;
        rootY = hunterC.h * 0.72;
        la = Math.sin(t * 14) * 0.8 - 2;
        ra = Math.cos(t * 14) * 0.8 - 2;
        ll = Math.sin(t * 12) * 0.6;
        rl = -ll;
        c.x = hunterC.x - Math.cos(hunterC.d) * 0.35;
        c.z = hunterC.z + Math.sin(hunterC.d) * 0.35;
        c.d = hunterC.d + Math.PI / 2;
        y = 0;
      } else if (p.st === 'caged') {
        rootY = -0.2;
        ll = rl = -1.4;
        la = -2.4 + Math.sin(t * 5 + c.phase) * 0.2;
        ra = -2.4 + Math.cos(t * 5 + c.phase) * 0.2;
        y = 0;
        rx = 0;
        c.g.rotation.y += dt * 0.5;
      }
      c.shadow.visible = p.st !== 'carried';
      const ghost = p.inv ? 0.3 : 1;
      if (c.ghost !== ghost) {
        c.ghost = ghost;
        c.g.traverse((o) => {
          if (o.isMesh && o !== c.shadow && !o.userData.glow) {
            if (!o.userData.base) o.userData.base = o.material;
            o.material = ghost < 1 ? (o.userData.gm ||= Object.assign(o.userData.base.clone(), { transparent: true, opacity: 0.3 })) : o.userData.base;
          }
        });
      }
      c.mark.visible = this.meRole === 'hunter' && !!p.shown && p.st === 'ok';
      c.label.visible = this.meRole !== 'hunter' && c.info.id !== this.you && p.st !== 'carried';
    } else {
      rx *= 0.6;
      if (a === 'wind') {
        c.swing = lerp(c.swing, 1, Math.min(1, dt * 14));
        ra = -2.6 * c.swing;
        rx = -0.15;
      } else if (a === 'wipe' || a === 'rec') {
        c.swing = lerp(c.swing, 0, Math.min(1, dt * (a === 'wipe' ? 3 : 6)));
        ra = 0.9 - c.swing * 3.2;
        rx = 0.35 * (1 - c.swing) + 0.1;
        if (a === 'wipe') la = -1.2 + Math.sin(t * 9) * 0.3;
      } else {
        c.swing = 0;
        ra += -0.25;
      }
      if (a === 'dash') {
        rx = 0.8;
        la = ra = 1.2;
        if (Math.random() < dt * 60) this.burst(c.x, 1, c.z, 1, 0xffb040, { speed: 0.6, up: 0.5, life: 0.4 });
      } else if (a === 'cast') {
        rootY = -0.6 - Math.sin(t * 9) * 0.1;
        la = ra = -2.4;
        if (Math.random() < dt * 40) this.burst(c.x, 0.8, c.z, 1, 0x90b8e0, { additive: false, speed: 1.2, up: 1.5, life: 0.9, grav: 0.5 });
      } else if (a === 'break' || a === 'pickup' || a === 'cage') {
        la = -1.6 + Math.sin(t * 12) * 0.5;
        ra = -1.6 + Math.cos(t * 12) * 0.5;
        rx = 0.4;
      } else if (a === 'vault') {
        y = Math.sin(clamp(p.ap, 0, 1) * Math.PI) * 0.7;
        rx = 0.5;
      }
      if (p.carry) la = -2.7;
      if (p.stun > 0) {
        rx = 0.5 + Math.sin(t * 5) * 0.1;
        la = ra = -0.4;
        headX = 0.5;
      }
      c.mark.visible = this.meRole !== 'hunter' && !!this.state.reveal;
      c.label.visible = false;
    }
    c.stars.visible = p.stun > 0;
    c.stars.rotation.y = t * 6;
    const k = Math.min(1, dt * 16);
    c.armL.rotation.x = lerp(c.armL.rotation.x, la, k);
    c.armR.rotation.x = lerp(c.armR.rotation.x, ra, k);
    c.legL.rotation.x = lerp(c.legL.rotation.x, ll, k);
    c.legR.rotation.x = lerp(c.legR.rotation.x, rl, k);
    c.body.rotation.x = lerp(c.body.rotation.x, rx, k);
    c.head.rotation.x = lerp(c.head.rotation.x, headX - rx * 0.6, k);
    c.root.rotation.x = lerp(c.root.rotation.x, rootRotX, Math.min(1, dt * 9));
    c.root.position.y = lerp(c.root.position.y, rootY, Math.min(1, dt * 9));
    c.y = lerp(c.y, y, Math.min(1, dt * 20));
    c.g.position.set(c.x, c.y, c.z);
    if (p.st !== 'caged') c.g.rotation.y = c.d;
  }

  // ---------------- 镜头 ----------------
  updateCamera(dt) {
    const f = this.focus;
    const tx = f.x;
    const ty = (this.meRole === 'hunter' ? 1.9 : 1.3) + (f.y || 0);
    const tz = f.z;
    // 镜头与角色之间有墙：先把镜头抬高（从墙头上方看过去），实在不行再拉近
    const map = this.setup.map;
    const W = map.W;
    const blockedAt = (pitch) => {
      const c = Math.cos(pitch);
      const s = Math.sin(pitch);
      for (let d = 0.5; d <= this.camDist; d += 0.3) {
        const x = tx + Math.sin(this.yaw) * c * d;
        const z = tz + Math.cos(this.yaw) * c * d;
        const cx = Math.floor(x);
        const cz = Math.floor(z);
        if (cx < 0 || cz < 0 || cx >= W || cz >= W) return d;
        const border = cx === 0 || cz === 0 || cx === W - 1 || cz === W - 1;
        if (map.rows[cz][cx] === '1' && ty + s * d < (border ? 5 : 3.3)) return d;
      }
      return null;
    };
    let pitch = this.pitch;
    let want = this.camDist;
    let hit = blockedAt(pitch);
    while (hit !== null && pitch < 1.3) {
      pitch = Math.min(1.3, pitch + 0.08);
      hit = blockedAt(pitch);
    }
    if (hit !== null) want = Math.max(2.6, hit - 0.4);
    this.effPitch = lerp(this.effPitch === undefined ? pitch : this.effPitch, pitch, Math.min(1, dt * 6));
    const cp = Math.cos(this.effPitch);
    const sp = Math.sin(this.effPitch);
    this.curDist = lerp(this.curDist, want, Math.min(1, dt * (want < this.curDist ? 14 : 4)));
    const d = this.curDist;
    this.shake = Math.max(0, this.shake - dt * 2.5);
    const sx = (Math.random() - 0.5) * this.shake * 0.5;
    const sy = (Math.random() - 0.5) * this.shake * 0.5;
    this.cam.position.set(tx + Math.sin(this.yaw) * cp * d + sx, ty + sp * d + sy, tz + Math.cos(this.yaw) * cp * d);
    this.cam.lookAt(tx, ty, tz);
  }

  // 一帧里把世界坐标投到屏幕（给 HUD 的指示用）
  project(x, y, z) {
    const v = new THREE.Vector3(x, y, z).project(this.cam);
    return { x: (v.x * 0.5 + 0.5) * window.innerWidth, y: (-v.y * 0.5 + 0.5) * window.innerHeight, behind: v.z > 1 };
  }
}
