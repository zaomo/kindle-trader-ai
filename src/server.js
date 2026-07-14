'use strict';
/**
 * Kindle Trader AI —— MVP 后端服务。
 * 零依赖：仅用 Node 内置 http + node:sqlite。
 * 提供行情查询 / AI 定价 / AI 文案 / 库存利润 四组接口，并把 public/ 作为静态站点托管。
 *
 * 运行： npm start  （即 node --experimental-sqlite src/server.js）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

// 极简零依赖 .env 加载：若项目根存在 .env，则填充尚未设置的环境变量（不覆盖已有值）。
// 放在所有业务模块 require 之前，使 auth/llm 等能在加载时读到配置。
(function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  try {
    const text = fs.readFileSync(envPath, 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (!m || line.trim().startsWith('#')) continue;
      const k = m[1];
      const v = m[2].replace(/^["']|["']$/g, '');
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch (e) { /* 忽略 .env 解析错误 */ }
})();

const { getDb, seedIfEmpty, saveAdvice, listAdvice, updateAdvice } = require('./db');
const pricing = require('./pricing');
const copywriting = require('./copywriting');
const purchase = require('./purchase');
const inventory = require('./inventory');
const admin = require('./admin');
const auth = require('./auth');
const billing = require('./billing');
const { isConfigured, getProvider } = require('./llm');

// ---- 验证码发送限流（防刷）----
// 同邮箱 60s 冷却；单 IP 每日上限（按自然日重置）。
const _codeIpStat = new Map();      // ip -> { date: 'YYYY-MM-DD', count: n }
const _codeEmailLast = new Map();   // email(小写) -> 上次发送时间戳(ms)
const CODE_IP_DAILY_LIMIT = 20;
const CODE_EMAIL_COOLDOWN_MS = 60 * 1000;
function codeRateLimit(ip, email) {
  const key = String(email || '').toLowerCase();
  const today = new Date().toISOString().slice(0, 10);
  const st = _codeIpStat.get(ip) || { date: today, count: 0 };
  if (st.date !== today) { st.date = today; st.count = 0; }
  if (st.count >= CODE_IP_DAILY_LIMIT) {
    return { error: '今日验证码发送次数过多，请明天再试' };
  }
  const last = _codeEmailLast.get(key) || 0;
  const gap = Date.now() - last;
  if (gap < CODE_EMAIL_COOLDOWN_MS) {
    const sec = Math.ceil((CODE_EMAIL_COOLDOWN_MS - gap) / 1000);
    return { error: `验证码发送过于频繁，请 ${sec} 秒后再试` };
  }
  st.count += 1;
  _codeIpStat.set(ip, st);
  _codeEmailLast.set(key, Date.now());
  return null;
}
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'unknown';
}

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// 统一日志：带时间戳 + 级别，便于排查（微信回调 / 邮件失败等）
function log(level, ...args) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const tag = { info: '\x1b[36mINFO\x1b[0m', warn: '\x1b[33mWARN\x1b[0m', error: '\x1b[31mERROR\x1b[0m' }[level] || level;
  console.log(`[${ts}] ${tag}`, ...args);
}

// MVP 免费版每日额度（来自需求文档 7）
const LIMITS = { pricing: 3, copywriting: 5 };

seedIfEmpty();

// ---------- 工具 ----------
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy(); // 防止超大请求
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function usageCount(anonId, action, day) {
  const db = getDb();
  const row = db.prepare(
    'SELECT COUNT(*) AS c FROM usage_log WHERE anon_id=? AND action=? AND day=?'
  ).get(anonId, action, day);
  return row.c;
}

function recordUsage(anonId, action, day) {
  const db = getDb();
  db.prepare(
    "INSERT INTO usage_log (anon_id, action, day, created_at) VALUES (?, ?, ?, ?)"
  ).run(anonId, action, day, new Date().toISOString());
}

function checkLimit(identity, action) {
  const limit = LIMITS[action] ?? Infinity;
  // 登录且为会员 → 无限次
  if (identity.userId && identity.isPro) {
    return { ok: true, used: 0, limit: Infinity, key: 'user:' + identity.userId, pro: true };
  }
  const key = identity.userId ? ('user:' + identity.userId) : (identity.anonId || 'anonymous');
  const used = usageCount(key, action, todayStr());
  return { ok: used < limit, used, limit, key, pro: false };
}

// ---------- 静态资源 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { // 目录穿越防护
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      // SPA 兜底：未知路径返回 index.html
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        if (e2) { res.writeHead(404); res.end('Not Found'); return; }
        res.writeHead(200, { 'content-type': MIME['.html'] });
        res.end(html);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    res.end(buf);
  });
}

// ---------- 路由 ----------
const db = getDb();

async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;
  const method = req.method;

  // 行情：型号列表
  if (pathname === '/api/models' && method === 'GET') {
    const rows = db.prepare('SELECT id, name, family, generation, screen_size, release_year, ref_low, ref_high, sample_size, updated_at FROM models ORDER BY family, release_year').all();
    return sendJSON(res, 200, { models: rows });
  }

  // 行情：历史趋势
  const histMatch = pathname.match(/^\/api\/models\/(\d+)\/history$/);
  if (histMatch && method === 'GET') {
    const modelId = Number(histMatch[1]);
    const range = Number(searchParams.get('range')) === 90 ? 90 : 30;
    const rows = db.prepare(
      'SELECT date, avg_price, sample_size FROM price_history WHERE model_id=? ORDER BY date DESC LIMIT ?'
    ).all(modelId, range);
    const data = rows.reverse();
    const model = db.prepare('SELECT name, ref_low, ref_high, sample_size, updated_at FROM models WHERE id=?').get(modelId);
    return sendJSON(res, 200, { model, range, history: data });
  }

  // AI 定价
  if (pathname === '/api/pricing' && method === 'POST') {
    const body = await readBody(req);
    const user = auth.resolveUser(req);
    const identity = user ? { userId: user.id, isPro: auth.isPro(user) } : { anonId: body.anonId };
    const gate = checkLimit(identity, 'pricing');
    if (!gate.ok) {
      return sendJSON(res, 402, { error: '今日免费定价次数已用完', used: gate.used, limit: gate.limit, upgrade: true });
    }
    try {
      const result = await pricing.price({
        modelId: Number(body.modelId),
        condition: body.condition,
        accessories: body.accessories || [],
        screenIssue: !!body.screenIssue,
        battery: body.battery || '正常',
      });
      recordUsage(gate.key, 'pricing', todayStr());
      result.usage = { used: gate.pro ? 0 : gate.used + 1, limit: gate.limit, pro: gate.pro };
      // 落库：历史定价建议
      try { saveAdvice('pricing', result.modelId, result.modelName, result); } catch (e) { console.error('[saveAdvice:pricing]', e); }
      return sendJSON(res, 200, result);
    } catch (e) {
      return sendJSON(res, e.statusCode || 400, { error: e.message });
    }
  }

  // AI 文案
  if (pathname === '/api/copywriting' && method === 'POST') {
    const body = await readBody(req);
    const user = auth.resolveUser(req);
    const identity = user ? { userId: user.id, isPro: auth.isPro(user) } : { anonId: body.anonId };
    const gate = checkLimit(identity, 'copywriting');
    if (!gate.ok) {
      return sendJSON(res, 402, { error: '今日免费文案次数已用完', used: gate.used, limit: gate.limit, upgrade: true });
    }
    try {
      const result = await copywriting.generate({
        modelName: body.modelName,
        condition: body.condition,
        price: body.price,
        sellingPoints: body.sellingPoints || [],
      });
      recordUsage(gate.key, 'copywriting', todayStr());
      result.usage = { used: gate.pro ? 0 : gate.used + 1, limit: gate.limit, pro: gate.pro };
      saveAdvice('copywriting', null, body.modelName || '未知型号', result);
      return sendJSON(res, 200, result);
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  // AI 采购决策（结合知识库 + Model Router 调 Qwen3-235B；无 LLM 回退本地规则）
  if (pathname === '/api/purchase-advice' && method === 'POST') {
    const body = await readBody(req);
    try {
      const result = await purchase.purchaseAdvice({
        modelId: Number(body.modelId),
        myPurchasePrice: Number(body.myPurchasePrice),
        expectedSellPrice: Number(body.expectedSellPrice),
        channel: body.channel,
        condition: body.condition,
        note: body.note,
      });
      // 落库：历史采购建议
      try { saveAdvice('purchase', result.modelId, result.modelName, result); } catch (e) { console.error('[saveAdvice:purchase]', e); }
      return sendJSON(res, 200, result);
    } catch (e) {
      return sendJSON(res, e.statusCode || 400, { error: e.message });
    }
  }

  // 历史建议列表（定价 / 采购 / 文案），用户端"查看以往产生的建议"
  const adviceHistMatch = pathname.match(/^\/api\/(pricing|purchase|copywriting)\/history(?:\/(\d+))?$/);
  if (adviceHistMatch) {
    const type = adviceHistMatch[1];
    const id = adviceHistMatch[2] ? Number(adviceHistMatch[2]) : null;
    if (method === 'GET') {
      const limit = Math.min(100, Math.max(1, Number(searchParams.get('limit')) || 20));
      return sendJSON(res, 200, { items: listAdvice(type, limit) });
    }
    if (method === 'DELETE') {
      if (id) {
        const r = db.prepare('DELETE FROM advice_history WHERE id=? AND type=?').run(id, type);
        return sendJSON(res, 200, { ok: true, deleted: r.changes });
      }
      const r = db.prepare('DELETE FROM advice_history WHERE type=?').run(type);
      return sendJSON(res, 200, { ok: true, deleted: r.changes });
    }
    if (method === 'PATCH' && id) {
      const body = await readBody(req);
      const patch = {};
      if (body.results && typeof body.results === 'object') patch.results = body.results;
      if (typeof body.title === 'string') patch.title = body.title;
      if (typeof body.note === 'string') patch.note = body.note;
      if (!Object.keys(patch).length) return sendJSON(res, 400, { error: '无有效修改字段' });
      const ok = updateAdvice(id, type, patch);
      if (!ok) return sendJSON(res, 404, { error: '记录不存在' });
      return sendJSON(res, 200, { ok: true });
    }
  }

  // 库存：列表
  if (pathname === '/api/inventory' && method === 'GET') {
    return sendJSON(res, 200, { items: inventory.list(), summary: inventory.summary() });
  }
  // 库存：新增
  if (pathname === '/api/inventory' && method === 'POST') {
    const body = await readBody(req);
    const item = inventory.create(body);
    return sendJSON(res, 201, item);
  }
  // 库存：汇总（单独入口，便于前端刷新）
  if (pathname === '/api/inventory/summary' && method === 'GET') {
    return sendJSON(res, 200, inventory.summary());
  }
  // 库存：更新 / 删除
  const invMatch = pathname.match(/^\/api\/inventory\/(\d+)$/);
  if (invMatch) {
    const id = Number(invMatch[1]);
    if (method === 'PUT' || method === 'PATCH') {
      const body = await readBody(req);
      const item = inventory.update(id, body);
      return item ? sendJSON(res, 200, item) : sendJSON(res, 404, { error: '记录不存在' });
    }
    if (method === 'DELETE') {
      const ok = inventory.remove(id);
      return sendJSON(res, ok ? 200 : 404, { ok });
    }
  }

  // 用量查询（前端展示剩余次数 / 会员无限）
  if (pathname === '/api/usage' && method === 'GET') {
    const user = auth.resolveUser(req);
    const day = todayStr();
    if (user && auth.isPro(user)) {
      return sendJSON(res, 200, {
        pro: true,
        pricing: { used: 0, limit: Infinity },
        copywriting: { used: 0, limit: Infinity },
      });
    }
    const anonId = user ? ('user:' + user.id) : (searchParams.get('anonId') || 'anonymous');
    return sendJSON(res, 200, {
      pro: false,
      pricing: { used: usageCount(anonId, 'pricing', day), limit: LIMITS.pricing },
      copywriting: { used: usageCount(anonId, 'copywriting', day), limit: LIMITS.copywriting },
    });
  }

  // 模型调度中心（Model Router）公开状态（供用户端展示，不含任何 Key）
  if (pathname === '/api/router/status' && method === 'GET') {
    return sendJSON(res, 200, require('./llm').getRouterStatus());
  }

  // ---------- 用户登录 / 注册（无需鉴权） ----------
  if (pathname === '/api/auth/register' && method === 'POST') {
    const b = await readBody(req);
    const r = auth.registerEmail(b);
    if (r.error) return sendJSON(res, 400, { error: r.error });
    return sendJSON(res, 201, { token: r.token, user: r.user });
  }
  // 发送邮箱验证码（注册校验用）
  if (pathname === '/api/auth/send-code' && method === 'POST') {
    const b = await readBody(req);
    const rl = codeRateLimit(clientIp(req), b.email);
    if (rl && rl.error) return sendJSON(res, 429, { error: rl.error });
    const r = await auth.sendEmailCode(b);
    if (r.error) return sendJSON(res, 400, { error: r.error });
    return sendJSON(res, 200, r);
  }
  if (pathname === '/api/auth/login' && method === 'POST') {
    const b = await readBody(req);
    const r = auth.loginEmail(b);
    if (r.error) return sendJSON(res, 401, { error: r.error });
    return sendJSON(res, 200, { token: r.token, user: r.user });
  }
  if (pathname === '/api/auth/wechat' && method === 'POST') {
    const b = await readBody(req);
    const r = await auth.loginWeChat(b);
    if (r.error) return sendJSON(res, 401, { error: r.error });
    return sendJSON(res, 200, { token: r.token, user: r.user, demo: !!r.demo });
  }
  // 微信扫码：返回真实授权地址（或 demo 标记）
  if (pathname === '/api/auth/wechat/qrcode' && method === 'GET') {
    const r = auth.wechatAuthorizeUrl();
    return sendJSON(res, 200, r);
  }
  // 微信扫码回调（真实模式）：用 code 换 openid 后渲染 postMessage 关弹窗
  if (pathname === '/api/auth/wechat/callback' && method === 'GET') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const r = await auth.loginWeChatCallback({ code, state });
    if (r.error) {
      log('error', '[wechat-callback]', r.error);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><body style="font-family:sans-serif;text-align:center;padding:40px">' +
        '<h3>微信登录失败</h3><p>' + String(r.error).replace(/[<>&]/g, '') + '</p>' +
        '<script>setTimeout(function(){window.close();},1500);</script></body></html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><title>微信登录中</title></head>' +
      '<body style="font-family:sans-serif;text-align:center;padding:40px">' +
      '<h3>登录成功</h3><p>正在返回应用…</p><script>' +
      '(function(){try{window.opener&&window.opener.postMessage({type:"wechat-login",token:' +
      JSON.stringify(r.token) + '},"*");}catch(e){}' +
      'setTimeout(function(){window.close();},800);})();' +
      '</script></body></html>');
    return;
  }
  if (pathname === '/api/auth/logout' && method === 'POST') {
    const authz = req.headers['authorization'];
    const token = authz && authz.startsWith('Bearer ') ? authz.slice(7).trim() : null;
    auth.logout(token);
    return sendJSON(res, 200, { ok: true });
  }
  // 当前登录用户（受 token 保护）
  if (pathname === '/api/auth/me' && method === 'GET') {
    const user = auth.resolveUser(req);
    if (!user) return sendJSON(res, 401, { error: '未登录' });
    return sendJSON(res, 200, { user: auth.publicUser(user) });
  }

  // ---------- 充值 / 会员（受 token 保护） ----------
  if (pathname.startsWith('/api/billing/') && method === 'GET' && pathname === '/api/billing/me') {
    const user = auth.resolveUser(req);
    if (!user) return sendJSON(res, 401, { error: '请先登录' });
    return sendJSON(res, 200, billing.getMe(user.id));
  }
  if (pathname === '/api/billing/recharge' && method === 'POST') {
    const user = auth.resolveUser(req);
    if (!user) return sendJSON(res, 401, { error: '请先登录' });
    const b = await readBody(req);
    const amountCents = Math.round(Number(b.amount) * 100);
    const r = billing.topUp(user.id, amountCents, b.method || 'wechat');
    if (r.error) return sendJSON(res, 400, { error: r.error });
    return sendJSON(res, 200, { ok: true, balance: r.balance });
  }
  if (pathname === '/api/billing/membership' && method === 'POST') {
    const user = auth.resolveUser(req);
    if (!user) return sendJSON(res, 401, { error: '请先登录' });
    const b = await readBody(req);
    const r = billing.buyMembership(user.id, b.payMethod || 'simulate');
    if (r.error) return sendJSON(res, 400, { error: r.error });
    return sendJSON(res, 200, r);
  }

  // ---------- 管理员登录（无需鉴权） ----------
  if (pathname === '/api/admin/login' && method === 'POST') {
    const body = await readBody(req);
    const token = admin.login(body.password);
    if (!token) return sendJSON(res, 401, { error: '密码错误' });
    return sendJSON(res, 200, { token });
  }
  if (pathname === '/api/admin/logout' && method === 'POST') {
    const auth = req.headers['authorization'];
    const token = auth && auth.startsWith('Bearer ') ? auth.slice(7).trim() : url.searchParams.get('token');
    if (token) admin.logout(token);
    return sendJSON(res, 200, { ok: true });
  }

  // ---------- 受保护的管理接口 ----------
  if (pathname.startsWith('/api/admin/')) {
    if (!admin.authenticate(req, url)) return sendJSON(res, 401, { error: '未授权，请先登录' });
    return handleAdmin(req, res, url);
  }

  return sendJSON(res, 404, { error: '接口不存在' });
}

// 重生成某型号近 90 天历史趋势（Admin 用）
function regenHistory(modelId) {
  const m = db.prepare('SELECT * FROM models WHERE id = ?').get(modelId);
  if (!m) return;
  db.prepare('DELETE FROM price_history WHERE model_id = ?').run(modelId);
  const mid = (m.ref_low + m.ref_high) / 2;
  const today = new Date();
  const insert = db.prepare(
    'INSERT OR IGNORE INTO price_history (model_id, date, avg_price, sample_size) VALUES (?, ?, ?, ?)'
  );
  db.exec('BEGIN');
  try {
    for (let i = 89; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const drift = 1 + 0.0016 * i;
      const noise = 1 + (Math.random() - 0.5) * 0.06;
      const avg = Math.round((mid * drift * noise) / 5) * 5;
      const sample = Math.max(1, Math.round((m.sample_size || 30) / 90 + Math.random() * 3));
      insert.run(modelId, d.toISOString().slice(0, 10), avg, sample);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---------- Admin 路由分发 ----------
async function handleAdmin(req, res, url) {
  const { pathname, searchParams } = url;
  const method = req.method;

  if (pathname === '/api/admin/dashboard' && method === 'GET') {
    return sendJSON(res, 200, admin.dashboard());
  }
  if (pathname === '/api/admin/usage' && method === 'GET') {
    return sendJSON(res, 200, admin.usageStats());
  }

  // 用户管理：列表（搜索 / 会员筛选 / 分页）
  if (pathname === '/api/admin/users' && method === 'GET') {
    const q = (searchParams.get('q') || '').trim();
    const membership = searchParams.get('membership') || 'all';
    const page = Math.max(1, Number(searchParams.get('page') || 1));
    const pageSize = Math.min(100, Math.max(1, Number(searchParams.get('pageSize') || 20)));
    const offset = (page - 1) * pageSize;

    const where = [];
    const args = [];
    if (q) {
      where.push('(email LIKE ? OR nickname LIKE ? OR wechat_openid LIKE ?)');
      const like = '%' + q + '%';
      args.push(like, like, like);
    }
    if (membership === 'pro') {
      where.push("membership = 'pro' AND membership_expires_at > ?");
      args.push(new Date().toISOString());
    } else if (membership === 'free') {
      where.push("(membership != 'pro' OR membership_expires_at <= ?)");
      args.push(new Date().toISOString());
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) c FROM users ${whereSql}`).get(...args).c;
    const rows = db.prepare(
      `SELECT id, email, wechat_openid, nickname, balance_cents, membership, membership_expires_at, created_at
       FROM users ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...args, pageSize, offset);
    const stat = admin.usersStat();
    const users = rows.map((u) => ({
      id: u.id,
      email: u.email,
      wechat_openid: u.wechat_openid,
      nickname: u.nickname,
      loginType: u.wechat_openid ? (u.email ? '邮箱+微信' : '微信') : '邮箱',
      balance: (u.balance_cents || 0) / 100,
      membership: u.membership,
      membership_expires_at: u.membership_expires_at,
      isPro: u.membership === 'pro' && (!u.membership_expires_at || new Date(u.membership_expires_at).getTime() > Date.now()),
      created_at: u.created_at,
    }));
    return sendJSON(res, 200, {
      users,
      stat: { total: stat.total, proCount: stat.proCount, totalBalance: stat.totalBalanceCents / 100, todayNew: stat.todayNew },
      page,
      pageSize,
      total,
    });
  }

  // 用户管理：详情
  const userMatch = pathname.match(/^\/api\/admin\/users\/(\d+)$/);
  if (userMatch && method === 'GET') {
    const detail = admin.userDetail(Number(userMatch[1]));
    if (!detail) return sendJSON(res, 404, { error: '用户不存在' });
    const u = detail.user;
    return sendJSON(res, 200, {
      user: {
        id: u.id, email: u.email, wechat_openid: u.wechat_openid, nickname: u.nickname,
        balance: (u.balance_cents || 0) / 100,
        membership: u.membership, membership_expires_at: u.membership_expires_at,
        isPro: u.membership === 'pro' && (!u.membership_expires_at || new Date(u.membership_expires_at).getTime() > Date.now()),
        created_at: u.created_at, sessionCount: detail.sessionCount,
      },
      recharges: detail.recharges.map((r) => ({
        id: r.id, amount: (r.amount_cents || 0) / 100, method: r.method, status: r.status, created_at: r.created_at,
      })),
    });
  }

  // 用户管理：改昵称 / 会员状态
  if (userMatch && method === 'PUT') {
    const b = await readBody(req);
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(userMatch[1]));
    if (!u) return sendJSON(res, 404, { error: '用户不存在' });
    const sets = [];
    const args = [];
    if (b.nickname !== undefined) { sets.push('nickname = ?'); args.push(String(b.nickname).trim()); }
    if (b.membership !== undefined) {
      const m = String(b.membership);
      if (!['free', 'pro'].includes(m)) return sendJSON(res, 400, { error: 'membership 必须为 free 或 pro' });
      sets.push('membership = ?');
      args.push(m);
      if (m === 'pro') {
        const days = Number(b.membershipDays || 30);
        const exp = new Date(Date.now() + days * 86400000).toISOString();
        sets.push('membership_expires_at = ?');
        args.push(exp);
      } else {
        sets.push("membership_expires_at = NULL");
      }
    }
    if (!sets.length) return sendJSON(res, 400, { error: '无有效更新字段' });
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args, u.id);
    return sendJSON(res, 200, { ok: true, user: db.prepare('SELECT * FROM users WHERE id = ?').get(u.id) });
  }

  // 用户管理：管理员调账（正负都可，记一条 recharges）
  const adjMatch = pathname.match(/^\/api\/admin\/users\/(\d+)\/adjust-balance$/);
  if (adjMatch && method === 'POST') {
    const b = await readBody(req);
    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount === 0) return sendJSON(res, 400, { error: '金额必须为非零数值（元）' });
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(adjMatch[1]));
    if (!u) return sendJSON(res, 404, { error: '用户不存在' });
    const newCents = (u.balance_cents || 0) + Math.round(amount * 100);
    if (newCents < 0) return sendJSON(res, 400, { error: '调整后余额不能为负' });
    db.prepare('UPDATE users SET balance_cents = ? WHERE id = ?').run(newCents, u.id);
    db.prepare(
      "INSERT INTO recharges (user_id, amount_cents, method, status, note, created_at) VALUES (?, ?, 'admin', 'done', ?, ?)"
    ).run(u.id, Math.round(amount * 100), b.note ? String(b.note) : (amount > 0 ? '管理员充值' : '管理员扣减'), new Date().toISOString());
    return sendJSON(res, 200, { ok: true, balance: newCents / 100 });
  }

  // 用户管理：删除
  const delMatch = pathname.match(/^\/api\/admin\/users\/(\d+)$/);
  if (delMatch && method === 'DELETE') {
    const uid = Number(delMatch[1]);
    const u = db.prepare('SELECT id FROM users WHERE id = ?').get(uid);
    if (!u) return sendJSON(res, 404, { error: '用户不存在' });
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM recharges WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM users WHERE id = ?').run(uid);
    return sendJSON(res, 200, { ok: true });
  }

  // 配置（定价规则 / 文案模板）
  if (pathname === '/api/admin/config' && method === 'GET') {
    return sendJSON(res, 200, {
      pricing: admin.getConfig('pricing', pricing.DEFAULT_PRICING),
      copywriting: admin.getConfig('copywriting', copywriting.DEFAULT_COPYWRITING),
    });
  }
  if (pathname === '/api/admin/config-default' && method === 'GET') {
    return sendJSON(res, 200, {
      pricing: pricing.DEFAULT_PRICING,
      copywriting: copywriting.DEFAULT_COPYWRITING,
    });
  }
  if (pathname === '/api/admin/config' && method === 'PUT') {
    const body = await readBody(req);
    if (body.pricing !== undefined) {
      if (typeof body.pricing !== 'object' || body.pricing === null) return sendJSON(res, 400, { error: 'pricing 必须是对象' });
      admin.setConfig('pricing', body.pricing);
    }
    if (body.copywriting !== undefined) {
      if (typeof body.copywriting !== 'object' || body.copywriting === null) return sendJSON(res, 400, { error: 'copywriting 必须是对象' });
      admin.setConfig('copywriting', body.copywriting);
    }
    return sendJSON(res, 200, {
      pricing: admin.getConfig('pricing', pricing.DEFAULT_PRICING),
      copywriting: admin.getConfig('copywriting', copywriting.DEFAULT_COPYWRITING),
    });
  }

  // AI（LLM）配置：框架式多 Key 列表，可在后台直接添加/切换厂商 Key，保存后立即生效
  if (pathname === '/api/admin/llm' && method === 'GET') {
    return sendJSON(res, 200, admin.getLlmConfig());
  }

  // 新增 / 更新一条 LLM Key（upsert）；body 可含 set_active
  if (pathname === '/api/admin/llm/key' && method === 'POST') {
    const body = await readBody(req);
    try {
      return sendJSON(res, 200, admin.addLlmKey(body));
    } catch (err) {
      return sendJSON(res, 400, { error: err.message });
    }
  }

  // 拉取某 provider 真实模型列表（接口不可用时由后端用预置清单兜底）
  if (pathname === '/api/admin/llm/models' && method === 'POST') {
    const body = await readBody(req);
    const models = await admin.listLlmModels(body);
    return sendJSON(res, 200, { models });
  }

  // 单条 Key 操作：删除 / 设为当前 / 测试
  const llmKeyMatch = pathname.match(/^\/api\/admin\/llm\/key\/([\w-]+)$/);
  if (llmKeyMatch) {
    const keyId = llmKeyMatch[1];
    if (method === 'DELETE') {
      return sendJSON(res, 200, admin.deleteLlmKey(keyId));
    }
    if (method === 'PUT') {
      const b = await readBody(req);
      if (typeof b.enabled === 'boolean' || b.active) {
        return sendJSON(res, 200, admin.updateLlmKey(keyId, { enabled: b.enabled, active: Boolean(b.active) }));
      }
      return sendJSON(res, 400, { error: 'enabled 或 active 至少提供一个' });
    }
  }
  const llmActivate = pathname.match(/^\/api\/admin\/llm\/key\/([\w-]+)\/activate$/);
  if (llmActivate && method === 'POST') {
    return sendJSON(res, 200, admin.activateLlmKey(llmActivate[1]));
  }
  const llmTest = pathname.match(/^\/api\/admin\/llm\/key\/([\w-]+)\/test$/);
  if (llmTest && method === 'POST') {
    const r = await admin.testLlmKey(llmTest[1]);
    return sendJSON(res, 200, r);
  }

  // 型号管理
  if (pathname === '/api/admin/models' && method === 'GET') {
    const rows = db.prepare('SELECT * FROM models ORDER BY family, release_year').all();
    return sendJSON(res, 200, { models: rows });
  }
  if (pathname === '/api/admin/models' && method === 'POST') {
    const b = await readBody(req);
    if (!b.name || !(b.ref_low >= 0) || !(b.ref_high > 0)) {
      return sendJSON(res, 400, { error: 'name / ref_low / ref_high 必填且有效' });
    }
    const info = db.prepare(
      `INSERT INTO models (name, family, generation, screen_size, release_year, ref_low, ref_high, sample_size, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      b.name, b.family || '', b.generation || '', Number(b.screen_size) || 6, Number(b.release_year) || null,
      Number(b.ref_low), Number(b.ref_high), Number(b.sample_size) || 0, todayStr()
    );
    const row = db.prepare('SELECT * FROM models WHERE id = ?').get(info.lastInsertRowid);
    return sendJSON(res, 201, row);
  }

  const modelMatch = pathname.match(/^\/api\/admin\/models\/(\d+)(?:\/([\w-]+))?$/);
  if (modelMatch) {
    const id = Number(modelMatch[1]);
    const sub = modelMatch[2];
    if (sub === 'regen-history' && method === 'POST') {
      regenHistory(id);
      return sendJSON(res, 200, { ok: true });
    }
    if (!sub && method === 'PUT') {
      const b = await readBody(req);
      const sets = [];
      const vals = [];
      for (const f of ['name', 'family', 'generation', 'screen_size', 'release_year', 'ref_low', 'ref_high', 'sample_size']) {
        if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(b[f]); }
      }
      if (!sets.length) return sendJSON(res, 400, { error: '无可更新字段' });
      sets.push('updated_at = ?');
      vals.push(todayStr());
      vals.push(id);
      db.prepare(`UPDATE models SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      const row = db.prepare('SELECT * FROM models WHERE id = ?').get(id);
      return row ? sendJSON(res, 200, row) : sendJSON(res, 404, { error: '型号不存在' });
    }
    if (!sub && method === 'DELETE') {
      db.prepare('DELETE FROM price_history WHERE model_id = ?').run(id);
      db.prepare('DELETE FROM models WHERE id = ?').run(id);
      return sendJSON(res, 200, { ok: true });
    }
  }

  // 模型调度中心（Model Router）：配置读写（含 presets / 已配置模型）
  if (pathname === '/api/admin/router' && method === 'GET') {
    return sendJSON(res, 200, admin.getRouterConfig());
  }
  if (pathname === '/api/admin/router' && method === 'PUT') {
    const body = await readBody(req);
    try {
      return sendJSON(res, 200, admin.saveRouterConfig(body));
    } catch (err) {
      return sendJSON(res, 400, { error: err.message });
    }
  }
  // 成本与用量看板
  if (pathname === '/api/admin/router/cost' && method === 'GET') {
    return sendJSON(res, 200, admin.routerCostDashboard());
  }

  return sendJSON(res, 404, { error: '管理接口不存在' });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => {
      log('error', '[api]', e && e.message ? e.message : e);
      sendJSON(res, 500, { error: '服务器内部错误' });
    });
    return;
  }
  serveStatic(req, res, url.pathname);
});

server.listen(PORT, () => {
  log('info', 'Kindle Trader AI MVP 已启动： http://localhost:' + PORT);
  log('info', '接口：');
  log('info', '  GET  /api/models · POST /api/pricing · POST /api/copywriting · GET/POST /api/inventory');
  log('info', '  POST /api/auth/register · /api/auth/login · POST /api/auth/send-code · /api/auth/wechat · GET /api/auth/wechat/qrcode · GET /api/auth/wechat/callback · GET /api/auth/me');
  log('info', '  GET  /api/billing/me · POST /api/billing/recharge · POST /api/billing/membership');
  log('info', '  页面： /login.html · /account.html · 管理后台 /admin.html\n');
  if (!isConfigured()) {
    log('warn', '未检测到 LLM 密钥，AI 采用本地规则/模板生成；可在后台「AI 配置」填写 Key 或设置 LLM_PROVIDER+API_KEY。');
  } else {
    log('info', 'LLM provider = ' + getProvider() + '，定价理由与文案将由模型润色（价格数字仍由真实数据计算）。');
  }
});
