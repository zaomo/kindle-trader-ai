'use strict';
/**
 * 简易库存与利润模块。
 * 记录：收购价/收购日期、售出价/售出日期/平台。自动计算单台利润、平均周转天数、在库台数、总利润。
 * MVP 不做批量进货单 / 复杂报表，一张列表 + 合计即可。
 */
const { getDb } = require('./db');

function isoNow() {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Math.max(0, Math.round(ms / 86400000));
}

function list() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM inventory ORDER BY created_at DESC, id DESC').all();
  return rows.map(withProfit);
}

function withProfit(row) {
  const sold = row.status === '已售' && row.sell_price != null;
  const profit = sold ? Number((row.sell_price - row.buy_price).toFixed(2)) : null;
  const turnover = sold && row.sell_date ? daysBetween(row.buy_date, row.sell_date) : null;
  return { ...row, profit, turnoverDays: turnover };
}

function create(input) {
  const db = getDb();
  const status = input.status === '已售' ? '已售' : '在库';
  const info = db.prepare(
    `INSERT INTO inventory (model_name, buy_price, buy_date, sell_price, sell_date, platform, status, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.modelName, Number(input.buyPrice), input.buyDate, input.sellPrice != null ? Number(input.sellPrice) : null,
    input.sellDate || null, input.platform || null, status, input.note || null, isoNow()
  );
  return get(info.lastInsertRowid);
}

function get(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM inventory WHERE id = ?').get(id);
  return row ? withProfit(row) : null;
}

function update(id, input) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM inventory WHERE id = ?').get(id);
  if (!existing) return null;
  const merged = {
    modelName: input.modelName ?? existing.model_name,
    buyPrice: input.buyPrice != null ? Number(input.buyPrice) : existing.buy_price,
    buyDate: input.buyDate ?? existing.buy_date,
    sellPrice: input.sellPrice !== undefined ? (input.sellPrice != null ? Number(input.sellPrice) : null) : existing.sell_price,
    sellDate: input.sellDate !== undefined ? (input.sellDate || null) : existing.sell_date,
    platform: input.platform !== undefined ? (input.platform || null) : existing.platform,
    status: input.status ?? existing.status,
    note: input.note !== undefined ? (input.note || null) : existing.note,
  };
  db.prepare(
    `UPDATE inventory SET model_name=?, buy_price=?, buy_date=?, sell_price=?, sell_date=?, platform=?, status=?, note=? WHERE id=?`
  ).run(
    merged.modelName, merged.buyPrice, merged.buyDate, merged.sellPrice, merged.sellDate,
    merged.platform, merged.status, merged.note, id
  );
  return get(id);
}

function remove(id) {
  const db = getDb();
  return db.prepare('DELETE FROM inventory WHERE id = ?').run(id).changes > 0;
}

function summary() {
  const db = getDb();
  const all = db.prepare('SELECT * FROM inventory').all();
  const inStock = all.filter((r) => r.status !== '已售');
  const sold = all.filter((r) => r.status === '已售' && r.sell_price != null);
  const totalProfit = sold.reduce((s, r) => s + (r.sell_price - r.buy_price), 0);
  const turnovers = sold
    .filter((r) => r.sell_date)
    .map((r) => daysBetween(r.buy_date, r.sell_date));
  const avgTurnover = turnovers.length
    ? Math.round(turnovers.reduce((a, b) => a + b, 0) / turnovers.length)
    : 0;
  return {
    totalCount: all.length,
    inStockCount: inStock.length,
    soldCount: sold.length,
    totalProfit: Number(totalProfit.toFixed(2)),
    avgTurnoverDays: avgTurnover,
  };
}

module.exports = { list, create, get, update, remove, summary };
