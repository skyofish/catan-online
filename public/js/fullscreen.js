// 平台共享：全屏游玩（像手机上全屏看视频一样）。
// - 页面上所有 [data-fullscreen] 按钮都会变成「全屏 / 退出全屏」开关。
// - 浏览器在换页面时会自动退出全屏；记住玩家的选择，到了下一个页面点一下屏幕就自动回到全屏。
// - iPhone 的 Safari 不支持网页全屏：提示「添加到主屏幕」，从桌面图标打开就是全屏（见 /manifest.webmanifest）。
const KEY = 'platform.fullscreen';

const doc = document;
const root = doc.documentElement;
const supported = !!(doc.fullscreenEnabled || doc.webkitFullscreenEnabled || root.requestFullscreen || root.webkitRequestFullscreen);
const isIOS = /iP(hone|od|ad)/.test(navigator.platform || '') || (/Mac/.test(navigator.platform || '') && navigator.maxTouchPoints > 1);
// 已经是从桌面图标打开的全屏应用
const standalone = () => matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || navigator.standalone === true;

export const isFullscreen = () => !!(doc.fullscreenElement || doc.webkitFullscreenElement);

function remember(on) {
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {}
}
function wanted() {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export async function enterFullscreen() {
  try {
    if (root.requestFullscreen) await root.requestFullscreen({ navigationUI: 'hide' });
    else if (root.webkitRequestFullscreen) root.webkitRequestFullscreen();
    remember(true);
    return true;
  } catch {
    return false;
  }
}

export async function exitFullscreen() {
  remember(false);
  try {
    if (doc.exitFullscreen) await doc.exitFullscreen();
    else if (doc.webkitExitFullscreen) doc.webkitExitFullscreen();
  } catch {}
}

export function toggleFullscreen() {
  if (isFullscreen()) return exitFullscreen();
  if (!supported) return showIOSTip();
  return enterFullscreen();
}

// iPhone：教玩家添加到主屏幕
function showIOSTip() {
  if (doc.getElementById('fs-tip')) return;
  const el = doc.createElement('div');
  el.id = 'fs-tip';
  el.className = 'fs-tip';
  el.innerHTML = `<div class="fs-tip-card" role="dialog" aria-label="全屏游玩">
      <b>全屏游玩</b>
      <p>${isIOS ? 'iPhone 上的 Safari 不支持网页全屏。' : '这个浏览器不支持网页全屏。'}可以把游戏厅加到主屏幕，从桌面图标打开就是全屏：</p>
      <ol>${isIOS ? '<li>点 Safari 底部的「分享」按钮 <span aria-hidden="true">⬆︎</span></li><li>选「添加到主屏幕」</li>' : '<li>打开浏览器菜单</li><li>选「添加到主屏幕」或「安装应用」</li>'}<li>以后从桌面图标打开</li></ol>
      <button type="button">知道了</button>
    </div>`;
  el.addEventListener('click', (e) => {
    if (e.target === el || e.target.tagName === 'BUTTON') el.remove();
  });
  doc.body.appendChild(el);
}

function render() {
  const on = isFullscreen();
  for (const b of doc.querySelectorAll('[data-fullscreen]')) {
    // 已经是桌面图标打开的全屏应用：不需要这个按钮
    b.hidden = standalone() && !on;
    b.classList.toggle('fs-on', on);
    b.setAttribute('aria-label', on ? '退出全屏' : '全屏');
    b.title = on ? '退出全屏' : '全屏游玩';
    b.innerHTML = on
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
}

let inited = false;
export function initFullscreen() {
  if (inited) return;
  inited = true;
  const style = doc.createElement('style');
  style.textContent = `
    [data-fullscreen] svg { width: 18px; height: 18px; display: block; margin: auto; }
    .fs-tip { position: fixed; inset: 0; z-index: 9999; background: rgba(0,0,0,.6); display: grid; place-items: center; padding: 16px; }
    .fs-tip-card { width: min(360px, 100%); background: #1c1a1f; color: #eee; border: 1px solid #444; border-radius: 10px; padding: 16px 18px; font: 14px/1.6 system-ui, -apple-system, 'PingFang SC', sans-serif; }
    .fs-tip-card b { font-size: 17px; }
    .fs-tip-card ol { padding-left: 20px; margin: 8px 0 12px; }
    .fs-tip-card button { float: right; padding: 7px 16px; border-radius: 6px; border: 1px solid #666; background: #2c2a30; color: #eee; font: inherit; cursor: pointer; }`;
  doc.head.appendChild(style);
  doc.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-fullscreen]');
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    toggleFullscreen();
  });
  // 换页面时浏览器会退出全屏，这不算玩家主动退出
  let leaving = false;
  window.addEventListener('pagehide', () => (leaving = true));
  window.addEventListener('beforeunload', () => (leaving = true));
  const onChange = () => {
    // 按 Esc / 系统返回键退出全屏：记下来，换页面后不再自动进入
    if (!isFullscreen() && !leaving) remember(false);
    render();
    // 让画布等按新尺寸重新布局
    setTimeout(() => window.dispatchEvent(new Event('resize')), 60);
  };
  doc.addEventListener('fullscreenchange', onChange);
  doc.addEventListener('webkitfullscreenchange', onChange);
  // 上一个页面是全屏：第一次点屏幕时恢复（浏览器要求必须由点击触发）
  if (supported && wanted() && !isFullscreen()) {
    const resume = (e) => {
      // 点的就是全屏按钮：交给按钮自己处理
      if (e.target.closest && e.target.closest('[data-fullscreen]')) return;
      if (wanted() && !isFullscreen()) enterFullscreen();
    };
    doc.addEventListener('pointerup', resume, { once: true, capture: true });
  }
  render();
}
