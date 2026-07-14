'use strict';
/**
 * 数据层：基于 Node 原生 SQLite（node:sqlite）。
 * 负责 schema 初始化 + 种子数据（13 个主流 Kindle 型号行情 + 90 天历史趋势）。
 *
 * 生产环境迁移提示：将本文件中的 SQL 与建表语句平移到 Supabase(PostgreSQL) 即可，
 * 业务层（pricing/copywriting/inventory）只依赖本模块暴露的 getDb()。
 */
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'kindle_trader.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 5000;'); // 偶发写锁时等待，避免 SQLITE_BUSY
db.exec('PRAGMA foreign_keys = ON;');

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS models (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL UNIQUE,   -- 展示名，如 "Paperwhite 11代"
      family        TEXT NOT NULL,          -- 系列，如 "Paperwhite"
      generation    TEXT,                   -- 代数，如 "11代"
      screen_size   REAL,                  -- 英寸
      release_year  INTEGER,
      ref_low       INTEGER NOT NULL,       -- 参考成交价下限
      ref_high      INTEGER NOT NULL,       -- 参考成交价上限
      sample_size   INTEGER NOT NULL,       -- 样本量（诚实展示）
      updated_at    TEXT NOT NULL           -- 数据更新日期 YYYY-MM-DD
    );

    CREATE TABLE IF NOT EXISTS price_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id    INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
      date        TEXT NOT NULL,            -- YYYY-MM-DD
      avg_price   INTEGER NOT NULL,         -- 当日参考均价
      sample_size INTEGER NOT NULL,         -- 当日样本量
      UNIQUE(model_id, date)
    );

    CREATE TABLE IF NOT EXISTS inventory (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      model_name  TEXT NOT NULL,
      buy_price   REAL NOT NULL,
      buy_date    TEXT NOT NULL,
      sell_price  REAL,
      sell_date   TEXT,
      platform    TEXT,                     -- 闲鱼 / 转转 / 其他
      status      TEXT NOT NULL DEFAULT '在库',  -- 在库 / 已售
      note        TEXT,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS usage_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      anon_id     TEXT NOT NULL,
      action      TEXT NOT NULL,            -- pricing / copywriting
      day         TEXT NOT NULL,            -- YYYY-MM-DD
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_config (
      key         TEXT PRIMARY KEY,         -- 'pricing' | 'copywriting' | 'llm' | 'model_router'
      value       TEXT NOT NULL             -- JSON 字符串
    );

    -- 模型调度中心（Model Router）成本与用量埋点
    CREATE TABLE IF NOT EXISTS model_calls (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      model        TEXT NOT NULL,           -- 实际调用模型名
      provider     TEXT,                    -- 厂商（zhipu/alibaba/...）
      task         TEXT NOT NULL,           -- 任务类型（pricing/vision/...）
      tokens_in    INTEGER NOT NULL DEFAULT 0,
      tokens_out   INTEGER NOT NULL DEFAULT 0,
      cost_cents   INTEGER NOT NULL DEFAULT 0,  -- 估算成本（分）
      latency_ms   INTEGER NOT NULL DEFAULT 0,
      day          TEXT NOT NULL,           -- YYYY-MM-DD
      created_at   TEXT NOT NULL
    );

    -- ---------- 用户 / 登录 / 充值 ----------
    CREATE TABLE IF NOT EXISTS users (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      email                 TEXT UNIQUE,                 -- 邮箱登录（微信用户可为空）
      password_hash        TEXT,                        -- scrypt: salt:hash（邮箱用户才有）
      wechat_openid        TEXT UNIQUE,                 -- 微信登录唯一标识
      nickname             TEXT,
      balance_cents        INTEGER NOT NULL DEFAULT 0,  -- 账户余额（分）
      membership           TEXT NOT NULL DEFAULT 'free',-- free | pro
      membership_expires_at TEXT,                       -- pro 到期时间 ISO
      created_at           TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token         TEXT PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at    TEXT NOT NULL,
      created_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recharges (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount_cents  INTEGER NOT NULL,      -- 正数=充值；负数=消费（如购会员）
      method        TEXT NOT NULL,         -- wechat | alipay | balance | membership | admin
      status        TEXT NOT NULL DEFAULT 'paid',
      note          TEXT,                  -- 备注（如管理员调账说明）
      created_at    TEXT NOT NULL
    );

    -- 邮箱验证码（注册 / 找回密码等用途，6 位，10 分钟有效）
    CREATE TABLE IF NOT EXISTS email_codes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      email       TEXT NOT NULL,
      code        TEXT NOT NULL,              -- 6 位数字验证码
      purpose     TEXT NOT NULL DEFAULT 'register', -- register | reset
      expires_at  TEXT NOT NULL,              -- ISO，过期时间
      used        INTEGER NOT NULL DEFAULT 0, -- 0 未用 / 1 已用
      created_at  TEXT NOT NULL
    );

    -- 历史建议记录：定价建议 / 采购建议（用户端"查看以往建议"）
    CREATE TABLE IF NOT EXISTS advice_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      type        TEXT NOT NULL,           -- 'pricing' | 'purchase'
      model_id    INTEGER,                 -- 型号 id（可能为空）
      model_name  TEXT NOT NULL,           -- 展示用型号名
      data_json   TEXT NOT NULL,           -- 完整结果 JSON（含建议区间/结论等）
      created_at  TEXT NOT NULL
    );
  `);

  // 兼容已有数据库：补充 note 列（旧库 recharges 无此列）
  const hasNote = db.prepare("SELECT COUNT(*) c FROM pragma_table_info('recharges') WHERE name='note'").get().c;
  if (!hasNote) db.exec('ALTER TABLE recharges ADD COLUMN note TEXT');
}

// 确定性伪随机：让历史数据在不同运行间保持稳定
function seeded(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

function hashStr(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// 13 个主流 Kindle 型号（二手行情，单位 CNY，样本为人工采样维护示意值）
const SEED_MODELS = [
  { name: 'Kindle 入门款 10代', family: '入门款', generation: '10代', screen_size: 6, release_year: 2019, ref_low: 180, ref_high: 240, sample_size: 60 },
  { name: 'Kindle 入门款 11代', family: '入门款', generation: '11代', screen_size: 6, release_year: 2022, ref_low: 280, ref_high: 350, sample_size: 85 },
  { name: 'Kindle 青春版', family: '青春版', generation: '2024款', screen_size: 6, release_year: 2024, ref_low: 300, ref_high: 370, sample_size: 50 },
  { name: 'Kindle Paperwhite 4', family: 'Paperwhite', generation: '4代', screen_size: 6, release_year: 2018, ref_low: 220, ref_high: 290, sample_size: 55 },
  { name: 'Kindle Paperwhite 11代', family: 'Paperwhite', generation: '11代', screen_size: 6.8, release_year: 2021, ref_low: 350, ref_high: 420, sample_size: 120 },
  { name: 'Kindle Paperwhite 签名版 11代', family: 'Paperwhite', generation: '签名版11代', screen_size: 6.8, release_year: 2021, ref_low: 420, ref_high: 500, sample_size: 70 },
  { name: 'Kindle Paperwhite 12代', family: 'Paperwhite', generation: '12代', screen_size: 7, release_year: 2024, ref_low: 450, ref_high: 560, sample_size: 60 },
  { name: 'Kindle Oasis', family: 'Oasis', generation: '1代', screen_size: 6, release_year: 2016, ref_low: 320, ref_high: 400, sample_size: 30 },
  { name: 'Kindle Oasis 2', family: 'Oasis', generation: '2代', screen_size: 7, release_year: 2017, ref_low: 380, ref_high: 480, sample_size: 40 },
  { name: 'Kindle Oasis 3', family: 'Oasis', generation: '3代', screen_size: 7, release_year: 2019, ref_low: 480, ref_high: 600, sample_size: 65 },
  { name: 'Kindle Voyage', family: 'Voyage', generation: '1代', screen_size: 6, release_year: 2014, ref_low: 200, ref_high: 280, sample_size: 25 },
  { name: 'Kindle Scribe 16GB', family: 'Scribe', generation: '16GB', screen_size: 10.2, release_year: 2022, ref_low: 1400, ref_high: 1700, sample_size: 45 },
  { name: 'Kindle Scribe 签名版', family: 'Scribe', generation: '签名版', screen_size: 10.2, release_year: 2022, ref_low: 1700, ref_high: 2000, sample_size: 30 },
];

function seedIfEmpty(force = false) {
  const count = db.prepare('SELECT COUNT(*) AS c FROM models').get().c;
  if (count > 0 && !force) {
    console.log(`[db] 已存在 ${count} 个型号，跳过种子。`);
    return;
  }
  if (force && count > 0) {
    db.exec('DELETE FROM price_history; DELETE FROM models;');
    console.log('[db] 强制重置种子数据。');
  }

  const today = new Date();
  const insertModel = db.prepare(
    `INSERT INTO models (name, family, generation, screen_size, release_year, ref_low, ref_high, sample_size, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertHist = db.prepare(
    `INSERT OR IGNORE INTO price_history (model_id, date, avg_price, sample_size) VALUES (?, ?, ?, ?)`
  );

  // node:sqlite 无 transaction() 助手，使用显式事务
  db.exec('BEGIN');
  try {
    for (const m of SEED_MODELS) {
      const updated = isoDate(today);
      const info = insertModel.run(
        m.name, m.family, m.generation, m.screen_size, m.release_year,
        m.ref_low, m.ref_high, m.sample_size, updated
      );
      const modelId = info.lastInsertRowid;
      const mid = (m.ref_low + m.ref_high) / 2;
      const rng = seeded(hashStr(m.name));
      // 生成近 90 天：越远价格略高（二手电子缓慢贬值），叠加确定性噪声
      for (let i = 89; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const daysAgo = i;
        const drift = 1 + 0.0016 * daysAgo;          // 历史更高
        const noise = 1 + (rng() - 0.5) * 0.06;       // ±3% 噪声
        const avg = Math.round((mid * drift * noise) / 5) * 5;
        const sample = Math.max(1, Math.round(m.sample_size / 90 + rng() * 3));
        insertHist.run(modelId, isoDate(d), avg, sample);
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  console.log(`[db] 已写入 ${SEED_MODELS.length} 个型号及各自 90 天历史。`);
}

function getDb() {
  return db;
}

/**
 * 保存一条建议记录（定价 / 采购）到历史表。
 * @param {'pricing'|'purchase'} type
 * @param {number|null} modelId
 * @param {string} modelName
 * @param {object} result  建议结果对象（会被 JSON 序列化存储）
 */
function saveAdvice(type, modelId, modelName, result) {
  // 去掉运行时字段（如 usage 计数），只存业务结果
  const { usage, ...clean } = result || {};
  db.prepare(
    `INSERT INTO advice_history (type, model_id, model_name, data_json, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(type, modelId || null, modelName || '未知型号', JSON.stringify(clean), new Date().toISOString());
}

/**
 * 列出某类历史建议（最新在前）。
 * @returns {Array<{id,type,model_id,model_name,created_at,data}>}
 */
function listAdvice(type, limit = 20) {
  const rows = db.prepare(
    'SELECT id, type, model_id, model_name, data_json, created_at FROM advice_history WHERE type=? ORDER BY id DESC LIMIT ?'
  ).all(type, limit);
  return rows.map((r) => {
    let data = {};
    try { data = JSON.parse(r.data_json); } catch { /* 损坏记录跳过解析 */ }
    return { id: r.id, type: r.type, model_id: r.model_id, model_name: r.model_name, created_at: r.created_at, data };
  });
}

/**
 * 修改某条历史记录：把 patch 合并进 data_json 后写回。
 * @param {number} id
 * @param {string} type
 * @param {object} patch  要合并进 data 的字段（如 { results, title }）
 * @returns {boolean} 是否更新成功（记录存在且匹配 type）
 */
function updateAdvice(id, type, patch) {
  const row = db.prepare('SELECT data_json FROM advice_history WHERE id=? AND type=?').get(id, type);
  if (!row) return false;
  let data = {};
  try { data = JSON.parse(row.data_json); } catch { data = {}; }
  const merged = { ...data, ...patch };
  // 若 patch 含 results，逐平台覆盖
  if (patch.results && typeof patch.results === 'object') {
    merged.results = { ...(data.results || {}), ...patch.results };
  }
  db.prepare('UPDATE advice_history SET data_json=? WHERE id=? AND type=?')
    .run(JSON.stringify(merged), id, type);
  return true;
}

migrate();
// 直接运行 `node src/db.js --reseed` 可重置种子
if (require.main === module) {
  const force = process.argv.includes('--reseed');
  seedIfEmpty(force);
}

module.exports = { getDb, migrate, seedIfEmpty, saveAdvice, listAdvice, updateAdvice, DB_PATH };
