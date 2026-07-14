'use strict';
// 独立 Admin 后台前端逻辑
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

let TOKEN = localStorage.getItem('kta_admin_token') || '';

// ---------- 通用请求 ----------
async function api(method, path, body) {
  const headers = { 'content-type': 'application/json' };
  if (TOKEN) headers['authorization'] = 'Bearer ' + TOKEN;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) {
    TOKEN = ''; localStorage.removeItem('kta_admin_token');
    showLogin(); throw new Error('登录已失效，请重新登录');
  }
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show ' + kind;
  setTimeout(() => { t.className = 'toast'; }, 2600);
}

// ---------- 视图切换 ----------
function showLogin() {
  $('#loginView').style.display = 'flex';
  $('#appView').style.display = 'none';
}
function showApp() {
  $('#loginView').style.display = 'none';
  $('#appView').style.display = 'flex';
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginErr').textContent = '';
  try {
    const r = await api('POST', '/api/admin/login', { password: $('#loginPwd').value });
    TOKEN = r.token;
    localStorage.setItem('kta_admin_token', TOKEN);
    $('#loginPwd').value = '';
    showApp();
    loadSection('dashboard');
  } catch (err) {
    $('#loginErr').textContent = err.message;
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  try { await api('POST', '/api/admin/logout'); } catch {}
  TOKEN = ''; localStorage.removeItem('kta_admin_token');
  showLogin();
});

// ---------- 导航 ----------
$$('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.nav-item').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    loadSection(btn.dataset.sec);
  });
});

function loadSection(sec) {
  $$('.section').forEach((s) => s.classList.remove('active'));
  $('#sec-' + sec).classList.add('active');
  if (sec === 'dashboard') loadDashboard();
  if (sec === 'models') loadModels();
  if (sec === 'users') loadUsers();
  if (sec === 'pricing') loadConfig('pricing');
  if (sec === 'copywriting') loadConfig('copywriting');
  if (sec === 'usage') loadUsage();
  if (sec === 'ai') loadLlm();
  if (sec === 'router') loadRouter();
}

// ---------- 仪表盘 ----------
async function loadDashboard() {
  const d = await api('GET', '/api/admin/dashboard');
  const inv = d.inventory || {};
  const u = d.usage || {};
  $('#dashCards').innerHTML = [
    card('在库台数', inv.inStockCount ?? 0, ''),
    card('已售台数', inv.soldCount ?? 0, ''),
    card('累计利润', '¥' + (inv.totalProfit ?? 0), 'green'),
    card('平均周转(天)', inv.avgTurnoverDays ?? '-', 'accent'),
    card('今日定价调用', (u.todayByAction && u.todayByAction.pricing) || 0, ''),
    card('今日文案调用', (u.todayByAction && u.todayByAction.copywriting) || 0, ''),
  ].join('');

  $('#dashInv').innerHTML = `
    <ul class="kv">
      <li><span>在库</span><b>${inv.inStockCount ?? 0}</b></li>
      <li><span>已售</span><b>${inv.soldCount ?? 0}</b></li>
      <li><span>累计利润</span><b class="green">¥${inv.totalProfit ?? 0}</b></li>
      <li><span>平均周转</span><b>${inv.avgTurnoverDays ?? '-'} 天</b></li>
    </ul>`;

  const tb = u.todayByAction || {};
  $('#dashUsage').innerHTML = `
    <ul class="kv">
      <li><span>今日定价</span><b>${tb.pricing || 0}</b></li>
      <li><span>今日文案</span><b>${tb.copywriting || 0}</b></li>
      <li><span>累计总调用</span><b>${u.total || 0}</b></li>
    </ul>`;

  const us = d.users || {};
  $('#dashUsers').innerHTML = `
    <ul class="kv">
      <li><span>总用户</span><b>${us.total ?? 0}</b></li>
      <li><span>Pro 会员</span><b class="accent">${us.proCount ?? 0}</b></li>
      <li><span>今日新增</span><b>${us.todayNew ?? 0}</b></li>
      <li><span>账户总余额</span><b class="green">¥${((us.totalBalanceCents || 0) / 100).toFixed(2)}</b></li>
    </ul>`;
}
function card(label, value, cls) {
  return `<div class="card"><div class="label">${label}</div><div class="value ${cls}">${value}</div></div>`;
}

// ---------- 型号管理 ----------
async function loadModels() {
  const { models } = await api('GET', '/api/admin/models');
  $('#modelCount').textContent = models.length;
  const tb = $('#modelTable tbody');
  tb.innerHTML = models.map((m) => `
    <tr>
      <td>${m.id}</td>
      <td>${m.name}</td>
      <td>${m.family || '-'}</td>
      <td>${m.screen_size ?? '-'}</td>
      <td>${m.release_year ?? '-'}</td>
      <td>¥${m.ref_low} - ¥${m.ref_high}</td>
      <td>${m.sample_size}</td>
      <td>${m.updated_at}</td>
      <td><div class="ops">
        <button class="mini" data-edit="${m.id}">编辑</button>
        <button class="mini" data-regen="${m.id}">刷历史</button>
        <button class="danger" data-del="${m.id}">删除</button>
      </div></td>
    </tr>`).join('');

  tb.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => fillModelForm(models.find((m) => m.id == b.dataset.edit))));
  tb.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => delModel(b.dataset.del)));
  tb.querySelectorAll('[data-regen]').forEach((b) => b.addEventListener('click', () => regenHistory(b.dataset.regen)));
}

function fillModelForm(m) {
  $('#m_id').value = m.id;
  $('#m_name').value = m.name;
  $('#m_family').value = m.family || '';
  $('#m_generation').value = m.generation || '';
  $('#m_screen').value = m.screen_size ?? '';
  $('#m_year').value = m.release_year ?? '';
  $('#m_sample').value = m.sample_size ?? '';
  $('#m_low').value = m.ref_low;
  $('#m_high').value = m.ref_high;
  $('#modelFormTitle').textContent = '编辑型号 #' + m.id;
  $('#modelCancel').style.display = 'inline-block';
}

$('#modelCancel').addEventListener('click', resetModelForm);
function resetModelForm() {
  $('#modelForm').reset();
  $('#m_id').value = '';
  $('#modelFormTitle').textContent = '新增型号';
  $('#modelCancel').style.display = 'none';
}

$('#modelForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#m_id').value;
  const payload = {
    name: $('#m_name').value.trim(),
    family: $('#m_family').value.trim(),
    generation: $('#m_generation').value.trim(),
    screen_size: $('#m_screen').value ? Number($('#m_screen').value) : null,
    release_year: $('#m_year').value ? Number($('#m_year').value) : null,
    sample_size: $('#m_sample').value ? Number($('#m_sample').value) : 0,
    ref_low: Number($('#m_low').value),
    ref_high: Number($('#m_high').value),
  };
  try {
    if (id) {
      await api('PUT', '/api/admin/models/' + id, payload);
      toast('已更新型号', 'ok');
    } else {
      await api('POST', '/api/admin/models', payload);
      toast('已新增型号', 'ok');
    }
    resetModelForm();
    loadModels();
  } catch (err) { toast(err.message, 'err'); }
});

async function delModel(id) {
  if (!confirm('确认删除该型号及其历史趋势？')) return;
  try {
    await api('DELETE', '/api/admin/models/' + id);
    toast('已删除', 'ok');
    loadModels();
  } catch (err) { toast(err.message, 'err'); }
}

async function regenHistory(id) {
  try {
    await api('POST', '/api/admin/models/' + id + '/regen-history');
    toast('历史趋势已重生成', 'ok');
  } catch (err) { toast(err.message, 'err'); }
}

// ---------- 配置（定价 / 文案） ----------
async function loadConfig(kind) {
  const cfg = await api('GET', '/api/admin/config');
  const ta = kind === 'pricing' ? $('#pricingJson') : $('#copyJson');
  ta.value = JSON.stringify(cfg[kind], null, 2);
  const msg = kind === 'pricing' ? $('#pricingMsg') : $('#copyMsg');
  msg.textContent = '';
}

async function saveConfig(kind) {
  const ta = kind === 'pricing' ? $('#pricingJson') : $('#copyJson');
  const msg = kind === 'pricing' ? $('#pricingMsg') : $('#copyMsg');
  let obj;
  try { obj = JSON.parse(ta.value); }
  catch (e) { msg.textContent = 'JSON 格式错误：' + e.message; msg.className = 'msg err'; return; }
  try {
    await api('PUT', '/api/admin/config', { [kind]: obj });
    msg.textContent = '已保存并立即生效'; msg.className = 'msg ok';
    toast(kind === 'pricing' ? '定价规则已更新' : '文案模板已更新', 'ok');
  } catch (err) { msg.textContent = err.message; msg.className = 'msg err'; }
}

async function resetConfig(kind) {
  try {
    const def = await api('GET', '/api/admin/config-default');
    const ta = kind === 'pricing' ? $('#pricingJson') : $('#copyJson');
    ta.value = JSON.stringify(def[kind], null, 2);
    await api('PUT', '/api/admin/config', { [kind]: def[kind] });
    const msg = kind === 'pricing' ? $('#pricingMsg') : $('#copyMsg');
    msg.textContent = '已恢复默认并保存'; msg.className = 'msg ok';
    toast(kind === 'pricing' ? '定价规则已恢复默认' : '文案模板已恢复默认', 'ok');
  } catch (err) { toast(err.message, 'err'); }
}

$('#pricingSave').addEventListener('click', () => saveConfig('pricing'));
$('#copySave').addEventListener('click', () => saveConfig('copywriting'));

// ---------- AI 模型配置 ----------
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 根据选中服务商动态更新 Key 占位提示
function updateProviderUI(provider) {
  const keyEl = $('#llmKey');
  const modelEl = $('#llmModel');
  const map = {
    zhipu: ['粘贴你的智谱 API Key', '留空用默认 glm-4-flash（可选 glm-4-plus 等）'],
    alibaba: ['粘贴你的阿里云百炼 DashScope API Key', '留空用默认 qwen-plus（可选 qwen-max / qwen-turbo）'],
    anthropic: ['粘贴你的 Claude API Key（x-api-key）', '留空用默认 claude-sonnet-4-6'],
    openai: ['粘贴你的 OpenAI API Key', '留空用默认 gpt-4o'],
  };
  const p = map[provider] || ['粘贴对应厂商的 API Key', '模型（可选）'];
  keyEl.placeholder = p[0];
  modelEl.placeholder = p[1];
}

async function loadLlm() {
  const cfg = await api('GET', '/api/admin/llm');
  $('#llmMsg').textContent = '';
  $('#llmModelList').innerHTML = '';
  renderLlmKeys(cfg);
}

// 渲染已添加 Key 列表，并绑定行内操作（事件委托）
function renderLlmKeys(cfg) {
  const wrap = $('#llmKeysList');
  const empty = $('#llmKeysEmpty');
  const count = $('#llmKeysCount');
  const keys = cfg.api_keys || [];
  count.textContent = String(keys.length);
  wrap.innerHTML = '';
  if (!keys.length) { empty.style.display = 'block'; return; }
  empty.style.display = 'none';
  keys.forEach((k) => {
    const isActive = cfg.active_llm === k.id;
    const row = document.createElement('div');
    row.className = 'llm-key-row' + (isActive ? ' active' : '');
    row.innerHTML =
      '<div class="lk-info">' +
        '<div class="lk-main">' +
          '<span class="lk-provider">' + escapeHtml(k.provider_name || k.provider) + '</span>' +
          (k.label ? '<span class="lk-label">' + escapeHtml(k.label) + '</span>' : '') +
          (isActive ? '<span class="lk-badge active">当前使用</span>' : '') +
          (k.enabled ? '' : '<span class="lk-badge off">已停用</span>') +
        '</div>' +
        '<div class="lk-sub">' + escapeHtml(k.key_preview) + (k.model ? ' · ' + escapeHtml(k.model) : '') + '</div>' +
      '</div>' +
      '<div class="lk-actions">' +
        (isActive ? '' : '<button class="btn-sm" data-act="activate" data-id="' + k.id + '">设为当前</button>') +
        '<button class="btn-sm" data-act="test" data-id="' + k.id + '">测试</button>' +
        '<button class="btn-sm" data-act="edit" data-id="' + k.id + '">编辑</button>' +
        (k.enabled ? '<button class="btn-sm" data-act="toggle" data-id="' + k.id + '" data-enabled="true">停用</button>'
                    : '<button class="btn-sm" data-act="toggle" data-id="' + k.id + '" data-enabled="false">启用</button>') +
        '<button class="btn-sm danger" data-act="del" data-id="' + k.id + '">删除</button>' +
      '</div>';
    wrap.appendChild(row);
  });
  // 事件委托
  wrap.onclick = async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.dataset.id;
    const act = btn.dataset.act;
    const msg = $('#llmMsg');
    try {
      let r;
      if (act === 'del') {
        if (!confirm('确定删除该 Key？此操作不可撤销。')) return;
        r = await api('DELETE', '/api/admin/llm/key/' + id);
        msg.textContent = '已删除 Key';
      } else if (act === 'activate') {
        r = await api('POST', '/api/admin/llm/key/' + id + '/activate');
        msg.textContent = '已设为当前使用';
      } else if (act === 'test') {
        msg.textContent = '测试中…'; msg.className = 'msg';
        const res = await api('POST', '/api/admin/llm/key/' + id + '/test');
        msg.textContent = res.ok ? ('✅ 连接成功（' + (res.model || '') + '，' + res.latencyMs + 'ms）') : ('❌ 测试失败：' + res.error);
        msg.className = 'msg ' + (res.ok ? 'ok' : 'err');
        return;
      } else if (act === 'edit') {
        return openLlmModal(id);
      } else if (act === 'toggle') {
        const enabled = btn.dataset.enabled !== 'true';
        r = await api('PUT', '/api/admin/llm/key/' + id, { enabled });
        msg.textContent = enabled ? '已启用' : '已停用';
      }
      msg.className = 'msg ok';
      renderLlmKeys(r);
    } catch (err) {
      msg.textContent = err.message;
      msg.className = 'msg err';
    }
  };
}

// 打开添加 / 编辑弹窗
async function openLlmModal(editId) {
  const cfg = await api('GET', '/api/admin/llm');
  $('#llmEditId').value = editId || '';
  $('#llmMsg').textContent = '';
  $('#llmModelList').innerHTML = '';
  if (editId) {
    const k = (cfg.api_keys || []).find((x) => x.id === editId);
    $('#llmModalTitle').textContent = '编辑模型 Key';
    $('#llmProvider').value = k.provider;
    $('#llmKey').value = '';                 // 编辑时不回显明文，留空则保留原 Key
    $('#llmKeyHint').textContent = '留空则保留原 Key';
    $('#llmBaseUrl').value = k.base_url || '';
    $('#llmModel').value = k.model || '';
    $('#llmKeyLabel').value = k.label || '';
    $('#llmSetActive').checked = (cfg.active_llm === editId);
  } else {
    $('#llmModalTitle').textContent = '添加模型 Key';
    $('#llmProvider').value = 'zhipu';
    $('#llmKey').value = '';
    $('#llmKeyHint').textContent = '';
    $('#llmBaseUrl').value = '';
    $('#llmModel').value = '';
    $('#llmKeyLabel').value = '';
    $('#llmSetActive').checked = !(cfg.api_keys || []).length; // 首个自动设为当前
  }
  updateProviderUI($('#llmProvider').value);
  $('#llmModal').style.display = 'flex';
}

function closeLlmModal() {
  $('#llmModal').style.display = 'none';
}

async function saveLlm() {
  const id = $('#llmEditId').value || undefined;
  const provider = $('#llmProvider').value;
  const apiKey = $('#llmKey').value.trim();
  const baseUrl = $('#llmBaseUrl').value.trim();
  const model = $('#llmModel').value.trim();
  const label = $('#llmKeyLabel').value.trim();
  const setActive = $('#llmSetActive').checked;
  const msg = $('#llmMsg');
  if (!apiKey && !id) { msg.textContent = '请填写 API Key'; msg.className = 'msg err'; return; }
  try {
    const r = await api('POST', '/api/admin/llm/key', { id, provider, api_key: apiKey, base_url: baseUrl, model, label, set_active: setActive });
    msg.textContent = (id ? '已更新' : '已添加') + '并立即生效';
    msg.className = 'msg ok';
    toast('AI 配置已更新', 'ok');
    closeLlmModal();
    renderLlmKeys(r);
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'msg err';
  }
}

// 拉取模型列表（📋 选择）
async function fetchModels() {
  const provider = $('#llmProvider').value;
  const baseUrl = $('#llmBaseUrl').value.trim();
  const apiKey = $('#llmKey').value.trim();
  const box = $('#llmModelList');
  box.innerHTML = '<div class="model-loading">拉取中…</div>';
  try {
    const r = await api('POST', '/api/admin/llm/models', { provider, base_url: baseUrl, api_key: apiKey });
    const models = r.models || [];
    if (!models.length) { box.innerHTML = '<div class="model-loading">无可用模型</div>'; return; }
    box.innerHTML = models.map((m) => '<button type="button" class="model-chip" data-m="' + escapeHtml(m) + '">' + escapeHtml(m) + '</button>').join('');
    box.querySelectorAll('.model-chip').forEach((chip) => {
      chip.onclick = () => { $('#llmModel').value = chip.dataset.m; box.innerHTML = ''; };
    });
  } catch (err) {
    box.innerHTML = '<div class="model-loading err">拉取失败：' + escapeHtml(err.message) + '</div>';
  }
}

$('#llmAddBtn').addEventListener('click', () => openLlmModal());
$('#llmModalClose').addEventListener('click', closeLlmModal);
$('#llmSave').addEventListener('click', saveLlm);
$('#llmProvider').addEventListener('change', (e) => updateProviderUI(e.target.value));
$('#llmFetchModels').addEventListener('click', fetchModels);
$('#pricingReset').addEventListener('click', () => resetConfig('pricing'));
$('#copyReset').addEventListener('click', () => resetConfig('copywriting'));

// ---------- 模型调度中心（Model Router）----------
async function loadRouter() {
  const cfg = await api('GET', '/api/admin/router');
  renderRouterTasks(cfg);
  $('#routerAutoDegrade').checked = !!cfg.auto_degrade;
  $('#routerMultiModel').checked = !!cfg.multi_model;
  $('#routerMaxTokens').value = cfg.max_tokens ?? 2000;
  $('#routerTimeout').value = cfg.timeout_ms ?? 30000;
  $('#routerTemp').value = cfg.temperature ?? 0.7;
  $('#routerTopP').value = cfg.top_p ?? 0.9;
  $('#routerConcurrency').value = cfg.max_concurrency ?? 4;
  await loadRouterCost();
}

function renderRouterTasks(cfg) {
  const wrap = $('#routerTaskTable');
  const labels = cfg.task_labels || {};
  const models = cfg.available_models || cfg.presets || [];
  const tasks = Object.keys(labels);
  wrap.innerHTML = tasks.map((key) => {
    const sel = '<select class="router-model-sel" data-task="' + key + '">' +
      models.map((m) => '<option value="' + escapeHtml(m) + '"' + (cfg.task_models[key] === m ? ' selected' : '') + '>' + escapeHtml(m) + '</option>').join('') +
      '</select>';
    return '<div class="router-task-row"><span class="rt-label">' + escapeHtml(labels[key]) + '</span><span class="rt-key">' + escapeHtml(key) + '</span>' + sel + '</div>';
  }).join('');
}

async function loadRouterCost() {
  try {
    const d = await api('GET', '/api/admin/router/cost');
    $('#routerCostCards').innerHTML = [
      card('今日 Token', ((d.today.tokens_in || 0) + (d.today.tokens_out || 0)).toLocaleString(), ''),
      card('本月 Token', ((d.month.tokens_in || 0) + (d.month.tokens_out || 0)).toLocaleString(), ''),
      card('今日调用', d.today.calls || 0, 'accent'),
      card('本月成本', '¥' + ((d.month.cost || 0)).toFixed(2), 'green'),
    ].join('');
    $('#routerModelTable tbody').innerHTML = (d.byModel || []).map((r) => `
      <tr><td>${escapeHtml(r.model)}</td><td>${escapeHtml(r.provider || '-')}</td><td>${((r.tokens_in || 0) + (r.tokens_out || 0)).toLocaleString()}</td><td>${r.calls}</td><td>¥${((r.cost_cents || 0) / 100).toFixed(2)}</td></tr>`).join('')
      || '<tr><td colspan="5">暂无调用记录</td></tr>';
    $('#routerTaskCostTable tbody').innerHTML = (d.byTask || []).map((r) => `
      <tr><td>${escapeHtml(r.task)}</td><td>${r.calls}</td><td>¥${(r.cost || 0).toFixed(2)}</td></tr>`).join('')
      || '<tr><td colspan="3">暂无调用记录</td></tr>';
  } catch (e) { /* 忽略看板错误 */ }
}

$('#routerSaveTasks').addEventListener('click', async () => {
  const msg = $('#routerTasksMsg');
  const task_models = {};
  $$('.router-model-sel').forEach((s) => { task_models[s.dataset.task] = s.value; });
  try {
    await api('PUT', '/api/admin/router', { task_models });
    msg.textContent = '路由策略已保存'; msg.className = 'msg ok';
    toast('路由策略已保存', 'ok');
  } catch (e) { msg.textContent = e.message; msg.className = 'msg err'; }
});

$('#routerSaveCfg').addEventListener('click', async () => {
  const msg = $('#routerCfgMsg');
  const num = (id, d) => { const v = Number($('#' + id).value); return Number.isFinite(v) ? v : d; };
  const body = {
    auto_degrade: $('#routerAutoDegrade').checked,
    multi_model: $('#routerMultiModel').checked,
    max_tokens: num('routerMaxTokens', 2000),
    timeout_ms: num('routerTimeout', 30000),
    temperature: num('routerTemp', 0.7),
    top_p: num('routerTopP', 0.9),
    max_concurrency: num('routerConcurrency', 4),
  };
  try {
    await api('PUT', '/api/admin/router', body);
    msg.textContent = '模型配置已保存'; msg.className = 'msg ok';
    toast('模型配置已保存', 'ok');
  } catch (e) { msg.textContent = e.message; msg.className = 'msg err'; }
});

// ---------- 用量 ----------
async function loadUsage() {
  const u = await api('GET', '/api/admin/usage');
  $('#usageCards').innerHTML = [
    card('累计总调用', u.total ?? 0, ''),
    card('今日定价', (u.todayByAction && u.todayByAction.pricing) || 0, 'accent'),
    card('今日文案', (u.todayByAction && u.todayByAction.copywriting) || 0, 'accent'),
    card('统计天数', (u.byDay || []).length, ''),
  ].join('');

  $('#usageTable tbody').innerHTML = (u.byDay || []).map((r) => `
    <tr><td>${r.day}</td><td>${r.action}</td><td>${r.c}</td></tr>`).join('') || '<tr><td colspan="3">暂无数据</td></tr>';

  $('#usageUsers tbody').innerHTML = (u.topUsers || []).map((r) => `
    <tr><td>${r.anon_id}</td><td>${r.c}</td></tr>`).join('') || '<tr><td colspan="2">暂无数据</td></tr>';
}

// ---------- 用户管理 ----------
let userPage = 1;
const userState = { q: '', membership: 'all', total: 0, pageSize: 20 };

async function loadUsers() {
  const { q, membership } = userState;
  const params = new URLSearchParams({ q, membership, page: userPage, pageSize: userState.pageSize });
  const d = await api('GET', '/api/admin/users?' + params.toString());
  userState.total = d.total;
  const s = d.stat || {};
  $('#userCards').innerHTML = [
    card('总用户', s.total ?? 0, ''),
    card('Pro 会员', s.proCount ?? 0, 'accent'),
    card('今日新增', s.todayNew ?? 0, ''),
    card('账户总余额', '¥' + (s.totalBalance ?? 0).toFixed(2), 'green'),
  ].join('');

  const tb = $('#userTable tbody');
  tb.innerHTML = (d.users || []).map((u) => `
    <tr>
      <td>${u.id}</td>
      <td>${u.nickname || '-'}</td>
      <td>${u.loginType || '-'}</td>
      <td class="acct">${u.email ? u.email : (u.wechat_openid ? '微信:' + u.wechat_openid : '-')}</td>
      <td class="num">¥${(u.balance || 0).toFixed(2)}</td>
      <td>${u.isPro ? '<span class="tag pro">Pro</span>' : '<span class="tag free">普通</span>'}</td>
      <td>${u.created_at ? u.created_at.slice(0, 10) : '-'}</td>
      <td><div class="ops">
        <button class="mini" data-view="${u.id}">详情</button>
        <button class="mini" data-bal="${u.id}">调账</button>
        <button class="danger" data-delu="${u.id}">删除</button>
      </div></td>
    </tr>`).join('') || '<tr><td colspan="8">暂无用户</td></tr>';

  tb.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => openUserModal(b.dataset.view)));
  tb.querySelectorAll('[data-bal]').forEach((b) => b.addEventListener('click', () => openBalModal(b.dataset.bal)));
  tb.querySelectorAll('[data-delu]').forEach((b) => b.addEventListener('click', () => deleteUser(b.dataset.delu)));

  renderUserPager();
}

function renderUserPager() {
  const total = userState.total;
  const pageSize = userState.pageSize;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  $('#userPager').innerHTML = `
    <button class="mini" data-pg="prev" ${userPage <= 1 ? 'disabled' : ''}>上一页</button>
    <span class="pg-info">第 ${userPage} / ${pages} 页 · 共 ${total} 人</span>
    <button class="mini" data-pg="next" ${userPage >= pages ? 'disabled' : ''}>下一页</button>`;
  $('#userPager').querySelectorAll('[data-pg]').forEach((b) => b.addEventListener('click', () => {
    const p = b.dataset.pg;
    if (p === 'prev' && userPage > 1) userPage--;
    if (p === 'next' && userPage < pages) userPage++;
    loadUsers();
  }));
}

$('#userSearch').addEventListener('input', debounce(() => { userPage = 1; userState.q = $('#userSearch').value.trim(); loadUsers(); }, 300));
$('#userFilter').addEventListener('change', () => { userPage = 1; userState.membership = $('#userFilter').value; loadUsers(); });
$('#userRefresh').addEventListener('click', () => loadUsers());

function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---- 详情弹窗 ----
async function openUserModal(id) {
  const d = await api('GET', '/api/admin/users/' + id);
  const u = d.user;
  const mem = u.isPro
    ? `<span class="tag pro">Pro</span> 到期 ${u.membership_expires_at ? u.membership_expires_at.slice(0, 10) : '-'}`
    : '<span class="tag free">普通用户</span>';
  const recs = (d.recharges || []).map((r) => `
    <tr><td>${r.id}</td><td>¥${r.amount.toFixed(2)}</td><td>${r.method}</td><td>${r.status}</td><td>${r.created_at ? r.created_at.slice(0, 10) : '-'}</td></tr>`).join('')
    || '<tr><td colspan="5">暂无记录</td></tr>';
  $('#umTitle').textContent = '用户 #' + u.id + ' · ' + (u.nickname || '-');
  $('#umBody').innerHTML = `
    <ul class="kv">
      <li><span>昵称</span><b>${u.nickname || '-'}</b></li>
      <li><span>邮箱</span><b>${u.email || '-'}</b></li>
      <li><span>微信</span><b>${u.wechat_openid || '-'}</b></li>
      <li><span>余额</span><b class="green">¥${u.balance.toFixed(2)}</b></li>
      <li><span>会员</span><b>${mem}</b></li>
      <li><span>活跃会话</span><b>${u.sessionCount || 0}</b></li>
      <li><span>注册时间</span><b>${u.created_at ? u.created_at.slice(0, 19).replace('T', ' ') : '-'}</b></li>
    </ul>
    <div class="form-actions" style="margin:10px 0">
      ${u.isPro
        ? '<button id="umRevoke" class="ghost">撤销会员</button>'
        : '<button id="umGrant">授予 Pro(30天)</button>'}
      <button id="umBal" class="mini">调整余额</button>
    </div>
    <h4>充值 / 消费记录</h4>
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>ID</th><th>金额</th><th>方式</th><th>状态</th><th>时间</th></tr></thead>
        <tbody>${recs}</tbody>
      </table>
    </div>`;
  $('#userModal').style.display = 'flex';
  const grant = $('#umGrant'); if (grant) grant.addEventListener('click', () => setMembership(u.id, 'pro', 30));
  const rev = $('#umRevoke'); if (rev) rev.addEventListener('click', () => setMembership(u.id, 'free', 0));
  const balBtn = $('#umBal'); if (balBtn) balBtn.addEventListener('click', () => { $('#userModal').style.display = 'none'; openBalModal(u.id); });
}
$('#umClose').addEventListener('click', () => { $('#userModal').style.display = 'none'; });
$('#userModal').addEventListener('click', (e) => { if (e.target.id === 'userModal') $('#userModal').style.display = 'none'; });

async function setMembership(id, membership, days) {
  try {
    await api('PUT', '/api/admin/users/' + id, { membership, membershipDays: days });
    toast(membership === 'pro' ? '已授予 Pro 会员' : '已撤销会员', 'ok');
    $('#userModal').style.display = 'none';
    loadUsers();
  } catch (err) { toast(err.message, 'err'); }
}

// ---- 调账弹窗 ----
let balUserId = null;
async function openBalModal(id) {
  const d = await api('GET', '/api/admin/users/' + id);
  balUserId = id;
  $('#balUser').textContent = `当前余额：¥${d.user.balance.toFixed(2)}（${d.user.nickname || d.user.email || '-'}）`;
  $('#balAmount').value = '';
  $('#balNote').value = '';
  $('#balMsg').textContent = '';
  $('#balModal').style.display = 'flex';
  $('#balAmount').focus();
}
$('#balClose').addEventListener('click', () => { $('#balModal').style.display = 'none'; });
$('#balModal').addEventListener('click', (e) => { if (e.target.id === 'balModal') $('#balModal').style.display = 'none'; });
$('#balSubmit').addEventListener('click', async () => {
  const amount = Number($('#balAmount').value);
  if (!Number.isFinite(amount) || amount === 0) { $('#balMsg').textContent = '请输入非零金额'; $('#balMsg').className = 'msg err'; return; }
  try {
    const r = await api('POST', '/api/admin/users/' + balUserId + '/adjust-balance', { amount, note: $('#balNote').value.trim() });
    $('#balMsg').textContent = '已调整，新余额 ¥' + r.balance.toFixed(2); $('#balMsg').className = 'msg ok';
    toast('余额已调整', 'ok');
    $('#balModal').style.display = 'none';
    loadUsers();
  } catch (err) { $('#balMsg').textContent = err.message; $('#balMsg').className = 'msg err'; }
});

async function deleteUser(id) {
  if (!confirm('确认删除该用户？其会话与充值记录将一并清除，不可恢复。')) return;
  try {
    await api('DELETE', '/api/admin/users/' + id);
    toast('已删除用户', 'ok');
    loadUsers();
  } catch (err) { toast(err.message, 'err'); }
}

// ---------- 启动 ----------
if (TOKEN) {
  // 预校验 token 是否仍有效
  api('GET', '/api/admin/dashboard').then(() => { showApp(); loadSection('dashboard'); })
    .catch(() => showLogin());
} else {
  showLogin();
}
