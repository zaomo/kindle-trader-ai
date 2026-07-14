'use strict';
/**
 * AI 文案生成：多平台风格（默认 闲鱼 / 转转 / 小红书）。
 *
 * MVP 采用「模板 + 结构化注入」，模板现为「可配置项」，由 Admin 后台通过
 * admin_config(copywriting) 管理；未配置时回退到下方 DEFAULT_COPYWRITING。
 * 若配置了 LLM（Anthropic / 智谱任一），则把结构化信息交给模型生成更生动的文案，
 * 但型号/价格/卖点等硬性信息仍由输入决定，避免幻觉。
 */
const { routerComplete, isConfigured } = require('./llm');
const { getConfig } = require('./admin');

// 默认文案模板（Admin 后台可改，存于 admin_config.copywriting）
// 占位符：{model} {condition} {points} {price}
const DEFAULT_COPYWRITING = {
  styles: ['闲鱼', '转转', '小红书'],
  templates: {
    闲鱼:
`【闲置出清】{model} {condition}
自用闲置，平时很爱惜，{points}。
一口价 ¥{price}，诚心要可小刀～
学生党/通勤党必备阅读神器，看书做笔记都方便 📚✨
有意私聊，同城可面交～`,
    转转:
`【个人闲置转让】{model} {condition}
机器功能正常，{points}。
支持平台验机，放心入手，拒绝翻新机。
标价 ¥{price}，价格公道，欢迎对比。
适合考研 / 阅读爱好者，护眼墨水屏不伤眼。`,
    小红书:
`挖到宝了姐妹们！💡
百元/千元价位也能拥有的阅读自由～
{model} {condition}，{points}。
每天通勤路上看会儿书，整个人都静下来了🍃
挂上来给有缘人，¥{price} 带走这份治愈～
#Kindle #二手好物 #阅读 #考研党 #自我提升`,
  },
};

function buildData(input) {
  const points = Array.isArray(input.sellingPoints) && input.sellingPoints.length
    ? input.sellingPoints.join('、')
    : '';
  return {
    model: input.modelName || 'Kindle',
    condition: input.condition || '9成新',
    points,
    price: Number(input.price) || 0,
  };
}

function render(tpl, d) {
  return String(tpl)
    .split('{model}').join(d.model)
    .split('{condition}').join(d.condition)
    .split('{points}').join(d.points)
    .split('{price}').join(d.price);
}

async function generate(input) {
  const cfg = getConfig('copywriting', DEFAULT_COPYWRITING);
  const styles = Array.isArray(cfg.styles) && cfg.styles.length ? cfg.styles : DEFAULT_COPYWRITING.styles;
  const templates = (cfg.templates && typeof cfg.templates === 'object') ? cfg.templates : {};
  const data = buildData(input);
  const results = {};
  for (const style of styles) {
    const tpl = templates[style];
    results[style] = tpl ? render(tpl, data) : `${data.model} ${data.condition} ¥${data.price} ${data.points}`;
  }

  let llmUsed = false;
  if (isConfigured() && input.useLLM !== false) {
    const system =
      '你是二手数码电商文案助手。根据给定型号、成色、价格、卖点，生成对应平台风格的文案。' +
      '只使用提供的信息，不要编造型号参数或虚假成色。保持口语化、真实。';
    for (const style of styles) {
      const userPrompt =
        `平台风格：${style}\n型号：${data.model}\n成色：${data.condition}\n` +
        `卖点：${data.points || '（无）'}\n价格：¥${data.price}\n` +
        `请生成一段该平台风格的售卖文案。`;
      const text = await routerComplete('copywriting', system, userPrompt);
      if (text) results[style] = text;
    }
    llmUsed = true;
  }

  return { styles, results, llmUsed };
}

module.exports = { generate, DEFAULT_COPYWRITING };
