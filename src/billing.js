'use strict';
/**
 * 充值与会员模块。
 * MVP 阶段支付为「模拟支付」：充值即时到账、会员即时开通，便于本地零依赖体验完整流程。
 * 生产接入真实支付（微信/支付宝/Stripe）时，只需在回调中调用 topUp / buyMembership 即可。
 */
const { getDb } = require('./db');

const MEMBERSHIP_PRICE_CENTS = 1900; // ¥19 / 月（来自需求文档 7）
const MEMBERSHIP_DAYS = 30;

function nowISO() { return new Date().toISOString(); }

function getMe(userId) {
  const u = getDb().prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u) return null;
  const rows = getDb().prepare(
    'SELECT id, amount_cents, method, status, created_at FROM recharges WHERE user_id = ? ORDER BY id DESC LIMIT 50'
  ).all(userId);
  return {
    id: u.id,
    email: u.email,
    nickname: u.nickname,
    balance: (u.balance_cents || 0) / 100,
    membership: u.membership,
    membership_expires_at: u.membership_expires_at,
    isPro: u.membership === 'pro' && (!u.membership_expires_at || new Date(u.membership_expires_at).getTime() > Date.now()),
    membership_price: MEMBERSHIP_PRICE_CENTS / 100,
    recharges: rows.map((r) => ({
      id: r.id, amount: r.amount_cents / 100, method: r.method, status: r.status, created_at: r.created_at,
    })),
  };
}

// 模拟充值：金额即时加到余额，并记录流水（status=paid）
function topUp(userId, amountCents, method = 'wechat') {
  if (!(amountCents > 0)) return { error: '充值金额无效' };
  const db = getDb();
  const info = db.prepare(
    'INSERT INTO recharges (user_id, amount_cents, method, status, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, amountCents, method, 'paid', nowISO());
  db.prepare('UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?').run(amountCents, userId);
  return { ok: true, id: info.lastInsertRowid, balance: getMe(userId).balance };
}

// 开通 / 续费会员：payMethod='balance' 走余额抵扣（需余额足够），否则模拟直接支付
function buyMembership(userId, payMethod = 'simulate') {
  const db = getDb();
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u) return { error: '用户不存在' };

  if (payMethod === 'balance') {
    if ((u.balance_cents || 0) < MEMBERSHIP_PRICE_CENTS) return { error: '余额不足，请先充值' };
    db.prepare('UPDATE users SET balance_cents = balance_cents - ? WHERE id = ?').run(MEMBERSHIP_PRICE_CENTS, userId);
    db.prepare(
      'INSERT INTO recharges (user_id, amount_cents, method, status, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(userId, -MEMBERSHIP_PRICE_CENTS, 'membership', 'paid', nowISO());
  }
  // 到期时间在「现有到期」或「现在」基础上 +30 天
  const base = (u.membership_expires_at && new Date(u.membership_expires_at).getTime() > Date.now())
    ? new Date(u.membership_expires_at)
    : new Date();
  base.setDate(base.getDate() + MEMBERSHIP_DAYS);
  db.prepare('UPDATE users SET membership = ?, membership_expires_at = ? WHERE id = ?')
    .run('pro', base.toISOString(), userId);
  return { ok: true, membership: 'pro', membership_expires_at: base.toISOString(), balance: getMe(userId).balance };
}

module.exports = { getMe, topUp, buyMembership, MEMBERSHIP_PRICE_CENTS };
