'use strict';
/**
 * AI 智能定价引擎。
 *
 * 关键约束（来自需求文档 4.2 / 风险 2）：
 *   价格区间必须来自数据库中"真实参考区间"，LLM 只负责"区间内的合理化解释 + 微调"，
 *   绝不独立编造具体数字误导交易决策。
 *
 * 规则（成色系数 / 配件加价 / 屏幕扣减 / 电池系数 / 建议区间浮动）现为「可配置项」，
 * 由 Admin 后台通过 admin_config(pricing) 管理；未配置时回退到下方 DEFAULT_PRICING。
 */
const { getDb } = require('./db');
const { routerComplete, isConfigured } = require('./llm');
const { getConfig } = require('./admin');

// 默认定价规则（Admin 后台可改，存于 admin_config.pricing）
const DEFAULT_PRICING = {
  conditions: {
    '全新': 0.98,
    '9成新': 0.82,
    '8成新': 0.66,
    '5成新及以下': 0.42,
  },
  accessories: {
    '原装充电器': 15,
    '原装包装盒': 25,
    '无配件': -25,
  },
  screenPenalty: 40, // 屏幕有划痕/亮点时的扣减
  battery: {
    '优秀': 10,
    '正常': 0,
    '下降': -30,
  },
  suggestionLow: 0.93,  // 建议下限 = 调整后中点 × 该系数
  suggestionHigh: 1.07, // 建议上限 = 调整后中点 × 该系数
  floorRatio: 0.3,      // 建议价地板 = ref_low × 该系数
};

function round5(n) {
  return Math.round(n / 5) * 5;
}

/**
 * @param {object} input
 *  modelId    INTEGER
 *  condition  成色 key（对应 conditions）
 *  accessories string[] 可含配件 key 或 '无配件'
 *  screenIssue boolean
 *  battery    battery key（对应 battery）
 */
async function price(input) {
  const cfg = getConfig('pricing', DEFAULT_PRICING);
  const db = getDb();
  const model = db.prepare('SELECT * FROM models WHERE id = ?').get(input.modelId);
  if (!model) {
    const err = new Error('型号不存在');
    err.statusCode = 404;
    throw err;
  }

  const mid = (model.ref_low + model.ref_high) / 2;
  const condFactor = cfg.conditions[input.condition] ?? 0.7;
  let base = mid * condFactor;

  const accessoryNotes = [];
  let accDelta = 0;
  const accessories = Array.isArray(input.accessories) ? input.accessories : [];
  for (const a of accessories) {
    const delta = cfg.accessories[a];
    if (typeof delta === 'number') {
      accDelta += delta;
      accessoryNotes.push(`${a} ${delta >= 0 ? '+' : '-'}¥${Math.abs(delta)}`);
    }
  }

  const screenDelta = input.screenIssue ? -Math.abs(cfg.screenPenalty || 0) : 0;
  const batteryDelta = cfg.battery[input.battery] ?? 0;
  const batteryNote = batteryDelta !== 0
    ? `电池健康度${input.battery || '正常'} ${batteryDelta >= 0 ? '+' : '-'}¥${Math.abs(batteryDelta)}`
    : '电池健康度正常';

  const adjusted = base + accDelta + screenDelta + batteryDelta;
  const floor = model.ref_low * (cfg.floorRatio ?? 0.3);
  const suggestMid = Math.max(round5(floor), round5(adjusted));
  const suggestLow = round5(suggestMid * (cfg.suggestionLow ?? 0.93));
  const suggestHigh = round5(suggestMid * (cfg.suggestionHigh ?? 1.07));

  const factors = [
    `数据库「${model.name}」近 ${model.sample_size} 条成交样本，参考区间 ¥${model.ref_low}-${model.ref_high}（更新于 ${model.updated_at}）`,
    `成色「${input.condition}」折损系数 ${condFactor}`,
    ...accessoryNotes,
    input.screenIssue ? `屏幕有使用痕迹（划痕/亮点） -¥${Math.abs(cfg.screenPenalty || 0)}` : '屏幕无明显痕迹',
    batteryNote,
  ];

  const reasonLocal =
    `基于真实行情数据，「${model.name}」参考成交价 ¥${model.ref_low}-${model.ref_high}（样本 ${model.sample_size} 条，更新于 ${model.updated_at}）。` +
    `按成色「${input.condition}」折算后约为 ¥${suggestMid}；` +
    (accessoryNotes.length ? `配件项（${accessoryNotes.join('、')}）调整；` : '') +
    (input.screenIssue ? `屏幕有痕迹 -¥${Math.abs(cfg.screenPenalty || 0)}；` : '') +
    (batteryDelta !== 0 ? batteryNote + '；' : '') +
    `综合给出建议区间 ¥${suggestLow}-${suggestHigh}。该区间为参考数据，实际成交请结合平台行情微调。`;

  let reason = reasonLocal;
  let llmUsed = false;

  // 仅在配置了 LLM（Anthropic / 智谱任一）时，把上述"事实 + 数字"润色成更口语化的中文理由
  if (isConfigured()) {
    const system =
      '你是二手数码定价助手。下面会给你已经算好的真实价格区间和各项调整事实，' +
      '请用自然、简洁的中文总结定价理由。严禁修改任何数字，严禁编造新的价格或样本量。';
    const userPrompt =
      `型号：${model.name}\n` +
      `真实参考区间：¥${model.ref_low}-${model.ref_high}（样本 ${model.sample_size} 条，更新于 ${model.updated_at}）\n` +
      `成色：${input.condition}（折损系数 ${condFactor}）\n` +
      `配件调整：${accessoryNotes.join('；') || '无'}\n` +
      `屏幕：${input.screenIssue ? '有划痕/亮点 -¥' + Math.abs(cfg.screenPenalty || 0) : '无明显痕迹'}\n` +
      `电池：${input.battery || '正常'}${batteryDelta !== 0 ? '（' + batteryNote + '）' : ''}\n` +
      `最终建议区间：¥${suggestLow}-${suggestHigh}\n` +
      `请基于以上事实，用 2-3 句话说明定价理由（不要重复所有数字，挑重点）。`;
    const polished = await routerComplete('pricing', system, userPrompt);
    if (polished) {
      reason = polished;
      llmUsed = true;
    }
  }

  return {
    modelId: model.id,
    modelName: model.name,
    condition: input.condition,
    accessories: accessories,
    screenIssue: !!input.screenIssue,
    battery: input.battery || '正常',
    refLow: model.ref_low,
    refHigh: model.ref_high,
    sampleSize: model.sample_size,
    updatedAt: model.updated_at,
    suggestLow,
    suggestHigh,
    suggestMid,
    factors,
    reason,
    llmUsed,
  };
}

module.exports = { price, DEFAULT_PRICING };
