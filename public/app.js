'use strict';
// ===== Kindle Trader AI 前端逻辑 =====
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// 将 UTC ISO 字符串转为北京时间 "YYYY-MM-DD HH:mm"（+8h）
function fmtBJTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.replace('T', ' ').slice(0, 16); // 兜底：非标准格式
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 匿名用户 id（未登录时的软限制标识）
const anonId = (() => {
  let id = localStorage.getItem('kta_anon');
  if (!id) { id = 'u_' + Math.random().toString(36).slice(2, 10); localStorage.setItem('kta_anon', id); }
  return id;
})();
// 登录态（邮箱 / 微信登录后写入 localStorage）
const token = localStorage.getItem('kta_token') || '';
let me = (() => { try { return JSON.parse(localStorage.getItem('kta_user') || 'null'); } catch { return null; } })();

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (opts.body && !headers['content-type']) headers['content-type'] = 'application/json';
  const res = await fetch(path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || '请求失败'), { status: res.status, data });
  return data;
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2200);
}

// 统一确认弹层（替代原生 confirm，视觉与 .modal-mask 体系一致），返回 Promise<boolean>
function confirmDialog(title, message) {
  return new Promise((resolve) => {
    let mask = document.getElementById('confirmMask');
    if (!mask) {
      mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.id = 'confirmMask';
      mask.hidden = true;
      mask.innerHTML =
        '<div class="modal" role="dialog" aria-modal="true">' +
          '<div class="modal-head"><span id="confirmTitle"></span></div>' +
          '<div class="modal-body" id="confirmBody"></div>' +
          '<div class="modal-foot">' +
            '<button class="btn ghost" id="confirmCancel">取消</button>' +
            '<button class="btn primary" id="confirmOk">确认</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(mask);
      mask.addEventListener('click', (e) => { if (e.target === mask) cleanup(false); });
    }
    document.getElementById('confirmTitle').textContent = title || '确认';
    document.getElementById('confirmBody').textContent = message || '';
    const okBtn = document.getElementById('confirmOk');
    const cancelBtn = document.getElementById('confirmCancel');
    function cleanup(val) {
      mask.hidden = true;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(val);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    mask.hidden = false;
  });
}

// ---- 用量展示（会员显示无限，登录免费用户按用户计次，匿名按本机计次）----
async function refreshUsage() {
  try {
    const u = await api('/api/usage');
    if (u.pro) {
      $('#usagePricing').innerHTML = '定价 <b>∞</b>';
      $('#usageCopy').innerHTML = '文案 <b>∞</b>';
    } else {
      $('#usagePricing').innerHTML = `定价 <b>${Math.max(0, u.pricing.limit - u.pricing.used)}</b>/${u.pricing.limit}`;
      $('#usageCopy').innerHTML = `文案 <b>${Math.max(0, u.copywriting.limit - u.copywriting.used)}</b>/${u.copywriting.limit}`;
    }
  } catch (e) { /* ignore */ }
}

function updateLoginEntry() {
  const el = $('#loginEntry');
  if (token && me) {
    el.textContent = me.isPro ? '会员' : (me.nickname || me.email || '我的');
    el.href = '/account.html';
    el.classList.add('is-member');
  } else {
    el.textContent = '登录';
    el.href = '/login.html';
    el.classList.remove('is-member');
  }
}

// 限额用尽的引导
function onLimit(e) {
  if (e.status !== 402) return false;
  if (token) toast('今日免费次数已用完，去「我的」开通会员解锁无限次');
  else toast('今日免费次数已用完，登录或开通会员解锁无限次');
  return true;
}

// ---- Tab 切换 ----
$$('.tabbar .tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.tabbar .tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const target = btn.dataset.target;
    $$('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.tab !== target));
    if (target === 'stock') loadInventory();
    if (target === 'price') { loadPricingHistory(); loadPurchaseHistory(); }
    if (target === 'copy') { loadCopyHistory(); }
  });
});

// ---- 行情 ----
let MODELS = [];
let marketKeyword = '';
let marketSort = 'default';

function showMarketSkeleton(n = 5) {
  const el = $('#modelList');
  if (!el) return;
  el.innerHTML = Array.from({ length: n }).map(() => `
    <div class="sk-card">
      <div class="skeleton sk-line sk-title"></div>
      <div class="skeleton sk-line sk-meta"></div>
      <div class="skeleton sk-line sk-price"></div>
    </div>`).join('');
}

async function loadModels() {
  showMarketSkeleton();
  try {
    const { models } = await api('/api/models');
    MODELS = models;
    const opts = models.map((m) => `<option value="${m.id}">${m.name}</option>`).join('');
    $('#priceModel').innerHTML = opts;
    $('#copyModel').innerHTML = models.map((m) => `<option>${m.name}</option>`).join('');
    $('#purchaseModel').innerHTML = opts;
    renderMarket(filterModels());
  } catch (e) {
    $('#modelList').innerHTML = '<div class="empty"><span class="em">⚠️</span>行情加载失败，请稍后重试</div>';
  }
}

function filterModels() {
  const kw = marketKeyword.trim().toLowerCase();
  let list = MODELS.filter((m) => {
    if (!kw) return true;
    return (m.name || '').toLowerCase().includes(kw) || (m.family || '').toLowerCase().includes(kw);
  });
  if (marketSort === 'price_asc') list = list.slice().sort((a, b) => a.ref_low - b.ref_low);
  else if (marketSort === 'price_desc') list = list.slice().sort((a, b) => b.ref_low - a.ref_low);
  return list;
}

function applyMarketFilter() {
  const list = filterModels();
  if (!list.length) {
    $('#modelList').innerHTML = '<div class="empty"><span class="em">🔍</span>没有匹配的型号，换个关键词试试</div>';
    return;
  }
  renderMarket(list);
}

// 搜索 / 排序（脚本在 body 末尾加载，元素已存在，绑定一次）
$('#marketSearch').addEventListener('input', (e) => { marketKeyword = e.target.value; applyMarketFilter(); });
$('#marketSort').addEventListener('change', (e) => { marketSort = e.target.value; applyMarketFilter(); });


function renderMarket(models) {
  const el = $('#modelList');
  el.innerHTML = models.map((m) => `
    <div class="card" data-id="${m.id}">
      <div class="model-head">
        <div>
          <div class="model-name">${m.name}</div>
          <div class="model-meta"><span class="chip">${m.screen_size}" 屏</span>${m.release_year} 年 · ${m.family} ${m.generation}</div>
        </div>
        <div style="text-align:right">
          <div class="price-range">¥${m.ref_low}-${m.ref_high}</div>
        </div>
      </div>
      <div class="sample">基于 ${m.sample_size} 条参考样本 · 更新于 ${m.updated_at}</div>
      <button class="expand-btn" data-act="expand">查看 30 天趋势 ▾</button>
      <div class="trend-slot"></div>
      <div class="model-actions">
        <button class="btn sm ghost" data-act="toPrice">去定价</button>
        <button class="btn sm ghost" data-act="toCopy">写文案</button>
      </div>
    </div>`).join('');

  $$('.card', el).forEach((card) => {
    const id = card.dataset.id;
    card.querySelector('[data-act="toPrice"]').addEventListener('click', () => {
      $('#priceModel').value = id;
      $('.tabbar .tab[data-target="price"]').click();
    });
    card.querySelector('[data-act="toCopy"]').addEventListener('click', () => {
      const m = MODELS.find((x) => String(x.id) === id);
      if (m) $('#copyModel').value = m.name;
      $('.tabbar .tab[data-target="copy"]').click();
    });
    const expBtn = card.querySelector('[data-act="expand"]');
    const slot = card.querySelector('.trend-slot');
    let open = false, range = 30;
    expBtn.addEventListener('click', async () => {
      if (open) { slot.innerHTML = ''; expBtn.textContent = `查看 ${range} 天趋势 ▾`; open = false; return; }
      expBtn.textContent = '加载中…';
      try {
        const d = await api(`/api/models/${id}/history?range=${range}`);
        slot.innerHTML = chartHTML(d);
        open = true;
        expBtn.textContent = `收起趋势 ▴ · 切换`;
        // 30/90 切换
        const sw = slot.querySelector('[data-range]');
        if (sw) sw.addEventListener('click', async (e) => {
          range = Number(e.target.dataset.range);
          const d2 = await api(`/api/models/${id}/history?range=${range}`);
          slot.innerHTML = chartHTML(d2);
          bindRange(slot, id);
        });
      } catch (e) { toast('趋势加载失败'); expBtn.textContent = '查看趋势 ▾'; }
    });
  });
}
function bindRange(slot, id) {
  const sw = slot.querySelector('[data-range]');
  if (sw) sw.addEventListener('click', async (e) => {
    const range = Number(e.target.dataset.range);
    const d2 = await api(`/api/models/${id}/history?range=${range}`);
    slot.innerHTML = chartHTML(d2);
    bindRange(slot, id);
  });
}

function chartHTML(d) {
  const pts = d.history.map((h) => h.avg_price);
  if (!pts.length) return '<p class="hint">暂无历史数据</p>';
  const W = 300, H = 120, pad = 18;
  const min = Math.min(...pts), max = Math.max(...pts);
  const span = Math.max(1, max - min);
  const stepX = (W - pad * 2) / (pts.length - 1 || 1);
  const coords = pts.map((v, i) => [pad + i * stepX, H - pad - ((v - min) / span) * (H - pad * 2)]);
  const line = coords.map((c) => c.join(',')).join(' ');
  const area = `${pad},${H - pad} ${line} ${W - pad},${H - pad}`;
  const first = d.history[0], last = d.history[d.history.length - 1];
  // 两条参考网格线
  const g1 = H - pad - (H - pad * 2) * 0.33;
  const g2 = H - pad - (H - pad * 2) * 0.66;
  return `
    <div class="chart-wrap">
      <svg viewBox="0 0 ${W} ${H}" width="100%">
        <line x1="${pad}" y1="${g1}" x2="${W - pad}" y2="${g1}" stroke="#eef0f4" stroke-width="1" />
        <line x1="${pad}" y1="${g2}" x2="${W - pad}" y2="${g2}" stroke="#eef0f4" stroke-width="1" />
        <polygon class="area-anim" points="${area}" fill="rgba(255,106,0,.12)" />
        <polyline class="polyline-anim" points="${line}" fill="none" stroke="#ff5e3a" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
        <text x="${pad}" y="${H - 4}" font-size="9" fill="#939aa6">${first.date.slice(5)}</text>
        <text x="${W - pad}" y="${H - 4}" font-size="9" fill="#939aa6" text-anchor="end">${last.date.slice(5)}</text>
      </svg>
      <div class="chart-legend">
        <span>区间 <b>¥${min} - ¥${max}</b></span>
        <span>近 ${d.range} 天</span>
        <button class="expand-btn" data-range="${d.range === 30 ? 90 : 30}">切到 ${d.range === 30 ? '90' : '30'}天</button>
      </div>
    </div>`;
}

// ---- 定价 ----
function segValue(container) { return $(`.seg button.active`, container)?.dataset.v; }
$$('#priceCondition button').forEach((b) => b.addEventListener('click', () => {
  $$('#priceCondition button').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
}));

$('#priceBtn').addEventListener('click', async () => {
  const body = {
    anonId,
    modelId: Number($('#priceModel').value),
    condition: segValue($('#priceCondition')),
    accessories: $$('#priceAccessories input:checked').map((c) => c.value),
    screenIssue: $('#priceScreen').checked,
    battery: $('#priceBattery').value,
  };
  const btn = $('#priceBtn'); btn.disabled = true; btn.textContent = '计算中…';
  try {
    const r = await api('/api/pricing', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    renderPriceResult(r);
    loadPricingHistory();
    refreshUsage();
  } catch (e) {
    if (!onLimit(e)) toast(e.message || '定价失败');
  } finally { btn.disabled = false; btn.textContent = '生成定价建议'; }
});

function renderPriceResult(r) {
  // 价格建议相对于「参考区间 + 建议区间」的可视化条
  const lo = Math.min(r.refLow, r.suggestLow);
  const hi = Math.max(r.refHigh, r.suggestHigh);
  const span = Math.max(1, hi - lo);
  const pct = (v) => ((v - lo) / span) * 100;
  const bar = `
    <div class="price-bar">
      <div class="pb-track">
        <div class="pb-suggest" style="left:${pct(r.suggestLow)}%;width:${Math.max(2, pct(r.suggestHigh) - pct(r.suggestLow))}%"></div>
        <div class="pb-marker" style="left:${pct(r.refLow)}%">参考低</div>
        <div class="pb-marker" style="left:${pct(r.refHigh)}%">参考高</div>
      </div>
      <div class="pb-legend"><span>¥${lo}</span><span>建议 <b>¥${r.suggestLow}-${r.suggestHigh}</b></span><span>¥${hi}</span></div>
    </div>`;
  $('#priceResult').innerHTML = `
    <div class="card result-card">
      <div class="row"><div class="model-name">${r.modelName}</div>
        ${r.llmUsed ? '<span class="llm-badge">AI 润色</span>' : ''}</div>
      <div class="suggest">¥${r.suggestLow} - ¥${r.suggestHigh}</div>
      <div class="sample">参考区间 ¥${r.refLow}-${r.refHigh}（${r.sampleSize} 样本，更新 ${r.updatedAt}）</div>
      ${bar}
      <div class="reason">${r.reason}</div>
      <div class="chip-row">${r.factors.map((f) => `<span class="factor-chip">${f}</span>`).join('')}</div>
    </div>`;
}

// ---- 采购决策（AI 辅助）----
$('#purchaseBtn').addEventListener('click', async () => {
  const modelId = Number($('#purchaseModel').value);
  const body = {
    modelId,
    myPurchasePrice: Number($('#purchasePrice').value) || 0,
    expectedSellPrice: Number($('#purchaseSell').value) || 0,
    channel: $('#purchaseChannel').value,
    condition: $('#purchaseCondition').value,
    note: $('#purchaseNote').value.trim(),
  };
  if (!body.myPurchasePrice) { toast('请填写我的收购价'); return; }
  const btn = $('#purchaseBtn'); btn.disabled = true; btn.textContent = '分析中…';
  try {
    const r = await api('/api/purchase-advice', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    renderPurchase(r);
    loadPurchaseHistory();
  } catch (e) {
    toast(e.message || '采购分析失败');
  } finally { btn.disabled = false; btn.textContent = '生成采购建议'; }
});

function renderPurchase(r) {
  const verdictClass = r.verdict === '值得收' ? 'good' : (r.verdict === '建议谨慎 / 放弃' ? 'bad' : 'mid');
  const riskClass = r.riskLevel === '高' ? 'bad' : (r.riskLevel === '中' ? 'mid' : 'good');
  const lo = Math.min(r.refLow, r.targetIdeal || r.refLow);
  const hi = Math.max(r.refHigh, r.myPurchasePrice || r.refHigh, r.expectedSellPrice || r.refHigh);
  const span = Math.max(1, hi - lo);
  const pct = (v) => ((v - lo) / span) * 100;
  const bar = `
    <div class="price-bar">
      <div class="pb-track">
        <div class="pb-ref" style="left:${pct(r.refLow)}%;width:${Math.max(2, pct(r.refHigh) - pct(r.refLow))}%"></div>
        <div class="pb-marker" style="left:${pct(r.targetMax)}%">目标价</div>
        ${r.myPurchasePrice ? `<div class="pb-mine" style="left:${pct(r.myPurchasePrice)}%">我的</div>` : ''}
      </div>
      <div class="pb-legend"><span>¥${lo}</span><span>参考 <b>¥${r.refLow}-${r.refHigh}</b></span><span>¥${hi}</span></div>
    </div>`;
  const knowledgeChips = (r.knowledge || []).map((k) => `<span class="factor-chip">${k}</span>`).join('');
  const riskChips = (r.risks || []).length
    ? r.risks.map((x) => `<span class="factor-chip risk">${x}</span>`).join('')
    : '<span class="factor-chip">暂无显著风险</span>';
  const trendText = r.trendMin != null
    ? `近 12 日：¥${r.trendMin}-${r.trendMax}（${r.trendUp ? '走升 ↑' : '走弱 ↓'}）`
    : '近 12 日：无数据';
  const soldText = r.avgSoldProfit != null ? `本店同型号历史平均利润 ¥${r.avgSoldProfit}` : '本店暂无同型号历史成交';
  $('#purchaseResult').innerHTML = `
    <div class="card result-card">
      <div class="row">
        <div class="model-name">${r.modelName}</div>
        ${r.llmUsed ? `<span class="llm-badge">AI · ${r.modelUsed || 'Qwen3-235B'}</span>` : '<span class="llm-badge local">本地规则</span>'}
      </div>
      <div class="verdict-line">
        <span class="verdict ${verdictClass}">${r.verdict}</span>
        <span class="risk-tag ${riskClass}">风险 ${r.riskLevel}</span>
      </div>
      ${bar}
      <div class="suggest purchase-suggest">
        <div><span class="sl">目标价上限</span><b>¥${r.targetMax}</b></div>
        <div><span class="sl">理想收购价</span><b>¥${r.targetIdeal}</b></div>
        <div><span class="sl">预期利润率</span><b>${r.roi != null ? Math.round(r.roi * 100) + '%' : '—'}</b></div>
      </div>
      <div class="reason">${r.suggestion}</div>
      <div class="sub-line">${trendText} · ${soldText}</div>
      <div class="block-title">知识库</div>
      <div class="chip-row">${knowledgeChips}</div>
      <div class="block-title">风险点</div>
      <div class="chip-row">${riskChips}</div>
    </div>`;
}

// ---- 历史建议（定价 / 采购）----
async function loadPricingHistory() {
  try {
    const { items } = await api('/api/pricing/history?limit=30');
    renderAdviceHistory('pricing', items);
  } catch (e) { /* 忽略加载失败 */ }
}
async function loadPurchaseHistory() {
  try {
    const { items } = await api('/api/purchase/history?limit=30');
    renderAdviceHistory('purchase', items);
  } catch (e) { /* 忽略加载失败 */ }
}

function renderAdviceHistory(type, items) {
  const block = type === 'pricing' ? $('#pricingHistoryBlock') : $('#purchaseHistoryBlock');
  const list = type === 'pricing' ? $('#pricingHistory') : $('#purchaseHistory');
  if (!items || !items.length) { block.hidden = true; return; }
  block.hidden = false;
  list.innerHTML = items.map((it) => {
    const d = it.data || {};
    let summary;
    if (type === 'pricing') {
      summary = `<b>¥${d.suggestLow}-${d.suggestHigh}</b> · ${d.condition || ''}${d.screenIssue ? ' · 屏痕' : ''}${d.battery && d.battery !== '正常' ? ' · ' + d.battery : ''}`;
    } else {
      const verdictShort = (d.verdict || '').replace('建议谨慎 / ', '');
      summary = `<span class="vh-verdict v-${d.verdict === '值得收' ? 'good' : (d.verdict === '建议谨慎 / 放弃' ? 'bad' : 'mid')}">${verdictShort}</span> 收¥${d.myPurchasePrice || '-'} → 售¥${d.expectedSellPrice || '-'} · 目标≤¥${d.targetMax}`;
    }
    const time = fmtBJTime(it.created_at);
    return `
      <div class="hist-card" data-type="${type}" data-id="${it.id}">
        <div class="hist-head">
          <span class="hist-model">${it.model_name}</span>
          <span class="hist-time">${time}</span>
        </div>
        <div class="hist-body">${summary} ${d.llmUsed ? '<span class="llm-badge">AI</span>' : ''}</div>
        <button class="link-btn view-detail" data-id="${it.id}">查看详情 ▾</button>
      </div>`;
  }).join('');
  $$('.hist-card', list).forEach((card) => {
    card.querySelector('.view-detail').addEventListener('click', () => {
      const id = Number(card.dataset.id);
      const item = items.find((x) => x.id === id);
      if (!item) return;
      if (type === 'pricing') renderPriceResult(item.data);
      else renderPurchase(item.data);
      $('#' + (type === 'pricing' ? 'priceResult' : 'purchaseResult')).scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });
}

$('#pricingHistoryClear').addEventListener('click', async () => {
  if (!(await confirmDialog('清空历史定价', '确认清空全部历史定价建议？此操作不可恢复。'))) return;
  try { await api('/api/pricing/history', { method: 'DELETE' }); loadPricingHistory(); toast('已清空'); }
  catch (e) { toast('清空失败'); }
});
$('#purchaseHistoryClear').addEventListener('click', async () => {
  if (!(await confirmDialog('清空历史采购', '确认清空全部历史采购建议？此操作不可恢复。'))) return;
  try { await api('/api/purchase/history', { method: 'DELETE' }); loadPurchaseHistory(); toast('已清空'); }
  catch (e) { toast('清空失败'); }
});

// ---- 文案 ----
let currentCopyCtx = {};
$('#copyBtn').addEventListener('click', async () => {
  const body = {
    anonId,
    modelName: $('#copyModel').value,
    condition: $('#copyCondition').value,
    price: Number($('#copyPrice').value) || 0,
    sellingPoints: $$('#copyPoints input:checked').map((c) => c.value),
  };
  currentCopyCtx = body;
  if (!body.price) { toast('请填写售价'); return; }
  const btn = $('#copyBtn'); btn.disabled = true; btn.textContent = '生成中…';
  try {
    const r = await api('/api/copywriting', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    renderCopy(r);
    refreshUsage();
    loadCopyHistory();
  } catch (e) {
    if (!onLimit(e)) toast(e.message || '生成失败');
  } finally { btn.disabled = false; btn.textContent = '生成文案'; }
});

function renderCopy(r) {
  const styles = r.styles;
  $('#copyResult').innerHTML = `
    <div class="card result-card">
      <div class="copy-tabs">${styles.map((s, i) => `<button data-i="${i}" class="${i === 0 ? 'active' : ''}">${s}</button>`).join('')}</div>
      <div class="copy-body" id="copyBody"></div>
      <button class="btn sm ghost" id="copyClip">复制当前文案</button>
      <div class="copy-platform">
        <button class="btn sm ghost" id="copyXianyu">复制为闲鱼模板</button>
        <button class="btn sm ghost" id="copyZhuanzhuan">复制为转转模板</button>
      </div>
      ${r.llmUsed ? '<span class="llm-badge">AI 生成</span>' : ''}
    </div>`;
  const body = $('#copyBody');
  const show = (i) => (body.textContent = r.results[styles[i]]);
  show(0);
  $$('.copy-tabs button').forEach((b) => b.addEventListener('click', () => {
    $$('.copy-tabs button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active'); show(Number(b.dataset.i));
  }));
  $('#copyClip').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(body.textContent); toast('已复制'); }
    catch { toast('复制失败，请手动选择'); }
  });
  const platformText = (p) => {
    const c = currentCopyCtx || {};
    const title = (c.modelName || 'Kindle') + ' ' + (c.condition || '');
    const points = (c.sellingPoints && c.sellingPoints.length) ? c.sellingPoints.join('、') : '—';
    const price = c.price ? '¥' + c.price : '面议';
    const head = (p === 'xianyu' ? '【闲鱼】闲置转让 ' : '【转转】出售 ') + title + '\n'
      + '卖点：' + points + '\n'
      + '售价：' + price + '（参考行情，诚心可小刀）\n'
      + '——————————\n';
    return head + (body.textContent || '');
  };
  $('#copyXianyu').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(platformText('xianyu')); toast('已复制为闲鱼模板'); }
    catch { toast('复制失败'); }
  });
  $('#copyZhuanzhuan').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(platformText('zhuanzhuan')); toast('已复制为转转模板'); }
    catch { toast('复制失败'); }
  });
}

// ---- 文案历史（查看 / 删除 / 修改）----
async function loadCopyHistory() {
  try {
    const { items } = await api('/api/copywriting/history?limit=30');
    renderCopyHistory(items);
  } catch (e) { /* 忽略加载失败 */ }
}

function renderCopyHistory(items) {
  const block = $('#copyHistoryBlock');
  const list = $('#copyHistory');
  if (!items || !items.length) { block.hidden = true; return; }
  block.hidden = false;
  list.innerHTML = items.map((it) => {
    const d = it.data || {};
    const styles = d.styles || Object.keys(d.results || {});
    const firstText = styles.length ? (d.results[styles[0]] || '').replace(/\n/g, ' ').slice(0, 42) : '';
    const time = fmtBJTime(it.created_at);
    return `
      <div class="hist-card" data-id="${it.id}">
        <div class="hist-head">
          <span class="hist-model">${it.model_name}</span>
          <span class="hist-time">${time}</span>
        </div>
        <div class="hist-body">${styles.map((s) => `<span class="chip">${s}</span>`).join('')} ${d.llmUsed ? '<span class="llm-badge">AI</span>' : ''}</div>
        <div class="hist-sub">${firstText}${firstText.length >= 42 ? '…' : ''}</div>
        <div class="hist-actions">
          <button class="link-btn act-view" data-id="${it.id}">查看</button>
          <button class="link-btn act-edit" data-id="${it.id}">修改</button>
          <button class="link-btn act-del" data-id="${it.id}">删除</button>
        </div>
      </div>`;
  }).join('');
  $$('.hist-card', list).forEach((card) => {
    const id = Number(card.dataset.id);
    const item = items.find((x) => x.id === id);
    if (!item) return;
    card.querySelector('.act-view').addEventListener('click', () => {
      renderCopy(item.data);
      $('#copyResult').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    card.querySelector('.act-edit').addEventListener('click', () => openCopyEdit(item));
    card.querySelector('.act-del').addEventListener('click', async () => {
      if (!(await confirmDialog('删除文案', '确认删除这条历史文案？此操作不可恢复。'))) return;
      try { await api(`/api/copywriting/history/${id}`, { method: 'DELETE' }); loadCopyHistory(); toast('已删除'); }
      catch (e) { toast('删除失败'); }
    });
  });
}

// 修改弹层
let copyEditData = null;
function openCopyEdit(item) {
  copyEditData = item;
  const d = item.data || {};
  const styles = d.styles || Object.keys(d.results || {});
  $('#copyEditModel').textContent = item.model_name || '';
  $('#copyEditBody').innerHTML = styles.map((s) => `
    <label class="field">
      <span>${s}</span>
      <textarea class="copy-edit-area" data-style="${s}" rows="5">${escHtml(d.results[s] || '')}</textarea>
    </label>`).join('');
  $('#copyEditMask').hidden = false;
}
function closeCopyEdit() { $('#copyEditMask').hidden = true; copyEditData = null; }
$('#copyEditClose').addEventListener('click', closeCopyEdit);
$('#copyEditCancel').addEventListener('click', closeCopyEdit);
$('#copyEditMask').addEventListener('click', (e) => { if (e.target === $('#copyEditMask')) closeCopyEdit(); });
$('#copyEditSave').addEventListener('click', async () => {
  if (!copyEditData) return;
  const results = {};
  $$('#copyEditBody .copy-edit-area').forEach((ta) => { results[ta.dataset.style] = ta.value; });
  try {
    await api(`/api/copywriting/history/${copyEditData.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ results }),
    });
    closeCopyEdit(); loadCopyHistory(); toast('已保存修改');
  } catch (e) { toast(e.message || '保存失败'); }
});

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

$('#copyHistoryClear').addEventListener('click', async () => {
  if (!(await confirmDialog('清空历史文案', '确认清空全部历史文案？此操作不可恢复。'))) return;
  try { await api('/api/copywriting/history', { method: 'DELETE' }); loadCopyHistory(); toast('已清空'); }
  catch (e) { toast('清空失败'); }
});

// ---- 库存 ----
async function loadInventory() {
  try {
    const { items, summary } = await api('/api/inventory');
    renderSummary(summary);
    renderInvList(items);
  } catch (e) { toast('库存加载失败'); }
}
function renderSummary(s) {
  $('#stockSummary').innerHTML = `
    <div class="box"><div class="num">${s.inStockCount}</div><div class="lbl">在库台数</div></div>
    <div class="box"><div class="num green">¥${s.totalProfit}</div><div class="lbl">累计利润（已售）</div></div>
    <div class="box"><div class="num">${s.soldCount}</div><div class="lbl">已售台数</div></div>
    <div class="box"><div class="num">${s.avgTurnoverDays}</div><div class="lbl">平均周转(天)</div></div>`;
}
function renderInvList(items) {
  const el = $('#invList');
  if (!items.length) {
    el.innerHTML = '<div class="empty"><span class="em">📦</span>还没有库存记录<br/>添加第一台 Kindle 开始记账吧' +
      '<br/><button class="btn sm primary empty-cta" id="invEmptyAdd">添加第一台</button></div>';
    $('#invEmptyAdd').addEventListener('click', () => {
      const f = document.getElementById('invModel');
      if (f) { f.scrollIntoView({ behavior: 'smooth', block: 'center' }); f.focus(); }
    });
    return;
  }
  el.innerHTML = items.map((it) => {
    const profit = it.profit;
    const profitHtml = it.status === '已售'
      ? `<span class="profit ${profit >= 0 ? 'pos' : 'neg'}">${profit >= 0 ? '+' : ''}¥${profit}</span><span class="inv-sub">周转 ${it.turnoverDays}天</span>`
      : '<span class="tag stock">在库</span>';
    return `
      <div class="inv-row" data-id="${it.id}">
        <div>
          <div class="inv-name">${it.model_name}</div>
          <div class="inv-sub">收 ¥${it.buy_price} · ${it.buy_date}${it.sell_price != null ? ' · 售 ¥' + it.sell_price : ''}${it.platform ? ' · ' + it.platform : ''}</div>
        </div>
        <div style="text-align:right">
          ${profitHtml}
          <div class="inv-actions">
            ${it.status !== '已售' ? '<button class="icon-btn" data-act="sell">标记售出</button>' : ''}
            <button class="icon-btn" data-act="del">删除</button>
          </div>
        </div>
      </div>`;
  }).join('');
  $$('.inv-row', el).forEach((row) => {
    const id = row.dataset.id;
    const del = row.querySelector('[data-act="del"]');
    const sell = row.querySelector('[data-act="sell"]');
    del?.addEventListener('click', async () => {
      if (!(await confirmDialog('删除库存记录', '确认删除这条库存记录？相关利润统计将一并移除，此操作不可恢复。'))) return;
      await api(`/api/inventory/${id}`, { method: 'DELETE' });
      loadInventory(); toast('已删除');
    });
    sell?.addEventListener('click', async () => {
      const price = prompt('请输入售出价（¥）：');
      if (price == null) return;
      await api(`/api/inventory/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: '已售', sellPrice: Number(price), sellDate: new Date().toISOString().slice(0, 10) }) });
      loadInventory(); toast('已标记售出，利润已计入');
    });
  });
}

$('#invAdd').addEventListener('click', async () => {
  const payload = {
    modelName: $('#invModel').value.trim(),
    buyPrice: Number($('#invBuy').value),
    buyDate: $('#invBuyDate').value,
    status: $('#invStatus').value,
    sellPrice: $('#invSell').value ? Number($('#invSell').value) : null,
    sellDate: $('#invSellDate').value || null,
    platform: $('#invPlatform').value,
    note: $('#invNote').value.trim(),
  };
  if (!payload.modelName || !payload.buyPrice || !payload.buyDate) { toast('请填写型号、收购价、收购日期'); return; }
  const btn = $('#invAdd'); btn.disabled = true;
  try {
    await api('/api/inventory', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    $('#invModel').value = ''; $('#invBuy').value = ''; $('#invSell').value = ''; $('#invNote').value = '';
    loadInventory(); toast('已添加');
  } catch (e) { toast(e.message || '添加失败'); }
  finally { btn.disabled = false; }
});

// ---- 模型调度中心（定价页高亮）----
async function loadRouterSpotlight() {
  const el = $('#routerSpotStatus');
  if (!el) return;
  try {
    const s = await api('/api/router/status');
    const model = s.active_model ? s.active_model : '未配置';
    const degrade = s.auto_degrade ? '开' : '关';
    const enabled = s.enabled ? '运行中' : '未启用（使用本地生成）';
    el.innerHTML = `调度状态：<b>${enabled}</b> · 当前模型 <b>${model}</b> · 自动降级 <b>${degrade}</b>`;
  } catch (e) {
    el.textContent = '调度状态：暂时无法获取';
  }
}

// ---- 初始化 ----
(async function init() {
  updateLoginEntry();
  $('#invBuyDate').value = new Date().toISOString().slice(0, 10);
  try { await loadModels(); } catch (e) { toast('行情加载失败'); }
  refreshUsage();
  loadRouterSpotlight();
  loadPricingHistory();
  loadPurchaseHistory();
  loadCopyHistory();
})();
