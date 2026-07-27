// netlify/functions/square-webhook.js
//
// Squareからの決済完了通知(Webhook)を受け取るための関数です。
// invoice.payment_made イベントを検知したら、運営(あなた)宛に
// 「入金がありました」という通知メールを送信します。
// (将来的には、この通知内容をもとに設定用Zoeの案内メール送信まで自動化する予定)

const crypto = require("crypto");
const nodemailer = require("nodemailer");

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
      const invoice = payload.data.object.invoice;
      const payerEmail = invoice?.primary_recipient?.email_address || "不明";
      const amount = invoice?.payment_requests?.[0]?.total_completed_amount_money?.amount || "不明";

      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: process.env.GMAIL_USER,
          pass: process.env.GMAIL_APP_PASSWORD,
        },
      });

      await transporter.sendMail({
        from: process.env.GMAIL_USER,
        to: process.env.GMAIL_USER, // 運営(自分)宛
        subject: "【入金通知】the.chatBOT Zoe の決済がありました",
        text: `決済完了通知が届きました。\n\n支払者メール: ${payerEmail}\n金額: ${amount}\n\nこの内容をもとに、該当のお客様へ設定用Zoeのご案内を送ってください。`,
      });
    }

    return { statusCode: 200, body: "OK" };
  } catch (err) {
    return { statusCode: 500, body: "内部エラー: " + err.message };
  }
};
