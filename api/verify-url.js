// api/verify-url.js (Vercel版)
//
// お客様が伝えた会社URLが実在するか、また会社名との一致を確認するAPIです。
// 保存先はNetlify BlobsからUpstash Redisに切り替え。ロジック自体は変更ありません。

const { kv } = require("@vercel/kv");
const dns = require("dns").promises;

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "unknown";
}

async function checkRateLimit(ip) {
  try {
    const key = `ratelimit:verify-url:${ip}`;
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

// ============================================================
// 共通IP不正利用トラッカー(全Function共通、キー"ipabuse:{ip}")
// ============================================================
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

function isPrivateIp(ip) {
  if (/^127\./.test(ip)) return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^169\.254\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;
  if (ip === "::1") return true;
  if (/^f[cd]/i.test(ip)) return true;
  return false;
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
    let url = (reqBody.url || "").trim();
    const customerName = (reqBody.customerName || "").trim();

    if (!url) {
      res.status(200).json({ exists: false, nameMatch: false, reason: "URL未入力" });
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      url = "https://" + url;
    }

    let hostname;
    try {
      hostname = new URL(url).hostname;
    } catch (e) {
      res.status(200).json({ exists: false, nameMatch: false, reason: "URLの形式が不正です" });
      return;
    }
    if (hostname === "localhost") {
      res.status(200).json({ exists: false, nameMatch: false, reason: "このホストへはアクセスできません" });
      return;
    }
    try {
      const { address } = await dns.lookup(hostname);
      if (isPrivateIp(address)) {
        res.status(200).json({ exists: false, nameMatch: false, reason: "このホストへはアクセスできません" });
        return;
      }
    } catch (e) {
      res.status(200).json({ exists: false, nameMatch: false, reason: "名前解決に失敗しました" });
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    let exists = false;
    let pageText = "";
    try {
      const fetchRes = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; the.chatBOT-URLCheck/1.0)" },
      });
      exists = fetchRes.status < 500;
      if (exists) {
        const html = await fetchRes.text();
        pageText = html.replace(/<script[\s\S]*?<\/script>/gi, "")
                        .replace(/<style[\s\S]*?<\/style>/gi, "")
                        .replace(/<[^>]+>/g, " ")
                        .replace(/\s+/g, "");
      }
    } catch (e) {
      exists = false;
    } finally {
      clearTimeout(timeout);
    }

    let nameMatch = null;
    if (exists && customerName) {
      const normalized = customerName.replace(/株式会社|有限会社|合同会社|\(株\)|㈱/g, "").trim();
      const candidates = [customerName, normalized].filter(Boolean);
      nameMatch = candidates.some((c) => c && pageText.includes(c));
    }

    res.status(200).json({ exists, nameMatch, checkedUrl: url });
  } catch (err) {
    res.status(200).json({ exists: false, nameMatch: null, error: err.message });
  }
};
