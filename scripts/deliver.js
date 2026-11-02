#!/usr/bin/env node

// ============================================================================
// Follow Builders — Delivery Script
// ============================================================================
// Sends a digest to the user via their chosen delivery method.
// Supports: WeCom group robot, Telegram bot, Email (via Resend), or stdout.
//
// Usage:
//   echo "digest text" | node deliver.js
//   node deliver.js --message "digest text"
//   node deliver.js --file /path/to/digest.txt
//
// The script reads delivery config from ~/.follow-builders/config.json
// and API keys / webhook URLs from ~/.follow-builders/.env
//
// Delivery methods:
//   - "smtp": sends an HTML + plain-text email via SMTP (needs SMTP_HOST/USER/PASS + MAIL_TO in .env)  ← 当前使用
//   - "pushplus": sends to personal WeChat via PushPlus (needs PUSHPLUS_TOKEN; 需付费实名，已停用)
//   - "wecom": sends to a WeCom group robot (needs WECOM_WEBHOOK_URL in .env)
//   - "telegram": sends via Telegram Bot API (needs TELEGRAM_BOT_TOKEN + chat ID)
//   - "email": sends via Resend API (needs RESEND_API_KEY + email address)
//   - "stdout" (default): just prints to terminal
// ============================================================================

// LOCAL PATCH: Node's global fetch ignores HTTP_PROXY/HTTPS_PROXY by default.
if (!process.env.NODE_USE_ENV_PROXY) process.env.NODE_USE_ENV_PROXY = '1';

const FETCH_TIMEOUT_MS = 30000;

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { config as loadEnv } from 'dotenv';

// -- Constants ---------------------------------------------------------------

const USER_DIR = join(homedir(), '.follow-builders');
const CONFIG_PATH = join(USER_DIR, 'config.json');
const ENV_PATH = join(USER_DIR, '.env');

// -- Read input --------------------------------------------------------------

// The digest text can come from stdin, --message flag, or --file flag
async function getDigestText() {
  const args = process.argv.slice(2);

  // Check --message flag
  const msgIdx = args.indexOf('--message');
  if (msgIdx !== -1 && args[msgIdx + 1]) {
    return args[msgIdx + 1];
  }

  // Check --file flag
  const fileIdx = args.indexOf('--file');
  if (fileIdx !== -1 && args[fileIdx + 1]) {
    return await readFile(args[fileIdx + 1], 'utf-8');
  }

  // Read from stdin
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// -- PushPlus (微信公众号推送) Delivery --------------------------------------

// PushPlus sends to the user's personal WeChat via its official account.
// POST https://www.pushplus.plus/send  {token, title, content, template}
// Success is {"code": 200}. Free tier: 200 messages/day — plenty for a digest.
// `template` MUST be "markdown"; the default "html" template collapses newlines
// and the digest arrives as one unreadable wall of text.
//
// Content length: the WeChat side caps template-message bodies, so long digests
// are split on paragraph boundaries. Chunk size is deliberately conservative —
// if a single chunk still gets truncated in WeChat, lower PUSHPLUS_MAX_CHARS.
const PUSHPLUS_API = 'https://www.pushplus.plus/send';
const PUSHPLUS_MAX_CHARS = 12000;
const PUSHPLUS_MAX_CHUNKS = 5;

async function sendPushPlus(text, token, timezone) {
  const date = new Date().toLocaleDateString('sv-SE', { timeZone: timezone || 'Asia/Shanghai' });

  const chunks = [];
  let remaining = text;
  while (remaining.length > 0 && chunks.length < PUSHPLUS_MAX_CHUNKS) {
    if (remaining.length <= PUSHPLUS_MAX_CHARS) {
      chunks.push(remaining);
      remaining = '';
      break;
    }
    // Prefer a paragraph break, fall back to a line break, then a hard cut.
    let cut = remaining.lastIndexOf('\n\n', PUSHPLUS_MAX_CHARS);
    if (cut < PUSHPLUS_MAX_CHARS * 0.5) cut = remaining.lastIndexOf('\n', PUSHPLUS_MAX_CHARS);
    if (cut <= 0) cut = PUSHPLUS_MAX_CHARS;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining.length > 0) {
    // Hit the chunk ceiling — drop the tail rather than silently losing the middle.
    console.error(`PushPlus: digest exceeds ${PUSHPLUS_MAX_CHUNKS} chunks, tail truncated`);
  }

  const total = chunks.length;
  for (let i = 0; i < total; i++) {
    const body = chunks[i].trim();
    if (!body) continue;

    const title = total > 1
      ? `AI Builders Digest · ${date} (${i + 1}/${total})`
      : `AI Builders Digest · ${date}`;

    const res = await fetch(PUSHPLUS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, title, content: body, template: 'markdown' }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });

    const data = await res.json().catch(() => null);
    if (!data || data.code !== 200) {
      throw new Error(
        `PushPlus API error: ${data ? (data.msg || JSON.stringify(data)) : `HTTP ${res.status}`} (code ${data ? data.code : 'n/a'})`
      );
    }

    if (total > 1) await new Promise(r => setTimeout(r, 1000));
  }

  return total;
}

// -- WeCom (企业微信) Delivery -----------------------------------------------

// Sends to a WeCom group robot webhook.
// WeCom markdown messages cap at 4096 BYTES (not characters) — Chinese text
// costs 3 bytes per char, so long digests are split into chunks.
// API rate limit is 20 messages/minute, hence the delay between chunks.
async function sendWeCom(text, webhookUrl) {
  const MAX_BYTES = 3400;
  const chunks = [];
  let remaining = text;

  while (Buffer.byteLength(remaining, 'utf8') > 0) {
    if (Buffer.byteLength(remaining, 'utf8') <= MAX_BYTES) {
      chunks.push(remaining);
      break;
    }
    // Cut at the last line break that still fits, so we don't mangle markdown.
    let cut = remaining.length;
    while (cut > 0 && Buffer.byteLength(remaining.slice(0, cut), 'utf8') > MAX_BYTES) {
      cut = remaining.lastIndexOf('\n', cut - 1);
      if (cut <= 0) { cut = -1; break; }
    }
    if (cut <= 0) {
      // No usable newline — hard cut on a character boundary.
      cut = MAX_BYTES / 3;
    }
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }

  for (let i = 0; i < chunks.length; i++) {
    const body = chunks[i].trim();
    if (!body) continue;

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content: body } }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });

    const data = await res.json().catch(() => null);
    if (!data || data.errcode !== 0) {
      throw new Error(
        `WeCom API error: ${data ? data.errmsg : `HTTP ${res.status}`} (errcode ${data ? data.errcode : 'n/a'})`
      );
    }

    if (chunks.length > 1) await new Promise(r => setTimeout(r, 600));
  }

  return chunks.length;
}

// -- Telegram Delivery -------------------------------------------------------

// Sends the digest via Telegram Bot API.
// The user creates a bot via @BotFather and provides the token.
// The chat ID is obtained when the user sends their first message to the bot.
async function sendTelegram(text, botToken, chatId) {
  // Telegram has a 4096 character limit per message.
  // If the digest is longer, we split it into chunks.
  const MAX_LEN = 4000;
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LEN) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline near the limit
    let splitAt = remaining.lastIndexOf('\n', MAX_LEN);
    if (splitAt < MAX_LEN * 0.5) splitAt = MAX_LEN;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  for (const chunk of chunks) {
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        })
      }
    );

    if (!res.ok) {
      const err = await res.json();
      // If Markdown parsing fails, retry without parse_mode
      if (err.description && err.description.includes("can't parse")) {
        await fetch(
          `https://api.telegram.org/bot${botToken}/sendMessage`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: chunk,
              disable_web_page_preview: true
            })
          }
        );
      } else {
        throw new Error(`Telegram API error: ${err.description}`);
      }
    }

    // Small delay between chunks to avoid rate limiting
    if (chunks.length > 1) await new Promise(r => setTimeout(r, 500));
  }
}

// -- Digest text → HTML ------------------------------------------------------

// Why this exists: a plain-text email renders at whatever size the recipient's
// client picks (Hotmail/Outlook web default to roughly 13px, which is genuinely
// hard to read for long-form text), and the sender has no way to override it.
// Sending an HTML body with an explicit font-size alongside the plain text
// fixes readability. nodemailer turns { text, html } into multipart/alternative
// automatically, so clients that refuse HTML still get the plain-text version.
const DIGEST_FONT_SIZE = 20;      // px — override via config.delivery.fontSize
const DIGEST_LINE_HEIGHT = 1.75;  //      override via config.delivery.lineHeight
const DIGEST_MAX_WIDTH = 860;     // px — override via config.delivery.maxWidth

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function linkify(escaped) {
  return escaped.replace(
    /(https?:\/\/[^\s<>"']+)/g,
    '<a href="$1" style="color:#0b5cad;text-decoration:underline;word-break:break-all;">$1</a>'
  );
}

function inline(s) {
  return linkify(escapeHtml(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>'));
}

// Renders the skill's plain-text digest format as styled HTML.
// Structure detected: title line, "═══ SECTION ═══" dividers, markdown
// headings (so the archived .md renders the same way), standalone short lines
// with no sentence-ending punctuation (builder names / episode titles), and
// everything else as paragraphs.
function digestToHtml(text, opts = {}) {
  const fontSize = Number(opts.fontSize) || DIGEST_FONT_SIZE;
  const lineHeight = Number(opts.lineHeight) || DIGEST_LINE_HEIGHT;
  const maxWidth = Number(opts.maxWidth) || DIGEST_MAX_WIDTH;

  const pStyle = `margin:0 0 16px;font-size:${fontSize}px;line-height:${lineHeight};color:#1a1a1a;`;
  const hStyle = `margin:30px 0 12px;font-size:${fontSize + 2}px;line-height:1.4;color:#111111;font-weight:600;`;
  const sStyle = `margin:36px 0 20px;padding:8px 0;font-size:${fontSize - 1}px;letter-spacing:1px;color:#5a5a5a;font-weight:600;border-top:1px solid #e2e2e2;border-bottom:1px solid #e2e2e2;`;

  const out = [];
  let buf = [];
  let title = 'AI Builders Digest';
  let sawTitle = false;

  const flush = () => {
    const chunk = buf.join('\n').replace(/\s+$/, '');
    buf = [];
    if (!chunk.trim()) return;
    const html = chunk.split('\n').map((l) => inline(l)).join('<br>');
    out.push(`<p style="${pStyle}">${html}</p>`);
  };

  for (const line of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    const t = line.trim();

    if (!t) { flush(); continue; }

    if (!sawTitle) {
      sawTitle = true;
      title = t;
      out.push(`<h1 style="margin:0 0 10px;font-size:${fontSize + 7}px;line-height:1.3;color:#111111;font-weight:700;">${inline(t)}</h1>`);
      continue;
    }

    // Section divider: ═══ X / TWITTER ═══
    if (/^\u2550{2,}/.test(t)) {
      flush();
      out.push(`<div style="${sStyle}">${escapeHtml(t.replace(/^[\u2550\s]+|[\u2550\s]+$/g, ''))}</div>`);
      continue;
    }

    // Markdown heading (used by the archived .md copy)
    const md = t.match(/^(#{1,6})\s+(.*)$/);
    if (md) {
      flush();
      out.push(`<h2 style="${hStyle}">${inline(md[2])}</h2>`);
      continue;
    }

    // Standalone heading line: builder name or episode title
    if (
      t.length <= 105 &&
      !/https?:\/\//.test(t) &&
      !/^[(\[]/.test(t) &&
      !/[.。!！?？,，;；]$/.test(t)
    ) {
      flush();
      out.push(`<h2 style="${hStyle}">${inline(t)}</h2>`);
      continue;
    }

    buf.push(line);
  }
  flush();

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f3;">
<div style="max-width:${maxWidth}px;margin:0 auto;padding:28px 32px 44px;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;font-size:${fontSize}px;line-height:${lineHeight};color:#1a1a1a;-webkit-text-size-adjust:100%;">
${out.join('\n')}
</div>
</body>
</html>`;
}

// -- Email Delivery (SMTP: QQ / 163 / Gmail / any provider) ------------------

// Sends the digest as a multipart/alternative email through a standard SMTP
// server: an HTML body carrying an explicit font size, plus the plain-text
// original as fallback. Credentials come from .env; recipient comes from
// config.delivery.email.
//
// NOTE for QQ mail: SMTP_PASS must be the 16-char 授权码 generated in
// QQ邮箱 → 设置 → 账户 → POP3/SMTP 服务, NOT the account login password.
async function sendSmtp(text, opts) {
  const nodemailer = (await import('nodemailer')).default;

  const transporter = nodemailer.createTransport({
    host: opts.host,
    port: opts.port,
    secure: opts.secure,          // true = SSL on 465, false = STARTTLS on 587
    auth: { user: opts.user, pass: opts.pass },
    connectionTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 60000,
    tls: { minVersion: 'TLSv1.2' }
  });

  // Fail fast with a clear message instead of a stack trace
  try {
    await transporter.verify();
  } catch (err) {
    const raw = err.message || String(err);
    if (/535|authentication failed|认证失败/i.test(raw)) {
      throw new Error(
        `SMTP 认证失败：${raw}。QQ 邮箱请确认 SMTP_PASS 填的是「授权码」而不是登录密码（QQ邮箱 → 设置 → 账户 → POP3/SMTP 服务 → 生成授权码）。`
      );
    }
    throw new Error(`SMTP 连接失败：${raw}`);
  }

  const date = new Date().toLocaleDateString('en-CA', { timeZone: opts.timezone || 'Asia/Shanghai' });
  const info = await transporter.sendMail({
    from: opts.from || opts.user,
    to: opts.to,
    subject: `AI Builders Digest — ${date}`,
    // Plain text first: it is the fallback for clients that refuse HTML.
    text,
    html: digestToHtml(text, { fontSize: opts.fontSize, lineHeight: opts.lineHeight, maxWidth: opts.maxWidth })
  });

  return info.messageId;
}

// -- Email Delivery (Resend) -------------------------------------------------

// Sends the digest via Resend's email API.
// The user provides their own Resend API key and email address.
async function sendEmail(text, apiKey, toEmail) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      from: 'AI Builders Digest <digest@resend.dev>',
      to: [toEmail],
      subject: `AI Builders Digest — ${new Date().toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
      })}`,
      text: text
    })
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Resend API error: ${err.message || JSON.stringify(err)}`);
  }
}

// -- Main --------------------------------------------------------------------

async function main() {
  // Load env and config
  loadEnv({ path: ENV_PATH });

  let config = {};
  if (existsSync(CONFIG_PATH)) {
    config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
  }

  const delivery = config.delivery || { method: 'stdout' };
  const digestText = await getDigestText();

  if (!digestText || digestText.trim().length === 0) {
    console.log(JSON.stringify({ status: 'skipped', reason: 'Empty digest text' }));
    return;
  }

  try {
    switch (delivery.method) {
      case 'pushplus': {
        const token = process.env.PUSHPLUS_TOKEN;
        if (!token) {
          throw new Error(
            'PUSHPLUS_TOKEN not found. Get one at https://www.pushplus.plus (WeChat scan login), then add it to ~/.follow-builders/.env as: PUSHPLUS_TOKEN=...'
          );
        }
        const sent = await sendPushPlus(digestText, token, config.timezone);
        console.log(JSON.stringify({
          status: 'ok',
          method: 'pushplus',
          message: `Digest sent to WeChat in ${sent} message(s)`
        }));
        break;
      }

      case 'wecom': {
        const webhookUrl = process.env.WECOM_WEBHOOK_URL;
        if (!webhookUrl) {
          throw new Error(
            'WECOM_WEBHOOK_URL not found. Add it to ~/.follow-builders/.env as: WECOM_WEBHOOK_URL=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...'
          );
        }
        if (!webhookUrl.startsWith('https://qyapi.weixin.qq.com/')) {
          throw new Error('WECOM_WEBHOOK_URL looks wrong — it must start with https://qyapi.weixin.qq.com/');
        }
        const sent = await sendWeCom(digestText, webhookUrl);
        console.log(JSON.stringify({
          status: 'ok',
          method: 'wecom',
          message: `Digest sent to WeCom in ${sent} message(s)`
        }));
        break;
      }

      case 'telegram': {
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        const chatId = delivery.chatId;
        if (!botToken) throw new Error('TELEGRAM_BOT_TOKEN not found in .env');
        if (!chatId) throw new Error('delivery.chatId not found in config.json');
        await sendTelegram(digestText, botToken, chatId);
        console.log(JSON.stringify({
          status: 'ok',
          method: 'telegram',
          message: 'Digest sent to Telegram'
        }));
        break;
      }

      case 'smtp': {
        const host = process.env.SMTP_HOST;
        const user = process.env.SMTP_USER;
        const pass = process.env.SMTP_PASS;
        const toEmail = process.env.MAIL_TO || delivery.email;
        if (!host) throw new Error('SMTP_HOST not found in .env（QQ 邮箱填 smtp.qq.com）');
        if (!user) throw new Error('SMTP_USER not found in .env（填完整邮箱地址）');
        if (!pass) throw new Error('SMTP_PASS not found in .env（QQ 邮箱填 16 位授权码，不是登录密码）');
        if (!toEmail) throw new Error('收件地址缺失：在 .env 填 MAIL_TO 或在 config.json 填 delivery.email');
        const messageId = await sendSmtp(digestText, {
          host,
          port: Number(process.env.SMTP_PORT || 465),
          secure: (process.env.SMTP_SECURE || 'true') === 'true',
          user,
          pass,
          to: toEmail,
          timezone: config.timezone,
          fontSize: delivery.fontSize,
          lineHeight: delivery.lineHeight,
          maxWidth: delivery.maxWidth
        });
        console.log(JSON.stringify({
          status: 'ok',
          method: 'smtp',
          message: `Digest sent to ${toEmail}`,
          messageId
        }));
        break;
      }

      case 'email': {
        const apiKey = process.env.RESEND_API_KEY;
        const toEmail = delivery.email;
        if (!apiKey) throw new Error('RESEND_API_KEY not found in .env');
        if (!toEmail) throw new Error('delivery.email not found in config.json');
        await sendEmail(digestText, apiKey, toEmail);
        console.log(JSON.stringify({
          status: 'ok',
          method: 'email',
          message: `Digest sent to ${toEmail}`
        }));
        break;
      }

      case 'stdout':
      default:
        // Just print to terminal — the agent or OpenClaw handles delivery
        console.log(digestText);
        break;
    }
  } catch (err) {
    console.log(JSON.stringify({
      status: 'error',
      method: delivery.method,
      message: err.message
    }));
    process.exit(1);
  }
}

export { digestToHtml };

// Only run the CLI when this file is executed directly (not when test code
// imports it to exercise digestToHtml).
const invokedAsScript = (process.argv[1] || '').endsWith('deliver.js');
if (invokedAsScript) main();
