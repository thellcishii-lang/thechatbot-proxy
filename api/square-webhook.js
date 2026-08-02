// api/square-webhook.js (Vercel版)
//
// Squareからの決済完了通知(Webhook)を受け取るためのAPIです。
// 保存先(処理済みpayment.idの記録)はNetlify BlobsからUpstash Redisに切り替え。
// customer.js呼び出し先も、既にVercelに移行した新しいURLに変更しています。
//
// 重要:署名検証には「生のリクエスト本文の文字列」が必要なため、
// Vercelの自動JSONパースをこのAPIだけ無効化しています(下部のconfig参照)。
// Squareの管理画面側のWebhook送信先URLも、このAPIの新しいURLに変更してください。

const crypto = require("crypto");
const nodemailer = require("nodemailer");
const { kv } = require("@vercel/kv");

const CUSTOMER_API_URL = "https://thechatbot-proxy.vercel.app/api/customer";

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
  const res = await fetch(CUSTOMER_API_URL, {
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
  const res = await fetch(CUSTOMER_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "adminGet", id, secret: process.env.INTERNAL_FUNCTION_SECRET }),
  });
  if (!res.ok) return false;
  const data = await res.json();
  return !!(data.record && data.record.paid === true);
}

// Vercelでbodyparser: falseにした場合、リクエストの生データを自分でストリームから読み取る
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("POSTのみ対応しています");
    return;
  }

  try {
    const body = await readRawBody(req);

    // ① Square側の署名を検証(なりすまし通知の防止)
    const signature = req.headers["x-square-hmacsha256-signature"];
    const notificationUrl = `https://${req.headers.host}/api/square-webhook`;

    const hmac = crypto.createHmac("sha256", process.env.SQUARE_WEBHOOK_SIGNATURE_KEY);
    hmac.update(notificationUrl + body);
    const expectedSignature = hmac.digest("base64");

    if (signature !== expectedSignature) {
      res.status(401).send("署名が一致しません");
      return;
    }

    const payload = JSON.parse(body);

    // ② 決済完了イベントだけを処理する
    if (payload.type === "payment.updated") {
      const payment = payload.data.object.payment;

      if (payment.status === "COMPLETED") {
        // ③ 重複処理防止:同じpayment.idを既に処理済みなら何もしない
        const alreadyProcessed = await kv.get(`processed-payment:${payment.id}`);
        if (alreadyProcessed) {
          res.status(200).send("既に処理済みのためスキップしました");
          return;
        }
        // 先に「処理済み」の印を記録してから、後続の処理に入る
        await kv.set(`processed-payment:${payment.id}`, new Date().toISOString());

        const transporter = getTransporter();
        const buyerEmail = payment.buyer_email_address || null;
        const amount = payment.amount_money ? payment.amount_money.amount : "不明";

        let customer = null;
        if (buyerEmail) {
          customer = await findCustomerByEmail(buyerEmail);
        }

        if (customer && customer.id) {
          const isRecurring = await wasAlreadyPaid(customer.id);

          await fetch(CUSTOMER_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "markPaid", id: customer.id, secret: process.env.INTERNAL_FUNCTION_SECRET }),
          });

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

    res.status(200).send("OK");
  } catch (err) {
    res.status(500).send("内部エラー: " + err.message);
  }
};

// Squareの署名検証には生のリクエスト本文が必要なため、Vercelの自動JSONパースを無効化する
module.exports.config = {
  api: {
    bodyParser: false,
  },
};
