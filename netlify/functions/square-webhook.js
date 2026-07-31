// netlify/functions/square-webhook.js
//
// Squareからの決済完了通知(Webhook)を受け取るための関数です。
// payment.updated かつ status:COMPLETED を検知したら、
// 支払いに使われたメールアドレスでcustomer.jsを検索し、
// 該当する顧客が見つかれば、設定用Zoeの案内メールを自動送信します。
// (見つからない/一致しない場合は、運営宛に確認依頼メールを送ります)
//
// Squareは同じ決済に対して複数回Webhookを送ってくることがあるため、
// Netlify Blobsに「処理済みのpayment.id」を記録し、二重処理を防ぎます。

const crypto = require("crypto");
const nodemailer = require("nodemailer");
const { getStore } = require("@netlify/blobs");

const EMAIL_SIGNATURE = `

the.chatBOT Zoe
the.chatBOT.com
-------------------------
the.LLC
357-0123　埼玉県飯能市中藤下郷23-21
the.chatbot.zoe@gmail.com`;

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

// この決済より前に既にpaid:trueだったかどうかを確認する(初回決済か、2回目以降の
// 継続課金かを判定するため)。markPaidで上書きする前に必ず呼ぶこと
async function wasAlreadyPaid(id) {
  const res = await fetch("https://chatbot-proxy.netlify.app/.netlify/functions/customer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "adminGet", id, secret: process.env.INTERNAL_FUNCTION_SECRET }),
  });
  if (!res.ok) return false;
  const data = await res.json();
  return !!(data.record && data.record.paid === true);
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

    // ② 決済完了イベントだけを処理する
    if (payload.type === "payment.updated") {
      const payment = payload.data.object.payment;

      if (payment.status === "COMPLETED") {
        // ③ 重複処理防止:同じpayment.idを既に処理済みなら何もしない
        const processedStore = getStore({
          name: "processed-payments",
          siteID: process.env.NETLIFY_SITE_ID,
          token: process.env.NETLIFY_API_TOKEN,
        });
        const alreadyProcessed = await processedStore.get(payment.id);
        if (alreadyProcessed) {
          return { statusCode: 200, body: "既に処理済みのためスキップしました" };
        }
        // 先に「処理済み」の印を記録してから、後続の処理に入る
        await processedStore.set(payment.id, new Date().toISOString());

        const transporter = getTransporter();
        const buyerEmail = payment.buyer_email_address || null;
        const amount = payment.amount_money ? payment.amount_money.amount : "不明";

        let customer = null;
        if (buyerEmail) {
          customer = await findCustomerByEmail(buyerEmail);
        }

        if (customer && customer.id) {
          // ③.5 この決済より前から既に支払い済みだったか(=継続課金か)を、markPaidで
          // 上書きする前に確認しておく
          const isRecurring = await wasAlreadyPaid(customer.id);

          // 支払い済みフラグを立てる(1週間期限切れチェックの対象から外すため)
          await fetch("https://chatbot-proxy.netlify.app/.netlify/functions/customer", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "markPaid", id: customer.id, secret: process.env.INTERNAL_FUNCTION_SECRET }),
          });

          // ④ 一致した場合:お客様へメールを自動送信。初回は設定用チャットの案内、
          //    2回目以降(継続課金)は設定リンク・ID・パスワードを省いた簡潔な決済完了通知にする
          const customerMailText = isRecurring
            ? `${customer.customerName} 様\n\n` +
              `いつもthe.chatBOTをご利用いただきありがとうございます。\n` +
              `今月分のご決済が完了いたしましたので、ご案内いたします。\n\n` +
              `the.chatBOT`
            : `${customer.customerName} 様\n\n` +
              `ご入金を確認いたしました。導入受付が完了しましたので、ご案内いたします。\n\n` +
              `以下がお客様専用の設定用チャットへのリンクです。\n` +
              `https://the-chatbot.com/zoe-setup.html\n\n` +
              `ID: ${customer.id}\n` +
              `パスワード: (お申込み時にお送りしたものと同じです)\n\n` +
              `まだお客様のサイトには掲載できません。まずは設定用チャットでの設定を完了させてください。\n\n` +
              `the.chatBOT`;

          await transporter.sendMail({
            from: process.env.GMAIL_USER,
            to: customer.email,
            subject: isRecurring ? "【the.chatBOT】ご決済完了のお知らせ" : "【the.chatBOT】お申込み受付完了のご案内",
            text: customerMailText + EMAIL_SIGNATURE,
          });

          // 運営宛に控えを送信
          await transporter.sendMail({
            from: process.env.GMAIL_USER,
            to: process.env.GMAIL_USER,
            subject: (isRecurring ? "【継続課金・決済確認】" : "【入金確認・自動案内送信済み】") + customer.customerName,
            text:
              (isRecurring
                ? `${customer.customerName}様(ID: ${customer.id})の継続課金の決済を確認しました。`
                : `${customer.customerName}様(ID: ${customer.id})への設定用Zoe案内メールを自動送信しました。`) +
              `\n支払者メール: ${buyerEmail}\n金額: ${amount}` +
              EMAIL_SIGNATURE,
          });
        } else {
          // ⑤ 一致しなかった場合:運営宛に確認依頼メールを送る
          await transporter.sendMail({
            from: process.env.GMAIL_USER,
            to: process.env.GMAIL_USER,
            subject: "【要確認】入金がありましたが自動処理できませんでした",
            text:
              `決済完了通知が届きましたが、登録済みのメールアドレスと一致しなかったため、自動処理できませんでした。\n\n` +
              `支払者メール: ${buyerEmail || "取得できず"}\n金額: ${amount}\n\n` +
              `お手数ですが、該当のお客様を手動でご確認のうえ、設定用Zoeのご案内をお願いします。` +
              EMAIL_SIGNATURE,
          });
        }
      }
    }

    return { statusCode: 200, body: "OK" };
  } catch (err) {
    return { statusCode: 500, body: "内部エラー: " + err.message };
  }
};
