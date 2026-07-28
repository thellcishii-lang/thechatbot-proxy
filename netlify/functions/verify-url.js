// netlify/functions/verify-url.js
//
// お客様が伝えた会社URLが実在するか、また、そのページの中に
// お客様が名乗った会社名が含まれているかを確認するための関数です。
// 完全な照合ではなく、明らかな入力ミス・無関係なURLを弾くための簡易チェックです。
//
// セキュリティ対策(2026年7月29日追加):
// この関数は「指定されたURLの代わりにアクセスしてあげる」という性質上、
// 悪用されると社内ネットワークやクラウドの内部情報(メタデータAPI等)への
// 攻撃の踏み台にされるリスクがあるため、①同一IPからのレート制限、
// ②localhost・プライベートIP・クラウドメタデータアドレス宛のリクエストを
// 拒否するチェック、の2つを追加しています。

const { getStore } = require("@netlify/blobs");
const dns = require("dns").promises;

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
      name: "rate-limit-verify-url",
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

function isPrivateIp(ip) {
  // IPv4のプライベート・ループバック・リンクローカル(クラウドのメタデータAPIを含む)を弾く
  if (/^127\./.test(ip)) return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^169\.254\./.test(ip)) return true; // 169.254.169.254 等のメタデータAPIを含む
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;
  if (ip === "::1") return true;
  if (/^f[cd]/i.test(ip)) return true; // IPv6のユニークローカルアドレス
  return false;
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
    return { statusCode: 429, headers, body: JSON.stringify({ error: "リクエストが多すぎます。しばらくしてから再度お試しください。" }) };
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

    // SSRF対策:接続先ホスト名の実際のIPアドレスを解決し、社内・内部向けアドレスなら拒否する
    let hostname;
    try {
      hostname = new URL(url).hostname;
    } catch (e) {
      return { statusCode: 200, headers, body: JSON.stringify({ exists: false, nameMatch: false, reason: "URLの形式が不正です" }) };
    }
    if (hostname === "localhost") {
      return { statusCode: 200, headers, body: JSON.stringify({ exists: false, nameMatch: false, reason: "このホストへはアクセスできません" }) };
    }
    try {
      const { address } = await dns.lookup(hostname);
      if (isPrivateIp(address)) {
        return { statusCode: 200, headers, body: JSON.stringify({ exists: false, nameMatch: false, reason: "このホストへはアクセスできません" }) };
      }
    } catch (e) {
      // 名前解決に失敗した場合はexists:falseとして扱う(実在しないURLとして処理する)
      return { statusCode: 200, headers, body: JSON.stringify({ exists: false, nameMatch: false, reason: "名前解決に失敗しました" }) };
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


