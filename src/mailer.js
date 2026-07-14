'use strict';
/**
 * 零依赖邮件发送模块：基于 Node 内置 net / tls 实现最小 SMTP 客户端。
 *
 * 配置（环境变量）：
 *   SMTP_HOST   发信服务器，如 smtp.qq.com / smtp.163.com / smtp.gmail.com
 *   SMTP_PORT   端口，默认 465（隐式 TLS）。587 走 STARTTLS
 *   SMTP_SECURE 可选，强制 true/false；不填时端口 465 视为安全连接
 *   SMTP_USER   发信账号
 *   SMTP_PASS   授权码（注意：QQ/163 邮箱需用「授权码」而非登录密码）
 *   SMTP_FROM   发件人地址，默认同 SMTP_USER
 *
 * 未配置 SMTP_HOST/USER/PASS 时进入「控制台回退」模式：验证码仅打印到服务端
 * 控制台，保证本地零依赖也能完整跑通注册校验流程（生产请配置真实 SMTP）。
 */
const net = require('net');
const tls = require('tls');
const os = require('os');

const SMTP = {
  host: process.env.SMTP_HOST || '',
  port: Number(process.env.SMTP_PORT || 465),
  secure: process.env.SMTP_SECURE
    ? /^(1|true|yes)$/i.test(process.env.SMTP_SECURE)
    : Number(process.env.SMTP_PORT || 465) === 465,
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  from: process.env.SMTP_FROM || process.env.SMTP_USER || '',
};

function configured() {
  return !!(SMTP.host && SMTP.user && SMTP.pass);
}

function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }

function buildMessage({ to, subject, text, html }) {
  const fromName = 'Kindle Trader AI';
  const headers = [
    'From: ' + fromName + ' <' + SMTP.from + '>',
    'To: ' + to,
    'Subject: =?UTF-8?B?' + b64(subject) + '?=',
    'Date: ' + new Date().toUTCString(),
    'MIME-Version: 1.0',
  ];
  if (html) {
    headers.push('Content-Type: multipart/alternative; boundary="kta-boundary"');
    const body =
      '--kta-boundary\r\n' +
      'Content-Type: text/plain; charset=UTF-8\r\n' +
      'Content-Transfer-Encoding: base64\r\n\r\n' +
      b64(text) + '\r\n' +
      '--kta-boundary\r\n' +
      'Content-Type: text/html; charset=UTF-8\r\n' +
      'Content-Transfer-Encoding: base64\r\n\r\n' +
      b64(html) + '\r\n' +
      '--kta-boundary--';
    return headers.join('\r\n') + '\r\n\r\n' + body;
  }
  headers.push('Content-Type: text/plain; charset=UTF-8');
  headers.push('Content-Transfer-Encoding: base64');
  return headers.join('\r\n') + '\r\n\r\n' + b64(text);
}

function smtpSend(msg) {
  return new Promise((resolve, reject) => {
    const domain = (SMTP.from.split('@')[1] || os.hostname() || 'localhost');
    const doConnect = SMTP.secure ? tls.connect : net.connect;
    let transport = doConnect({ host: SMTP.host, port: SMTP.port });
    let buffer = '';
    let pending = null;
    let closed = false;

    const waitFor = (codes) => new Promise((res, rej) => { pending = { res, rej, codes }; });
    const send = (line) => transport.write(line + '\r\n');

    function onData(chunk) {
      buffer += chunk.toString('utf8');
      let i;
      while ((i = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        const m = /^(\d{3})([ -])(.*)$/.exec(line);
        if (!m) continue;
        if (m[2] === '-') continue; // 多行续行，等待终端行
        if (!pending) continue;
        const p = pending;
        pending = null;
        if (p.codes.includes(m[1])) p.res(m[1]);
        else p.rej(new Error('SMTP 错误 ' + m[1] + ': ' + line));
      }
    }

    transport.on('data', onData);
    transport.on('error', (e) => {
      if (pending) { const p = pending; pending = null; p.rej(e); }
      else if (!closed) reject(e);
    });
    transport.setTimeout(20000);
    transport.on('timeout', () => {
      transport.destroy();
      if (pending) { const p = pending; pending = null; p.rej(new Error('SMTP 连接超时')); }
    });

    async function run() {
      try {
        await waitFor(['220']);
        send('EHLO ' + domain);
        await waitFor(['250']);
        if (!SMTP.secure) {
          send('STARTTLS');
          await waitFor(['220']);
          const tlsSock = tls.connect({ socket: transport, host: SMTP.host });
          transport.removeListener('data', onData);
          transport = tlsSock;
          transport.on('data', onData);
          transport.on('error', (e) => { if (pending) { const p = pending; pending = null; p.rej(e); } });
          transport.setTimeout(20000);
          await new Promise((r) => tlsSock.once('secureConnect', r));
          send('EHLO ' + domain);
          await waitFor(['250']);
        }
        send('AUTH LOGIN');
        await waitFor(['334']);
        send(b64(SMTP.user));
        await waitFor(['334']);
        send(b64(SMTP.pass));
        const authCode = await waitFor(['235', '535']);
        if (authCode === '535') throw new Error('SMTP 认证失败：请检查账号与授权码');
        send('MAIL FROM:<' + SMTP.from + '>');
        await waitFor(['250']);
        send('RCPT TO:<' + msg.to + '>');
        await waitFor(['250']);
        send('DATA');
        await waitFor(['354']);
        send(buildMessage(msg) + '\r\n.');
        await waitFor(['250']);
        send('QUIT');
        await waitFor(['221']);
        transport.end();
        closed = true;
        resolve({ sent: true });
      } catch (e) {
        try { transport.end(); } catch { /* ignore */ }
        closed = true;
        reject(e);
      }
    }
    run();
  });
}

/**
 * 发送注册/校验验证码邮件。
 * 未配置 SMTP 时回退到控制台打印（仍返回真实验证码供本地校验）。
 */
async function sendVerificationCode(email, code, purposeLabel = '注册') {
  const subject = `[Kindle Trader AI] 您的${purposeLabel}验证码`;
  const text =
    `您的验证码是 ${code}，10 分钟内有效，请勿泄露给他人。\n\n如非本人操作，请忽略本邮件。`;
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:420px;margin:0 auto;padding:24px;background:#fff7f0;border-radius:16px">` +
    `<h2 style="margin:0 0 12px">📚 Kindle Trader AI</h2>` +
    `<p>您正在${purposeLabel}，验证码如下：</p>` +
    `<div style="font-size:32px;font-weight:700;letter-spacing:6px;color:#e8590c;margin:12px 0">${code}</div>` +
    `<p style="color:#666;font-size:13px">10 分钟内有效，请勿泄露给他人。如非本人操作请忽略。</p>` +
    `</div>`;

  if (!configured()) {
    console.log('\n\x1b[33m[mailer] SMTP 未配置：验证码仅打印到控制台（生产请设置 SMTP_HOST/SMTP_USER/SMTP_PASS）\x1b[0m');
    console.log(`\x1b[36m[mailer] 收件人 ${email} 的验证码 = ${code}\x1b[0m\n`);
    return { sent: false, console: true };
  }
  const MAX_TRIES = 2;
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    try {
      await smtpSend({ to: email, subject, text, html });
      return { sent: true };
    } catch (e) {
      lastErr = e;
      console.error(`[mailer] 第 ${attempt}/${MAX_TRIES} 次发送失败：${e.message}`);
      if (attempt < MAX_TRIES) await new Promise((r) => setTimeout(r, 800)); // 简单退避后重试
    }
  }
  // 重试仍失败：回退控制台打印，保证注册流程仍可本地走通（与未配置 SMTP 行为一致）
  console.log('\n\x1b[33m[mailer] SMTP 多次发送失败，回退到控制台打印验证码\x1b[0m');
  console.log(`\x1b[36m[mailer] 收件人 ${email} 的验证码 = ${code}\x1b[0m\n`);
  return { sent: false, console: true, error: lastErr && lastErr.message };
}

module.exports = { configured, sendVerificationCode, smtpSend };
