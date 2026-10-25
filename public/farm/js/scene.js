// 青野牧歌：3D 场景（Three.js）。手绘动画风：卡通着色、大朵积云与地面上缓慢移动的云影、随风摆动的草、红瓦白墙的小屋。
// 为了手机性能：同类物体用一个 InstancedMesh 一次画完；多部件模型烘焙成一个带顶点色的几何体。
import * as THREE from '../vendor/three.module.min.js';

const V3 = THREE.Vector3;
const TAU = Math.PI * 2;
const col = (h) => new THREE.Color(h);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function hash(x, y, k = 0) {
  let h = (x * 374761393 + y * 668265263 + k * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// ======================= 共享的着色器片段 =======================
const U = {
  uTime: { value: 0 },
  uWind: { value: 1 },
  uCloud: { value: new THREE.Vector2() },
  uCloudAmt: { value: 1 },
};
const NOISE_GLSL = `
float fhash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(fhash(i), fhash(i+vec2(1.0,0.0)), f.x), mix(fhash(i+vec2(0.0,1.0)), fhash(i+vec2(1.0,1.0)), f.x), f.y); }
float cloudShade(vec2 p){ p = (p + uCloud) * 0.05; float n = vnoise(p)*0.62 + vnoise(p*2.13)*0.28 + vnoise(p*4.7)*0.1;
  return 1.0 - smoothstep(0.56, 0.7, n) * 0.3 * uCloudAmt; }
`;

const gradientMap = (() => {
  const t = new THREE.DataTexture(new Uint8Array([120, 120, 120, 255, 205, 205, 205, 255, 255, 255, 255, 255]), 3, 1);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
})();

// 卡通材质；sway：按高度随风摆动的幅度；cloud：接收云影
function toon(opts = {}, sway = 0, cloud = false) {
  const m = new THREE.MeshToonMaterial({ gradientMap, ...opts });
  if (sway || cloud) {
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U);
      sh.vertexShader =
        'uniform float uTime; uniform float uWind; varying vec2 vWXZ;\n' +
        sh.vertexShader.replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          vec4 wP = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            wP = instanceMatrix * wP;
          #endif
          wP = modelMatrix * wP;
          vWXZ = wP.xz;
          ${sway ? `float swH = max(0.0, position.y) * ${sway.toFixed(3)} * uWind;
          float ph = wP.x * 0.31 + wP.z * 0.23;
          transformed.x += (sin(uTime * 1.6 + ph) + 0.4 * sin(uTime * 3.7 + ph * 2.0)) * swH;
          transformed.z += cos(uTime * 1.2 + ph * 1.4) * swH * 0.5;` : ''}`
        );
      sh.fragmentShader =
        'uniform vec2 uCloud; uniform float uCloudAmt; varying vec2 vWXZ;\n' +
        NOISE_GLSL +
        sh.fragmentShader.replace('#include <fog_fragment>', `${cloud ? 'gl_FragColor.rgb *= cloudShade(vWXZ);' : ''}\n#include <fog_fragment>`);
    };
    m.customProgramCacheKey = () => `t${sway}${cloud}`;
  }
  return m;
}

// ======================= 几何体烘焙 =======================
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new V3();
const _p = new V3();
// parts: [geometry, 颜色, { p:[x,y,z], r:[x,y,z], s:[x,y,z] | 数字 }]
function bake(parts) {
  const pos = [];
  const nor = [];
  const cl = [];
  for (const [g0, color, t = {}] of parts) {
    const g = g0.index ? g0.toNonIndexed() : g0.clone();
    const s = typeof t.s === 'number' ? [t.s, t.s, t.s] : t.s || [1, 1, 1];
    _m.compose(_p.set(...(t.p || [0, 0, 0])), _q.setFromEuler(_e.set(...(t.r || [0, 0, 0]))), _s.set(...s));
    g.applyMatrix4(_m);
    const c = col(color);
    const pa = g.attributes.position.array;
    const na = g.attributes.normal.array;
    // 按高度给一点渐变：底部略暗，营造手绘的体积感
    for (let i = 0; i < pa.length; i += 3) {
      pos.push(pa[i], pa[i + 1], pa[i + 2]);
      nor.push(na[i], na[i + 1], na[i + 2]);
      const k = t.grad ? clamp(0.82 + (pa[i + 1] - (t.grad[0] || 0)) * (t.grad[1] || 0.2), 0.75, 1.12) : 1;
      cl.push(c.r * k, c.g * k, c.b * k);
    }
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(cl, 3));
  out.computeBoundingSphere();
  return out;
}
const G = {
  box: (w, h, d) => new THREE.BoxGeometry(w, h, d),
  sph: (r, d = 1) => new THREE.IcosahedronGeometry(r, d),
  ball: (r, w = 10, h = 8) => new THREE.SphereGeometry(r, w, h),
  cyl: (rt, rb, h, n = 8) => new THREE.CylinderGeometry(rt, rb, h, n),
  cone: (r, h, n = 8) => new THREE.ConeGeometry(r, h, n),
  dodo: (r) => new THREE.DodecahedronGeometry(r, 0),
  oct: (r) => new THREE.OctahedronGeometry(r, 0),
};
// 三角屋顶（沿 x 方向的屋脊）
function prism(w, h, d) {
  const s = new THREE.Shape();
  s.moveTo(-d / 2, 0);
  s.lineTo(0, h);
  s.lineTo(d / 2, 0);
  s.lineTo(-d / 2, 0);
  const g = new THREE.ExtrudeGeometry(s, { depth: w, bevelEnabled: false });
  g.translate(0, 0, -w / 2);
  g.rotateY(Math.PI / 2);
  return g;
}

// ======================= 调色板 =======================
const SEASON = {
  spring: { grass: '#7cbf48', grass2: '#97d05a', tip: '#c2e86a', base: '#3f8c30', leaf: ['#5aa04a', '#79bf58', '#a6d86e'], blossom: '#f7bfd0', far: '#6f9e5a' },
  summer: { grass: '#5aa83c', grass2: '#74bc48', tip: '#b2dc62', base: '#2f7c2a', leaf: ['#3f8a3c', '#5aa847', '#86c45a'], blossom: '#fff4b8', far: '#5a8f4c' },
  autumn: { grass: '#b4b35e', grass2: '#c8c070', tip: '#ecd88a', base: '#8a8a3e', leaf: ['#c45a2c', '#e0882f', '#f0b848'], blossom: '#f4a050', far: '#a08a4a' },
  winter: { grass: '#e6eef1', grass2: '#f2f6f8', tip: '#ffffff', base: '#c8d6dc', leaf: ['#4f6a5c', '#6a8270', '#e9f0f2'], blossom: '#ffffff', far: '#c8d4da' },
};
const GROUND_COL = { 1: '#d4b07c', 2: '#8a5c3c', 3: '#3e7f86', 5: '#ecd8a4', 6: '#c2bba6', 8: '#c9c2b0' };
const ROCK = '#a39a86';

// 一天中的光线（游戏分钟）
const KEYS = [
  { t: 300, top: '#1a2450', hor: '#4a5a8a', sun: '#ffd8b0', si: 0.4, hs: '#5a6a9a', hg: '#3a3a4a', hi: 0.8, cloud: '#8a8ab0', night: 0.85 },
  { t: 380, top: '#6a90c8', hor: '#f6c8a0', sun: '#ffd2a0', si: 1.3, hs: '#c8d8f0', hg: '#9a8a6a', hi: 1.0, cloud: '#ffe0d0', night: 0.15 },
  { t: 480, top: '#4a90dc', hor: '#cfe6f2', sun: '#fff0d4', si: 2.4, hs: '#cfe4f8', hg: '#a8a070', hi: 1.15, cloud: '#ffffff', night: 0 },
  { t: 900, top: '#3a86d8', hor: '#c6e2f2', sun: '#fff6e4', si: 2.6, hs: '#d4e8fa', hg: '#a8a070', hi: 1.2, cloud: '#ffffff', night: 0 },
  { t: 1050, top: '#5a8ad0', hor: '#f6d0a0', sun: '#ffd8a0', si: 2.1, hs: '#e0dcd0', hg: '#a88a60', hi: 1.05, cloud: '#fff0e0', night: 0 },
  { t: 1125, top: '#6a78c0', hor: '#f8a878', sun: '#ffa868', si: 1.4, hs: '#d8b8c0', hg: '#8a6a5a', hi: 0.9, cloud: '#ffc8b0', night: 0.1 },
  { t: 1200, top: '#2c3a78', hor: '#9a6a8a', sun: '#d88a8a', si: 0.4, hs: '#6a6a9a', hg: '#4a3a4a', hi: 0.7, cloud: '#a888b0', night: 0.55 },
  { t: 1290, top: '#14204a', hor: '#2e3e6c', sun: '#a8bce8', si: 0.6, hs: '#5a6aa0', hg: '#2e3448', hi: 0.85, cloud: '#6a74a0', night: 1 },
  { t: 1600, top: '#14204a', hor: '#2e3e6c', sun: '#a8bce8', si: 0.6, hs: '#5a6aa0', hg: '#2e3448', hi: 0.85, cloud: '#6a74a0', night: 1 },
];
const _white = new THREE.Color(1, 1, 1);
const _ca = new THREE.Color();
const _cb = new THREE.Color();
function lightAt(t) {
  if (t < KEYS[0].t) t += 0;
  let i = 0;
  while (i < KEYS.length - 2 && t > KEYS[i + 1].t) i++;
  const a = KEYS[i];
  const b = KEYS[i + 1];
  const k = clamp((t - a.t) / (b.t - a.t), 0, 1);
  const mix = (ka) => _ca.set(a[ka]).lerp(_cb.set(b[ka]), k).clone();
  return { top: mix('top'), hor: mix('hor'), sun: mix('sun'), si: lerp(a.si, b.si, k), hs: mix('hs'), hg: mix('hg'), hi: lerp(a.hi, b.hi, k), cloud: mix('cloud'), night: lerp(a.night, b.night, k) };
}

// ======================= 模型原型 =======================
function treeGeo(v, season, stage = 2) {
  const P = SEASON[season];
  const L = P.leaf;
  const trunk = '#7a5538';
  const parts = [];
  if (stage === 0) {
    parts.push([G.cyl(0.03, 0.04, 0.4, 5), trunk, { p: [0, 0.2, 0] }]);
    parts.push([G.sph(0.14, 0), L[1], { p: [0.05, 0.42, 0], s: [1, 0.7, 1] }]);
    return bake(parts);
  }
  const s = stage === 1 ? 0.55 : 1;
  if (season === 'winter' && v !== 1) {
    parts.push([G.cyl(0.1 * s, 0.17 * s, 1.6 * s, 6), trunk, { p: [0, 0.8 * s, 0] }]);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU;
      parts.push([G.cyl(0.03 * s, 0.06 * s, 0.9 * s, 5), trunk, { p: [Math.cos(a) * 0.25 * s, 1.6 * s, Math.sin(a) * 0.25 * s], r: [Math.sin(a) * 0.6, 0, -Math.cos(a) * 0.6] }]);
      parts.push([G.sph(0.12 * s, 0), '#f6fafc', { p: [Math.cos(a) * 0.45 * s, 2.0 * s, Math.sin(a) * 0.45 * s], s: [1, 0.5, 1] }]);
    }
    return bake(parts);
  }
  if (v === 1) {
    // 杉树：几层圆锥叠起来
    const pal = season === 'autumn' ? ['#3d6a40', '#4f8048', '#6a9a58'] : season === 'winter' ? ['#3d5a4a', '#4f6e58', '#5a7a62'] : L;
    parts.push([G.cyl(0.1 * s, 0.16 * s, 1.0 * s, 6), trunk, { p: [0, 0.5 * s, 0] }]);
    for (let i = 0; i < 4; i++) {
      const r = (1.15 - i * 0.24) * s;
      parts.push([G.cone(r, 1.15 * s, 9), pal[Math.min(2, i)], { p: [0, (1.1 + i * 0.62) * s, 0], grad: [0, 0.25] }]);
      if (season === 'winter') parts.push([G.cone(r * 0.75, 0.5 * s, 9), '#f2f6f8', { p: [0, (1.45 + i * 0.62) * s, 0] }]);
    }
    return bake(parts);
  }
  // 阔叶树：圆滚滚的大树冠，几团叶子叠在一起
  parts.push([G.cyl(0.12 * s, 0.22 * s, 1.5 * s, 7), trunk, { p: [0, 0.75 * s, 0] }]);
  parts.push([G.cyl(0.05 * s, 0.08 * s, 0.7 * s, 5), trunk, { p: [0.22 * s, 1.4 * s, 0], r: [0, 0, -0.7] }]);
  const blobs = v === 2 ? [[0, 2.05, 0, 0.95], [-0.55, 1.75, 0.2, 0.62], [0.6, 1.8, -0.1, 0.6], [0.1, 1.7, 0.55, 0.6], [0, 2.5, -0.2, 0.55]] : [[0, 2.15, 0, 1.05], [-0.7, 1.85, 0.15, 0.72], [0.72, 1.9, 0.05, 0.7], [0.1, 1.8, 0.62, 0.68], [-0.15, 1.85, -0.6, 0.7], [0.15, 2.75, 0.05, 0.62]];
  blobs.forEach(([x, y, z, r], i) => parts.push([G.sph(r * s, 2), L[i % 3 === 2 ? 2 : i % 2], { p: [x * s, y * s, z * s], grad: [1.6 * s, 0.22] }]));
  if (v === 2 && (season === 'spring' || season === 'summer')) {
    for (let i = 0; i < 18; i++) {
      const a = hash(i, 3) * TAU;
      const e = hash(i, 4) * 1.2 - 0.2;
      parts.push([G.sph(0.11 * s, 0), P.blossom, { p: [Math.cos(a) * 0.9 * s * Math.cos(e), (2.1 + Math.sin(e) * 0.8) * s, Math.sin(a) * 0.9 * s * Math.cos(e)] }]);
    }
  }
  if (v === 0 && season === 'summer') for (let i = 0; i < 8; i++) parts.push([G.sph(0.09 * s, 0), '#e8402e', { p: [Math.cos(i) * 0.95 * s, (1.9 + hash(i, 9) * 0.5) * s, Math.sin(i) * 0.95 * s] }]);
  return bake(parts);
}

function cropGeos(type, st) {
  // 返回 [叶子几何体（顶点色）, 果实几何体（白色，用实例颜色染色）]
  const leaf = '#ffffff';
  const L = [];
  const F = [];
  if (st === 0) {
    L.push([G.sph(0.16, 0), '#6a4a30', { p: [0, 0.02, 0], s: [1, 0.3, 1] }]);
    return [bake(L), null];
  }
  if (st === 1) {
    L.push([G.cyl(0.015, 0.02, 0.18, 4), leaf, { p: [0, 0.09, 0] }]);
    L.push([G.sph(0.07, 0), leaf, { p: [-0.06, 0.18, 0], s: [1.4, 0.4, 0.8] }]);
    L.push([G.sph(0.07, 0), leaf, { p: [0.06, 0.2, 0], s: [1.4, 0.4, 0.8] }]);
    return [bake(L), null];
  }
  const s = st === 2 ? 0.65 : st === 3 ? 0.85 : 1;
  if (type === 'root') {
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU;
      L.push([G.cone(0.05, 0.45 * s, 4), leaf, { p: [Math.cos(a) * 0.06, 0.22 * s, Math.sin(a) * 0.06], r: [Math.sin(a) * 0.35, 0, -Math.cos(a) * 0.35] }]);
    }
    if (st === 4) F.push([G.sph(0.14, 1), '#ffffff', { p: [0, 0.05, 0], s: [1, 0.75, 1] }]);
  } else if (type === 'bush') {
    L.push([G.sph(0.3 * s, 1), leaf, { p: [0, 0.28 * s, 0], s: [1, 0.85, 1] }]);
    L.push([G.sph(0.2 * s, 1), leaf, { p: [0.15 * s, 0.4 * s, 0.05], s: 1 }]);
    if (st >= 3) for (let i = 0; i < (st === 4 ? 9 : 4); i++) {
      const a = (i / 9) * TAU + 0.3;
      F.push([G.sph(st === 4 ? 0.06 : 0.04, 0), '#ffffff', { p: [Math.cos(a) * 0.27 * s, (0.25 + (i % 3) * 0.1) * s, Math.sin(a) * 0.27 * s] }]);
    }
  } else if (type === 'vine') {
    L.push([G.cyl(0.02, 0.025, 0.95 * s, 4), '#c8a070', { p: [0, 0.47 * s, 0] }]);
    for (let i = 0; i < 4; i++) L.push([G.sph(0.17 * s, 1), leaf, { p: [(i % 2 ? 0.1 : -0.1) * s, (0.25 + i * 0.2) * s, (i % 2 ? -0.05 : 0.05)], s: [1, 0.7, 1] }]);
    if (st >= 3) for (let i = 0; i < 4; i++) F.push([G.sph(0.08, 1), '#ffffff', { p: [(i % 2 ? 0.18 : -0.17) * s, (0.3 + i * 0.16) * s, 0.12], s: [1, 1.15, 1] }]);
  } else if (type === 'big') {
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU;
      L.push([G.sph(0.2 * s, 0), leaf, { p: [Math.cos(a) * 0.22 * s, 0.1, Math.sin(a) * 0.22 * s], s: [1.4, 0.35, 0.8], r: [0, -a, 0] }]);
    }
    if (st >= 3) F.push([G.sph(st === 4 ? 0.32 : 0.16, 1), '#ffffff', { p: [0, st === 4 ? 0.26 : 0.16, 0], s: [1, 0.85, 1] }]);
  } else if (type === 'flower') {
    L.push([G.cyl(0.015, 0.02, 0.5 * s, 4), leaf, { p: [0, 0.25 * s, 0] }]);
    L.push([G.sph(0.1, 0), leaf, { p: [-0.08, 0.15, 0], s: [1.5, 0.4, 0.8] }]);
    L.push([G.sph(0.1, 0), leaf, { p: [0.08, 0.2, 0], s: [1.5, 0.4, 0.8] }]);
    if (st >= 3) for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU;
      F.push([G.sph(st === 4 ? 0.12 : 0.07, 0), '#ffffff', { p: [Math.cos(a) * 0.1, 0.52 * s, Math.sin(a) * 0.1], s: [1, 0.5, 1] }]);
    }
  }
  return [bake(L), F.length ? bake(F) : null];
}

const PROTO = {
  stump: () => bake([[G.cyl(0.24, 0.3, 0.32, 8), '#7a5538', { p: [0, 0.16, 0] }], [G.cyl(0.24, 0.24, 0.02, 8), '#e2c08a', { p: [0, 0.33, 0] }]]),
  rock: () => bake([[G.dodo(0.3), '#8f948c', { p: [0, 0.15, 0], s: [1, 0.7, 0.9] }], [G.dodo(0.16), '#a9ada4', { p: [0.12, 0.28, -0.05], s: [1, 0.6, 1] }], [G.sph(0.12, 0), '#7aa04e', { p: [-0.1, 0.3, 0.05], s: [1, 0.3, 1] }]]),
  boulder: () => bake([[G.dodo(0.62), '#8a8f86', { p: [0, 0.38, 0], s: [1, 0.75, 0.9] }], [G.dodo(0.32), '#a3a79c', { p: [0.3, 0.7, 0], s: [1, 0.6, 1] }], [G.sph(0.25, 0), '#7aa04e', { p: [-0.2, 0.72, 0.1], s: [1.3, 0.25, 1] }]]),
  ore: () => bake([[G.dodo(0.3), '#7f8a88', { p: [0, 0.15, 0], s: [1, 0.7, 0.9] }], [G.oct(0.12), '#5ed2e0', { p: [-0.08, 0.36, 0.05], s: [0.7, 1.6, 0.7] }], [G.oct(0.1), '#8ae6f0', { p: [0.12, 0.32, -0.04], s: [0.7, 1.5, 0.7], r: [0, 0, 0.4] }]]),
  twig: () => bake([[G.cyl(0.03, 0.04, 0.6, 5), '#7a5538', { p: [0, 0.04, 0], r: [0, 0, Math.PI / 2] }], [G.cyl(0.02, 0.025, 0.25, 4), '#7a5538', { p: [0.08, 0.08, 0.06], r: [0.5, 0, 1.0] }]]),
  weed: () => {
    const p = [];
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * TAU;
      p.push([G.cone(0.06, 0.42 + (i % 3) * 0.1, 4), '#ffffff', { p: [Math.cos(a) * 0.12, 0.2, Math.sin(a) * 0.12], r: [Math.sin(a) * 0.4, 0, -Math.cos(a) * 0.4] }]);
    }
    return bake(p);
  },
  forage: () => bake([[G.sph(0.09, 0), '#5f9a46', { p: [-0.1, 0.03, 0], s: [1.4, 0.3, 0.8] }], [G.sph(0.09, 0), '#7ab656', { p: [0.1, 0.03, 0.02], s: [1.4, 0.3, 0.8] }], [G.sph(0.13, 1), '#ffffff', { p: [0, 0.14, 0] }]]),
  drop: () => bake([[G.ball(0.18, 8, 6), '#c8a26a', { p: [0, 0.16, 0], s: [1, 0.9, 1] }], [G.cyl(0.06, 0.1, 0.1, 6), '#a8824a', { p: [0, 0.33, 0] }]]),
  soil: () => bake([[new THREE.BoxGeometry(0.94, 0.08, 0.94, 1, 1, 1), '#ffffff', { p: [0, 0.03, 0] }], [G.box(0.9, 0.02, 0.06), '#e0e0e0', { p: [0, 0.075, -0.22] }], [G.box(0.9, 0.02, 0.06), '#e0e0e0', { p: [0, 0.075, 0.0] }], [G.box(0.9, 0.02, 0.06), '#e0e0e0', { p: [0, 0.075, 0.22] }]]),
  pathstone: () => bake([[G.cyl(0.24, 0.26, 0.06, 7), '#cfc8b6', { p: [-0.18, 0.03, -0.16] }], [G.cyl(0.2, 0.22, 0.06, 6), '#d8d2c0', { p: [0.2, 0.03, 0.14] }], [G.cyl(0.14, 0.16, 0.06, 6), '#c6bea8', { p: [0.22, 0.03, -0.24] }], [G.cyl(0.15, 0.16, 0.06, 6), '#d2cab6', { p: [-0.2, 0.03, 0.26] }]]),
  sprinkler: () => bake([[G.cyl(0.15, 0.18, 0.28, 8), '#8a9a9c', { p: [0, 0.14, 0] }], [G.cyl(0.04, 0.04, 0.2, 6), '#c8a050', { p: [0, 0.38, 0] }], [G.sph(0.07, 1), '#e8c870', { p: [0, 0.5, 0] }]]),
  campfire: () => {
    const p = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      p.push([G.dodo(0.1), i % 2 ? '#8f9692' : '#a9b0ab', { p: [Math.cos(a) * 0.32, 0.06, Math.sin(a) * 0.32] }]);
    }
    p.push([G.cyl(0.05, 0.05, 0.55, 5), '#6a4a2e', { p: [0, 0.1, 0], r: [0, 0.5, Math.PI / 2 - 0.2] }]);
    p.push([G.cyl(0.05, 0.05, 0.55, 5), '#6a4a2e', { p: [0, 0.1, 0], r: [0, -0.7, Math.PI / 2 + 0.2] }]);
    return bake(p);
  },
  scarecrow: () => bake([
    [G.cyl(0.04, 0.05, 1.4, 5), '#7a5538', { p: [0, 0.7, 0] }],
    [G.cyl(0.03, 0.03, 0.9, 5), '#7a5538', { p: [0, 1.0, 0], r: [0, 0, Math.PI / 2] }],
    [G.box(0.42, 0.45, 0.22), '#6f8fb8', { p: [0, 0.98, 0] }],
    [G.sph(0.18, 1), '#f2e2b8', { p: [0, 1.36, 0] }],
    [G.cyl(0.38, 0.4, 0.05, 12), '#e2c46a', { p: [0, 1.48, 0] }],
    [G.cyl(0.16, 0.2, 0.16, 10), '#e8cc72', { p: [0, 1.58, 0] }],
  ]),
};

// ======================= 场景 =======================
export class FarmScene {
  constructor(canvas, cfg) {
    this.cfg = cfg;
    this.canvas = canvas;
    this.quality = 'high';
    try {
      const q = localStorage.getItem('farm.quality');
      if (q) this.quality = q;
      else if (Math.min(screen.width, screen.height) < 500 && (navigator.hardwareConcurrency || 4) <= 4) this.quality = 'low';
    } catch {}
    const r = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: this.quality === 'high', powerPreference: 'high-performance' }));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NeutralToneMapping;
    r.toneMappingExposure = 0.92;
    r.shadowMap.enabled = this.quality === 'high';
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.5, 900);
    this.zoomK = 1;
    this.camTarget = new V3(cfg.MAP.start.x, 0, cfg.MAP.start.y);
    this.camLook = this.camTarget.clone();
    this.raycaster = new THREE.Raycaster();
    this.season = 'spring';
    this.weather = 'sun';
    this.time = 360;
    this.night = 0;
    this.players = new Map();
    this.animals = new Map();
    this.fx = [];
    this.temp = [];
    this.windowMats = [];
    this.glowMats = [];
    this.campfires = [];
    this.objDirty = true;
    this.lastRebuild = 0;
    this.setupLights();
    this.setupSky();
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  setQuality(q) {
    this.quality = q;
    try {
      localStorage.setItem('farm.quality', q);
    } catch {}
    this.renderer.shadowMap.enabled = q === 'high';
    this.sun.castShadow = q === 'high';
    this.scene.traverse((o) => {
      if (o.material) {
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of ms) m.needsUpdate = true;
      }
    });
    this.resize();
    if (this.world) this.buildGrass();
  }

  resize() {
    const w = this.canvas.clientWidth || innerWidth;
    const h = this.canvas.clientHeight || innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, this.quality === 'high' ? 2 : 1.25);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = w < h ? 52 : 40;
    this.camera.updateProjectionMatrix();
    this.vw = w;
    this.vh = h;
  }

  // ---------------- 光与天空 ----------------
  setupLights() {
    this.hemi = new THREE.HemisphereLight('#cfe4f8', '#a8a070', 1.1);
    this.scene.add(this.hemi);
    const sun = (this.sun = new THREE.DirectionalLight('#fff4e0', 2.4));
    sun.castShadow = this.quality === 'high';
    sun.shadow.mapSize.set(1024, 1024);
    const sc = sun.shadow.camera;
    sc.left = -20;
    sc.right = 20;
    sc.top = 20;
    sc.bottom = -20;
    sc.near = 1;
    sc.far = 90;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.03;
    this.scene.add(sun, sun.target);
    // 夜里身边的一点暖光（像提着灯）
    this.lantern = new THREE.PointLight('#ffc070', 0, 7, 1.6);
    this.scene.add(this.lantern);
    this.scene.fog = new THREE.Fog('#cfe6f2', 45, 170);
  }

  setupSky() {
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { top: { value: col('#3a86d8') }, hor: { value: col('#c6e2f2') }, sunDir: { value: new V3(0, 1, 0) }, sunCol: { value: col('#fff') }, night: { value: 0 } },
      vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform vec3 top; uniform vec3 hor; uniform vec3 sunDir; uniform vec3 sunCol; uniform float night; varying vec3 vD;
        float h3(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719))) * 43758.5453); }
        void main(){
          float h = vD.y;
          vec3 c = mix(hor, top, pow(clamp(h, 0.0, 1.0), 0.55));
          if (h < 0.0) c = mix(hor, hor * 0.85, clamp(-h * 4.0, 0.0, 1.0));
          float sd = max(dot(vD, normalize(sunDir)), 0.0);
          c += sunCol * (pow(sd, 600.0) * 3.0 + pow(sd, 12.0) * 0.28) * (1.0 - night * 0.6);
          vec3 cell = floor(vD * 160.0);
          float st = step(0.9965, h3(cell)) * smoothstep(0.05, 0.3, h) * night;
          c += vec3(st) * (0.6 + 0.4 * sin(h3(cell + 1.0) * 50.0));
          vec3 md = normalize(vec3(-0.5, 0.55, -0.6));
          float m = smoothstep(0.9993, 0.9996, dot(vD, md)) * night;
          c = mix(c, vec3(1.0, 0.97, 0.88), m);
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(600, 24, 14), skyMat);
    this.scene.add(this.sky);
  }

  // 大朵积云：顶部亮白，底部带一点淡紫的阴影
  buildClouds() {
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, fog: false, emissive: '#ffffff', emissiveIntensity: 0.45 });
    this.cloudMat = mat;
    this.clouds = [];
    const cx = this.W / 2;
    const cz = this.H / 2;
    for (let i = 0; i < 14; i++) {
      const parts = [];
      const n = 7 + Math.floor(hash(i, 1) * 7);
      for (let k = 0; k < n; k++) {
        const x = (hash(i, k, 2) - 0.5) * 3.2;
        const z = (hash(i, k, 3) - 0.5) * 1.6;
        const r = 0.8 + hash(i, k, 4) * 0.9 - Math.abs(x) * 0.15;
        parts.push([G.sph(r, 2), '#ffffff', { p: [x, r * 0.55 + hash(i, k, 5) * 0.6, z] }]);
      }
      parts.push([G.sph(1.6, 2), '#dfe4f2', { p: [0, 0.25, 0], s: [1.6, 0.35, 0.9] }]);
      const geo = bake(parts);
      // 底部染成淡紫灰
      const pa = geo.attributes.position.array;
      const ca = geo.attributes.color.array;
      for (let v = 0; v < pa.length; v += 3) {
        const k = clamp((pa[v + 1] - 0.1) / 1.6, 0, 1);
        ca[v] *= lerp(0.78, 1, k);
        ca[v + 1] *= lerp(0.8, 1, k);
        ca[v + 2] *= lerp(0.92, 1, k);
      }
      const m = new THREE.Mesh(geo, mat);
      const a = hash(i, 8) * TAU;
      const d = 70 + hash(i, 9) * 160;
      const s = 7 + hash(i, 10) * 9;
      m.position.set(cx + Math.cos(a) * d, 38 + hash(i, 11) * 34, cz + Math.sin(a) * d - 40);
      m.scale.set(s, s * (0.75 + hash(i, 12) * 0.4), s);
      m.rotation.y = hash(i, 13) * TAU;
      this.clouds.push(m);
      this.scene.add(m);
    }
  }

  // 远山：一层层越远越淡的蓝色山影
  buildMountains() {
    this.mountains = [];
    const cx = this.W / 2;
    const cz = this.H / 2;
    for (let layer = 0; layer < 3; layer++) {
      const n = 14 - layer * 2;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU + layer * 0.4 + hash(i, layer) * 0.3;
        const d = 150 + layer * 70 + hash(i, layer, 1) * 40;
        const h = 30 + hash(i, layer, 2) * 50 + layer * 15;
        const g = new THREE.ConeGeometry(h * 1.4, h, 7, 3);
        const pa = g.attributes.position.array;
        for (let v = 0; v < pa.length; v += 3) {
          if (pa[v + 1] > -h / 2 + 0.1 && pa[v + 1] < h / 2 - 0.1) {
            pa[v] *= 0.85 + hash(v, i, layer) * 0.3;
            pa[v + 2] *= 0.85 + hash(v, i, layer + 5) * 0.3;
          }
        }
        g.computeVertexNormals();
        const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: '#8fa9c4', fog: false }));
        m.position.set(cx + Math.cos(a) * d, h / 2 - 6, cz + Math.sin(a) * d);
        m.userData.layer = layer;
        this.mountains.push(m);
        this.scene.add(m);
        if (h > 62) {
          const cap = new THREE.Mesh(new THREE.ConeGeometry(h * 1.4 * 0.22, h * 0.22, 7), new THREE.MeshBasicMaterial({ color: '#f4f7fa', fog: false }));
          cap.position.set(m.position.x, m.position.y + h * 0.39, m.position.z);
          cap.userData.cap = true;
          this.mountains.push(cap);
          this.scene.add(cap);
        }
      }
    }
  }

  // ======================= 地形 =======================
  init(world) {
    this.world = world;
    this.W = world.W;
    this.H = world.H;
    this.season = this.cfg.SEASONS[world.meta.season].id;
    this.buildTerrain();
    this.buildOuter();
    this.buildWater();
    this.buildClouds();
    this.buildMountains();
    this.buildPools();
    this.buildStatic();
    this.buildGrass();
    this.buildWeather();
    this.buildTarget();
    this.objDirty = true;
  }

  tileHeight(x, y) {
    const g = this.world.ground[y * this.W + x];
    if (g === 4) {
      const e = Math.min(x, y, this.W - 1 - x, this.H - 1 - y);
      return 1.5 + (2 - Math.min(e, 2)) * 0.9 + hash(x, y, 7) * 0.6;
    }
    if (g === 3) return -0.55;
    if (g === 5) return -0.04;
    return 0;
  }

  buildTerrain() {
    const W = this.W;
    const H = this.H;
    const vw = W + 1;
    const vh = H + 1;
    const hgt = (this.heights = new Float32Array(vw * vh));
    for (let vy = 0; vy < vh; vy++) {
      for (let vx = 0; vx < vw; vx++) {
        let s = 0;
        let n = 0;
        let cliff = 0;
        for (const [tx, ty] of [[vx - 1, vy - 1], [vx, vy - 1], [vx - 1, vy], [vx, vy]]) {
          const cx = clamp(tx, 0, W - 1);
          const cy = clamp(ty, 0, H - 1);
          const h = this.tileHeight(cx, cy);
          s += h;
          n++;
          if (this.world.ground[cy * W + cx] === 4) cliff++;
        }
        // 山崖边缘更陡一点
        hgt[vy * vw + vx] = cliff >= 3 ? s / n + 0.2 : cliff === 2 ? (s / n) * 0.9 : s / n;
      }
    }
    // 用两个三角形一格的网格；每格单独的顶点，便于颜色按格变化又保持柔和
    const geo = new THREE.PlaneGeometry(W, H, W, H);
    geo.rotateX(-Math.PI / 2);
    geo.translate(W / 2, 0, H / 2);
    const pa = geo.attributes.position.array;
    for (let i = 0; i < pa.length / 3; i++) {
      const vx = Math.round(pa[i * 3]);
      const vz = Math.round(pa[i * 3 + 2]);
      pa[i * 3 + 1] = hgt[vz * vw + vx];
    }
    geo.computeVertexNormals();
    geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(pa.length), 3));
    this.terrain = new THREE.Mesh(geo, toon({ vertexColors: true }, 0, true));
    this.terrain.receiveShadow = true;
    this.scene.add(this.terrain);
    this.paintTerrain();
  }

  // 顶点颜色：四周格子颜色的平均，加一点低频噪声，像水彩一样柔和地过渡
  tileColor(x, y, out) {
    const g = this.world.ground[y * this.W + x];
    const P = SEASON[this.season];
    if (g === 0 || g === 7 || g === 4) {
      const n = hash(x >> 2, y >> 2, 3) * 0.5 + hash(x, y, 4) * 0.5;
      out.set(P.grass).lerp(_cb.set(P.grass2), n * 0.8);
      return out;
    }
    if (g === 2) return out.set(this.world.wet[y * this.W + x] ? '#5c3c28' : GROUND_COL[2]);
    if (g === 1 && this.season === 'winter') return out.set('#e2ddd4');
    if (g === 8 && this.season === 'winter') return out.set('#e4e8ea');
    return out.set(GROUND_COL[g] || P.grass);
  }

  paintTerrain(tiles) {
    const W = this.W;
    const H = this.H;
    const vw = W + 1;
    const geo = this.terrain.geometry;
    const ca = geo.attributes.color.array;
    const na = geo.attributes.normal.array;
    const c = new THREE.Color();
    const acc = new THREE.Color();
    const rock = col(this.season === 'winter' ? '#b8bcc0' : ROCK);
    const verts = new Set();
    if (tiles) {
      for (const i of tiles) {
        const x = i % W;
        const y = (i / W) | 0;
        for (const [vx, vy] of [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]]) verts.add(vy * vw + vx);
      }
    }
    const all = !tiles;
    const vcount = vw * (H + 1);
    for (let v = 0; v < vcount; v++) {
      if (!all && !verts.has(v)) continue;
      const vx = v % vw;
      const vy = (v / vw) | 0;
      acc.setRGB(0, 0, 0);
      let n = 0;
      for (const [tx, ty] of [[vx - 1, vy - 1], [vx, vy - 1], [vx - 1, vy], [vx, vy]]) {
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
        this.tileColor(tx, ty, c);
        acc.r += c.r;
        acc.g += c.g;
        acc.b += c.b;
        n++;
      }
      acc.multiplyScalar(1 / n);
      // 陡坡露出岩石
      const ny = na[v * 3 + 1];
      if (ny < 0.8) acc.lerp(rock, clamp((0.8 - ny) * 3, 0, 0.85));
      // 水下更深
      const hh = this.heights[v];
      if (hh < -0.15) acc.lerp(c.set('#2f6a74'), clamp(-hh * 1.4, 0, 0.9));
      ca[v * 3] = acc.r;
      ca[v * 3 + 1] = acc.g;
      ca[v * 3 + 2] = acc.b;
    }
    geo.attributes.color.needsUpdate = true;
  }

  heightAt(x, z) {
    if (!this.heights) return 0;
    const vw = this.W + 1;
    const fx = clamp(x, 0, this.W);
    const fz = clamp(z, 0, this.H);
    const x0 = Math.min(this.W - 1, Math.floor(fx));
    const z0 = Math.min(this.H - 1, Math.floor(fz));
    const tx = fx - x0;
    const tz = fz - z0;
    const h = this.heights;
    const a = h[z0 * vw + x0];
    const b = h[z0 * vw + x0 + 1];
    const c = h[(z0 + 1) * vw + x0];
    const d = h[(z0 + 1) * vw + x0 + 1];
    return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
  }

  // 地图外面：高处连绵的草坡与树林，把农场围成一个山谷
  buildOuter() {
    const W = this.W;
    const H = this.H;
    const R = 140;
    const geo = new THREE.PlaneGeometry(W + R * 2, H + R * 2, 70, 70);
    geo.rotateX(-Math.PI / 2);
    geo.translate(W / 2, 0, H / 2);
    const pa = geo.attributes.position.array;
    const cl = new Float32Array(pa.length);
    const P = SEASON[this.season];
    const c = new THREE.Color();
    for (let i = 0; i < pa.length; i += 3) {
      const x = pa[i];
      const z = pa[i + 2];
      const dx = Math.max(0, -x, x - W);
      const dz = Math.max(0, -z, z - H);
      const d = Math.hypot(dx, dz);
      const inside = d === 0;
      // 地图范围内压到地下（被地图本身盖住）
      pa[i + 1] = inside ? -3 : 3.3 + Math.sin(x * 0.08) * 1.5 + Math.cos(z * 0.07) * 1.5 + Math.min(d, 60) * 0.06 + hash(Math.round(x), Math.round(z), 1) * 0.8;
      c.set(P.grass).lerp(_cb.set(P.far), clamp(d / 50, 0, 1) * 0.7);
      cl[i] = c.r;
      cl[i + 1] = c.g;
      cl[i + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(cl, 3));
    geo.computeVertexNormals();
    if (this.outer) {
      this.scene.remove(this.outer);
      this.outer.geometry.dispose();
    }
    this.outer = new THREE.Mesh(geo, toon({ vertexColors: true }, 0, true));
    this.outer.receiveShadow = true;
    this.scene.add(this.outer);
  }

  // ======================= 水 =======================
  buildWater() {
    const W = this.W;
    const H = this.H;
    const data = new Uint8Array(W * H * 4);
    let minX = W;
    let minY = H;
    let maxX = 0;
    let maxY = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const w = this.world.ground[y * W + x] === 3;
        data[(y * W + x) * 4] = w ? 255 : 0;
        data[(y * W + x) * 4 + 3] = 255;
        if (w) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }
    if (minX > maxX) return;
    const tex = new THREE.DataTexture(data, W, H);
    tex.magFilter = tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      fog: true,
      depthWrite: false,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uMask: { value: null }, uSize: { value: new THREE.Vector2(W, H) }, uDeep: { value: col('#2f7f96') }, uShallow: { value: col('#5cc0c8') }, uLight: { value: new THREE.Color(1, 1, 1) }, uSky: { value: col('#c6e2f2') } }]),
      vertexShader: `varying vec2 vW; #include <fog_pars_vertex>
        void main(){ vec4 wp = modelMatrix * vec4(position, 1.0); vW = wp.xz; vec4 mvPosition = viewMatrix * wp; gl_Position = projectionMatrix * mvPosition; #include <fog_vertex> }`.replace('#include <fog_pars_vertex>', '\n#include <fog_pars_vertex>\n').replace('#include <fog_vertex>', '\n#include <fog_vertex>\n'),
      fragmentShader: `uniform sampler2D uMask; uniform vec2 uSize; uniform vec3 uDeep; uniform vec3 uShallow; uniform vec3 uLight; uniform vec3 uSky; uniform float uTime; varying vec2 vW;
        #include <fog_pars_fragment>
        ${NOISE_GLSL.replace('uCloud', 'vec2(0.0)').replace('uCloudAmt', '0.0')}
        void main(){
          float m = texture2D(uMask, vW / uSize).r;
          if (m < 0.38) discard;
          float deep = smoothstep(0.5, 0.95, m);
          vec3 c = mix(uShallow, uDeep, deep);
          float n = vnoise(vW * 1.3 + vec2(uTime * 0.25, uTime * 0.15)) + vnoise(vW * 2.7 - vec2(uTime * 0.2, 0.0)) * 0.5;
          c += smoothstep(1.05, 1.2, n) * 0.22;
          vec2 cell = floor(vW * 5.0);
          float on = step(0.93, fhash(cell + floor(uTime * 1.5 + fhash(cell) * 3.0)));
          float sp = on * smoothstep(0.12, 0.0, length(fract(vW * 5.0) - 0.5));
          c += sp * 0.8;
          c = mix(c, uSky, 0.18 * (1.0 - deep));
          float foam = smoothstep(0.58, 0.46, m) * (0.6 + 0.4 * sin(uTime * 2.0 + vW.x * 3.0 + vW.y * 2.0));
          c = mix(c, vec3(0.96, 0.98, 1.0), foam * 0.8);
          gl_FragColor = vec4(c * uLight, 0.86);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    mat.uniforms.uMask.value = tex;
    mat.uniforms.uTime = U.uTime;
    this.waterMat = mat;
    const geo = new THREE.PlaneGeometry(maxX - minX + 3, maxY - minY + 3);
    geo.rotateX(-Math.PI / 2);
    const water = new THREE.Mesh(geo, mat);
    water.position.set((minX + maxX + 1) / 2, -0.1, (minY + maxY + 1) / 2);
    water.renderOrder = 2;
    this.scene.add(water);
    // 睡莲与芦苇
    const deco = [];
    for (let k = 0; k < 400 && deco.length < 30; k++) {
      const x = minX + Math.floor(hash(k, 1) * (maxX - minX + 1));
      const y = minY + Math.floor(hash(k, 2) * (maxY - minY + 1));
      const g = this.world.ground[y * W + x];
      if (g === 3 && hash(k, 3) < 0.3) deco.push([G.cyl(0.28, 0.28, 0.02, 10), '#5aa04a', { p: [x + hash(k, 4), -0.07, y + hash(k, 5)] }]);
      if (g === 3 && hash(k, 6) < 0.08) deco.push([G.sph(0.09, 1), '#f6c8d8', { p: [x + 0.5, -0.02, y + 0.5] }]);
      if (g === 5 && hash(k, 7) < 0.35) for (let r = 0; r < 4; r++) {
        const rx = x + 0.3 + hash(k, r, 8) * 0.4;
        const rz = y + 0.3 + hash(k, r, 9) * 0.4;
        deco.push([G.cyl(0.015, 0.02, 0.9, 4), '#7a9a4a', { p: [rx, 0.4, rz] }]);
        deco.push([G.cyl(0.04, 0.04, 0.2, 5), '#7a5030', { p: [rx, 0.82, rz] }]);
      }
    }
    if (deco.length) this.scene.add(new THREE.Mesh(bake(deco), toon({ vertexColors: true }, 0.04)));
  }

  // ======================= 草 =======================
  buildGrass() {
    if (this.grass) {
      this.scene.remove(this.grass);
      this.grass.geometry.dispose();
    }
    const W = this.W;
    const H = this.H;
    const per = this.quality === 'high' ? 3 : 1;
    // 一簇 6 片草叶
    const pos = [];
    const hgt = [];
    for (let b = 0; b < 6; b++) {
      const a = (b / 6) * TAU + hash(b, 1);
      const ox = Math.cos(a) * 0.12;
      const oz = Math.sin(a) * 0.12;
      const h = 0.32 + hash(b, 2) * 0.28;
      const w = 0.05;
      const dx = Math.cos(a + 1.57) * w;
      const dz = Math.sin(a + 1.57) * w;
      const lean = 0.08 + hash(b, 3) * 0.1;
      pos.push(ox - dx, 0, oz - dz, ox + dx, 0, oz + dz, ox + Math.cos(a) * lean, h, oz + Math.sin(a) * lean);
      hgt.push(0, 0, 1, 0, 0, 1, 0, 0, 1);
      void hgt;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const slots = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const g = this.world.ground[y * W + x];
        const cliff = g === 4;
        if (!(g === 0 || g === 1 || g === 2 || g === 8 || g === 7 || (cliff && Math.min(x, y, W - 1 - x, H - 1 - y) >= 1))) continue;
        for (let k = 0; k < per; k++) slots.push([x, y, k]);
      }
    }
    const P = SEASON[this.season];
    const mat = new THREE.ShaderMaterial({
      fog: true,
      side: THREE.DoubleSide,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uBase: { value: col(P.base) }, uTip: { value: col(P.tip) }, uLight: { value: new THREE.Color(1, 1, 1) } }]),
      vertexShader: `uniform float uTime; uniform float uWind; varying float vH; varying vec2 vWXZ; varying float vGust;
        #include <fog_pars_vertex>
        void main(){
          vec3 p = position;
          vH = p.y / 0.6;
          vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
          float ph = wp.x * 0.35 + wp.z * 0.22;
          float gust = smoothstep(0.55, 1.0, sin(uTime * 0.8 - wp.x * 0.12 - wp.z * 0.05));
          vGust = gust;
          float k = vH * vH;
          wp.x += (sin(uTime * 2.1 + ph) * 0.06 + gust * 0.22) * k * uWind;
          wp.z += (cos(uTime * 1.7 + ph * 1.3) * 0.04 + gust * 0.06) * k * uWind;
          vWXZ = wp.xz;
          vec4 mvPosition = viewMatrix * wp;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `uniform vec3 uBase; uniform vec3 uTip; uniform vec3 uLight; uniform vec2 uCloud; uniform float uCloudAmt; varying float vH; varying vec2 vWXZ; varying float vGust;
        #include <fog_pars_fragment>
        ${NOISE_GLSL}
        void main(){
          vec3 c = mix(uBase, uTip, smoothstep(0.0, 1.0, vH));
          c += vGust * vH * 0.12;
          c *= uLight * cloudShade(vWXZ);
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    Object.assign(mat.uniforms, U);
    this.grassMat = mat;
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, slots.length));
    mesh.frustumCulled = false;
    this.grass = mesh;
    this.grassSlots = slots;
    this.grassIdx = new Map(); // 格子 -> 草丛编号
    slots.forEach(([x, y], n) => {
      const i = y * W + x;
      if (!this.grassIdx.has(i)) this.grassIdx.set(i, []);
      this.grassIdx.get(i).push(n);
    });
    this.scene.add(mesh);
    this.refreshGrass();
  }

  grassVisible(i) {
    if (this.season === 'winter') return false;
    const g = this.world.ground[i];
    if (!(g === 0 || g === 4 || g === 7)) return false;
    const o = this.world.objs.get(i);
    return !o || o.k === 'forage' || o.k === 'drop' || o.k === 'weed' || o.k === 'twig';
  }

  refreshGrass(tiles) {
    if (!this.grass) return;
    const m = new THREE.Matrix4();
    const list = tiles ? tiles.filter((i) => this.grassIdx.has(i)) : [...this.grassIdx.keys()];
    for (const i of list) {
      const vis = this.grassVisible(i);
      const x = i % this.W;
      const y = (i / this.W) | 0;
      for (const n of this.grassIdx.get(i)) {
        const k = this.grassSlots[n][2];
        const px = x + 0.2 + hash(x, y, k * 2 + 11) * 0.6;
        const pz = y + 0.2 + hash(x, y, k * 2 + 12) * 0.6;
        const s = vis ? 0.75 + hash(x, y, k + 13) * 0.6 : 0;
        _q.setFromEuler(_e.set(0, hash(x, y, k + 14) * TAU, 0));
        m.compose(_p.set(px, this.heightAt(px, pz) - 0.02, pz), _q, _s.set(s, s * (0.8 + hash(x, y, 15) * 0.5), s));
        this.grass.setMatrixAt(n, m);
      }
    }
    this.grass.instanceMatrix.needsUpdate = true;
  }

  // ======================= 物体实例池 =======================
  pool(key, geoFn, mat, cap, shadow = true) {
    const mesh = new THREE.InstancedMesh(geoFn(), mat, cap);
    mesh.count = 0;
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this.scene.add(mesh);
    this.pools[key] = mesh;
    return mesh;
  }

  buildPools() {
    if (this.pools) for (const p of Object.values(this.pools)) {
      this.scene.remove(p);
      p.geometry.dispose();
    }
    this.pools = {};
    const s = this.season;
    const vc = toon({ vertexColors: true });
    const vcSway = toon({ vertexColors: true }, 0.035);
    const vcSwaySoft = toon({ vertexColors: true }, 0.12);
    for (let v = 0; v < 3; v++) {
      this.pool('tree' + v, () => treeGeo(v, s), vcSway, 260);
      this.pool('young' + v, () => treeGeo(v, s, 1), vcSway, 60);
    }
    this.pool('sapling', () => treeGeo(0, s, 0), vcSwaySoft, 60);
    for (const k of ['stump', 'rock', 'boulder', 'ore', 'twig', 'drop', 'sprinkler', 'campfire', 'scarecrow']) this.pool(k, PROTO[k], vc, k === 'rock' ? 400 : k === 'twig' ? 300 : 120);
    this.pool('weed', PROTO.weed, toon({ vertexColors: true }, 0.18), 900);
    this.pool('forage', PROTO.forage, toon({ vertexColors: true }, 0.05), 60);
    this.pool('soil', PROTO.soil, toon({ vertexColors: true }), 1400, false);
    this.pool('path', PROTO.pathstone, vc, 600, false);
    // 作物：每种形态、每个阶段一组「叶」和一组「果」
    this.cropLeafMat = toon({ vertexColors: true }, 0.16);
    this.cropFruitMat = toon({ vertexColors: true }, 0.08);
    this.cropPools = {};
    for (const type of ['root', 'bush', 'vine', 'big', 'flower']) {
      for (const st of [0, 1, 2, 3, 4]) {
        if (st <= 1 && type !== 'root') continue;
        const [lg, fg] = cropGeos(type, st);
        const key = st <= 1 ? 'any' + st : type + st;
        this.cropPools[key] = { leaf: this.poolGeo('c_' + key, lg, this.cropLeafMat, 500), fruit: fg ? this.poolGeo('cf_' + key, fg, this.cropFruitMat, 500) : null };
      }
    }
    this.objDirty = true;
  }

  poolGeo(key, geo, mat, cap) {
    return this.pool(key, () => geo, mat, cap);
  }

  rebuildObjects() {
    const W = this.W;
    const P = this.pools;
    for (const p of Object.values(P)) p.count = 0;
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    const S = SEASON[this.season];
    const add = (pool, x, z, rot = 0, sc = 1, color = null, y = null) => {
      if (!pool || pool.count >= pool.instanceMatrix.count) return;
      _q.setFromEuler(_e.set(0, rot, 0));
      m.compose(_p.set(x, y === null ? this.heightAt(x, z) : y, z), _q, typeof sc === 'number' ? _s.set(sc, sc, sc) : sc);
      pool.setMatrixAt(pool.count, m);
      if (color) pool.setColorAt(pool.count, color);
      else if (pool.instanceColor) pool.setColorAt(pool.count, c.setRGB(1, 1, 1));
      pool.count++;
    };
    this.campfires = [];
    // 耕地与石板路
    for (let i = 0; i < W * this.H; i++) {
      const g = this.world.ground[i];
      if (g === 2) add(P.soil, (i % W) + 0.5, ((i / W) | 0) + 0.5, 0, 1, c.set(this.world.wet[i] ? '#5a3826' : '#8f5f3e'));
      else if (g === 8) add(P.path, (i % W) + 0.5, ((i / W) | 0) + 0.5, hash(i, 1) * TAU);
    }
    for (const [i, o] of this.world.objs) {
      const x = (i % W) + 0.5;
      const z = ((i / W) | 0) + 0.5;
      const r = hash(i, 2) * TAU;
      const jx = (hash(i, 3) - 0.5) * 0.2;
      const jz = (hash(i, 4) - 0.5) * 0.2;
      switch (o.k) {
        case 'tree':
          if (o.s === 0) add(P.sapling, x, z, r);
          else add(P[(o.s === 1 ? 'young' : 'tree') + (o.v || 0)], x + jx, z + jz, r, 0.9 + hash(i, 5) * 0.25);
          break;
        case 'stump':
          add(P.stump, x, z, r);
          break;
        case 'rock':
          add(o.big ? P.boulder : P.rock, x + jx, z + jz, r, o.big ? 1 : 0.9 + hash(i, 5) * 0.3);
          break;
        case 'ore':
          add(P.ore, x, z, r);
          break;
        case 'twig':
          add(P.twig, x + jx, z + jz, r);
          break;
        case 'weed': {
          const wc = this.season === 'winter' ? '#b8c4bc' : S.leaf[(o.v || 0) % 3];
          add(P.weed, x + jx, z + jz, r, 0.8 + hash(i, 5) * 0.4, c.set(wc));
          break;
        }
        case 'forage': {
          const f = this.cfg.FORAGE[o.id];
          add(P.forage, x + jx, z + jz, r, 1.1, c.set(f ? f.color : '#fff'));
          break;
        }
        case 'drop':
          add(P.drop, x, z, r);
          break;
        case 'place':
          add(P[o.id], x, z, o.id === 'scarecrow' ? 0 : r);
          if (o.id === 'campfire') this.campfires.push([x, z]);
          break;
        case 'crop': {
          const cd = this.cfg.CROPS[o.c];
          if (!cd) break;
          const look = cd.look;
          let st;
          if (o.ready) st = 4;
          else if (o.age === 0) st = 0;
          else {
            const k = o.age / cd.days;
            st = k < 0.3 ? 1 : k < 0.65 ? 2 : 3;
          }
          const key = st <= 1 ? 'any' + st : look.type + st;
          const cp = this.cropPools[key];
          if (!cp) break;
          const leafC = o.dead ? c.set('#9a8058') : c.set(st === 0 ? '#ffffff' : look.leaf);
          add(cp.leaf, x, z, hash(i, 6) * TAU, 1, leafC);
          if (cp.fruit && !o.dead) add(cp.fruit, x, z, hash(i, 6) * TAU, 1, c.set(st === 4 ? look.color : look.stripe || '#f4f0d0'));
          break;
        }
      }
    }
    for (const p of Object.values(P)) {
      p.instanceMatrix.needsUpdate = true;
      if (p.instanceColor) p.instanceColor.needsUpdate = true;
    }
  }

  // ======================= 建筑与固定物 =======================
  buildStatic() {
    const M = this.cfg.MAP;
    this.staticGroup = new THREE.Group();
    this.scene.add(this.staticGroup);
    const vc = toon({ vertexColors: true });
    const add = (geo, x, z, opts = {}) => {
      const mesh = new THREE.Mesh(geo, opts.mat || vc);
      mesh.position.set(x, opts.y ?? this.heightAt(x, z), z);
      if (opts.r) mesh.rotation.y = opts.r;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.staticGroup.add(mesh);
      return mesh;
    };
    this.addStatic = add;
    this.windowMat = new THREE.MeshToonMaterial({ gradientMap, color: '#6a8aa8', emissive: '#ffb860', emissiveIntensity: 0 });
    this.glowMat = new THREE.MeshBasicMaterial({ color: '#ffd890', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });

    // ---- 小屋：奶油色灰泥墙、木梁、橘红瓦片屋顶、烟囱 ----
    const h = M.house;
    const hx = h.x + h.w / 2;
    const hz = h.y + h.h / 2;
    const roof = this.season === 'winter' ? '#eef3f6' : '#cf6a45';
    const house = bake([
      [G.box(h.w + 0.2, 0.35, h.h + 0.2), '#a8a092', { p: [0, 0.17, 0] }],
      [G.box(h.w - 0.4, 2.2, h.h - 0.5), '#f4e6c8', { p: [0, 1.45, 0], grad: [0.4, 0.08] }],
      [G.box(0.18, 2.2, 0.18), '#7a5538', { p: [-(h.w - 0.4) / 2, 1.45, (h.h - 0.5) / 2] }],
      [G.box(0.18, 2.2, 0.18), '#7a5538', { p: [(h.w - 0.4) / 2, 1.45, (h.h - 0.5) / 2] }],
      [G.box(0.18, 2.2, 0.18), '#7a5538', { p: [-(h.w - 0.4) / 2, 1.45, -(h.h - 0.5) / 2] }],
      [G.box(0.18, 2.2, 0.18), '#7a5538', { p: [(h.w - 0.4) / 2, 1.45, -(h.h - 0.5) / 2] }],
      [G.box(h.w - 0.3, 0.14, 0.12), '#7a5538', { p: [0, 1.5, (h.h - 0.5) / 2 + 0.01] }],
      [G.box(0.12, 2.2, 0.1), '#7a5538', { p: [-0.7, 1.45, (h.h - 0.5) / 2 + 0.02] }],
      [G.box(0.12, 2.2, 0.1), '#7a5538', { p: [0.7, 1.45, (h.h - 0.5) / 2 + 0.02] }],
      [prism(h.w + 0.6, 1.9, h.h + 0.5), roof, { p: [0, 2.55, 0], grad: [2.5, 0.12] }],
      [G.box(h.w + 0.65, 0.2, 0.3), '#a04a30', { p: [0, 4.43, 0] }],
      ...[1, 2, 3, 4, 5].flatMap((k) => {
        const half = (h.h + 0.5) / 2;
        const ang = Math.atan2(1.9, half);
        const f = k / 6;
        const tile = this.season === 'winter' ? '#d4dee4' : '#a84c32';
        return [[G.box(h.w + 0.62, 0.05, 0.1), tile, { p: [0, 2.55 + 1.9 * f + 0.03, half * (1 - f) + 0.02], r: [-ang, 0, 0] }], [G.box(h.w + 0.62, 0.05, 0.1), tile, { p: [0, 2.55 + 1.9 * f + 0.03, -half * (1 - f) - 0.02], r: [ang, 0, 0] }]];
      }),
      [G.box(0.55, 1.6, 0.55), '#a8988a', { p: [1.3, 3.9, -0.6] }],
      [G.box(0.7, 0.18, 0.7), '#8a7a6c', { p: [1.3, 4.72, -0.6] }],
      // 门、门前台阶
      [G.box(0.85, 1.55, 0.12), '#8a5a34', { p: [M.house.door.x + 0.5 - hx, 1.12, (h.h - 0.5) / 2 + 0.05] }],
      [G.sph(0.05, 0), '#e8c870', { p: [M.house.door.x + 0.75 - hx, 1.1, (h.h - 0.5) / 2 + 0.13] }],
      [G.box(1.3, 0.16, 0.5), '#b0a594', { p: [M.house.door.x + 0.5 - hx, 0.08, h.h / 2 + 0.15] }],
      // 花箱
      [G.box(0.9, 0.18, 0.22), '#8a5a34', { p: [-1.55, 0.95, (h.h - 0.5) / 2 + 0.15] }],
      [G.box(0.9, 0.18, 0.22), '#8a5a34', { p: [1.55, 0.95, (h.h - 0.5) / 2 + 0.15] }],
      ...[-1.85, -1.55, -1.25, 1.25, 1.55, 1.85].map((x, i) => [G.sph(0.1, 0), i % 2 ? '#e85a5a' : '#f6c84a', { p: [x, 1.1, (h.h - 0.5) / 2 + 0.17] }]),
    ]);
    add(house, hx, hz, { y: 0 });
    // 窗户（夜里亮起暖光）
    for (const x of [-1.55, 1.55]) {
      const w = new THREE.Mesh(G.box(0.7, 0.6, 0.06), this.windowMat);
      w.position.set(hx + x, 1.6, hz + (h.h - 0.5) / 2 + 0.03);
      this.staticGroup.add(w);
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.8), this.glowMat);
      glow.position.set(hx + x, 1.6, hz + (h.h - 0.5) / 2 + 0.3);
      this.staticGroup.add(glow);
    }
    this.chimney = new V3(hx + 1.3, 4.9, hz - 0.6);

    // ---- 出货箱 ----
    const b = M.bin;
    const bin = bake([
      [G.box(b.w - 0.2, 0.8, b.h - 0.2), '#9a6a3e', { p: [0, 0.4, 0], grad: [0, 0.3] }],
      [G.box(b.w - 0.1, 0.12, b.h - 0.1), '#b07a48', { p: [0, 0.86, 0] }],
      [G.box(0.25, 0.2, 0.05), '#d8c070', { p: [0, 0.7, (b.h - 0.2) / 2 + 0.02] }],
    ]);
    add(bin, b.x + b.w / 2, b.y + b.h / 2, { y: 0 });

    // ---- 行商的摊位：条纹雨棚、木箱里的菜 ----
    const s = M.shop;
    const sx = s.x + s.w / 2;
    const sz = s.y + s.h / 2;
    const stall = [
      [G.box(s.w - 0.2, 0.95, 0.6), '#c49464', { p: [0, 0.48, s.h / 2 - 0.35] }],
      [G.box(s.w, 0.1, 0.75), '#8a5a34', { p: [0, 1.0, s.h / 2 - 0.35] }],
      [G.box(s.w - 0.4, 1.4, 0.4), '#a87a4e', { p: [0, 0.7, -s.h / 2 + 0.3] }],
      ...[[-s.w / 2 + 0.1, s.h / 2 - 0.1], [s.w / 2 - 0.1, s.h / 2 - 0.1], [-s.w / 2 + 0.1, -s.h / 2 + 0.1], [s.w / 2 - 0.1, -s.h / 2 + 0.1]].map(([x, z]) => [G.cyl(0.06, 0.07, 2.6, 6), '#7a5538', { p: [x, 1.3, z] }]),
    ];
    for (let i = 0; i < 8; i++) stall.push([G.box(s.w / 8 + 0.02, 0.06, s.h + 0.6), i % 2 ? '#f6ecd6' : '#3f8a8a', { p: [-s.w / 2 + (i + 0.5) * (s.w / 8), 2.65, 0.1], r: [0.18, 0, 0] }]);
    for (let i = 0; i < 3; i++) {
      stall.push([G.box(0.7, 0.3, 0.45), '#b08050', { p: [-1.15 + i * 1.15, 1.2, s.h / 2 - 0.35] }]);
      const cc = ['#f2e2b0', '#e6402e', '#ec8a24'][i];
      for (let k = 0; k < 5; k++) stall.push([G.sph(0.1, 0), cc, { p: [-1.35 + i * 1.15 + (k % 3) * 0.18, 1.42, s.h / 2 - 0.42 + (k > 2 ? 0.14 : 0)] }]);
    }
    for (let i = 0; i < 6; i++) stall.push([G.sph(0.1, 0), ['#e85a3a', '#f2c14e', '#7ab656', '#d88a3a', '#b05ad8', '#f6f0dc'][i], { p: [-1.3 + i * 0.52, 1.5, -s.h / 2 + 0.35] }]);
    stall.push([G.box(1.1, 0.45, 0.06), '#f6ecd6', { p: [0, 3.05, s.h / 2 + 0.25] }]);
    add(bake(stall), sx, sz, { y: 0 });
    this.shopLamp = new THREE.Mesh(G.sph(0.14, 1), new THREE.MeshBasicMaterial({ color: '#ffd890' }));
    this.shopLamp.position.set(sx + s.w / 2 - 0.1, 2.25, sz + s.h / 2 - 0.1);
    this.staticGroup.add(this.shopLamp);
    this.merchant = makeCharacter({ color: '#3f8a8a', hair: 2, hat: false, name: '阿青' });
    this.merchant.group.position.set(sx, 0, sz - 0.1);
    this.merchant.group.rotation.y = 0;
    this.scene.add(this.merchant.group);

    // ---- 牧场栅栏 ----
    const W = this.W;
    const posts = [];
    for (let i = 0; i < W * this.H; i++) {
      if (this.world.ground[i] !== 7) continue;
      const x = i % W;
      const y = (i / W) | 0;
      posts.push([G.box(0.14, 0.9, 0.14), '#a07850', { p: [x + 0.5, 0.45, y + 0.5] }]);
      const right = this.world.ground[i + 1] === 7;
      const down = this.world.ground[i + W] === 7;
      if (right) {
        posts.push([G.box(1, 0.08, 0.06), '#b88a5a', { p: [x + 1, 0.62, y + 0.5] }]);
        posts.push([G.box(1, 0.08, 0.06), '#b88a5a', { p: [x + 1, 0.32, y + 0.5] }]);
      }
      if (down) {
        posts.push([G.box(0.06, 0.08, 1), '#b88a5a', { p: [x + 0.5, 0.62, y + 1] }]);
        posts.push([G.box(0.06, 0.08, 1), '#b88a5a', { p: [x + 0.5, 0.32, y + 1] }]);
      }
    }
    if (posts.length) add(bake(posts), 0, 0, { y: 0 });

    // ---- 古代遗迹：长满苔藓的石柱、祭坛和漂浮的石头 ----
    const sh = M.shrine;
    this.pillarGems = [];
    for (const [i, o] of this.world.objs) {
      if (o.k !== 'pillar') continue;
      const x = (i % W) + 0.5;
      const z = ((i / W) | 0) + 0.5;
      const geo = bake([
        [G.box(0.8, 0.3, 0.8), '#8a8f84', { p: [0, 0.15, 0] }],
        [G.box(0.55, 2.3, 0.55), '#a9ad9e', { p: [0, 1.45, 0], grad: [0, 0.1] }],
        [G.box(0.7, 0.2, 0.7), '#8a8f84', { p: [0, 2.65, 0] }],
        [G.sph(0.22, 0), '#7aa04e', { p: [0.2, 0.6, 0.2], s: [1, 0.5, 0.6] }],
        [G.sph(0.18, 0), '#7aa04e', { p: [-0.25, 1.6, 0.1], s: [0.5, 1, 0.8] }],
      ]);
      add(geo, x, z, { r: hash(i, 1) * 0.3 });
      const gm = new THREE.MeshBasicMaterial({ color: '#7a8a8a' });
      const gem = new THREE.Mesh(G.oct(0.2), gm);
      gem.position.set(x, 3.05, z);
      gem.userData.b = o.b;
      this.staticGroup.add(gem);
      this.pillarGems.push(gem);
    }
    const alt = sh.altar;
    const ax = alt.x + alt.w / 2;
    const az = alt.y + alt.h / 2;
    add(bake([
      [G.cyl(1.05, 1.15, 0.4, 10), '#8f9488', { p: [0, 0.2, 0] }],
      [G.cyl(0.75, 0.85, 0.4, 10), '#a8ad9e', { p: [0, 0.6, 0] }],
      [G.cyl(0.45, 0.5, 0.3, 10), '#bcc0b2', { p: [0, 0.95, 0] }],
      [G.sph(0.3, 0), '#7aa04e', { p: [-0.7, 0.4, 0.5], s: [1.2, 0.4, 0.8] }],
    ]), ax, az, { y: 0 });
    this.crystalMat = new THREE.MeshToonMaterial({ gradientMap, color: '#b8c8c0', emissive: '#7fdcff', emissiveIntensity: 0.1 });
    this.crystal = new THREE.Mesh(G.oct(0.42), this.crystalMat);
    this.crystal.position.set(ax, 2.1, az);
    this.crystal.scale.set(0.8, 1.4, 0.8);
    this.staticGroup.add(this.crystal);
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.9, 40, 16, 1, true), new THREE.MeshBasicMaterial({ color: '#bff0ff', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
    this.beam.position.set(ax, 21, az);
    this.staticGroup.add(this.beam);

    // ---- 远处高地上的树林 ----
    this.buildForest();
    this.buildBarns();
  }

  buildForest() {
    if (this.forest) for (const f of this.forest) {
      this.scene.remove(f);
      f.geometry.dispose();
    }
    this.forest = [];
    const W = this.W;
    const H = this.H;
    const spots = [[], [], []];
    // 地图边缘的山崖上
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (this.world.ground[y * W + x] !== 4) continue;
      if (hash(x, y, 21) < 0.42) spots[hash(x, y, 22) < 0.45 ? 1 : 0].push([x + 0.5 + (hash(x, y, 23) - 0.5) * 0.6, y + 0.5 + (hash(x, y, 24) - 0.5) * 0.6, 0.9 + hash(x, y, 25) * 0.6]);
    }
    // 外面的高地
    for (let k = 0; k < (this.quality === 'high' ? 900 : 450); k++) {
      const side = k % 4;
      const t = hash(k, 1);
      const d = 1 + Math.pow(hash(k, 2), 1.6) * 34;
      let x;
      let z;
      if (side === 0) [x, z] = [-d, t * (H + 40) - 20];
      else if (side === 1) [x, z] = [W + d, t * (H + 40) - 20];
      else if (side === 2) [x, z] = [t * (W + 40) - 20, -d];
      else [x, z] = [t * (W + 40) - 20, H + d];
      spots[hash(k, 3) < 0.5 ? 1 : hash(k, 4) < 0.5 ? 0 : 2].push([x, z, 1 + hash(k, 5) * 0.9]);
    }
    const mat = toon({ vertexColors: true }, 0.025);
    const m = new THREE.Matrix4();
    spots.forEach((list, v) => {
      const mesh = new THREE.InstancedMesh(treeGeo(v, this.season), mat, Math.max(1, list.length));
      list.forEach(([x, z, s], n) => {
        const y = x >= 0 && z >= 0 && x <= W && z <= H ? this.heightAt(x, z) : 3.3 + Math.sin(x * 0.08) * 1.5 + Math.cos(z * 0.07) * 1.5 + Math.min(Math.hypot(Math.max(0, -x, x - W), Math.max(0, -z, z - H)), 60) * 0.06;
        _q.setFromEuler(_e.set(0, hash(n, v) * TAU, 0));
        m.compose(_p.set(x, y - 0.1, z), _q, _s.set(s, s, s));
        mesh.setMatrixAt(n, m);
      });
      mesh.castShadow = this.quality === 'high';
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      this.forest.push(mesh);
    });
  }

  // 鸡舍、畜棚：空地上立一块牌子；施工中是脚手架；盖好了是房子
  buildBarns() {
    if (this.barnGroup) this.scene.remove(this.barnGroup);
    const g = (this.barnGroup = new THREE.Group());
    this.scene.add(g);
    const B = (this.world.meta && this.world.meta.buildings) || {};
    const vc = toon({ vertexColors: true });
    for (const id of ['coop', 'barn']) {
      const r = this.cfg.MAP[id];
      const st = B[id] || {};
      const cx = r.x + r.w / 2;
      const cz = r.y + r.h / 2;
      let geo;
      const roofC = this.season === 'winter' ? '#eef3f6' : id === 'barn' ? '#8a5e4a' : '#5f9a6a';
      const roofLine = this.season === 'winter' ? '#d0dae0' : id === 'barn' ? '#6a4434' : '#4a7a54';
      if (st.built) {
        const wall = id === 'barn' ? '#b9533c' : '#d8b88a';
        const hh = id === 'barn' ? 2.4 : 1.7;
        const door = this.cfg.MAP[id].door;
        geo = bake([
          [G.box(r.w - 0.3, hh, r.h - 0.3), wall, { p: [0, hh / 2, 0], grad: [0, 0.1] }],
          [prism(r.w + 0.3, r.w * 0.3, r.h + 0.4), roofC, { p: [0, hh, 0], grad: [hh, 0.15] }],
          [G.box(r.w + 0.4, 0.14, 0.2), roofLine, { p: [0, hh + r.w * 0.3, 0] }],
          ...[1, 2, 3].flatMap((k) => {
            const half = (r.h + 0.4) / 2;
            const ht = r.w * 0.3;
            const ang = Math.atan2(ht, half);
            const f = k / 4;
            return [[G.box(r.w + 0.32, 0.04, 0.08), roofLine, { p: [0, hh + ht * f + 0.025, half * (1 - f) + 0.02], r: [-ang, 0, 0] }], [G.box(r.w + 0.32, 0.04, 0.08), roofLine, { p: [0, hh + ht * f + 0.025, -half * (1 - f) - 0.02], r: [ang, 0, 0] }]];
          }),
          [G.box(r.w - 0.1, 0.12, 0.1), '#f6ecd6', { p: [0, hh - 0.05, (r.h - 0.3) / 2 + 0.03] }],
          [G.box(id === 'barn' ? 1.7 : 0.75, id === 'barn' ? 1.7 : 1.0, 0.08), id === 'barn' ? '#8a3a28' : '#7a5538', { p: [door.x + 0.5 - cx, id === 'barn' ? 0.85 : 0.5, (r.h - 0.3) / 2 + 0.03] }],
          ...(id === 'barn' ? [[G.box(1.8, 0.08, 0.04), '#f6ecd6', { p: [door.x + 0.5 - cx, 1.72, (r.h - 0.3) / 2 + 0.08] }], [G.box(0.08, 1.7, 0.04), '#f6ecd6', { p: [door.x + 0.5 - cx, 0.85, (r.h - 0.3) / 2 + 0.08] }]] : []),
          [G.box(0.7, 0.5, 0.06), '#6a8aa0', { p: [r.w / 2 - 1, hh * 0.65, (r.h - 0.3) / 2 + 0.03] }],
        ]);
      } else if (st.pending) {
        const p = [];
        for (let i = 0; i < 4; i++) for (const zz of [-1, 1]) p.push([G.box(0.12, 2.2, 0.12), '#c49a64', { p: [-r.w / 2 + 0.3 + (i * (r.w - 0.6)) / 3, 1.1, zz * (r.h / 2 - 0.3)] }]);
        for (const y of [0.8, 1.6]) for (const zz of [-1, 1]) p.push([G.box(r.w - 0.4, 0.08, 0.08), '#c49a64', { p: [0, y, zz * (r.h / 2 - 0.3)] }]);
        p.push([G.box(1.2, 0.5, 0.8), '#d8c49a', { p: [0, 0.25, 0] }]);
        geo = bake(p);
      } else {
        geo = bake([
          [G.cyl(0.05, 0.06, 0.8, 5), '#7a5538', { p: [0, 0.4, r.h / 2 - 0.2] }],
          [G.box(0.9, 0.42, 0.06), '#d8b884', { p: [0, 0.9, r.h / 2 - 0.18] }],
          [G.box(r.w - 0.2, 0.06, r.h - 0.2), '#b8b2a0', { p: [0, 0.03, 0] }],
        ]);
      }
      const mesh = new THREE.Mesh(geo, vc);
      mesh.position.set(cx, 0, cz);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      g.add(mesh);
    }
  }

  // ======================= 天气粒子 =======================
  buildWeather() {
    const N = this.quality === 'high' ? 900 : 400;
    const rp = new Float32Array(N * 6);
    for (let i = 0; i < N; i++) {
      const x = (Math.random() - 0.5) * 50;
      const y = Math.random() * 22;
      const z = (Math.random() - 0.5) * 40;
      rp.set([x, y, z, x + 0.12, y - 0.7, z + 0.05], i * 6);
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(rp, 3));
    this.rain = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: '#d8e8f4', transparent: true, opacity: 0.5, fog: false }));
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    this.scene.add(this.rain);
    // 雪、花瓣、落叶、萤火虫共用一种圆点粒子
    const dot = (() => {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 32;
      const c = cv.getContext('2d');
      const g = c.createRadialGradient(16, 16, 0, 16, 16, 16);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.5, 'rgba(255,255,255,.8)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, 32, 32);
      return new THREE.CanvasTexture(cv);
    })();
    this.dotTex = dot;
    const mk = (n, color, size, additive = false) => {
      const g = new THREE.BufferGeometry();
      const p = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) p.set([(Math.random() - 0.5) * 50, Math.random() * 14, (Math.random() - 0.5) * 40], i * 3);
      g.setAttribute('position', new THREE.BufferAttribute(p, 3));
      const pts = new THREE.Points(g, new THREE.PointsMaterial({ color, size, map: dot, transparent: true, depthWrite: false, opacity: 0.9, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, fog: false }));
      pts.frustumCulled = false;
      pts.visible = false;
      this.scene.add(pts);
      return pts;
    };
    this.snow = mk(N, '#ffffff', 0.22);
    this.petals = mk(70, '#f8c4d4', 0.2);
    this.flies = mk(60, '#e8ff9a', 0.28, true);
  }

  buildTarget() {
    const g = new THREE.RingGeometry(0.5, 0.6, 4, 1, Math.PI / 4);
    g.rotateX(-Math.PI / 2);
    this.target = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.8, depthWrite: false, fog: false }));
    this.target.scale.set(Math.SQRT2 * 0.82, 1, Math.SQRT2 * 0.82);
    this.target.renderOrder = 3;
    this.target.visible = false;
    this.scene.add(this.target);
    // 粒子特效
    const pg = G.sph(0.06, 0);
    this.parts = new THREE.InstancedMesh(pg, new THREE.MeshBasicMaterial({ color: '#ffffff' }), 500);
    this.parts.count = 0;
    this.parts.frustumCulled = false;
    this.parts.setColorAt(0, new THREE.Color());
    this.scene.add(this.parts);
    this.particles = [];
  }

  // ======================= 外部接口 =======================
  // 地图变化后调用：tiles 是变化过的格子编号
  tilesChanged(tiles, groundChanged) {
    this.objDirty = true;
    if (groundChanged) this.paintTerrain(tiles);
    this.refreshGrass(tiles);
  }

  setMeta(meta) {
    const season = this.cfg.SEASONS[meta.season].id;
    const bkey = JSON.stringify(meta.buildings);
    if (season !== this.season) {
      this.season = season;
      this.paintTerrain();
      this.buildOuter();
      this.buildPools();
      this.buildGrass();
      this.buildForest();
      this.buildBarns();
      this.barnKey = bkey;
      // 屋顶积雪要重建小屋：简单起见整组重建
      this.scene.remove(this.staticGroup);
      this.scene.remove(this.merchant.group);
      this.buildStatic();
    }
    if (bkey !== this.barnKey) {
      this.barnKey = bkey;
      this.buildBarns();
    }
    this.weather = meta.weather;
    this.awake = meta.awake;
    this.bundleDone = meta.bundleDone || {};
  }

  setTarget(x, y, ok) {
    if (x === null) {
      this.target.visible = false;
      return;
    }
    this.target.visible = true;
    this.target.position.set(x + 0.5, this.heightAt(x + 0.5, y + 0.5) + 0.06, y + 0.5);
    this.target.material.color.set(ok ? '#ffffff' : '#ff9a7a');
  }

  zoom(f) {
    this.zoomK = clamp(this.zoomK * f, 0.6, 1.9);
  }

  pick(cx, cy) {
    const rect = this.canvas.getBoundingClientRect();
    const v = new THREE.Vector2(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(v, this.camera);
    const hit = this.raycaster.intersectObject(this.terrain, false)[0];
    let p = hit ? hit.point : null;
    if (!p) {
      const pl = new THREE.Plane(new V3(0, 1, 0), 0);
      p = this.raycaster.ray.intersectPlane(pl, new V3());
    }
    return p ? { x: p.x, y: p.z } : null;
  }

  // 屏幕坐标（CSS 像素）
  project(x, z, h = 0) {
    _p.set(x, this.heightAt(x, z) + h, z).project(this.camera);
    return { x: (_p.x * 0.5 + 0.5) * this.vw, y: (-_p.y * 0.5 + 0.5) * this.vh, vis: _p.z < 1 };
  }

  // ---------------- 角色 ----------------
  syncPlayers(list, selfId, members) {
    const seen = new Set();
    for (const p of list) {
      seen.add(p.id);
      let e = this.players.get(p.id);
      const mem = members[p.id] || {};
      if (!e) {
        const h = hashStr(p.id);
        e = makeCharacter({ color: mem.color || '#e8604c', hair: h % 6, hat: h % 3 !== 0, name: mem.name || '' });
        e.x = p.x;
        e.y = p.y;
        this.players.set(p.id, e);
        this.scene.add(e.group);
      }
      e.self = p.id === selfId;
      e.tx = p.x;
      e.ty = p.y;
      e.f = p.f;
      e.held = p.held;
      e.moving = p.anim;
      e.sleep = p.sleep;
      e.fish = p.fish;
      if (mem.color && mem.color !== e.color) {
        e.setColor(mem.color);
        e.color = mem.color;
      }
      if (mem.name && mem.name !== e.name) {
        e.setName(mem.name);
        e.name = mem.name;
      }
    }
    for (const [id, e] of this.players) {
      if (!seen.has(id)) {
        this.scene.remove(e.group);
        this.players.delete(id);
      }
    }
  }

  swing(pid) {
    const e = this.players.get(pid);
    if (e) e.swingT = 0.0001;
  }

  emote(pid, text) {
    const e = this.players.get(pid);
    if (!e) return;
    if (e.emote) e.group.remove(e.emote);
    e.emote = textSprite(text, 64, 0.7);
    e.emote.position.set(0, 2.5, 0);
    e.emoteT = 2.6;
    e.group.add(e.emote);
  }

  syncAnimals(list, info) {
    const seen = new Set();
    const byId = new Map((info || []).map((a) => [a.id, a]));
    for (const [id, x, y, f, inside, ready, petted] of list) {
      seen.add(id);
      let e = this.animals.get(id);
      const meta = byId.get(id);
      if (!e && meta) {
        e = makeAnimal(meta.kind);
        e.x = x;
        e.y = y;
        e.kind = meta.kind;
        this.animals.set(id, e);
        this.scene.add(e.group);
      }
      if (!e) continue;
      Object.assign(e, { tx: x, ty: y, f, inside, ready, petted });
    }
    for (const [id, e] of this.animals) {
      if (!seen.has(id)) {
        this.scene.remove(e.group);
        this.animals.delete(id);
      }
    }
  }

  // ---------------- 特效 ----------------
  burst(x, z, color, n = 10, opts = {}) {
    const y0 = this.heightAt(x, z) + (opts.y || 0.2);
    const c = new THREE.Color(color);
    for (let i = 0; i < n; i++) {
      if (this.particles.length > 480) this.particles.shift();
      const a = Math.random() * TAU;
      const sp = (opts.speed || 2) * (0.4 + Math.random() * 0.8);
      this.particles.push({ x: x + (Math.random() - 0.5) * 0.3, y: y0, z: z + (Math.random() - 0.5) * 0.3, vx: Math.cos(a) * sp * 0.5, vy: (opts.up || 2.5) * (0.6 + Math.random() * 0.6), vz: Math.sin(a) * sp * 0.5, life: opts.life || 0.8, t: 0, s: (opts.size || 1) * (0.6 + Math.random() * 0.8), c: c.clone(), g: opts.g ?? 9, float: opts.float });
    }
  }

  // 服务器事件 → 动画
  event(e) {
    const tx = e.x + 0.5;
    const tz = e.y + 0.5;
    switch (e.type) {
      case 'till':
        this.burst(tx, tz, '#7a5234', 12, { up: 2.2 });
        break;
      case 'water':
        this.burst(tx, tz, '#9ad8f0', 14, { up: 1.5, speed: 1.5, size: 0.8 });
        break;
      case 'refill':
        this.burst(tx, tz, '#bfeaff', 18, { up: 2.8, size: 0.8 });
        break;
      case 'chop':
        this.burst(tx, tz, '#d8b080', 8, { y: 0.6 });
        if (e.hp > 0) this.shake(e.x, e.y);
        break;
      case 'fall':
        this.fallTree(e.x, e.y, e.v || 0);
        break;
      case 'mine':
        this.burst(tx, tz, e.ore ? '#7fe0f0' : '#a8aca4', 10, { y: 0.3 });
        break;
      case 'cut':
        this.burst(tx, tz, SEASON[this.season].leaf[1], 12, { up: 2, g: 4, life: 1.1 });
        break;
      case 'plant':
        this.burst(tx, tz, '#8a6a4a', 5, { up: 1.2 });
        break;
      case 'harvest':
      case 'pickup':
        this.burst(tx, tz, '#fff3b0', 10, { up: 3, g: 2, life: 0.9, size: 0.8 });
        break;
      case 'place':
        this.burst(tx, tz, '#d8d0c0', 8, { up: 1.5 });
        break;
      case 'cast': {
        this.burst(tx, tz, '#d8f2ff', 10, { y: -0.1, up: 1.6 });
        break;
      }
      case 'fishEnd':
        if (e.why === 'catch') {
          const p = this.players.get(e.pid);
          if (p) this.burst(p.x, p.y, '#bfeaff', 16, { y: 1, up: 3 });
        }
        break;
      case 'pet': {
        const a = this.animals.get(e.aid);
        if (a) this.burst(a.x, a.y, '#ff8aa8', 6, { y: 0.8, up: 1.6, g: -0.5, life: 1.3, size: 1.4 });
        break;
      }
      case 'bundle':
        this.burst(this.crystal.position.x, this.crystal.position.z, '#bff0ff', 40, { y: 2, up: 4, g: 1, life: 1.8 });
        break;
    }
  }

  shake(x, y) {
    this.shakes = this.shakes || [];
    this.shakes.push({ i: y * this.W + x, t: 0.25 });
  }

  fallTree(x, y, v) {
    const mesh = new THREE.Mesh(treeGeo(v, this.season), toon({ vertexColors: true }));
    const cx = x + 0.5;
    const cz = y + 0.5;
    mesh.position.set(cx, this.heightAt(cx, cz), cz);
    mesh.castShadow = true;
    this.scene.add(mesh);
    this.temp.push({ mesh, t: 0, dir: Math.random() < 0.5 ? 1 : -1, kind: 'fall' });
  }

  // ======================= 每帧更新 =======================
  update(dt, st) {
    const now = performance.now() / 1000;
    U.uTime.value = now % 1000;
    this.time = st.time;
    // 风：有时强一点
    const wind = 1 + Math.sin(now * 0.23) * 0.35 + (this.weather === 'rain' ? 0.6 : 0);
    U.uWind.value = wind;
    U.uCloud.value.set(now * 0.9, now * 0.35);
    // ---- 光线 ----
    const L = lightAt(st.time);
    const wx = this.weather;
    const grey = wx === 'sun' ? 0 : 0.55;
    const greyC = new THREE.Color('#9aa4ae');
    const top = L.top.clone().lerp(greyC.clone().multiplyScalar(0.8 + (1 - L.night) * 0.3), grey);
    const hor = L.hor.clone().lerp(greyC, grey * 0.8);
    this.night = L.night;
    const sky = this.sky.material.uniforms;
    sky.top.value.copy(top);
    sky.hor.value.copy(hor);
    sky.night.value = L.night * (1 - grey);
    sky.sunCol.value.copy(L.sun).multiplyScalar(1 - grey);
    this.scene.fog.color.copy(hor);
    this.scene.fog.near = wx === 'sun' ? 45 : 22;
    this.scene.fog.far = wx === 'sun' ? 170 : 90;
    this.hemi.color.copy(L.hs);
    this.hemi.groundColor.copy(L.hg);
    this.hemi.intensity = L.hi * (1 - grey * 0.25);
    this.sun.color.copy(L.sun);
    this.sun.intensity = L.si * (1 - grey * 0.7);
    U.uCloudAmt.value = (1 - grey) * (1 - L.night);
    // 太阳从东边升起、西边落下；夜里是月光
    const k = clamp((st.time - 330) / (1170 - 330), 0, 1);
    const ang = k * Math.PI;
    const sunDir = L.night > 0.7 ? new V3(-0.4, 0.8, -0.5) : new V3(Math.cos(ang) * 0.9, 0.25 + Math.sin(ang) * 0.9, -0.45);
    sky.sunDir.value.copy(new V3(Math.cos(ang), Math.max(0.02, Math.sin(ang) * 0.8), -0.6));
    // ---- 相机 ----
    const self = st.self;
    if (self) this.camTarget.set(self.x, 0, self.y);
    const tgt = this.camLook.lerp(new V3(clamp(this.camTarget.x, 7, this.W - 7), 0, clamp(this.camTarget.z, 6, this.H - 3)), 1 - Math.exp(-dt * 6));
    const portrait = this.vw < this.vh;
    const dist = (portrait ? 23 : 21) * this.zoomK;
    // 拉远时镜头放低，能看到远山和天上的云
    const pitch = lerp(0.86, 0.5, clamp((this.zoomK - 0.6) / 1.1, 0, 1));
    this.camera.position.set(tgt.x, tgt.y + Math.sin(pitch) * dist, tgt.z + Math.cos(pitch) * dist);
    this.camera.lookAt(tgt.x, tgt.y + 0.5, tgt.z - 1.2 - (this.zoomK - 1) * 4);
    this.sky.position.copy(this.camera.position);
    this.sun.position.copy(tgt).addScaledVector(sunDir.normalize(), 40);
    this.sun.target.position.copy(tgt);
    // 远山与云跟着天色变
    for (const m of this.mountains) {
      const base = m.userData.cap ? new THREE.Color('#f4f7fa') : new THREE.Color(['#6f8fa8', '#8aa4bc', '#a6bccc'][m.userData.layer]);
      m.material.color.copy(base.lerp(hor, m.userData.cap ? 0.35 : 0.45 + m.userData.layer * 0.12)).multiplyScalar(lerp(1, 0.45, L.night));
    }
    if (this.cloudMat) {
      this.cloudMat.color.copy(L.cloud).lerp(greyC, grey * 0.7);
      this.cloudMat.emissive.copy(L.cloud).multiplyScalar(0.55).lerp(greyC, grey * 0.5);
      for (const c of this.clouds) {
        c.position.x += dt * 0.8;
        if (c.position.x > this.W / 2 + 230) c.position.x -= 460;
      }
    }
    const glow = clamp((L.night - 0.15) * 1.6, 0, 1);
    const lightCol = new THREE.Color().copy(L.hs).multiplyScalar(L.hi * 0.55).add(L.sun.clone().multiplyScalar(L.si * 0.2 * (1 - grey * 0.6)));
    // 草的着色器不接收点光源：夜里给它留一点亮度，避免变成黑色剪影
    const grassLight = lightCol.clone();
    grassLight.r = Math.max(grassLight.r, 0.32 + glow * 0.12);
    grassLight.g = Math.max(grassLight.g, 0.36 + glow * 0.1);
    grassLight.b = Math.max(grassLight.b, 0.42);
    if (this.grassMat) this.grassMat.uniforms.uLight.value.copy(grassLight);
    if (this.waterMat) {
      this.waterMat.uniforms.uLight.value.copy(lightCol).multiplyScalar(1.05);
      this.waterMat.uniforms.uSky.value.copy(top);
    }
    // 夜里的灯火
    this.windowMat.emissiveIntensity = glow * 1.6;
    this.glowMat.opacity = glow * 0.35;
    this.shopLamp.material.color.set(glow > 0.1 ? '#ffd890' : '#e8d8b0');
    this.lantern.intensity = glow * 7;
    if (self) this.lantern.position.set(self.x, this.heightAt(self.x, self.y) + 1.8, self.y + 0.3);
    // 祭坛
    const lit = Object.values(this.bundleDone || {}).filter(Boolean).length;
    for (const gem of this.pillarGems) {
      const on = this.bundleDone && this.bundleDone[this.cfg.BUNDLES[gem.userData.b].id];
      gem.material.color.set(on ? '#9ff0ff' : '#7a8a8a');
      gem.rotation.y += dt * (on ? 1.5 : 0.2);
      gem.position.y = 3.05 + (on ? Math.sin(now * 2 + gem.userData.b) * 0.08 : 0);
    }
    this.crystal.rotation.y += dt * 0.6;
    this.crystal.position.y = 2.1 + Math.sin(now * 1.3) * 0.12;
    this.crystalMat.emissiveIntensity = 0.15 + lit * 0.18 + (this.awake ? 0.8 : 0);
    this.beam.material.opacity = this.awake ? 0.16 + Math.sin(now * 2) * 0.04 : 0;
    // 行商：营业时间站在柜台后
    const open = st.time >= this.cfg.SHOP_HOURS[0] && st.time < this.cfg.SHOP_HOURS[1];
    this.merchant.group.visible = open;
    if (open) animateCharacter(this.merchant, dt, { moving: false, idle: now, f: 2 });
    // ---- 天气 ----
    this.updateWeather(dt, tgt, L.night, now);
    // ---- 物体 ----
    if (this.objDirty && now - this.lastRebuild > 0.08) {
      this.objDirty = false;
      this.lastRebuild = now;
      this.rebuildObjects();
    }
    // ---- 角色 ----
    for (const [, e] of this.players) {
      if (!e.self) {
        const a = 1 - Math.exp(-dt * 12);
        e.x = lerp(e.x, e.tx, a);
        e.y = lerp(e.y, e.ty, a);
      } else {
        e.x = self.x;
        e.y = self.y;
        e.f = self.f;
        e.held = self.held;
        e.moving = self.moving;
        e.dir = self.dir;
      }
      e.group.visible = !e.sleep;
      e.group.position.set(e.x, this.heightAt(e.x, e.y), e.y);
      const targetRot = e.dir !== undefined && e.self ? e.dir : [Math.PI, Math.PI / 2, 0, -Math.PI / 2][e.f || 0];
      e.rot = e.rot === undefined ? targetRot : angLerp(e.rot, targetRot, 1 - Math.exp(-dt * 14));
      e.group.rotation.y = e.rot;
      animateCharacter(e, dt, { moving: e.moving, idle: now });
      if (e.emote) {
        e.emoteT -= dt;
        e.emote.position.y = 2.5 + Math.sin(now * 4) * 0.05;
        if (e.emoteT <= 0) {
          e.group.remove(e.emote);
          e.emote = null;
        }
      }
      this.updateFishLine(e, now);
    }
    // ---- 动物 ----
    for (const [, a] of this.animals) {
      const k = 1 - Math.exp(-dt * 8);
      const dx = a.tx - a.x;
      const dz = a.ty - a.y;
      a.x = lerp(a.x, a.tx, k);
      a.y = lerp(a.y, a.ty, k);
      a.group.visible = !a.inside;
      a.group.position.set(a.x, this.heightAt(a.x, a.y), a.y);
      if (Math.abs(dx) + Math.abs(dz) > 0.01) a.rot = Math.atan2(dx, dz);
      a.group.rotation.y = angLerp(a.group.rotation.y, a.rot || 0, 1 - Math.exp(-dt * 6));
      const moving = Math.abs(dx) + Math.abs(dz) > 0.02;
      a.body.position.y = moving ? Math.abs(Math.sin(now * 10 + a.x)) * 0.06 : Math.sin(now * 2 + a.y) * 0.01;
      a.icon.visible = !!a.ready;
      a.icon.position.y = a.iconY + Math.sin(now * 3) * 0.08;
    }
    // ---- 树被砍时摇晃、倒下 ----
    for (let i = this.temp.length - 1; i >= 0; i--) {
      const t = this.temp[i];
      t.t += dt;
      if (t.kind === 'fall') {
        t.mesh.rotation.z = t.dir * Math.min(Math.PI / 2, t.t * t.t * 3);
        if (t.t > 1.0) {
          this.burst(t.mesh.position.x + t.dir * 2, t.mesh.position.z, SEASON[this.season].leaf[1], 26, { up: 2.5, g: 3, life: 1.2, size: 1.4 });
          this.scene.remove(t.mesh);
          t.mesh.geometry.dispose();
          this.temp.splice(i, 1);
        }
      }
    }
    // ---- 粒子 ----
    const P = this.particles;
    const m = new THREE.Matrix4();
    let n = 0;
    for (let i = P.length - 1; i >= 0; i--) {
      const p = P[i];
      p.t += dt;
      if (p.t >= p.life) {
        P.splice(i, 1);
        continue;
      }
      p.vy -= p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      const floor = this.heightAt(p.x, p.z) + 0.03;
      if (p.y < floor) {
        p.y = floor;
        p.vy *= -0.3;
        p.vx *= 0.6;
        p.vz *= 0.6;
      }
      const s = p.s * (1 - (p.t / p.life) ** 2);
      m.compose(_p.set(p.x, p.y, p.z), _q.identity(), _s.set(s, s, s));
      this.parts.setMatrixAt(n, m);
      this.parts.setColorAt(n, p.c);
      n++;
    }
    this.parts.count = n;
    this.parts.instanceMatrix.needsUpdate = true;
    if (this.parts.instanceColor) this.parts.instanceColor.needsUpdate = true;
    // 烟囱的炊烟
    this.smokeT = (this.smokeT || 0) - dt;
    if (this.smokeT <= 0 && this.chimney) {
      this.smokeT = 0.35;
      this.particles.push({ x: this.chimney.x, y: this.chimney.y, z: this.chimney.z, vx: 0.3 * wind, vy: 0.6, vz: -0.05, life: 3.2, t: 0, s: 2.6, c: new THREE.Color(L.night > 0.5 ? '#8a90a8' : '#f2f0ea'), g: -0.05 });
    }
    // 营火的火苗
    for (const [x, z] of this.campfires) {
      if (Math.random() < dt * 14) this.particles.push({ x: x + (Math.random() - 0.5) * 0.2, y: this.heightAt(x, z) + 0.15, z: z + (Math.random() - 0.5) * 0.2, vx: 0, vy: 1.1, vz: 0, life: 0.6, t: 0, s: 2.2, c: new THREE.Color(Math.random() < 0.5 ? '#ffb040' : '#ff7030'), g: -0.4 });
    }
    // 被砍时轻轻摇晃（通过粒子表现已足够，这里只做计时）
    if (this.shakes) this.shakes = this.shakes.filter((s) => (s.t -= dt) > 0);
    this.renderer.render(this.scene, this.camera);
  }

  updateWeather(dt, tgt, night, now) {
    const wx = this.weather;
    this.rain.visible = wx === 'rain';
    this.snow.visible = wx === 'snow';
    if (wx === 'rain') {
      const a = this.rain.geometry.attributes.position.array;
      for (let i = 0; i < a.length; i += 6) {
        a[i + 1] -= dt * 18;
        a[i + 4] -= dt * 18;
        a[i] += dt * 2;
        a[i + 3] += dt * 2;
        if (a[i + 4] < -1) {
          const x = (Math.random() - 0.5) * 50;
          const z = (Math.random() - 0.5) * 40;
          a.set([x, 20, z, x + 0.12, 19.3, z + 0.05], i);
        }
      }
      this.rain.geometry.attributes.position.needsUpdate = true;
      this.rain.position.set(tgt.x, 0, tgt.z);
    }
    if (wx === 'snow') this.drift(this.snow, dt, tgt, -1.2, 0.6, 14);
    // 春天的花瓣、秋天的落叶随风飘
    const showPetal = wx === 'sun' && night < 0.5 && (this.season === 'spring' || this.season === 'autumn');
    this.petals.visible = showPetal;
    if (showPetal) {
      this.petals.material.color.set(this.season === 'spring' ? '#f8c4d4' : '#f0a040');
      this.drift(this.petals, dt, tgt, -0.6, 2.2, 10);
    }
    // 夏夜的萤火虫
    const showFlies = night > 0.5 && this.season === 'summer' && wx === 'sun';
    this.flies.visible = showFlies;
    if (showFlies) {
      const a = this.flies.geometry.attributes.position.array;
      for (let i = 0; i < a.length; i += 3) {
        a[i] += Math.sin(now * 0.7 + i) * dt * 0.5;
        a[i + 1] = 0.4 + (Math.sin(now * 0.5 + i * 1.3) + 1) * 0.8;
        a[i + 2] += Math.cos(now * 0.6 + i * 0.7) * dt * 0.5;
      }
      this.flies.geometry.attributes.position.needsUpdate = true;
      this.flies.position.set(tgt.x, this.heightAt(tgt.x, tgt.z), tgt.z);
      this.flies.material.opacity = 0.6 + Math.sin(now * 3) * 0.3;
    }
  }

  drift(pts, dt, tgt, vy, vx, top) {
    const a = pts.geometry.attributes.position.array;
    const t = performance.now() / 1000;
    for (let i = 0; i < a.length; i += 3) {
      a[i] += (vx + Math.sin(t + i) * 0.4) * dt;
      a[i + 1] += vy * dt;
      a[i + 2] += Math.cos(t * 0.7 + i) * 0.3 * dt;
      if (a[i + 1] < 0) {
        a[i] = (Math.random() - 0.5) * 50;
        a[i + 1] = top;
        a[i + 2] = (Math.random() - 0.5) * 40;
      }
      if (a[i] > 25) a[i] -= 50;
    }
    pts.geometry.attributes.position.needsUpdate = true;
    pts.position.set(tgt.x, 0, tgt.z);
  }

  updateFishLine(e, now) {
    if (!e.fish || e.sleep) {
      if (e.line) e.line.visible = false;
      if (e.bobber) e.bobber.visible = false;
      return;
    }
    if (!e.line) {
      e.line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new V3(), new V3()]), new THREE.LineBasicMaterial({ color: '#f4f4f4', transparent: true, opacity: 0.8 }));
      e.line.frustumCulled = false;
      e.bobber = new THREE.Mesh(G.sph(0.09, 1), new THREE.MeshToonMaterial({ gradientMap, color: '#e84a3a' }));
      this.scene.add(e.line, e.bobber);
    }
    const [fx, fy, st] = e.fish;
    const bx = fx + 0.5;
    const bz = fy + 0.5;
    const bite = st === 'bite';
    const by = -0.08 + (bite ? -0.08 + Math.sin(now * 30) * 0.05 : Math.sin(now * 3) * 0.02);
    e.bobber.position.set(bx, by, bz);
    const rodTip = new V3(e.x + Math.sin(e.rot || 0) * 0.5, this.heightAt(e.x, e.y) + 2.0, e.y + Math.cos(e.rot || 0) * 0.5);
    const a = e.line.geometry.attributes.position.array;
    a.set([rodTip.x, rodTip.y, rodTip.z, bx, by + 0.05, bz]);
    e.line.geometry.attributes.position.needsUpdate = true;
    e.line.visible = e.bobber.visible = true;
  }
}

// ======================= 角色模型 =======================
function hashStr(s) {
  let h = 0;
  for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h);
}
function angLerp(a, b, t) {
  let d = ((b - a + Math.PI) % TAU) - Math.PI;
  if (d < -Math.PI) d += TAU;
  return a + d * t;
}

const HAIRS = ['#4a3020', '#2a2220', '#8a4a2a', '#c89a4a', '#5a3a2a', '#3a2a3a'];
const SKIN = '#f6d7b8';

function textSprite(text, px = 40, h = 0.42, bg = null) {
  const cv = document.createElement('canvas');
  const c = cv.getContext('2d');
  c.font = `600 ${px}px system-ui, -apple-system, 'PingFang SC', sans-serif`;
  const w = Math.ceil(c.measureText(text).width) + px * 0.8;
  cv.width = w;
  cv.height = Math.ceil(px * 1.5);
  c.font = `600 ${px}px system-ui, -apple-system, 'PingFang SC', sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  if (bg) {
    c.fillStyle = bg;
    c.beginPath();
    c.roundRect(2, 2, w - 4, cv.height - 4, cv.height / 2);
    c.fill();
  }
  c.lineWidth = px * 0.16;
  c.strokeStyle = 'rgba(30,40,30,.75)';
  c.strokeText(text, w / 2, cv.height / 2 + 1);
  c.fillStyle = '#ffffff';
  c.fillText(text, w / 2, cv.height / 2 + 1);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, fog: false }));
  sp.scale.set((h * w) / cv.height, h, 1);
  sp.renderOrder = 5;
  return sp;
}

const TOOL_GEO = {};
function toolGeo(id) {
  if (TOOL_GEO[id]) return TOOL_GEO[id];
  const wood = '#8a5a34';
  const metal = '#a8b4b6';
  let g = null;
  const handle = [G.cyl(0.025, 0.03, 0.7, 5), wood, { p: [0, -0.35, 0] }];
  if (id === 'hoe') g = bake([handle, [G.box(0.22, 0.05, 0.12), metal, { p: [0, -0.72, 0.06] }]]);
  else if (id === 'axe') g = bake([handle, [G.box(0.05, 0.2, 0.22), metal, { p: [0, -0.62, 0.1] }]]);
  else if (id === 'pick') g = bake([handle, [G.box(0.05, 0.06, 0.5), metal, { p: [0, -0.7, 0], r: [0.25, 0, 0] }]]);
  else if (id === 'scythe') g = bake([handle, [G.box(0.04, 0.05, 0.42), '#c8d4d6', { p: [0, -0.72, 0.2], r: [-0.3, 0, 0] }]]);
  else if (id === 'can') g = bake([[G.cyl(0.13, 0.15, 0.24, 8), '#6aa0b8', { p: [0, -0.18, 0.08] }], [G.cyl(0.02, 0.03, 0.26, 5), '#6aa0b8', { p: [0, -0.16, 0.28], r: [1.1, 0, 0] }]]);
  else if (id === 'rod') g = bake([[G.cyl(0.015, 0.03, 1.5, 5), '#a07a4a', { p: [0, -0.6, 0.3], r: [-0.5, 0, 0] }]]);
  else g = bake([[G.box(0.2, 0.2, 0.2), '#e8c870', { p: [0, -0.15, 0.05] }]]);
  TOOL_GEO[id] = g;
  return g;
}

export function makeCharacter({ color, hair, hat, name }) {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const mat = (c) => new THREE.MeshToonMaterial({ gradientMap, color: c });
  const tunic = mat(color);
  const shadowed = (m) => {
    m.castShadow = true;
    return m;
  };
  const legL = shadowed(new THREE.Mesh(G.cyl(0.07, 0.07, 0.38, 6), mat('#5a4a40')));
  const legR = legL.clone();
  legL.geometry = legL.geometry.clone();
  legL.geometry.translate(0, -0.19, 0);
  legR.geometry = legL.geometry;
  legL.position.set(-0.1, 0.4, 0);
  legR.position.set(0.1, 0.4, 0);
  const torso = shadowed(new THREE.Mesh(G.cyl(0.2, 0.26, 0.55, 10), tunic));
  torso.position.y = 0.66;
  const belt = new THREE.Mesh(G.cyl(0.235, 0.24, 0.06, 10), mat('#8a6a4a'));
  belt.position.y = 0.5;
  const head = shadowed(new THREE.Mesh(G.ball(0.27, 14, 10), mat(SKIN)));
  head.position.y = 1.18;
  const hairM = mat(HAIRS[hair % HAIRS.length]);
  const hairCap = new THREE.Mesh(new THREE.SphereGeometry(0.29, 14, 10, 0, TAU, 0, Math.PI * 0.55), hairM);
  hairCap.position.y = 1.2;
  hairCap.rotation.x = -0.25;
  const eyeM = mat('#2a2020');
  const eyeL = new THREE.Mesh(G.ball(0.035, 6, 5), eyeM);
  eyeL.position.set(-0.1, 1.18, 0.24);
  const eyeR = eyeL.clone();
  eyeR.position.x = 0.1;
  const blush = new THREE.MeshBasicMaterial({ color: '#f4a6a0', transparent: true, opacity: 0.6 });
  const chL = new THREE.Mesh(G.ball(0.04, 6, 4), blush);
  chL.position.set(-0.16, 1.1, 0.22);
  chL.scale.set(1, 0.6, 0.4);
  const chR = chL.clone();
  chR.position.x = 0.16;
  const armGeo = G.cyl(0.055, 0.06, 0.4, 6);
  armGeo.translate(0, -0.2, 0);
  const armL = shadowed(new THREE.Mesh(armGeo, tunic));
  armL.position.set(-0.27, 0.88, 0);
  const armR = shadowed(new THREE.Mesh(armGeo, tunic));
  armR.position.set(0.27, 0.88, 0);
  const hand = new THREE.Group();
  hand.position.y = -0.4;
  armR.add(hand);
  body.add(legL, legR, torso, belt, head, hairCap, eyeL, eyeR, chL, chR, armL, armR);
  if (hat) {
    const straw = mat('#e8c870');
    const brim = new THREE.Mesh(G.cyl(0.46, 0.48, 0.04, 16), straw);
    brim.position.y = 1.34;
    const crown = new THREE.Mesh(G.cyl(0.22, 0.26, 0.2, 14), straw);
    crown.position.y = 1.45;
    const band = new THREE.Mesh(G.cyl(0.265, 0.265, 0.05, 14), mat(color));
    band.position.y = 1.38;
    body.add(brim, crown, band);
  }
  const label = name ? textSprite(name) : null;
  if (label) {
    label.position.y = 2.05;
    group.add(label);
  }
  const ch = {
    group,
    body,
    legL,
    legR,
    armL,
    armR,
    hand,
    tool: null,
    toolId: null,
    t: 0,
    swingT: 0,
    color,
    name,
    label,
    setColor(c) {
      tunic.color.set(c);
    },
    setName(n) {
      if (ch.label) group.remove(ch.label);
      ch.label = textSprite(n);
      ch.label.position.y = 2.05;
      group.add(ch.label);
    },
  };
  return ch;
}

const HOLDABLE = new Set(['hoe', 'can', 'axe', 'pick', 'scythe', 'rod']);
function animateCharacter(e, dt, { moving, idle }) {
  e.t += dt * (moving ? 9 : 0);
  const sw = Math.sin(e.t);
  e.legL.rotation.x = moving ? sw * 0.6 : 0;
  e.legR.rotation.x = moving ? -sw * 0.6 : 0;
  e.body.position.y = moving ? Math.abs(Math.cos(e.t)) * 0.06 : Math.sin(idle * 2) * 0.012;
  e.armL.rotation.x = moving ? -sw * 0.5 : 0;
  // 手里的工具
  const held = HOLDABLE.has(e.held) ? e.held : null;
  if (held !== e.toolId) {
    if (e.tool) e.hand.remove(e.tool);
    e.tool = held ? new THREE.Mesh(toolGeo(held), toon({ vertexColors: true })) : null;
    if (e.tool) {
      e.tool.castShadow = true;
      e.hand.add(e.tool);
      e.tool.rotation.x = -Math.PI / 2;
      e.tool.position.z = 0.05;
    }
    e.toolId = held;
  }
  if (e.swingT > 0) {
    e.swingT += dt;
    const k = e.swingT / 0.32;
    // 举起再挥下
    e.armR.rotation.x = k < 0.4 ? -2.6 * (k / 0.4) : -2.6 + 3.2 * Math.min(1, (k - 0.4) / 0.35);
    if (k >= 1) {
      e.swingT = 0;
      e.armR.rotation.x = 0;
    }
  } else {
    e.armR.rotation.x = moving ? sw * 0.5 : held === 'rod' && e.fish ? -0.9 : held ? -0.35 : 0;
  }
}

// ======================= 动物模型 =======================
function makeAnimal(kind) {
  const group = new THREE.Group();
  const parts = [];
  let iconY = 1;
  if (kind === 'chicken') {
    parts.push([G.ball(0.22, 10, 8), '#fbf7ee', { p: [0, 0.3, 0], s: [0.9, 0.85, 1.15] }]);
    parts.push([G.ball(0.13, 10, 8), '#fbf7ee', { p: [0, 0.52, 0.16] }]);
    parts.push([G.cone(0.05, 0.1, 5), '#f0b040', { p: [0, 0.5, 0.31], r: [Math.PI / 2, 0, 0] }]);
    parts.push([G.sph(0.05, 0), '#e04a3a', { p: [0, 0.66, 0.15], s: [0.6, 1, 1.2] }]);
    parts.push([G.ball(0.025, 5, 4), '#2a2020', { p: [-0.08, 0.55, 0.25] }]);
    parts.push([G.ball(0.025, 5, 4), '#2a2020', { p: [0.08, 0.55, 0.25] }]);
    parts.push([G.sph(0.1, 0), '#efe9dc', { p: [0, 0.38, -0.2], s: [0.8, 1.2, 0.8] }]);
    parts.push([G.cyl(0.015, 0.015, 0.14, 4), '#e8a030', { p: [-0.07, 0.07, 0] }]);
    parts.push([G.cyl(0.015, 0.015, 0.14, 4), '#e8a030', { p: [0.07, 0.07, 0] }]);
    iconY = 1.0;
  } else if (kind === 'cow') {
    parts.push([G.ball(0.4, 12, 10), '#f6f1e6', { p: [0, 0.68, 0], s: [0.85, 0.75, 1.4] }]);
    parts.push([G.sph(0.18, 1), '#6a4a3a', { p: [0.22, 0.8, 0.1], s: [0.5, 1, 1.2] }]);
    parts.push([G.sph(0.15, 1), '#6a4a3a', { p: [-0.25, 0.7, -0.25], s: [0.5, 1, 1.1] }]);
    parts.push([G.ball(0.22, 10, 8), '#f6f1e6', { p: [0, 0.9, 0.62] }]);
    parts.push([G.ball(0.15, 10, 8), '#f2c4b8', { p: [0, 0.82, 0.8], s: [1.1, 0.8, 0.8] }]);
    parts.push([G.cone(0.04, 0.16, 5), '#efe4c8', { p: [-0.12, 1.12, 0.6], r: [0, 0, 0.4] }]);
    parts.push([G.cone(0.04, 0.16, 5), '#efe4c8', { p: [0.12, 1.12, 0.6], r: [0, 0, -0.4] }]);
    parts.push([G.ball(0.03, 5, 4), '#2a2020', { p: [-0.1, 0.96, 0.8] }]);
    parts.push([G.ball(0.03, 5, 4), '#2a2020', { p: [0.1, 0.96, 0.8] }]);
    for (const [x, z] of [[-0.2, 0.35], [0.2, 0.35], [-0.2, -0.35], [0.2, -0.35]]) parts.push([G.cyl(0.07, 0.07, 0.42, 6), '#efe8dc', { p: [x, 0.21, z] }]);
    iconY = 1.6;
  } else {
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * TAU;
      parts.push([G.sph(0.2, 1), '#efe6d0', { p: [Math.cos(a) * 0.22, 0.62 + Math.sin(a * 2) * 0.05, Math.sin(a) * 0.32] }]);
    }
    parts.push([G.ball(0.34, 10, 8), '#f8f2e2', { p: [0, 0.68, 0], s: [0.9, 0.85, 1.2] }]);
    parts.push([G.ball(0.15, 10, 8), '#3a3030', { p: [0, 0.78, 0.45], s: [0.9, 1, 1.1] }]);
    parts.push([G.sph(0.11, 1), '#f8f2e2', { p: [0, 0.92, 0.42] }]);
    parts.push([G.ball(0.025, 5, 4), '#ffffff', { p: [-0.07, 0.8, 0.57] }]);
    parts.push([G.ball(0.025, 5, 4), '#ffffff', { p: [0.07, 0.8, 0.57] }]);
    for (const [x, z] of [[-0.15, 0.25], [0.15, 0.25], [-0.15, -0.25], [0.15, -0.25]]) parts.push([G.cyl(0.05, 0.05, 0.4, 6), '#3a3030', { p: [x, 0.2, z] }]);
    iconY = 1.4;
  }
  const body = new THREE.Mesh(bake(parts), toon({ vertexColors: true }));
  body.castShadow = true;
  group.add(body);
  const icon = textSprite({ chicken: '🥚', cow: '🥛', sheep: '🧶' }[kind], 56, 0.55, 'rgba(255,250,235,.92)');
  icon.position.y = iconY;
  icon.visible = false;
  group.add(icon);
  return { group, body, icon, iconY, x: 0, y: 0, tx: 0, ty: 0 };
}
