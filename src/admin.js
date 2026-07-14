'use strict';
/**
 * 独立 Admin 后台支撑模块：
 *   - 登录鉴权（内存会话 + Bearer Token，默认密码见 ADMIN_PASSWORD）
 *   - 可配置项读写（admin_config 表：定价规则 / 文案模板）
 *   - 用量与库存聚合（供仪表盘）
 *
 * 注意：MVP 阶段采用「单管理员 + 内存会话」的最简鉴权，足够把后台与用户端隔离。
 * 生产化时请替换为数据库持久化会话 + 多账号 + 强哈希密码（bcrypt/scrypt）。
 */
const crypto = require('crypto');
const { getDb } = require('./db');
const inventory = require('./inventory');
const llm = require('./llm');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const SESSION_TTL = 8 * 3600 * 1000; // 8 小时

// token -> 过期时间戳(ms)
const sessions = new Map();

function login(password) {
  if (!password || password !== ADMIN_PASSWORD) return null;
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL);
  return token;
}

function logout(token) {
  sessions.delete(token);
}

// 校验请求是否携带有效 token（支持 Authorization 头或 ?token= 查询参数）
function authenticate(req, url) {
  let token = null;
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) token = auth.slice(7).trim();
  if (!token && url && url.searchParams.get('token')) token = url.searchParams.get('token');
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(token); return false; }
  return true;
}

// ---------- 可配置项 ----------
function getConfig(key, fallback) {
  const db = getDb();
  const row = db.prepare('SELECT value FROM admin_config WHERE key = ?').get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

function setConfig(key, obj) {
  const db = getDb();
  const exists = db.prepare('SELECT 1 FROM admin_config WHERE key = ?').get(key);
  const json = JSON.stringify(obj);
  if (exists) {
    db.prepare('UPDATE admin_config SET value = ? WHERE key = ?').run(json, key);
  } else {
    db.prepare('INSERT INTO admin_config (key, value) VALUES (?, ?)').run(key, json);
  }
}

// ---------- AI（LLM）配置：后台「AI 配置」界面（框架式多 Key 列表） ----------
function maskKey(key) {
  if (!key) return '';
  return key.length <= 6 ? '••••••' : key.slice(0, 3) + '…' + key.slice(-4);
}
function genKeyId() {
  // uuid 风格，保证全局唯一（框架约束）
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
// 兼容旧结构 {provider,model,keys,activeId} → 新结构 {api_keys, active_llm}
function normalizeLlm(raw) {
  if (!raw) return { api_keys: [], active_llm: null };
  if (Array.isArray(raw.api_keys)) return { api_keys: raw.api_keys, active_llm: raw.active_llm || null };
  // 旧单 provider 结构
  return migrateOldLlm(raw);
}
function migrateOldLlm(c) {
  const provider = c.provider || 'off';
  if (provider === 'off') return { api_keys: [], active_llm: null };
  const meta = require('./llm').LLM_PROVIDERS[provider];
  const oldKeys = Array.isArray(c.keys)
    ? c.keys
    : (c.key ? [{ id: c.activeId || 'k_legacy', label: '默认', key: c.key, createdAt: '', enabled: true }] : []);
  const api_keys = oldKeys
    .filter((k) => k && k.key)
    .map((k) => ({
      id: k.id || ('k_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
      provider,
      api_key: k.key,
      base_url: meta ? meta.base_url : '',
      model: c.model || (meta ? meta.model : ''),
      label: k.label || '',
      created_at: k.createdAt || new Date().toISOString().slice(0, 19),
      enabled: k.enabled !== false,
    }));
  return { api_keys, active_llm: c.activeId || (api_keys.length ? api_keys[0].id : null) };
}
function persistLlm(c) {
  const db = getDb();
  const value = JSON.stringify(c);
  const exists = db.prepare("SELECT 1 FROM admin_config WHERE key = 'llm'").get();
  if (exists) db.prepare("UPDATE admin_config SET value = ? WHERE key = 'llm'").run(value);
  else db.prepare("INSERT INTO admin_config (key, value) VALUES ('llm', ?)").run(value);
}
function loadLlm() {
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM admin_config WHERE key = 'llm'").get();
    if (!row || !row.value) return { api_keys: [], active_llm: null };
    return normalizeLlm(JSON.parse(row.value));
  } catch (e) {
    return { api_keys: [], active_llm: null };
  }
}

// 读取当前 LLM 配置；出于安全，API Key 只返回遮罩形式，不暴露明文。
function getLlmConfig() {
  const { api_keys, active_llm } = loadLlm();
  const keys = api_keys.map((k) => {
    const meta = require('./llm').LLM_PROVIDERS[k.provider] || {};
    return {
      id: k.id,
      provider: k.provider,
      provider_name: meta.name || k.provider,
      model: k.model || '',
      label: k.label || '',
      key_preview: maskKey(k.api_key),
      has_key: Boolean(k.api_key),
      base_url: k.base_url || (meta ? meta.base_url : ''),
      created_at: k.created_at || '',
      enabled: k.enabled !== false,
    };
  });
  const available_llm_models = keys
    .filter((k) => k.enabled)
    .map((k) => ({ id: k.id, provider: k.provider, provider_name: k.provider_name, model: k.model, label: k.label, key_preview: k.key_preview }));
  return { api_keys: keys, active_llm, available_llm_models };
}

// 新增或更新一条 LLM Key（upsert）。input: { id?, provider, api_key, base_url?, model?, label?, set_active? }
// 新增时不覆盖/删除旧的；编辑时只改该项。set_active=true 则该条设为当前。
function addLlmKey(input) {
  const db = getDb();
  let current = loadLlm();
  const provider = (input.provider || '').toLowerCase();
  const meta = require('./llm').LLM_PROVIDERS[provider];
  if (!meta) throw new Error('不支持的 provider: ' + provider);
  const base_url = (input.base_url && input.base_url.trim()) || meta.base_url;
  const model = (input.model && input.model.trim()) || '';
  const label = (input.label && input.label.trim()) || '';
  const api_key = (input.api_key && input.api_key.trim()) || '';
  if (!api_key) throw new Error('API Key 不能为空');

  let keys = current.api_keys || [];
  if (input.id) {
    const k = keys.find((x) => x.id === input.id);
    if (k) {
      k.provider = provider; k.api_key = api_key; k.base_url = base_url; k.model = model;
      if (label) k.label = label;
      k.enabled = true;
    }
  } else {
    const id = genKeyId();
    keys.push({ id, provider, api_key, base_url, model, label, created_at: new Date().toISOString().slice(0, 19), enabled: true });
    if (input.set_active) current.active_llm = id;
    else if (!current.active_llm) current.active_llm = id; // 首条自动设为当前
  }
  current.api_keys = keys;
  persistLlm(current);
  return getLlmConfig();
}

// 删除某条 Key；若删除的是当前激活，自动顺延到同类型（LLM）下一条
function deleteLlmKey(id) {
  const current = loadLlm();
  const keys = (current.api_keys || []).filter((k) => k.id !== id);
  if (current.active_llm === id) current.active_llm = keys.length ? keys[0].id : null;
  current.api_keys = keys;
  persistLlm(current);
  return getLlmConfig();
}

// 修改某条 Key：启用/停用，或设为当前（active 同时启用）
function updateLlmKey(id, patch) {
  const current = loadLlm();
  const k = (current.api_keys || []).find((x) => x.id === id);
  if (k) {
    if (typeof patch.enabled === 'boolean') k.enabled = patch.enabled;
    if (patch.active) { current.active_llm = id; k.enabled = true; }
    persistLlm(current);
  }
  return getLlmConfig();
}

// 设为当前使用
function activateLlmKey(id) {
  return updateLlmKey(id, { active: true });
}

// 按 id 取已存凭据测试连通性（前端不传明文）
async function testLlmKey(id) {
  const current = loadLlm();
  const k = (current.api_keys || []).find((x) => x.id === id);
  if (!k || !k.api_key) return { ok: false, error: '未找到该 Key 或 Key 为空' };
  const llm = require('./llm');
  return llm.testConnectivity({ provider: k.provider, base_url: k.base_url, api_key: k.api_key, model: k.model });
}

// 拉取某 provider 真实模型列表
async function listLlmModels(input) {
  const llm = require('./llm');
  return llm.listModels({ provider: input.provider, base_url: input.base_url, api_key: input.api_key });
}

// ---------- AI 模型调度中心（Model Router）----------
// 读取 Router 配置；附带预设模型清单、任务标签与当前已配置 Key 的模型（供后台下拉）
function getRouterConfig() {
  const base = llm.getRouterConfig();
  const llmCfg = getLlmConfig();
  const keyModels = (llmCfg.api_keys || []).map((k) => k.model).filter(Boolean);
  const available = Array.from(new Set([...llm.ROUTER_PRESET_MODELS, ...keyModels]));
  const taskLabels = {};
  for (const t of llm.ROUTER_TASKS) taskLabels[t.key] = t.label;
  return { ...base, presets: llm.ROUTER_PRESET_MODELS, task_labels: taskLabels, available_models: available };
}

// 保存 Router 配置（委托 llm 做校验与合并）
function saveRouterConfig(body) {
  return llm.setRouterConfig(body);
}

// 成本与用量看板（聚合 model_calls 表）
function routerCostDashboard() {
  const db = getDb();
  const today = todayStr();
  const month = today.slice(0, 7);
  const tr = db.prepare(
    'SELECT COALESCE(SUM(tokens_in),0) ti, COALESCE(SUM(tokens_out),0) to_, COALESCE(SUM(cost_cents),0) cost, COUNT(*) c FROM model_calls WHERE day = ?'
  ).get(today);
  const mr = db.prepare(
    "SELECT COALESCE(SUM(tokens_in),0) ti, COALESCE(SUM(tokens_out),0) to_, COALESCE(SUM(cost_cents),0) cost, COUNT(*) c FROM model_calls WHERE day LIKE ?"
  ).get(month + '%');
  const byModel = db.prepare(
    'SELECT model, provider, COALESCE(SUM(tokens_in),0) tokens_in, COALESCE(SUM(tokens_out),0) tokens_out, COALESCE(SUM(cost_cents),0) cost_cents, COUNT(*) calls FROM model_calls GROUP BY model, provider ORDER BY cost_cents DESC'
  ).all();
  const byTask = db.prepare(
    'SELECT task, COUNT(*) calls, COALESCE(SUM(cost_cents),0) cost_cents FROM model_calls GROUP BY task ORDER BY calls DESC'
  ).all();
  return {
    today: { tokens_in: tr.ti, tokens_out: tr.to_, cost: tr.cost / 100, calls: tr.c },
    month: { tokens_in: mr.ti, tokens_out: mr.to_, cost: mr.cost / 100, calls: mr.c },
    byModel,
    byTask: byTask.map((r) => ({ task: r.task, calls: r.calls, cost: r.cost_cents / 100 })),
  };
}

// ---------- 聚合：用量 ----------
function usageStats() {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) c FROM usage_log').get().c;
  const byAction = {};
  for (const row of db.prepare('SELECT action, COUNT(*) c FROM usage_log GROUP BY action').all()) {
    byAction[row.action] = row.c;
  }
  const byDay = db.prepare(
    'SELECT day, action, COUNT(*) c FROM usage_log GROUP BY day, action ORDER BY day DESC LIMIT 30'
  ).all();
  const topUsers = db.prepare(
    'SELECT anon_id, COUNT(*) c FROM usage_log GROUP BY anon_id ORDER BY c DESC LIMIT 10'
  ).all();
  const today = new Date().toISOString().slice(0, 10);
  const todayRows = db.prepare('SELECT action, COUNT(*) c FROM usage_log WHERE day = ? GROUP BY action').all(today);
  const todayByAction = {};
  for (const r of todayRows) todayByAction[r.action] = r.c;
  return { total, byAction, byDay, topUsers, today, todayByAction };
}

// ---------- 聚合：用户 ----------
function usersStat() {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  const proCount = db.prepare(
    "SELECT COUNT(*) c FROM users WHERE membership = 'pro' AND membership_expires_at > ?"
  ).get(new Date().toISOString()).c;
  const balRow = db.prepare('SELECT COALESCE(SUM(balance_cents),0) s FROM users').get();
  const today = new Date().toISOString().slice(0, 10);
  const todayNew = db.prepare('SELECT COUNT(*) c FROM users WHERE created_at >= ?').get(today + 'T00:00:00').c;
  const totalBalance = balRow ? balRow.s : 0;
  return { total, proCount, totalBalanceCents: totalBalance, todayNew };
}

// 单用户详细信息（含充值/消费流水），供后台用户详情弹窗
function userDetail(userId) {
  const db = getDb();
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u) return null;
  const recharges = db.prepare(
    'SELECT id, amount_cents, method, status, created_at FROM recharges WHERE user_id = ? ORDER BY created_at DESC'
  ).all(userId);
  const sessionCount = db.prepare(
    'SELECT COUNT(*) c FROM sessions WHERE user_id = ? AND expires_at > ?'
  ).get(userId, new Date().toISOString()).c;
  return { user: u, recharges, sessionCount };
}

// ---------- 聚合：仪表盘 ----------
function dashboard() {
  return {
    inventory: inventory.summary(),
    usage: usageStats(),
    users: usersStat(),
  };
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

module.exports = {
  ADMIN_PASSWORD,
  login,
  logout,
  authenticate,
  getConfig,
  setConfig,
  getLlmConfig,
  addLlmKey,
  deleteLlmKey,
  updateLlmKey,
  activateLlmKey,
  testLlmKey,
  listLlmModels,
  getRouterConfig,
  saveRouterConfig,
  routerCostDashboard,
  usageStats,
  usersStat,
  userDetail,
  dashboard,
  todayStr,
};
