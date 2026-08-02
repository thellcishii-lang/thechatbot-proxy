// api/admin-login.js (Vercel版)
//
// 秘書Zoe(管理画面)の第一段階の認証:管理者パスワードのチェックだけを行います。
// これが通った後、ブラウザ側でFace ID(WebAuthn)による第二段階の認証に進みます。
// 保存先(レート制限)はNetlify BlobsからUpstash Redisに切り替え。ロジック自体は変更ありません。

const { kv } = require("@vercel/kv");

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
      // 一時的な診断情報:パスワードの中身は一切含めず、文字数と
      // 前後の空白を除いた場合に一致するかどうかだけを返す
      res.status(401).json({
        error: "パスワードが違います",
        debug: {
          receivedLength: received.length,
          storedLength: stored.length,
          matchesWhenTrimmed: received.trim() === stored.trim(),
          storedIsEmpty: stored.length === 0,
        },
      });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "内部エラー: " + err.message });
  }
};
