// netlify/functions/verify-url.js
//
// お客様が伝えた会社URLが実在するかを確認するための関数です。
// HEADリクエスト(失敗時はGET)を送り、応答があるかどうかだけを判定します。
// 中身の正しさまでは保証しません(あくまで「存在するかどうか」の確認)。

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

  try {
    const req = JSON.parse(event.body);
    let url = (req.url || "").trim();
    if (!url) {
      return { statusCode: 200, headers, body: JSON.stringify({ exists: false, reason: "URL未入力" }) };
    }
    if (!/^https?:\/\//i.test(url)) {
      url = "https://" + url;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    async function tryFetch(method) {
      const res = await fetch(url, {
        method,
        redirect: "follow",
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; the.chatBOT-URLCheck/1.0)" },
      });
      return res;
    }

    let ok = false;
    try {
      const res = await tryFetch("HEAD");
      ok = res.status < 500; // 404等でもドメイン自体は生きている場合があるため、まずは緩めに判定
    } catch (e) {
      try {
        const res = await tryFetch("GET");
        ok = res.status < 500;
      } catch (e2) {
        ok = false;
      }
    } finally {
      clearTimeout(timeout);
    }

    return { statusCode: 200, headers, body: JSON.stringify({ exists: ok, checkedUrl: url }) };
  } catch (err) {
    return { statusCode: 200, headers, body: JSON.stringify({ exists: false, error: err.message }) };
  }
};
