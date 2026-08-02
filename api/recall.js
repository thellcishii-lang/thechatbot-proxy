// api/recall.js (Vercel版)
//
// 「会社名」+「お名前」の両方が一致する訪問者について、過去の会話内容を
// 覚えておき、次回同じ組み合わせで訪れた時に呼び出すためのAPIです。
// 保存先はNetlify BlobsからUpstash Redisに切り替え。ロジック自体は変更ありません。

const { kv } = require("@vercel/kv");

function makeKey(company, person) {
  const norm = (s) => (s || "").trim().toLowerCase();
  return `recall:${norm(company)}::${norm(person)}`;
}

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "unknown";
}

async function checkRateLimit(ip) {
  try {
    const key = `ratelimit:recall:${ip}`;
    const WINDOW_MS = 5 * 60 * 1000;
    const LIMIT = 20;
    const now = Date.now();
    const record = await kv.get(key);
    if (!record || now - record.windowStart > WINDOW_MS) {
      await kv.set(key, { windowStart: now, count: 1 }, { ex: 300 });
      return true;
    }
    if (record.count >= LIMIT) return false;
    await kv.set(key, { windowStart: record.windowStart, count: record.count + 1 }, { ex: 300 });
    return true;
  } catch (e) {
    return true;
  }
}

async function checkIpAbuse(ip) {
  try {
    const record = await kv.get(`ipabuse:${ip}`);
    return !!(record && record.blacklisted);
  } catch (e) {
    return false;
  }
}

async function recordIpAbuseStrike(ip) {
  try {
    const key = `ipabuse:${ip}`;
    const record = (await kv.get(key)) || {};
    const strikes = (record.strikes || 0) + 1;
    const blacklisted = strikes >= 3;
    await kv.set(key, { ...record, strikes, blacklisted });
  } catch (e) {
    // 記録に失敗しても本来の処理は止めない
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

  const isAbuser = await checkIpAbuse(clientIp);
  if (isAbuser) {
    res.status(403).json({ error: "このIPアドレスは、不審なアクセスが検知されたため利用を制限しています。" });
    return;
  }

  const withinLimit = await checkRateLimit(clientIp);
  if (!withinLimit) {
    await recordIpAbuseStrike(clientIp);
    res.status(429).json({ error: "リクエストが多すぎます。しばらくしてから再度お試しください。" });
    return;
  }

  try {
    const reqBody = req.body || {};
    if (!reqBody.company || !reqBody.person) {
      res.status(400).json({ error: "companyとpersonは必須です(名前だけの場合は記憶対象外)" });
      return;
    }
    const key = makeKey(reqBody.company, reqBody.person);
    if (reqBody.action === "save") {
      const record = {
        company: reqBody.company,
        person: reqBody.person,
        firstTopic: reqBody.firstTopic || "",
        lastUpdated: new Date().toISOString(),
      };
      await kv.set(key, record);
      res.status(200).json({ saved: true });
      return;
    }
    if (reqBody.action === "lookup") {
      const record = await kv.get(key);
      if (!record) {
        res.status(200).json({ found: false });
        return;
      }
      res.status(200).json({ found: true, record });
      return;
    }
    res.status(400).json({ error: "不明なactionです" });
  } catch (err) {
    res.status(500).json({ error: "内部エラー: " + err.message });
  }
};
