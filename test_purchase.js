'use strict';
// 集成测试：采购决策引擎（本地规则兜底路径，使用隔离的临时 DB，绝不触碰真库）
process.env.DB_PATH = '/tmp/kt_purchase_test.db';
const fs = require('fs');
try { fs.unlinkSync(process.env.DB_PATH); } catch (e) {}
const { getDb, seedIfEmpty } = require('./src/db');
seedIfEmpty(true);

const purchase = require('./src/purchase');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name); }
}

(async () => {
  const db = getDb();
  const m = db.prepare("SELECT id, name, ref_low, ref_high FROM models WHERE name = 'Kindle Paperwhite 11代'").get();
  console.log('型号:', m.name, '参考区间', m.ref_low, '-', m.ref_high);

  // 场景 1：低价好价 → 应判「值得收」，低风险
  const r1 = await purchase.purchaseAdvice({
    modelId: m.id, myPurchasePrice: 300, expectedSellPrice: 420,
    channel: '闲鱼', condition: '9成新', note: '带原装充电器，屏幕无划痕',
  });
  console.log('\n[场景1] 收购300/售420 →', r1.verdict, '/ 风险', r1.riskLevel, '/ LLM?', r1.llmUsed);
  check('返回型号名', r1.modelName === m.name);
  check('目标价上限 > 0 且 <= ref_low', r1.targetMax > 0 && r1.targetMax <= m.ref_low);
  check('verdict 为三态之一', ['值得收', '可收，注意议价', '建议谨慎 / 放弃'].includes(r1.verdict));
  check('riskLevel 为三态之一', ['高', '中', '低'].includes(r1.riskLevel));
  check('知识库含 3 条', r1.knowledge.length === 3);
  check('知识库含参考区间', r1.knowledge[0].includes('参考区间'));
  check('知识库含近12日走势', r1.knowledge[1].includes('近 12 日'));
  check('利润率已计算 (~40%)', r1.roi != null && Math.abs(r1.roi - 0.4) < 0.001);
  check('本地兜底建议非空', r1.suggestion && r1.suggestion.length > 10);
  check('无 LLM 时 llmUsed=false', r1.llmUsed === false);

  // 场景 2：高价被套 → 应建议谨慎/放弃
  const r2 = await purchase.purchaseAdvice({
    modelId: m.id, myPurchasePrice: 500, expectedSellPrice: 520,
    channel: '本地商家', condition: '8成新', note: '有磕痕',
  });
  console.log('[场景2] 收购500/售520 →', r2.verdict, '/ 风险', r2.riskLevel);
  check('高价场景 verdict 偏谨慎', r2.verdict !== '值得收');
  check('高价场景风险提升', r2.riskScore >= 2);

  // 场景 3：不存在型号 → 抛 404
  let threw = false;
  try { await purchase.purchaseAdvice({ modelId: 99999, myPurchasePrice: 100, expectedSellPrice: 200 }); }
  catch (e) { threw = true; check('无效型号抛错', e.statusCode === 404); }
  check('无效型号被拒绝', threw);

  console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(2); });
