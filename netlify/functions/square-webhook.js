// netlify/functions/square-webhook.js
//
// Squareからの決済完了通知(Webhook)を受け取るための関数です。
// payment.updated かつ status:COMPLETED を検知したら、
// 支払いに使われたメールアドレスでcustomer.jsを検索し、
// 該当する顧客が見つかれば、設定用Zoeの案内メールを自動送信します。
// (見つからない/一致しない場合は、運営宛に確認依頼メールを送ります)

const crypto = require("crypto");
const nodemailer = require("nodemailer");

function getTransporter() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
}

async function findCustomerByEmail(email) {
  const res = await fetch("https://chatbot-proxy.netlify.app/.netlify/functions/customer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "findByEmail", email }),
  });
  if (!res.ok) return null;
  return await res.json();
}

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
    const transporter = getTransporter();

    // ② 決済完了イベントだけを処理する
    if (payload.type === "payment.updated") {
      const payment = payload.data.object.payment;

      if (payment.status === "COMPLETED") {
        const buyerEmail = payment.buyer_email_address || null;
        const amount = payment.amount_money ? payment.amount_money.amount : "不明";

        let customer = null;
        if (buyerEmail) {
          customer = await findCustomerByEmail(buyerEmail);
        }

        if (customer && customer.id) {
          // ③ 一致した場合:お客様へ設定用Zoeの案内メールを自動送信
          await transporter.sendMail({
            from: process.env.GMAIL_USER,
            to: customer.email,
            subject: "【the.chatBOT】お申込み受付完了のご案内",
            text:
              `${customer.customerName} 様\n\n` +
              `ご入金を確認いたしました。導入受付が完了しましたので、ご案内いたします。\n\n` +
              `以下がお客様専用の設定用チャットへのリンクです。\n` +
              `https://the-chatbot.com/zoe-setup.html\n\n` +
              `ID: ${customer.id}\n` +
              `パスワード: (お申込み時にお送りしたものと同じです)\n\n` +
              `まだお客様のサイトには掲載できません。まずは設定用チャットでの設定を完了させてください。\n\n` +
              `the.chatBOT`,
          });

          // 運営宛に控えを送信
          await transporter.sendMail({
            from: process.env.GMAIL_USER,
            to: process.env.GMAIL_USER,
            subject: "【入金確認・自動案内送信済み】" + customer.customerName,
            text: `${customer.customerName}様(ID: ${customer.id})への設定用Zoe案内メールを自動送信しました。\n支払者メール: ${buyerEmail}\n金額: ${amount}`,
          });
        } else {
          // ④ 一致しなかった場合:運営宛に確認依頼メールを送る
          await transporter.sendMail({
            from: process.env.GMAIL_USER,
            to: process.env.GMAIL_USER,
            subject: "【要確認】入金がありましたが自動処理できませんでした",
            text:
              `決済完了通知が届きましたが、登録済みのメールアドレスと一致しなかったため、自動処理できませんでした。\n\n` +
              `支払者メール: ${buyerEmail || "取得できず"}\n金額: ${amount}\n\n` +
              `お手数ですが、該当のお客様を手動でご確認のうえ、設定用Zoeのご案内をお願いします。`,
          });
        }
      }
    }

    return { statusCode: 200, body: "OK" };
  } catch (err) {
    return { statusCode: 500, body: "内部エラー: " + err.message };
  }
};
