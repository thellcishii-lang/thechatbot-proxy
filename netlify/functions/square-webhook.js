// netlify/functions/square-webhook.js (デバッグ用に一時変更)

const crypto = require("crypto");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "POSTのみ対応しています" };
  }

  try {
    const signature = event.headers["x-square-hmacsha256-signature"];
    const notificationUrl = `https://${event.headers.host}${event.path}`;
    const body = event.body;

    const hmac = crypto.createHmac("sha256", process.env.SQUARE_WEBHOOK_SIGNATURE_KEY);
    hmac.update(notificationUrl + body);
    const expectedSignature = hmac.digest("base64");

    if (signature !== expectedSignature) {
      return { statusCode: 401, body: "署名が一致しません" };
    }

    const payload = JSON.parse(body);

    // 種類を問わず、届いた内容をまるごとログに出す(確認用)
    console.log("受信イベント種類:", payload.type);
    console.log("受信内容全文:", JSON.stringify(payload, null, 2));

    return { statusCode: 200, body: "OK" };
  } catch (err) {
    return { statusCode: 500, body: "内部エラー: " + err.message };
  }
};
