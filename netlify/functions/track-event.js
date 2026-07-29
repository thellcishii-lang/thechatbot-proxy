// netlify/functions/track-event.js
//
// サイトへのアクセス数・チャット開始数を、日付ごとに数えるための関数です。
// LP(index.html)が読み込まれた時に type:"site_visit" を、
// チャット画面(zoe-chat.html等)が読み込まれた時に type:"chat_start" を送ることで、
// 「今日は何件アクセスがあって、何件チャットが始まったか」を記録します。
//
// botId(例: Zoe001)ごとに分けて記録するので、将来PicoPay(Zoe002)等が
// 増えても、同じ仕組みのまま事業ごとの数字を分けて管理できます。

const { getStore } = require("@netlify/blobs");

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
      name: "rate-limit-track-event",
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_API_TOKEN,
    });
    const WINDOW_MS = 60 * 1000; // 1分間
    const LIMIT = 30; // 1分間に30回まで(通常のアクセスでは十分な余裕)
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

function todayJST() {
  // 日本時間の日付(YYYY-MM-DD)を基準に集計する
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
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
  const withinLimit = await checkRateLimit(clientIp);
  if (!withinLimit) {
    return { statusCode: 200, headers, body: JSON.stringify({ recorded: false }) }; // 記録目的なので静かに無視する
  }

  try {
    const req = JSON.parse(event.body);

    // 秘書Zoe専用:統計の取得(内部シークレットで保護)
    if (req.action === "get") {
      if (!process.env.INTERNAL_FUNCTION_SECRET || req.secret !== process.env.INTERNAL_FUNCTION_SECRET) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: "許可されていません" }) };
      }
      const botId = req.botId || "Zoe001";
      const date = req.date || todayJST();
      const store = getStore({
        name: "analytics",
        siteID: process.env.NETLIFY_SITE_ID,
        token: process.env.NETLIFY_API_TOKEN,
      });
      const siteVisit = (await store.get(`${botId}:site_visit:${date}`, { type: "json" })) || { count: 0 };
      const chatStart = (await store.get(`${botId}:chat_start:${date}`, { type: "json" })) || { count: 0 };
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ botId, date, siteVisitCount: siteVisit.count, chatStartCount: chatStart.count }),
      };
    }

    const botId = req.botId || "Zoe001";
    const type = req.type; // "site_visit" または "chat_start"
    if (type !== "site_visit" && type !== "chat_start") {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "typeが不正です" }) };
    }

    const store = getStore({
      name: "analytics",
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_API_TOKEN,
    });
    const date = req.date || todayJST();
    const key = `${botId}:${type}:${date}`;

    const current = (await store.get(key, { type: "json" })) || { count: 0 };
    current.count += 1;
    await store.setJSON(key, current);

    return { statusCode: 200, headers, body: JSON.stringify({ recorded: true }) };
  } catch (err) {
    // 記録機能自体の失敗でユーザー体験を止めないよう、静かに200を返す
    return { statusCode: 200, headers, body: JSON.stringify({ recorded: false, error: err.message }) };
  }
};
