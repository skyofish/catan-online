// 平台共享：登录状态、接口请求、HTTPS 自动跳转。平台大厅与各游戏页面共用。
// 登录令牌沿用 catan.session 这个键名，升级平台后玩家无需重新登录。
const KEY = 'catan.session';

export function getSession() {
  try {
    return JSON.parse(localStorage.getItem(KEY));
  } catch {
    return null;
  }
}

export function setSession(token) {
  try {
    if (token) localStorage.setItem(KEY, JSON.stringify(token));
    else localStorage.removeItem(KEY);
  } catch {}
}

// 从 HTTP 自动跳转到 HTTPS 时，登录状态通过网址片段（#s=…，不会发给服务器）带过来
export function takeHashSession() {
  const m = location.hash.match(/^#s=([^&]+)/);
  if (!m) return;
  setSession(decodeURIComponent(m[1]));
  history.replaceState(null, '', location.pathname + location.search);
}

export async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const s = getSession();
  if (s) headers.Authorization = 'Bearer ' + s;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || '请求失败，请稍后再试');
    e.status = res.status;
    throw e;
  }
  return data;
}

// 用 http:// 打开时，若同一地址的 HTTPS 已可用（证书有效），自动切换过去（麦克风需要 HTTPS）
export function upgradeToHttps() {
  if (location.protocol !== 'http:' || /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 5000);
  fetch(`https://${location.hostname}/health`, { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal })
    .then(() => {
      const s = getSession();
      const hash = s ? '#s=' + encodeURIComponent(s) : '';
      location.replace(`https://${location.hostname}${location.pathname}${location.search}${hash}`);
    })
    .catch(() => {});
}

// 回到平台登录页；登录后再回到 next 指定的页面。reason 会显示在登录页上
export function goToLogin(reason) {
  setSession(null);
  if (reason) {
    try {
      sessionStorage.setItem('hub.notice', reason);
    } catch {}
  }
  const next = location.pathname + location.search;
  location.replace('/?next=' + encodeURIComponent(next));
}

// 只允许站内相对路径，防止跳转到其他网站
export function safeNext(next) {
  return typeof next === 'string' && /^\/(?!\/)[^\s]*$/.test(next) ? next : null;
}

export function wsUrl(path) {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`;
}
