// netlify/functions/send-email.js
//
// Gmail(the.chatbot.zoe@gmail.com)経由でメールを送信するための中継関数です。
// アプリパスワードはコードに直接書かず、Netlifyの環境変数から読み込みます。
//
// フロント側からは、宛先(to)・件名(subject)・本文(text)を渡してPOSTするだけです。
//
// セキュリティ対策(2026年7月29日追加):
// 誰でも直接POSTできてしまう性質上、悪用されるとスパムメール送信の
// 踏み台にされるリスクがあるため、同一IPからのレート制限を追加しています。

const nodemailer = require("nodemailer");
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
      name: "rate-limit-send-email",
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_API_TOKEN,
    });
    const WINDOW_MS = 10 * 60 * 1000; // 10分間
    const LIMIT = 10;                 // 10分間に10通まで
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

const EMAIL_SIGNATURE = `

the.chatBOT Zoe
the.chatBOT.com
-------------------------
the.LLC
357-0123　埼玉県飯能市中藤下郷23-21
the.chatbot.zoe@gmail.com`;

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
    const gmailUser = process.env.GMAIL_USER;
    const gmailAppPassword = process.env.GMAIL_APP_PASSWORD;
    if (!gmailUser || !gmailAppPassword) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: "サーバー側にGMAIL_USERまたはGMAIL_APP_PASSWORDが設定されていません。",
        }),
      };
    }
    const { to, subject, text, attachments } = JSON.parse(event.body);
    if (!to || !subject || !text) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "to, subject, text は必須です" }),
      };
    }
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: gmailUser,
        pass: gmailAppPassword,
      },
    });

    const mailOptions = {
      from: `"Zoe (the.chatBOT)" <${gmailUser}>`,
      to: to,
      subject: subject,
      text: text + EMAIL_SIGNATURE,
    };

    // 添付ファイル(base64文字列の配列: [{filename, content}])が渡された場合、
    // nodemailerが扱える形式(Bufferに変換)にして添付する
    if (Array.isArray(attachments) && attachments.length > 0) {
      mailOptions.attachments = attachments
        .filter((a) => a && a.filename && a.content)
        .map((a) => ({
          filename: a.filename,
          content: Buffer.from(a.content, "base64"),
        }));
    }

    await transporter.sendMail(mailOptions);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "メール送信エラー: " + err.message }),
    };
  }
};
