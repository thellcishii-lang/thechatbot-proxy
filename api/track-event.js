// api/track-event.js (Vercel版)
//
// サイトへのアクセス数・チャット開始数を、日付ごとに数えるAPIです。
// 保存先はNetlify BlobsからUpstash Redisに切り替え。ロジック自体は変更ありません。

const { kv } = require("@vercel/kv");

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "unknown";
}

async function checkRateLimit(ip) {
  try {
    const key = `ratelimit:track-event:${ip}`;
    const WINDOW_MS = 60 * 1000;
    const LIMIT = 30;
    const now = Date.now();
    const record = await kv.get(key);
    if (!record || now - record.windowStart > WINDOW_MS) {
      await kv.set(key, { windowStart: now, count: 1 }, { ex: 60 });
      return true;
    }
    if (record.count >= LIMIT) return false;
    await kv.set(key, { windowStart: record.windowStart, count: record.count + 1 }, { ex: 60 });
    return true;
  } catch (e) {
    return true;
  }
}

function todayJST() {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
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
    res.status(200).json({ recorded: false }); // 記録目的なので静かに無視する
    return;
  }

  try {
    const reqBody = req.body || {};

    // 秘書Zoe専用:統計の取得(内部シークレットで保護)
    if (reqBody.action === "get") {
      if (!process.env.INTERNAL_FUNCTION_SECRET || reqBody.secret !== process.env.INTERNAL_FUNCTION_SECRET) {
        res.status(401).json({ error: "許可されていません" });
        return;
      }
      const botId = reqBody.botId || "Zoe001";
      const date = reqBody.date || todayJST();
      const siteVisit = (await kv.get(`analytics:${botId}:site_visit:${date}`)) || { count: 0 };
      const chatStart = (await kv.get(`analytics:${botId}:chat_start:${date}`)) || { count: 0 };
      res.status(200).json({ botId, date, siteVisitCount: siteVisit.count, chatStartCount: chatStart.count });
      return;
    }

    const botId = reqBody.botId || "Zoe001";
    const type = reqBody.type;
    if (type !== "site_visit" && type !== "chat_start") {
      res.status(400).json({ error: "typeが不正です" });
      return;
    }

    const date = reqBody.date || todayJST();
    const key = `analytics:${botId}:${type}:${date}`;

    const current = (await kv.get(key)) || { count: 0 };
    current.count += 1;
    await kv.set(key, current);

    res.status(200).json({ recorded: true });
  } catch (err) {
    res.status(200).json({ recorded: false, error: err.message });
  }
};
