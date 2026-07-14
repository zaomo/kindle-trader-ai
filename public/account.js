'use strict';
// ===== 账户 / 充值页 =====
const $ = (s) => document.querySelector(s);
const token = localStorage.getItem('kta_token');

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2200);
}
function authHeaders(extra = {}) {
  return token ? { 'content-type': 'application/json', Authorization: 'Bearer ' + token, ...extra } : { 'content-type': 'application/json', ...extra };
}
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: authHeaders(opts.headers) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { location.href = '/login.html?next=/account.html'; throw new Error('登录已失效'); }
  if (!res.ok) throw Object.assign(new Error(data.error || '请求失败'), { status: res.status, data });
  return data;
}

const METHOD_LABEL = { wechat: '微信充值', alipay: '支付宝充值', balance: '余额', membership: '开通会员' };

function fmtDate(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function load() {
  if (!token) { location.href = '/login.html?next=/account.html'; return; }
  try {
    const me = await api('/api/billing/me');
    render(me);
  } catch (e) { /* 跳转已在 api 内处理 */ }
}

function render(me) {
  $('#pName').textContent = me.nickname || me.email || '微信用户';
  $('#pMeta').textContent = me.email ? me.email : '微信账号登录';
  $('#balance').textContent = (me.balance || 0).toFixed(2);
  const badge = $('#mBadge');
  if (me.isPro) { badge.textContent = 'Pro 会员'; badge.classList.add('pro'); }
  else { badge.textContent = '免费版'; badge.classList.remove('pro'); }

  // 会员区域
  if (me.isPro && me.membership_expires_at) {
    $('#mExp').hidden = false;
    $('#mExp').textContent = '会员有效期至 ' + fmtDate(me.membership_expires_at) + '，已解锁无限次 AI 定价 / 文案。';
    $('#buyMember').textContent = '续费会员';
    $('#buyMemberBalance').textContent = '余额续费';
  } else {
    $('#mExp').hidden = true;
    $('#buyMember').textContent = '开通会员';
    $('#buyMemberBalance').textContent = '用余额开通';
  }

  // 充值记录
  const list = $('#rechargeList');
  if (!me.recharges.length) { list.innerHTML = '<p class="hint">暂无记录</p>'; return; }
  list.innerHTML = me.recharges.map((r) => {
    const plus = r.amount >= 0;
    return `
      <div class="recharge-row">
        <div class="rleft">${plus ? '充值' : '消费'}<div class="rmethod">${METHOD_LABEL[r.method] || r.method}${plus ? '' : ' · 扣款'}</div></div>
        <div>
          <div class="ramt ${plus ? 'plus' : 'minus'}">${plus ? '+' : ''}¥${r.amount.toFixed(2)}</div>
          <div class="rdate">${fmtDate(r.created_at)}</div>
        </div>
      </div>`;
  }).join('');
}

// 充值
$$('.chip-btn').forEach((b) => b.addEventListener('click', async () => {
  const amt = Number(b.dataset.amt);
  const old = b.textContent; b.disabled = true; b.textContent = '处理中…';
  try {
    const r = await api('/api/billing/recharge', { method: 'POST', body: JSON.stringify({ amount: amt, method: 'wechat' }) });
    toast('充值成功，余额 ¥' + r.balance.toFixed(2));
    load();
  } catch (e) { toast(e.message || '充值失败'); b.textContent = old; b.disabled = false; }
}));
function $$(s, r) { return [...(r || document).querySelectorAll(s)]; }

// ---- 主题切换（深色 / 浅色 / 跟随系统） ----
function applyTheme(mode) {
  if (mode === 'system' || !mode) {
    const dark = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  } else {
    document.documentElement.dataset.theme = mode;
  }
}
(function initTheme() {
  const saved = localStorage.getItem('kta_theme') || 'system';
  applyTheme(saved);
  const seg = $('#themeSeg');
  if (!seg) return;
  $$('button', seg).forEach((b) => {
    b.classList.toggle('active', b.dataset.theme === saved);
    b.addEventListener('click', () => {
      const mode = b.dataset.theme;
      localStorage.setItem('kta_theme', mode);
      applyTheme(mode);
      $$('button', seg).forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      toast('已切换为' + (mode === 'system' ? '跟随系统' : (mode === 'dark' ? '深色' : '浅色')));
    });
  });
  if (window.matchMedia) {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if ((localStorage.getItem('kta_theme') || 'system') === 'system') applyTheme('system');
    });
  }
})();

// 开通 / 续费会员
async function buy(payMethod) {
  try {
    const r = await api('/api/billing/membership', { method: 'POST', body: JSON.stringify({ payMethod }) });
    toast(payMethod === 'balance' ? '已用余额开通会员' : '会员开通成功');
    load();
  } catch (e) { toast(e.message || '开通失败'); }
}
$('#buyMember').addEventListener('click', () => buy('simulate'));
$('#buyMemberBalance').addEventListener('click', () => buy('balance'));

// 退出
$('#logoutBtn').addEventListener('click', async () => {
  try { await fetch('/api/auth/logout', { method: 'POST', headers: authHeaders() }); } catch {}
  localStorage.removeItem('kta_token');
  localStorage.removeItem('kta_user');
  location.href = '/login.html';
});

load();
