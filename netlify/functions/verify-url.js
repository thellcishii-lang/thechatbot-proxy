// netlify/functions/verify-url.js
//
// お客様が伝えた会社URLが実在するか、また、そのページの中に
// お客様が名乗った会社名が含まれているかを確認するための関数です。
// 完全な照合ではなく、明らかな入力ミス・無関係なURLを弾くための簡易チェックです。

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
    const customerName = (req.customerName || "").trim();

    if (!url) {
      return { statusCode: 200, headers, body: JSON.stringify({ exists: false, nameMatch: false, reason: "URL未入力" }) };
    }
    if (!/^https?:\/\//i.test(url)) {
      url = "https://" + url;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    let exists = false;
    let pageText = "";
    try {
      const res = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; the.chatBOT-URLCheck/1.0)" },
      });
      exists = res.status < 500;
      if (exists) {
        const html = await res.text();
        // タグを乱暴に取り除いて、テキスト照合用の生テキストだけを残す
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

    let nameMatch = null; // null = 判定不能(会社名未指定 or 取得失敗)
    if (exists && customerName) {
      // 会社名の代表的な表記ゆれ(株式会社の有無、法人格の位置)を軽くカバーする
      const normalized = customerName.replace(/株式会社|有限会社|合同会社|\(株\)|㈱/g, "").trim();
      const candidates = [customerName, normalized].filter(Boolean);
      nameMatch = candidates.some((c) => c && pageText.includes(c));
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ exists, nameMatch, checkedUrl: url }),
    };
  } catch (err) {
    return { statusCode: 200, headers, body: JSON.stringify({ exists: false, nameMatch: null, error: err.message }) };
  }
};

