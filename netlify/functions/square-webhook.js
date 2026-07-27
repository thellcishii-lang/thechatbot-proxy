// netlify/functions/square-webhook.js
//
// Squareからの決済完了通知(Webhook)を受け取るための関数です。
// invoice.payment_made イベントを検知したら、そのお客様に
// 「契約成立+設定用Zoeのご案内」メールを送信します。

const crypto = require("crypto");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "POSTのみ対応しています" };
  }

  try {
    // ① Square側の署名を検証(なりすまし通知の防止)
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

    // ② 支払い完了イベントだけを処理する
    if (payload.type === "invoice.payment_made") {
      // ここに「契約成立メール送信」の処理を追加していきます(次のステップ)
      console.log("決済完了を検知:", JSON.stringify(payload.data));
    }

    return { statusCode: 200, body: "OK" };
  } catch (err) {
    return { statusCode: 500, body: "内部エラー: " + err.message };
  }
};
