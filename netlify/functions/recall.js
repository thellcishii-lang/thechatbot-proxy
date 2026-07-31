// netlify/functions/recall.js
//
// 「会社名」+「お名前」の両方が分かっている訪問者について、
// 過去の会話内容(特に最初に相談してきた件)を覚えておき、
// 次回同じ組み合わせで訪れた時に呼び出すための関数です。
//
// 名前だけ(会社名なし)の人は記憶しません(方針により対象外)。
//
// action:
//   "save"   → 会話を保存(company, person, firstTopic, history を渡す。既存があれば上書き更新)
//   "lookup" → company + person が一致するか確認し、あれば firstTopic を返す(本人確認用の相槌に使う)
//
// セキュリティ対策(2026年7月29日追加):
// 会社名+担当者名の組み合わせを総当たりされると、他社の過去の相談内容が
// 漏れてしまう可能性があるため、同一IPからのレート制限を追加しています。

const { getStore } = require("@netlify/blobs");

function makeKey(company, person){
  // 会社名+お名前を正規化(前後の空白除去・小文字化)して結合し、キーにする
  const norm = (s) => (s || "").trim().toLowerCase();
  return norm(company) + "::" + norm(person);
}

function getClientIp(event) {
  return (
    event.headers["x-nf-client-connection-ip"] ||
    (event.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    "unknown"
  );
}

async function checkRateLimit(ip) {
  try {
    const store = getStore({
      name: "rate-limit-recall",
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_API_TOKEN,
    });
    const WINDOW_MS = 5 * 60 * 1000;
    const LIMIT = 20;
    const now = Date.now();
    const record = await store.get(ip, { type: "json" });
    if (!record || now - record.windowStart > WINDOW_MS) {
      await store.setJSON(ip, { windowStart: now, count: 1 });
      return true;
    }
    if (record.count >= LIMIT) return false;
    await store.setJSON(ip, { windowStart: record.windowStart, count: record.count + 1 });
    return true;
  } catch (e) {
    return true;
  }
}

// ============================================================
// 共通IP不正利用トラッカー(全Function共通、ストア名"ip-abuse-tracker")
// ============================================================
async function checkIpAbuse(ip) {
  try {
    const store = getStore({
      name: "ip-abuse-tracker",
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_API_TOKEN,
    });
    const record = await store.get(ip, { type: "json" });
    return !!(record && record.blacklisted);
  } catch (e) {
    return false;
  }
}

async function recordIpAbuseStrike(ip) {
  try {
    const store = getStore({
      name: "ip-abuse-tracker",
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_API_TOKEN,
    });
    const record = (await store.get(ip, { type: "json" })) || {};
    const strikes = (record.strikes || 0) + 1;
    const blacklisted = strikes >= 3;
    await store.setJSON(ip, { ...record, strikes, blacklisted });
  } catch (e) {
    // 記録に失敗しても本来の処理は止めない
  }
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "POSTのみ対応しています" }) };
  }

  const clientIp = getClientIp(event);

  const isAbuser = await checkIpAbuse(clientIp);
  if (isAbuser) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: "このIPアドレスは、不審なアクセスが検知されたため利用を制限しています。" }) };
  }

  const withinLimit = await checkRateLimit(clientIp);
  if (!withinLimit) {
    await recordIpAbuseStrike(clientIp);
    return { statusCode: 429, headers, body: JSON.stringify({ error: "リクエストが多すぎます。しばらくしてから再度お試しください。" }) };
  }

  try {
    const store = getStore({
      name: "conversations",
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_API_TOKEN,
    });
    const req = JSON.parse(event.body);
    if (!req.company || !req.person) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "companyとpersonは必須です(名前だけの場合は記憶対象外)" }),
      };
    }
    const key = makeKey(req.company, req.person);
    if (req.action === "save") {
      const record = {
        company: req.company,
        person: req.person,
        firstTopic: req.firstTopic || "",
        lastUpdated: new Date().toISOString(),
      };
      await store.setJSON(key, record);
      return { statusCode: 200, headers, body: JSON.stringify({ saved: true }) };
    }
    if (req.action === "lookup") {
      const record = await store.get(key, { type: "json" });
      if (!record) {
        return { statusCode: 200, headers, body: JSON.stringify({ found: false }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ found: true, record }) };
    }
    return { statusCode: 400, headers, body: JSON.stringify({ error: "不明なactionです" }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "内部エラー: " + err.message }) };
  }
};
