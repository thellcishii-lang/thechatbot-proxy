// netlify/functions/send-questions-pdf.js
//
// Zoeが「不明点が5件を超えた」と判断した時に呼び出す関数です。
// 質問リスト(questions配列)をテキストファイル(.txt)にまとめ、メールに添付して送信します。
// PDFではなくテキストファイルにしているのは、日本語フォント埋め込みの制約を避け、
// メモ帳やメモアプリなど、どんな環境でも文字化けなく開けるようにするためです。

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
      name: "rate-limit-send-questions-pdf",
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

// ============================================================
// 共通IP不正利用トラッカー(全Function共通、ストア名"ip-abuse-tracker")
// ============================================================
async function checkIpAbuse(ip) {
  try {
    const store = getStore({
      name: "ip-abuse-tracker",
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_API_TOKEN,
    });
    const record = await store.get(ip, { type: "json" });
    return !!(record && record.blacklisted);
  } catch (e) {
    return false;
  }
}

async function recordIpAbuseStrike(ip) {
  try {
    const store = getStore({
      name: "ip-abuse-tracker",
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_API_TOKEN,
    });
    const record = (await store.get(ip, { type: "json" })) || {};
    const strikes = (record.strikes || 0) + 1;
    const blacklisted = strikes >= 3;
    await store.setJSON(ip, { ...record, strikes, blacklisted });
  } catch (e) {
    // 記録に失敗しても本来の処理は止めない
  }
}

const EMAIL_SIGNATURE = `

the.chatBOT Zoe
the.chatBOT.com
-------------------------
the.LLC
357-0123　埼玉県飯能市中藤下郷23-21
the.chatbot.zoe@gmail.com`;

function buildTextFile(title, questions){
  const lines = [title, ""];
  questions.forEach((q, i) => {
    lines.push(`${i + 1}. ${q}`);
  });
  return lines.join("\n");
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

  const isAbuser = await checkIpAbuse(clientIp);
  if (isAbuser) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: "このIPアドレスは、不審なアクセスが検知されたため利用を制限しています。" }) };
  }

  const withinLimit = await checkRateLimit(clientIp);
  if (!withinLimit) {
    await recordIpAbuseStrike(clientIp);
    return { statusCode: 429, headers, body: JSON.stringify({ error: "リクエストが多すぎます。しばらくしてから再度お試しください。" }) };
  }

  try {
    const gmailUser = process.env.GMAIL_USER;
    const gmailAppPassword = process.env.GMAIL_APP_PASSWORD;

    if (!gmailUser || !gmailAppPassword) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: "サーバー側にGMAIL_USERまたはGMAIL_APP_PASSWORDが設定されていません。" }),
      };
    }

    const { to, questions, title } = JSON.parse(event.body);

    if (!to || !Array.isArray(questions) || questions.length === 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "to と questions(配列) は必須です" }),
      };
    }

    const fileTitle = title || "確認事項リスト";
    const textContent = buildTextFile(fileTitle, questions);

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: gmailUser, pass: gmailAppPassword },
    });

    await transporter.sendMail({
      from: `"Zoe (the.chatBOT)" <${gmailUser}>`,
      to: to,
      subject: fileTitle,
      text: `添付のテキストファイルに、確認させていただきたい項目(${questions.length}件)をまとめました。ご確認のうえ、詳細をお知らせください。` + EMAIL_SIGNATURE,
      attachments: [
        {
          filename: "questions.txt",
          content: Buffer.from(textContent, "utf-8"),
          contentType: "text/plain; charset=utf-8",
        },
      ],
    });

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, count: questions.length }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "送信エラー: " + err.message }) };
  }
};
