// api/admin-login.js (Vercel版)
//
// 秘書Zoe(管理画面)の認証です。
//
// 【一時措置・2026年8月2日】Face ID(WebAuthn)まわりの不具合の切り分けが
// 終わるまでの間、パスワード確認が通った時点でそのままログインセッションを
// 発行し、Face ID認証のステップを一時的にスキップしています。原因が分かり
// 次第、必ずFace ID必須の状態に戻してください(パスワードだけでは、パスワードが
// 漏れた場合に誰でも秘書Zoeを操作できてしまいます)。

const { kv } = require("@vercel/kv");
const crypto = require("crypto");

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12時間

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "unknown";
}

async function checkRateLimit(ip) {
  try {
    const key = `ratelimit:admin-login:${ip}`;
    const WINDOW_MS = 15 * 60 * 1000;
    const LIMIT = 10; // 15分間に10回まで(総当たり対策)
    const now = Date.now();
    const record = await kv.get(key);
    if (!record || now - record.windowStart > WINDOW_MS) {
      await kv.set(key, { windowStart: now, count: 1 }, { ex: 900 });
      return true;
    }
    if (record.count >= LIMIT) return false;
    await kv.set(key, { windowStart: record.windowStart, count: record.count + 1 }, { ex: 900 });
    return true;
  } catch (e) {
    return true;
  }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "POSTのみ対応しています" });
    return;
  }

  const clientIp = getClientIp(req);
  const withinLimit = await checkRateLimit(clientIp);
  if (!withinLimit) {
    res.status(429).json({ error: "リクエストが多すぎます。しばらくしてから再度お試しください。" });
    return;
  }

  try {
    const { password } = req.body || {};
    const stored = process.env.ADMIN_PASSWORD || "";
    const received = password || "";
    if (!stored || received !== stored) {
      res.status(401).json({ error: "パスワードが違います" });
      return;
    }

    // 【一時措置】Face IDを経ずに、ここでセッションを発行する
    const sessionToken = crypto.randomBytes(32).toString("hex");
    await kv.set(`admin-session:${sessionToken}`, { createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS });

    res.status(200).json({ ok: true, sessionToken });
  } catch (err) {
    res.status(500).json({ error: "内部エラー: " + err.message });
  }
};
