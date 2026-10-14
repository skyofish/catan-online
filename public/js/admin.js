// 管理员页面：登录、添加 / 启用 / 禁用 / 删除玩家账号。
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const KEY = 'catan.admin';
let token = null;
try {
  token = sessionStorage.getItem(KEY);
} catch {}
let users = [];
let timer = null;

function setToken(t) {
  token = t;
  try {
    if (t) sessionStorage.setItem(KEY, t);
    else sessionStorage.removeItem(KEY);
  } catch {}
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/admin/login') {
      setToken(null);
      show('login');
    }
    throw new Error(data.error || '请求失败');
  }
  return data;
}

function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  $('#toast-root').appendChild(t);
  setTimeout(() => t.classList.add('out'), 2600);
  setTimeout(() => t.remove(), 3100);
}

function show(which) {
  $('#admin-login').hidden = which !== 'login';
  $('#admin-main').hidden = which !== 'main';
  clearInterval(timer);
  if (which === 'main') {
    load();
    timer = setInterval(load, 10000);
  } else setTimeout(() => $('#a-user').focus(), 30);
}

const fmt = (t) => {
  if (!t) return '—';
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

async function load() {
  try {
    let aiStats;
    ({ users, ai: aiStats } = await api('/api/admin/users'));
    renderAi(aiStats);
    render();
  } catch (e) {
    if (token) toast(e.message, 'error');
  }
}

function renderAi(a) {
  const el = $('#ai-stats');
  if (!el || !a) return;
  if (!a.enabled) {
    el.textContent = 'AI 玩家：未配置智谱 API Key';
    return;
  }
  const total = a.promptTokens + a.completionTokens;
  const err = a.lastError ? `，最近一次错误：${a.lastError}（${fmt(a.lastErrorAt)}）` : '';
  el.textContent = `AI 玩家：${a.model}${a.thinking ? '（深度思考）' : ''}，本次启动以来调用 ${a.calls} 次，失败 ${a.errors} 次，消耗 ${total.toLocaleString()} tokens（缓存命中 ${a.cachedTokens.toLocaleString()}）${err}`;
}

function render() {
  const enabled = users.filter((u) => u.enabled).length;
  const online = users.filter((u) => u.online).length;
  $('#counts').innerHTML = `共<b>${users.length}</b>个账号，启用<b>${enabled}</b>个，在线<b>${online}</b>人`;
  const q = $('#filter').value.trim().toLowerCase();
  const list = q ? users.filter((u) => u.username.toLowerCase().includes(q)) : users;
  const tbody = $('#users');
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="users-empty">${users.length ? '没有匹配的账号' : '还没有账号。在上面添加第一个吧。'}</td></tr>`;
    return;
  }
  tbody.innerHTML = list
    .map(
      (u) => `<tr class="${u.enabled ? '' : 'disabled'}" data-id="${u.id}">
      <td class="uname">${esc(u.username)}</td>
      <td class="state"><span class="pill ${u.enabled ? 'on' : 'off'}">${u.enabled ? '启用' : '已禁用'}</span></td>
      <td class="meta online" data-label="在线">${u.online ? '<span class="online-dot"></span>在线' : '<span class="muted">—</span>'}</td>
      <td class="meta" data-label="对局">${u.games}</td>
      <td class="meta" data-label="胜场">${u.wins}</td>
      <td class="meta" data-label="最后登录">${fmt(u.last_login_at)}</td>
      <td class="meta" data-label="创建">${fmt(u.created_at)}</td>
      <td class="ops">
        <button class="mini" data-toggle="${u.id}">${u.enabled ? '禁用' : '启用'}</button>
        <button class="mini danger" data-del="${u.id}">删除</button>
      </td></tr>`
    )
    .join('');
}

$('#users').addEventListener('click', async (e) => {
  const tg = e.target.closest('[data-toggle]');
  const del = e.target.closest('[data-del]');
  if (tg) {
    const u = users.find((x) => x.id === Number(tg.dataset.toggle));
    tg.disabled = true;
    try {
      await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { enabled: !u.enabled } });
      toast(u.enabled ? `已禁用 ${u.username}，对方已被强制下线` : `已启用 ${u.username}`, 'good');
      await load();
    } catch (err) {
      toast(err.message, 'error');
      tg.disabled = false;
    }
  } else if (del) {
    const u = users.find((x) => x.id === Number(del.dataset.del));
    // 两次点击确认，避免误删
    if (!del.classList.contains('confirm')) {
      del.classList.add('confirm');
      del.textContent = '确认删除';
      setTimeout(() => {
        if (del.isConnected) {
          del.classList.remove('confirm');
          del.textContent = '删除';
        }
      }, 3000);
      return;
    }
    del.disabled = true;
    try {
      await api(`/api/admin/users/${u.id}`, { method: 'DELETE' });
      toast(`已删除 ${u.username}，历史战绩中保留其名字`, 'good');
      await load();
    } catch (err) {
      toast(err.message, 'error');
      del.disabled = false;
    }
  }
});

$('#add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const names = $('#add-names').value.trim();
  if (!names) return;
  const btn = $('#btn-add');
  btn.disabled = true;
  try {
    const r = await api('/api/admin/users', { method: 'POST', body: { usernames: names } });
    const parts = [];
    if (r.created.length) parts.push(`<p class="ok">已添加：${r.created.map(esc).join('、')}</p>`);
    if (r.errors.length) parts.push(`<p class="bad">${r.errors.map(esc).join('<br>')}</p>`);
    $('#add-result').innerHTML = parts.join('');
    if (r.created.length) $('#add-names').value = r.errors.map((x) => x.split('：')[0]).join(' ');
    await load();
  } catch (err) {
    $('#add-result').innerHTML = `<p class="bad">${esc(err.message)}</p>`;
  } finally {
    btn.disabled = false;
  }
});
$('#add-names').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#add-form').requestSubmit();
  }
});

$('#admin-login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#a-error');
  err.hidden = true;
  $('#a-submit').disabled = true;
  try {
    const r = await api('/api/admin/login', { method: 'POST', body: { username: $('#a-user').value.trim(), password: $('#a-pass').value } });
    setToken(r.token);
    $('#a-pass').value = '';
    show('main');
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    $('#a-submit').disabled = false;
  }
});

$('#btn-alogout').addEventListener('click', async () => {
  try {
    await api('/api/admin/logout', { method: 'POST' });
  } catch {}
  setToken(null);
  show('login');
});
$('#btn-reload').addEventListener('click', load);
$('#filter').addEventListener('input', render);

// 用 http:// 打开时，若 HTTPS 已可用则自动切换过去
if (location.protocol === 'http:' && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 5000);
  fetch(`https://${location.hostname}/health`, { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal })
    .then(() => location.replace(`https://${location.hostname}${location.pathname}${location.search}`))
    .catch(() => {});
}

show(token ? 'main' : 'login');
