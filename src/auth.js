'use strict';
/**
 * 用户鉴权模块：邮箱（密码哈希 + 6 位邮箱验证码注册）+ 微信（OAuth2 扫码登录）/ 会话管理 / 会员判定。
 * 零依赖：仅用 Node 内置 crypto / https / timers。
 *
 * 微信扫码登录说明：
 *  - 配置 WECHAT_APPID + WECHAT_SECRET（+ 可选 WECHAT_REDIRECT_URI）时，走真实 OAuth2 扫码：
 *    前端打开 qrconnect 授权页 → 用户扫码授权 → 微信回调本服务用 code 换 openid/昵称 → 登录。
 *  - 未配置时进入「演示模式」：前端弹出的模拟二维码点击后走 demo 登录，便于本地零依赖体验完整流程。
 */
const crypto = require('crypto');
const https = require('https');
const { getDb } = require('./db');
const mailer = require('./mailer');

const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS) || 30 * 24 * 3600 * 1000; // 会话有效期（默认 30 天，可在 .env 配置）
const CODE_TTL_MS = 10 * 60 * 1000;           // 验证码 10 分钟有效

const WECHAT_APPID = process.env.WECHAT_APPID || '';
const WECHAT_SECRET = process.env.WECHAT_SECRET || '';
const WECHAT_REDIRECT_URI = process.env.WECHAT_REDIRECT_URI ||
  `http://localhost:${process.env.PORT || 3000}/api/auth/wechat/callback`;

function nowISO() { return new Date().toISOString(); }

// ---------- 密码哈希（scrypt） ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const h = crypto.scryptSync(pw, salt, 64).toString('hex');
  const a = Buffer.from(h, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function newToken() { return crypto.randomBytes(32).toString('hex'); }

function createSession(userId) {
  const token = newToken();
  const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  getDb().prepare(
    'INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)'
  ).run(token, userId, expires, nowISO());
  return token;
}

// ---------- 会话解析 ----------
function getUserByToken(token) {
  if (!token) return null;
  const s = getDb().prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!s) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) {
    getDb().prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
}

function resolveUser(req) {
  const auth = req.headers['authorization'];
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  return getUserByToken(token);
}

function isPro(user) {
  if (!user || user.membership !== 'pro') return false;
  if (user.membership_expires_at && new Date(user.membership_expires_at).getTime() < Date.now()) return false;
  return true;
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    nickname: u.nickname,
    hasPassword: !!u.password_hash,
    balance: (u.balance_cents || 0) / 100,
    membership: u.membership,
    membership_expires_at: u.membership_expires_at,
    isPro: isPro(u),
    loginType: u.wechat_openid ? (u.email ? '邮箱+微信' : '微信') : '邮箱',
  };
}

// ---------- 邮箱验证码 ----------
function genCode() {
  return String(crypto.randomInt(100000, 1000000)); // 6 位
}

/**
 * 生成并发送邮箱验证码。
 * @returns {Promise<{ok:boolean, devCode?:string, sent:boolean}>}
 */
async function sendEmailCode({ email, purpose = 'register' }) {
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: '邮箱格式不正确' };
  const code = genCode();
  const expires = new Date(Date.now() + CODE_TTL_MS).toISOString();
  const db = getDb();
  // 失效该邮箱同类旧码
  db.prepare('UPDATE email_codes SET used=1 WHERE email=? AND purpose=? AND used=0').run(email, purpose);
  db.prepare(
    'INSERT INTO email_codes (email, code, purpose, expires_at, used, created_at) VALUES (?, ?, ?, ?, 0, ?)'
  ).run(email, code, purpose, expires, nowISO());
  const label = purpose === 'reset' ? '重置密码' : '注册';
  const r = await mailer.sendVerificationCode(email, code, label);
  const out = { ok: true, sent: !!r.sent };
  if (r.console) out.devCode = code; // 未配置 SMTP 时把验证码回传前端便于本地校验
  return out;
}

/** 校验验证码（校验成功即置为已用）。 */
function verifyEmailCode(email, code, purpose = 'register') {
  if (!email || !code) return { error: '请填写邮箱验证码' };
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM email_codes WHERE email=? AND purpose=? AND used=0 ORDER BY id DESC LIMIT 1'
  ).get(email, purpose);
  if (!row) return { error: '请先获取验证码' };
  if (new Date(row.expires_at).getTime() < Date.now()) return { error: '验证码已过期，请重新获取' };
  if (row.code !== String(code)) return { error: '验证码错误' };
  db.prepare('UPDATE email_codes SET used=1 WHERE id=?').run(row.id);
  return { ok: true };
}

// ---------- 邮箱注册 / 登录 ----------
function registerEmail({ email, password, code, purpose = 'register' }) {
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: '邮箱格式不正确' };
  if (!password || password.length < 6) return { error: '密码至少 6 位' };
  if (getDb().prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    return { error: '该邮箱已注册，请直接登录' };
  }
  // 必须校验邮箱验证码（注册环节去除昵称输入，昵称默认取邮箱前缀）
  const v = verifyEmailCode(email, code, purpose);
  if (v.error) return v;
  const hash = hashPassword(password);
  const nickname = email.split('@')[0];
  const info = getDb().prepare(
    'INSERT INTO users (email, password_hash, nickname, created_at) VALUES (?, ?, ?, ?)'
  ).run(email, hash, nickname, nowISO());
  const uid = info.lastInsertRowid;
  const token = createSession(uid);
  return { token, user: publicUser(getDb().prepare('SELECT * FROM users WHERE id = ?').get(uid)) };
}

function loginEmail({ email, password }) {
  if (!email || !password) return { error: '请输入邮箱和密码' };
  const u = getDb().prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!u || !u.password_hash || !verifyPassword(password, u.password_hash)) {
    return { error: '邮箱或密码错误' };
  }
  const token = createSession(u.id);
  return { token, user: publicUser(u) };
}

// ---------- 微信登录（扫码 OAuth2 + demo 回退） ----------
function httpsGetJson(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, headers || {}, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('微信接口请求超时')));
  });
}

// 真实模式：生成防 CSRF 的 state 并缓存
const wechatStates = new Map(); // state -> expiresAt
function createWechatState() {
  const state = crypto.randomBytes(16).toString('hex');
  wechatStates.set(state, Date.now() + 5 * 60 * 1000);
  // 顺手清理过期
  for (const [k, exp] of wechatStates) if (exp < Date.now()) wechatStates.delete(k);
  return state;
}
function consumeWechatState(state) {
  if (!state) return false;
  const exp = wechatStates.get(state);
  if (!exp) return false;
  wechatStates.delete(state);
  return exp >= Date.now();
}

/** 返回微信扫码授权地址（真实模式）或 demo 标记。 */
function wechatAuthorizeUrl() {
  if (!WECHAT_APPID || !WECHAT_SECRET) {
    return { real: false };
  }
  const state = createWechatState();
  const url = 'https://open.weixin.qq.com/connect/qrconnect?appid=' + WECHAT_APPID +
    '&redirect_uri=' + encodeURIComponent(WECHAT_REDIRECT_URI) +
    '&response_type=code&scope=snsapi_login&state=' + state + '#wechat_redirect';
  return { real: true, url, state };
}

/** 真实回调：用 code 换 openid + 用户信息，登录/注册并返回 token。 */
async function loginWeChatCallback({ code, state }) {
  if (!WECHAT_APPID || !WECHAT_SECRET) return { error: '微信未配置，无法使用真实扫码登录' };
  if (!consumeWechatState(state)) return { error: 'state 校验失败，请重新发起扫码' };
  if (!code) return { error: '缺少微信授权 code' };
  let tokenRes;
  try {
    const url = 'https://api.weixin.qq.com/sns/oauth2/access_token?appid=' + WECHAT_APPID +
      '&secret=' + WECHAT_SECRET + '&code=' + encodeURIComponent(code) + '&grant_type=authorization_code';
    tokenRes = await httpsGetJson(url);
  } catch (e) {
    return { error: '微信授权请求失败，请检查网络或配置' };
  }
  if (tokenRes.errcode) return { error: '微信授权失败：' + (tokenRes.errmsg || tokenRes.errcode) };
  const openid = tokenRes.openid;
  const accessToken = tokenRes.access_token;

  // 拉取用户信息（昵称/头像）
  let nickname = '微信用户' + String(openid).slice(-4);
  if (accessToken && openid) {
    try {
      const info = await httpsGetJson(
        'https://api.weixin.qq.com/sns/userinfo?access_token=' + encodeURIComponent(accessToken) +
        '&openid=' + encodeURIComponent(openid)
      );
      if (info && info.nickname) nickname = info.nickname;
    } catch { /* 昵称获取失败不影响登录 */ }
  }

  let u = getDb().prepare('SELECT * FROM users WHERE wechat_openid = ?').get(openid);
  if (!u) {
    const info = getDb().prepare(
      'INSERT INTO users (wechat_openid, nickname, created_at) VALUES (?, ?, ?)'
    ).run(openid, nickname, nowISO());
    u = getDb().prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  }
  const token = createSession(u.id);
  return { token, user: publicUser(u), demo: false };
}

/** demo 模式登录（前端模拟扫码）。 */
function loginWeChat({ code }) {
  if (!code) return { error: '缺少微信授权 code' };
  const openid = 'demo_' + crypto.createHash('sha256').update('wx:' + code).digest('hex').slice(0, 16);
  let u = getDb().prepare('SELECT * FROM users WHERE wechat_openid = ?').get(openid);
  if (!u) {
    const info = getDb().prepare(
      'INSERT INTO users (wechat_openid, nickname, created_at) VALUES (?, ?, ?)'
    ).run(openid, '微信用户' + openid.slice(-4), nowISO());
    u = getDb().prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  }
  const token = createSession(u.id);
  return { token, user: publicUser(u), demo: true };
}

function logout(token) {
  if (token) getDb().prepare('DELETE FROM sessions WHERE token = ?').run(token);
  return { ok: true };
}

module.exports = {
  registerEmail, loginEmail, loginWeChat, loginWeChatCallback,
  sendEmailCode, verifyEmailCode, wechatAuthorizeUrl, createWechatState,
  logout, resolveUser, getUserByToken, isPro, publicUser,
};
