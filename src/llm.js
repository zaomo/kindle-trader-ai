'use strict';
/**
 * 可选的 LLM 客户端 —— 框架式「多 Key 列表」配置（参考可移植 API 配置框架）。
 *
 * 数据模型（admin_config('llm')，唯一真相源）：
 *   {
 *     api_keys: [
 *       { id, provider, api_key, base_url, model, label, created_at, enabled },
 *       ...
 *     ],
 *     active_llm: <id>          // 当前生效的 LLM key id
 *   }
 * 每条 Key 自带 provider / base_url / model，可混合多家厂商；active_llm 决定当前用哪条。
 * 调用失败自动尝试列表里其它 enabled 的 Key（轮询兜底），全部失败回退 null（本地生成）。
 *
 * Provider 注册表（决定可选厂商与默认 base_url / model）：
 *   openai    OpenAI 兼容（gpt 系列）
 *   anthropic Anthropic Claude（Messages API，非 OpenAI 兼容）
 *   zhipu     智谱 GLM（OpenAI 兼容）
 *   alibaba   阿里云百炼 / 通义千问（OpenAI 兼容）
 *
 * 配置来源优先级（高→低）：环境变量（单 provider）> 数据库 api_keys。
 *
 * 设计原则：硬性价格数字始终由业务层计算后注入，LLM 仅做口语化润色，绝不编造价格。
 */
const { getDb } = require('./db');

// Provider 注册表：kind=openai 走 OpenAI 兼容接口，kind=anthropic 走 Anthropic Messages API
const LLM_PROVIDERS = {
  openai: { name: 'OpenAI', kind: 'openai', base_url: 'https://api.openai.com/v1', model: 'gpt-4o' },
  anthropic: { name: 'Anthropic Claude', kind: 'anthropic', base_url: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-6' },
  zhipu: { name: '智谱 GLM', kind: 'openai', base_url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  alibaba: { name: '阿里云百炼（通义千问）', kind: 'openai', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
};

// 预置模型清单（接口不可用时兜底；/models 拉取失败时使用）
const PRESET_MODELS = {
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1', 'o3-mini'],
  anthropic: ['claude-sonnet-4-6', 'claude-opus-4', 'claude-haiku-4'],
  zhipu: ['glm-4-flash', 'glm-4-plus', 'glm-4-air', 'glm-4-long'],
  alibaba: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen2.5-72b-instruct', 'qwen-long'],
};

function providerMeta(provider) {
  return LLM_PROVIDERS[provider] || null;
}

// 从环境变量解析单条配置（优先级最高）
function resolveEnv() {
  const p = (process.env.LLM_PROVIDER || '').toLowerCase();
  const map = {
    openai: { key: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL },
    anthropic: { key: process.env.ANTHROPIC_API_KEY, model: process.env.CLAUDE_MODEL },
    zhipu: { key: process.env.ZHIPU_API_KEY || process.env.GLM_API_KEY, model: process.env.ZHIPU_MODEL },
    alibaba: { key: process.env.DASHSCOPE_API_KEY || process.env.ALIYUN_API_KEY, model: process.env.DASHSCOPE_MODEL || process.env.ALIYUN_MODEL },
  };
  if (p && map[p] && map[p].key) {
    const meta = LLM_PROVIDERS[p];
    return {
      provider: p,
      kind: meta.kind,
      base_url: meta.base_url,
      api_key: map[p].key,
      model: map[p].model || meta.model,
    };
  }
  // 未显式指定 provider 时，若设有 ANTHROPIC_API_KEY 仍当作 anthropic
  if (process.env.ANTHROPIC_API_KEY) {
    return { provider: 'anthropic', kind: 'anthropic', base_url: LLM_PROVIDERS.anthropic.base_url, api_key: process.env.ANTHROPIC_API_KEY, model: process.env.CLAUDE_MODEL || LLM_PROVIDERS.anthropic.model };
  }
  return null;
}

// 读取数据库 api_keys（含旧结构自动迁移）
function readKeys() {
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM admin_config WHERE key = 'llm'").get();
    if (!row || !row.value) return { api_keys: [], active_llm: null };
    const c = JSON.parse(row.value);
    if (Array.isArray(c.api_keys)) return { api_keys: c.api_keys, active_llm: c.active_llm || null };
    // 旧结构 {provider, model, keys:[...], activeId} → 迁移
    return migrateOld(c);
  } catch (e) {
    return { api_keys: [], active_llm: null };
  }
}

function migrateOld(c) {
  const provider = c.provider || 'off';
  if (provider === 'off') return { api_keys: [], active_llm: null };
  const meta = LLM_PROVIDERS[provider];
  const oldKeys = Array.isArray(c.keys) ? c.keys : (c.key ? [{ id: c.activeId || 'k_legacy', label: '默认', key: c.key, createdAt: '', enabled: true }] : []);
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

// 候选凭据列表：active 优先，其余 enabled 的 Key 随后（用于轮询兜底）
function resolveCandidates() {
  const env = resolveEnv();
  if (env) return [env];
  const { api_keys, active_llm } = readKeys();
  const usable = api_keys.filter((k) => k && k.api_key && k.enabled !== false);
  if (!usable.length) return [];
  let ordered = [];
  const active = usable.find((k) => k.id === active_llm);
  if (active) ordered = [active, ...usable.filter((k) => k.id !== active_llm)];
  else ordered = usable;
  return ordered.map((k) => {
    const meta = providerMeta(k.provider) || {};
    return {
      provider: k.provider,
      kind: meta.kind || (k.provider === 'anthropic' ? 'anthropic' : 'openai'),
      base_url: k.base_url || (meta ? meta.base_url : ''),
      api_key: k.api_key,
      model: k.model || (meta ? meta.model : ''),
    };
  });
}

/** 当前生效的 provider（运行时解析），未配置返回 null */
function getProvider() {
  const candidates = resolveCandidates();
  return candidates.length ? candidates[0].provider : null;
}

/** 是否已配置可用的 LLM */
function isConfigured() {
  return resolveCandidates().length > 0;
}

/**
 * 调用 LLM。失败时返回 null（调用方应回退到本地生成）。
 * 多个可用 Key 时依次尝试，首个成功即返回；全部失败回退 null。
 */
async function complete(system, userPrompt) {
  const candidates = resolveCandidates();
  if (!candidates.length) return null;
  for (const c of candidates) {
    try {
      let text;
      if (c.kind === 'anthropic') text = await completeAnthropic(c.api_key, c.model, system, userPrompt);
      else text = await completeOpenAI(c.base_url + '/chat/completions', c.api_key, c.model, system, userPrompt);
      if (text) return text;
      console.warn('[llm] key 返回空，尝试下一个');
    } catch (e) {
      console.warn('[llm] key 调用失败，尝试下一个:', e.message);
    }
  }
  console.warn('[llm] 所有可用 key 均失败，回退本地生成');
  return null;
}

async function completeAnthropic(key, model, system, userPrompt) {
  const API_URL = 'https://api.anthropic.com/v1/messages';
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 600, system, messages: [{ role: 'user', content: userPrompt }] }),
  });
  if (!res.ok) { console.warn('[llm] Anthropic 返回非 200:', res.status); throw new Error('Anthropic HTTP ' + res.status); }
  const data = await res.json();
  const text = (data.content || []).map((b) => b.text || '').join('');
  return text.trim() || null;
}

// OpenAI 兼容接口（智谱 / 阿里云百炼 / OpenAI 共用），差异仅在 base_url
// opts: { max_tokens, temperature, top_p } 可选
async function completeOpenAI(endpoint, key, model, system, userPrompt, opts) {
  const o = opts || {};
  const max_tokens = Math.min(8000, Math.max(1, Number(o.max_tokens) || 600));
  const body = {
    model,
    max_tokens,
    messages: [{ role: 'system', content: system }, { role: 'user', content: userPrompt }],
  };
  if (typeof o.temperature === 'number') body.temperature = o.temperature;
  if (typeof o.top_p === 'number') body.top_p = o.top_p;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify(body),
  });
  if (!res.ok) { console.warn('[llm] OpenAI 兼容接口返回非 200:', res.status); throw new Error('OpenAI-compatible HTTP ' + res.status); }
  const data = await res.json();
  const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return (text || '').trim() || null;
}

/**
 * 按已存凭据测试连通性（取候选里匹配 provider/base_url/key 的那条）。
 * 用于「测试」按钮，前端不传明文。返回 { ok, model, latencyMs, error }。
 */
async function testConnectivity(target) {
  const t0 = Date.now();
  try {
    // target: { provider, base_url, api_key, model } 由调用方从已存 api_keys 取出
    const kind = (providerMeta(target.provider) || {}).kind || (target.provider === 'anthropic' ? 'anthropic' : 'openai');
    const model = target.model || (providerMeta(target.provider) || {}).model;
    let text;
    if (kind === 'anthropic') text = await completeAnthropic(target.api_key, model, 'ping', '请只回复 OK');
    else text = await completeOpenAI(target.base_url + '/chat/completions', target.api_key, model, 'ping', '请只回复 OK');
    return { ok: Boolean(text), model, latencyMs: Date.now() - t0, error: text ? null : '返回为空' };
  } catch (e) {
    return { ok: false, model: target.model || (providerMeta(target.provider) || {}).model, latencyMs: Date.now() - t0, error: e.message };
  }
}

/**
 * 拉取某 provider 的真实模型列表（OpenAI 兼容走 GET /models）。
 * 失败时用预置清单兜底。返回 string[]。
 */
async function listModels(input) {
  const provider = (input.provider || '').toLowerCase();
  const meta = providerMeta(provider);
  const base_url = input.base_url || (meta ? meta.base_url : '');
  const api_key = input.api_key || '';
  if (!base_url || !api_key) return PRESET_MODELS[provider] || [];
  if (meta && meta.kind === 'anthropic') {
    // Anthropic 无公开 /models 列表，直接返回预置
    return PRESET_MODELS[provider] || [];
  }
  try {
    const res = await fetch(base_url + '/models', { headers: { authorization: 'Bearer ' + api_key } });
    if (!res.ok) return PRESET_MODELS[provider] || [];
    const data = await res.json();
    const ids = (data.data || []).map((m) => m.id).filter(Boolean);
    if (!ids.length) return PRESET_MODELS[provider] || [];
    // 优先返回文本生成类模型（含 chat/completions 能力的）
    const chatModels = ids.filter((id) => !/embed|rerank|vision|image|audio|tts|realtime|omni/i.test(id));
    return (chatModels.length ? chatModels : ids).slice(0, 60);
  } catch (e) {
    return PRESET_MODELS[provider] || [];
  }
}

// 导出见文件末尾（Model Router 定义之后，避免 const TDZ）

// ===================== Model Router（AI 模型调度中心）=====================
// 参考《Kindle Trader AI V2.0》第 4 章：统一管理大模型 API，按任务类型自动路由到最合适模型，
// 支持自动降级（Failover）、成本控制与多模型配置。价格数字始终由业务层计算，模型只做润色/推理。

// 任务类型注册表：每个任务默认路由到的模型（来自文档 4.2/4.3 的 Qwen 推荐模型）
const ROUTER_TASKS = [
  { key: 'market_analysis', label: '行情分析', default_model: 'Qwen3-32B-Instruct' },
  { key: 'pricing', label: 'AI 定价', default_model: 'Qwen3-235B-A22B-Instruct' },
  { key: 'profit', label: '利润解释', default_model: 'Qwen3-32B-Instruct' },
  { key: 'risk', label: '风险评分', default_model: 'Qwen3-235B-A22B-Instruct' },
  { key: 'vision', label: '图片验机', default_model: 'Qwen-VL-Max', kind: 'vision' },
  { key: 'ocr', label: 'OCR 商品信息', default_model: 'Qwen-VL-Plus', kind: 'vision' },
  { key: 'copywriting', label: '文案生成', default_model: 'Qwen3-32B-Instruct' },
  { key: 'case_summary', label: '案例总结', default_model: 'Qwen3-32B-Instruct' },
  { key: 'sop', label: 'SOP 推荐', default_model: 'Qwen3-32B-Instruct' },
  { key: 'purchase', label: '采购决策', default_model: 'Qwen3-235B-A22B-Instruct' },
];

// 预设可选模型清单（供后台下拉；也可自动合并已配置 Key 的模型）
const ROUTER_PRESET_MODELS = [
  'Qwen3-235B-A22B-Instruct', 'Qwen3-32B-Instruct', 'Qwen3-8B-Instruct',
  'Qwen-VL-Max', 'Qwen-VL-Plus',
  'Text-Embedding-V3', 'Text-Rerank',
  'qwen-plus', 'qwen-max', 'qwen-turbo',
  'glm-4-flash', 'glm-4-plus',
  'claude-sonnet-4-6', 'gpt-4o',
];

function defaultRouterConfig() {
  const task_models = {};
  for (const t of ROUTER_TASKS) task_models[t.key] = t.default_model;
  return {
    task_models,
    auto_degrade: true,    // 自动降级（Failover）
    multi_model: false,    // 多模型协同
    max_tokens: 2000,
    temperature: 0.7,
    top_p: 0.9,
    max_concurrency: 4,
    timeout_ms: 30000,
  };
}

// 读取 Router 配置（合并默认值，保证字段完整）
function getRouterConfig() {
  let cfg = defaultRouterConfig();
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM admin_config WHERE key = 'model_router'").get();
    if (row && row.value) {
      const saved = JSON.parse(row.value);
      cfg = Object.assign(cfg, saved);
      cfg.task_models = Object.assign({}, defaultRouterConfig().task_models, saved.task_models || {});
    }
  } catch (e) { /* 用默认 */ }
  return cfg;
}

// 保存 Router 配置（校验 + 合并默认值 + 补齐全任务映射）
function setRouterConfig(input) {
  if (!input || typeof input !== 'object') throw new Error('配置必须是对象');
  const cur = getRouterConfig();
  const out = Object.assign({}, cur);
  if (input.task_models && typeof input.task_models === 'object') {
    for (const t of ROUTER_TASKS) {
      if (input.task_models[t.key] != null) out.task_models[t.key] = String(input.task_models[t.key]);
    }
  }
  if (typeof input.auto_degrade === 'boolean') out.auto_degrade = input.auto_degrade;
  if (typeof input.multi_model === 'boolean') out.multi_model = input.multi_model;
  const num = (v, min, max, dflt) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(max, Math.max(min, n));
  };
  if (input.max_tokens != null) out.max_tokens = num(input.max_tokens, 1, 8000, cur.max_tokens);
  if (input.temperature != null) out.temperature = num(input.temperature, 0, 2, cur.temperature);
  if (input.top_p != null) out.top_p = num(input.top_p, 0, 1, cur.top_p);
  if (input.max_concurrency != null) out.max_concurrency = num(input.max_concurrency, 1, 50, cur.max_concurrency);
  if (input.timeout_ms != null) out.timeout_ms = num(input.timeout_ms, 500, 120000, cur.timeout_ms);
  const db = getDb();
  const exists = db.prepare("SELECT 1 FROM admin_config WHERE key = 'model_router'").get();
  const json = JSON.stringify(out);
  if (exists) db.prepare("UPDATE admin_config SET value = ? WHERE key = 'model_router'").run(json);
  else db.prepare("INSERT INTO admin_config (key, value) VALUES ('model_router', ?)").run(json);
  return out;
}

// 解析某任务的候选凭据列表：目标模型优先，其余按 active 优先顺序兜底（自动降级链）
function resolveRouter(taskType) {
  const cfg = getRouterConfig();
  const candidates = resolveCandidates();
  if (!candidates.length) return [];
  const targetModel = (cfg.task_models && cfg.task_models[taskType]) || null;
  if (!targetModel) return candidates;
  const matched = candidates.filter((c) => c.model === targetModel);
  const rest = candidates.filter((c) => c.model !== targetModel);
  return [...matched, ...rest];
}

// 估算 token 数（中英文混合粗略估算）
function estTokens(s) {
  if (!s) return 0;
  // 英文/数字约 4 字符=1 token；中文约 1.5 字符=1 token。粗略用字符数/2。
  return Math.max(1, Math.ceil(String(s).length / 2));
}

// 估算单次调用成本（分）：按模型族给每 1K token 的 blended 单价
function estimateCost(model, tokensIn, tokensOut) {
  const m = (model || '').toLowerCase();
  let per1k; // 元 / 1K tokens（in+out 合计）
  if (m.includes('235b')) per1k = 0.012;
  else if (m.includes('32b')) per1k = 0.004;
  else if (m.includes('8b')) per1k = 0.0012;
  else if (m.includes('vl-max')) per1k = 0.02;
  else if (m.includes('vl-plus')) per1k = 0.008;
  else if (m.includes('embedding') || m.includes('rerank')) per1k = 0.0008;
  else per1k = 0.004; // 默认
  const total = (tokensIn + tokensOut) / 1000;
  return Math.round(total * per1k * 100); // 分
}

function recordModelUsage(model, provider, task, tokensIn, tokensOut, latencyMs) {
  try {
    const db = getDb();
    const cost = estimateCost(model, tokensIn, tokensOut);
    db.prepare(
      "INSERT INTO model_calls (model, provider, task, tokens_in, tokens_out, cost_cents, latency_ms, day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(model, provider, task, tokensIn, tokensOut, cost, latencyMs, new Date().toISOString().slice(0, 10), new Date().toISOString());
  } catch (e) {
    console.warn('[router] 记录用量失败:', e.message);
  }
}

/**
 * 经 Model Router 调用 LLM：按任务类型路由 + 自动降级。
 * 任务级 max_tokens/temperature/top_p 来自 Router 配置；逐候选尝试，成功即返回；
 * 全部失败回退 null（调用方应回退本地生成）。每次成功调用记录用量与估算成本。
 */
async function routerComplete(taskType, system, userPrompt) {
  const cfg = getRouterConfig();
  const candidates = resolveRouter(taskType);
  if (!candidates.length) return null;
  const opts = { max_tokens: cfg.max_tokens, temperature: cfg.temperature, top_p: cfg.top_p };
  const targetModel = (cfg.task_models && cfg.task_models[taskType]) || null;
  for (const c of candidates) {
    try {
      const t0 = Date.now();
      // 始终用候选 Key 自身配置的模型（provider 端点真正接受的模型名）发起调用；
      // task_models 仅用于「选 Key 偏好」与成本估算，不直接当作 API model 参数，
      // 否则当文档目标模型名与已配置 Key 的实际模型不一致时会调用失败。
      const model = c.model;
      let text;
      if (c.kind === 'anthropic') text = await completeAnthropic(c.api_key, model, system, userPrompt);
      else text = await completeOpenAI(c.base_url + '/chat/completions', c.api_key, model, system, userPrompt, opts);
      const dt = Date.now() - t0;
      if (text) {
        recordModelUsage(model, c.provider, taskType, estTokens(system + userPrompt), estTokens(text), dt);
        return text;
      }
      console.warn('[router] 返回空，尝试降级下一个');
    } catch (e) {
      console.warn('[router] 调用失败:', e.message);
      if (!cfg.auto_degrade) break; // 关闭自动降级则不再尝试后续候选
    }
  }
  return null;
}

// 公开状态（供用户端展示，绝不返回 Key）
function getRouterStatus() {
  const cfg = getRouterConfig();
  const candidates = resolveCandidates();
  const active = candidates[0] || null;
  const labels = {};
  for (const t of ROUTER_TASKS) labels[t.key] = t.label;
  return {
    enabled: candidates.length > 0,
    active_provider: active ? active.provider : null,
    active_model: active ? active.model : null,
    auto_degrade: !!cfg.auto_degrade,
    multi_model: !!cfg.multi_model,
    tasks: cfg.task_models || {},
    task_labels: labels,
  };
}

module.exports = { complete, isConfigured, getProvider, testConnectivity, listModels, LLM_PROVIDERS, PRESET_MODELS, routerComplete, resolveRouter, getRouterConfig, setRouterConfig, getRouterStatus, ROUTER_TASKS, ROUTER_PRESET_MODELS };
