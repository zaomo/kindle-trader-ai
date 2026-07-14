'use strict';
/**
 * 采购决策引擎（AI 辅助）。
 *
 * 业务流程（对齐《Kindle Trader AI V2.0》第 4.3 / 4.9 节）：
 *   用户输入采购信息（型号 / 我的收购价 / 预期售出价 / 渠道 / 成色 / 备注文本）
 *     → 经 Model Router 路由到「采购决策」任务（默认 Qwen3-235B-A22B-Instruct）
 *     → 读取知识库（型号真实参考区间、近 12 日走势、本店同型号历史成交）
 *     → 本地规则引擎先算 ROI / 风险 / 目标价
 *     → routerComplete('purchase', ...) 让大模型综合输出采购建议
 *     → 无 LLM 时回退本地规则生成的建议文本
 *
 * 硬约束：所有价格数字始终来自真实行情或用户输入，LLM 仅做推理与口语化综合，
 * 绝不编造价格、样本量或历史成交。
 */
const { getDb } = require('./db');
const { routerComplete, isConfigured, getRouterStatus } = require('./llm');

function round5(n) { return Math.round(n / 5) * 5; }

/**
 * @param {object} input
 *  modelId           INTEGER   型号 id
 *  myPurchasePrice   number    我的收购价
 *  expectedSellPrice number    预期售出价
 *  channel           string    渠道（闲鱼/转转/个人卖家/本地商家/其他）
 *  condition         string    成色（可选）
 *  note              string    采购信息备注文本
 */
async function purchaseAdvice(input) {
  const db = getDb();
  const model = db.prepare('SELECT * FROM models WHERE id = ?').get(input.modelId);
  if (!model) {
    const err = new Error('型号不存在');
    err.statusCode = 404;
    throw err;
  }

  const myPrice = Number(input.myPurchasePrice) || 0;
  const expSell = Number(input.expectedSellPrice) || 0;
  const channel = (input.channel || '未知').toString().slice(0, 20);
  const condition = (input.condition || '').toString().slice(0, 20);
  const note = (input.note || '').toString().slice(0, 1200);

  // ---------- 知识库：近 12 日走势 ----------
  const trend = db.prepare(
    'SELECT date, avg_price, sample_size FROM price_history WHERE model_id=? ORDER BY date DESC LIMIT 12'
  ).all(model.id).reverse();
  const trendAvg = trend.length ? Math.round(trend.reduce((s, h) => s + h.avg_price, 0) / trend.length) : null;
  const trendMin = trend.length ? Math.min(...trend.map((h) => h.avg_price)) : null;
  const trendMax = trend.length ? Math.max(...trend.map((h) => h.avg_price)) : null;
  const trendDir = trend.length >= 2 ? trend[trend.length - 1].avg_price - trend[0].avg_price : 0;
  const trendUp = trendDir > 0;

  // ---------- 知识库：本店同型号历史成交（库存表） ----------
  const history = db.prepare(
    'SELECT buy_price, sell_price, status, platform, buy_date FROM inventory WHERE model_name = ? ORDER BY buy_date DESC LIMIT 10'
  ).all(model.name);
  const soldCases = history.filter((h) => h.status === '已售' && h.sell_price != null);
  const soldProfits = soldCases.map((h) => h.sell_price - h.buy_price);
  const avgSoldProfit = soldCases.length ? Math.round(soldProfits.reduce((a, b) => a + b, 0) / soldCases.length) : null;

  // ---------- 本地规则引擎 ----------
  const refMid = Math.round((model.ref_low + model.ref_high) / 2);
  const margin = (expSell && myPrice) ? (expSell - myPrice) : 0;
  const roi = (myPrice > 0 && expSell > 0) ? (expSell - myPrice) / myPrice : null;

  // 目标价：留安全垫，理想低于 ref_low 的 80%，上限不超过 ref_low 的 92% 与 refMid 的 85% 二者较小
  const targetIdeal = round5(model.ref_low * 0.8);
  const targetMax = round5(Math.min(model.ref_low * 0.92, refMid * 0.85));

  // 风险评估
  const risks = [];
  let riskScore = 0;
  if (myPrice > model.ref_high) { risks.push('收购价高于参考区间上限，极易被套牢'); riskScore += 3; }
  else if (myPrice > refMid) { risks.push('收购价高于参考中位价，利润空间偏薄'); riskScore += 1; }
  if (roi != null && roi < 0.1) { risks.push('预期利润率低于 10%，加上运费/平台手续费可能不划算'); riskScore += 2; }
  if (trend.length && !trendUp) { risks.push('近 12 日行情走弱，存在继续贬值的下行风险'); riskScore += 1; }
  if (model.sample_size < 40) { risks.push('参考样本量偏小，价格区间仅供参考'); riskScore += 1; }
  if (channel === '本地商家' || channel === '其他') { risks.push('该渠道回收价通常偏低，注意转售时的价差'); riskScore += 1; }
  const riskLevel = riskScore >= 4 ? '高' : (riskScore >= 2 ? '中' : '低');

  // 是否值得收
  let verdict;
  if (myPrice <= targetMax && (roi == null || roi >= 0.15)) verdict = '值得收';
  else if (myPrice <= refMid && (roi == null || roi >= 0.08)) verdict = '可收，注意议价';
  else verdict = '建议谨慎 / 放弃';

  const local = {
    targetMax, targetIdeal, verdict, riskLevel, riskScore, risks,
    margin, roi: roi == null ? null : Math.round(roi * 100) / 100,
    refMid, trendUp, trendMin, trendMax, trendAvg,
    soldCases: soldCases.map((c) => ({ buy: c.buy_price, sell: c.sell_price })),
    avgSoldProfit,
  };

  // 知识库摘要（注入 LLM prompt）
  const knowledge = [
    `型号「${model.name}」真实参考区间 ¥${model.ref_low}-${model.ref_high}（样本 ${model.sample_size} 条，更新于 ${model.updated_at}），参考中位价 ¥${refMid}`,
    trend.length ? `近 12 日行情${trendUp ? '走升' : '走弱'}：区间 ¥${trendMin}-${trendMax}，均价 ¥${trendAvg}` : '暂无近 12 日走势数据',
    soldCases.length
      ? `本店同型号历史已售 ${soldCases.length} 笔，平均利润 ¥${avgSoldProfit}（如：${soldCases.slice(0, 3).map((c) => `收¥${c.buy_price}→售¥${c.sell_price}`).join('、')}）`
      : '暂无本店同型号历史成交记录',
  ];

  let suggestion = buildLocalSuggestion({ model, myPrice, expSell, channel, condition, note, local });
  let llmUsed = false;
  let modelUsed = null;

  if (isConfigured()) {
    const system =
      '你是二手数码采购决策助手。下面给出系统算好的真实行情、知识库（历史成交/走势）与本地规则结论，' +
      '请结合用户输入的采购信息，综合输出一段中文采购建议：是否值得收、目标价、主要风险点、议价要点。' +
      '严禁编造任何价格数字或样本量，只能基于给定事实推理。控制在 160 字以内，条理清晰。';
    const userPrompt =
      `型号：${model.name}（参考 ¥${model.ref_low}-${model.ref_high}，样本 ${model.sample_size}，更新 ${model.updated_at}）\n` +
      `用户采购信息：收购价 ¥${myPrice || '未填'}，预期售出价 ¥${expSell || '未填'}，渠道「${channel}」，成色「${condition || '未填'}」\n` +
      `用户备注：${note || '无'}\n` +
      `知识库：\n${knowledge.map((k) => ' - ' + k).join('\n')}\n` +
      `本地规则初步结论：建议${local.verdict}；目标价上限 ¥${local.targetMax}（理想 ¥${local.targetIdeal}）；风险等级${local.riskLevel}；` +
      (local.roi != null ? `预期利润率 ${Math.round(local.roi * 100)}%` : '利润率未知') + '。\n' +
      `请综合上述事实输出采购建议（不要逐条罗列所有数字，给结论与可执行建议）。`;
    const polished = await routerComplete('purchase', system, userPrompt);
    if (polished) {
      suggestion = polished;
      llmUsed = true;
      const st = getRouterStatus();
      modelUsed = st.active_model || (st.tasks && st.tasks.purchase) || 'Qwen3-235B-A22B-Instruct';
    }
  }

  return {
    modelId: model.id,
    modelName: model.name,
    myPurchasePrice: myPrice,
    expectedSellPrice: expSell,
    channel,
    condition,
    note,
    suggestion,
    verdict: local.verdict,
    targetMax: local.targetMax,
    targetIdeal: local.targetIdeal,
    riskLevel: local.riskLevel,
    riskScore: local.riskScore,
    risks: local.risks,
    roi: local.roi,
    margin: local.margin,
    refLow: model.ref_low,
    refHigh: model.ref_high,
    refMid,
    trendUp: local.trendUp,
    trendMin: local.trendMin,
    trendMax: local.trendMax,
    trendAvg: local.trendAvg,
    soldCases: local.soldCases,
    avgSoldProfit: local.avgSoldProfit,
    knowledge,
    llmUsed,
    modelUsed,
  };
}

// 无 LLM 时的本地规则文本兜底
function buildLocalSuggestion({ model, myPrice, expSell, channel, condition, note, local }) {
  const parts = [];
  parts.push(`综合真实行情与本地规则，对「${model.name}」的建议：${local.verdict}。`);
  if (myPrice) {
    if (myPrice <= local.targetMax) parts.push(`当前收购价 ¥${myPrice} 在目标价（≤¥${local.targetMax}）以内，相对安全。`);
    else if (myPrice <= local.refMid) parts.push(`当前收购价 ¥${myPrice} 介于目标价与中位价之间，建议再压价到 ¥${local.targetMax} 以内更稳妥。`);
    else parts.push(`当前收购价 ¥${myPrice} 已高于参考中位价 ¥${local.refMid}，不建议以该价收。`);
  }
  if (local.roi != null) parts.push(`按预期售出价 ¥${expSell} 估算，利润率约 ${Math.round(local.roi * 100)}%（毛利 ¥${local.margin}）。`);
  if (local.risks.length) parts.push('风险点：' + local.risks.join('；') + '。');
  parts.push(`理想收购价建议不高于 ¥${local.targetIdeal}，目标上限 ¥${local.targetMax}。`);
  if (local.avgSoldProfit != null) parts.push(`本店同型号历史平均利润 ¥${local.avgSoldProfit}，可作参考。`);
  return parts.join('');
}

module.exports = { purchaseAdvice };
