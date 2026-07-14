'use strict';
// ===== 登录 / 注册页 =====
const $ = (s) => document.querySelector(s);
function $$(s, r) { return [...(r || document).querySelectorAll(s)]; }

function setErr(errId, inputId, msg) {
  const e = $('#' + errId); if (e) e.textContent = msg || '';
  const inp = $('#' + inputId); if (inp) inp.classList.toggle('input-bad', !!msg);
}
function validateEmail() {
  const v = $('#email').value.trim();
  if (!v) { setErr('emailErr', 'email', ''); return false; }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { setErr('emailErr', 'email', '邮箱格式不正确'); return false; }
  setErr('emailErr', 'email', ''); return true;
}
function validatePassword() {
  const v = $('#password').value;
  if (!v) { setErr('pwErr', 'password', ''); return true; } // 空时不实时报错
  if (v.length < 6) { setErr('pwErr', 'password', '密码至少 6 位'); return false; }
  setErr('pwErr', 'password', ''); return true;
}
$('#email').addEventListener('input', validateEmail);
$('#email').addEventListener('blur', validateEmail);
$('#password').addEventListener('input', validatePassword);

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2400);
}
async function api(path, body, authToken) {
  const headers = { 'content-type': 'application/json' };
  if (authToken) headers['authorization'] = 'Bearer ' + authToken;
  const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || '请求失败'), { status: res.status, data });
  return data;
}
function nextUrl() {
  return new URLSearchParams(location.search).get('next') || '/account.html';
}
function loginSuccess(token, user) {
  localStorage.setItem('kta_token', token);
  localStorage.setItem('kta_user', JSON.stringify(user));
  toast('登录成功');
  setTimeout(() => (location.href = nextUrl()), 600);
}

// 模式切换（登录 / 注册）
let mode = 'login';
$('#authSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  mode = b.dataset.mode;
  $$('.seg button', $('#authSeg')).forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  $('#codeField').hidden = mode !== 'register';
  $('#emailSubmit').textContent = mode === 'login' ? '登录' : '注册并登录';
  $('#sendCodeBtn').disabled = false;
  $('#sendCodeBtn').textContent = '发送验证码';
});

// 发送邮箱验证码
let sending = false;
let codeTimer = null;
$('#sendCodeBtn').addEventListener('click', async () => {
  if (sending) return;
  const email = $('#email').value.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast('请先填写正确的邮箱'); return; }
  sending = true;
  const btn = $('#sendCodeBtn'); btn.disabled = true;
  try {
    const r = await api('/api/auth/send-code', { email, purpose: 'register' });
    if (r.devCode) {
      toast('验证码已生成：' + r.devCode + '（本地演示）');
    } else if (r.sent) {
      toast('验证码已发送到 ' + email);
    } else {
      toast('验证码已发送，请查收邮箱');
    }
    // 60 秒倒计时
    let left = 60;
    btn.textContent = left + 's 后重发';
    codeTimer = setInterval(() => {
      left -= 1;
      if (left <= 0) { clearInterval(codeTimer); btn.textContent = '重新发送'; btn.disabled = false; sending = false; }
      else btn.textContent = left + 's 后重发';
    }, 1000);
  } catch (err) {
    toast(err.message || '发送失败');
    btn.disabled = false; sending = false;
  }
});

// 邮箱登录 / 注册
$('#emailForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#email').value.trim();
  const password = $('#password').value;
  const btn = $('#emailSubmit');
  btn.disabled = true;
  if (!validateEmail()) { btn.disabled = false; return; }
  if (!password) { setErr('pwErr', 'password', '请输入密码'); btn.disabled = false; return; }
  if (password.length < 6) { setErr('pwErr', 'password', '密码至少 6 位'); btn.disabled = false; return; }
  try {
    if (mode === 'login') {
      const r = await api('/api/auth/login', { email, password });
      loginSuccess(r.token, r.user);
    } else {
      const code = $('#code').value.trim();
      if (!/^\d{6}$/.test(code)) { toast('请输入 6 位验证码'); btn.disabled = false; return; }
      const r = await api('/api/auth/register', { email, password, code, purpose: 'register' });
      loginSuccess(r.token, r.user);
    }
  } catch (err) {
    toast(err.message || '操作失败');
    btn.disabled = false;
  }
});

// ---------- 微信扫码登录 ----------
const wxMask = $('#wxMask');
$('#wxClose').addEventListener('click', () => { wxMask.hidden = true; });
wxMask.addEventListener('click', (e) => { if (e.target === wxMask) wxMask.hidden = true; });

window.addEventListener('message', (e) => {
  const d = e.data;
  if (d && d.type === 'wechat-login' && d.token) {
    // 用 token 拉取用户信息
    fetch('/api/auth/me', { headers: { authorization: 'Bearer ' + d.token } })
      .then((r) => r.json())
      .then((data) => {
        if (data.user) loginSuccess(d.token, data.user);
        else toast('微信登录失败');
      })
      .catch(() => toast('微信登录失败'));
  }
});

$('#wechatBtn').addEventListener('click', async () => {
  const btn = $('#wechatBtn');
  btn.disabled = true; btn.textContent = '正在唤起微信…';
  try {
    const r = await fetch('/api/auth/wechat/qrcode').then((x) => x.json());
    if (r.real) {
      // 真实模式：打开微信授权页（用户扫码授权后回调本服务）
      const popup = window.open(r.url, 'wechat_login', 'width=420,height=560');
      if (!popup) toast('请允许弹出窗口以完成微信扫码');
    } else {
      // 演示模式：弹层模拟扫码
      wxMask.hidden = false;
    }
  } catch (err) {
    toast(err.message || '微信登录失败');
  } finally {
    btn.disabled = false; btn.innerHTML = '<span class="wx-ico">💬</span> 微信扫码登录';
  }
});

// 演示模式：模拟扫码 → demo 登录
$('#wxSimBtn').addEventListener('click', async () => {
  const btn = $('#wxSimBtn');
  btn.disabled = true; btn.textContent = '登录中…';
  try {
    const code = 'demo_' + Math.random().toString(36).slice(2, 10);
    const r = await api('/api/auth/wechat', { code });
    wxMask.hidden = true;
    loginSuccess(r.token, r.user);
  } catch (err) {
    toast(err.message || '微信登录失败');
    btn.disabled = false; btn.textContent = '模拟扫码';
  }
});
