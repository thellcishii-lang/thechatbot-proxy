// api/send-questions-pdf.js (Vercel版)
//
// Zoeが「不明点が5件を超えた」と判断した時に呼び出すAPIです。
// 質問リスト(questions配列)をテキストファイルにまとめ、メールに添付して送信します。
// 保存先(レート制限・IPトラッカー)はNetlify BlobsからUpstash Redisに切り替え。ロジック自体は変更ありません。

const nodemailer = require("nodemailer");
const { kv } = require("@vercel/kv");

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "unknown";
}

async function checkRateLimit(ip) {
  try {
    const key = `ratelimit:send-questions-pdf:${ip}`;
    const WINDOW_MS = 10 * 60 * 1000;
    const LIMIT = 10;
    const now = Date.now();
    const record = await kv.get(key);
    if (!record || now - record.windowStart > WINDOW_MS) {
      await kv.set(key, { windowStart: now, count: 1 }, { ex: 600 });
      return true;
    }
    if (record.count >= LIMIT) return false;
    await kv.set(key, { windowStart: record.windowStart, count: record.count + 1 }, { ex: 600 });
    return true;
  } catch (e) {
    return true;
  }
}

async function checkIpAbuse(ip) {
  try {
    const record = await kv.get(`ipabuse:${ip}`);
    return !!(record && record.blacklisted);
  } catch (e) {
    return false;
  }
}

async function recordIpAbuseStrike(ip) {
  try {
    const key = `ipabuse:${ip}`;
    const record = (await kv.get(key)) || {};
    const strikes = (record.strikes || 0) + 1;
    const blacklisted = strikes >= 3;
    await kv.set(key, { ...record, strikes, blacklisted });
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

function buildTextFile(title, questions) {
  const lines = [title, ""];
  questions.forEach((q, i) => {
    lines.push(`${i + 1}. ${q}`);
  });
  return lines.join("\n");
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "POSTのみ対応しています" });
    return;
  }

  const clientIp = getClientIp(req);

  const isAbuser = await checkIpAbuse(clientIp);
  if (isAbuser) {
    res.status(403).json({ error: "このIPアドレスは、不審なアクセスが検知されたため利用を制限しています。" });
    return;
  }

  const withinLimit = await checkRateLimit(clientIp);
  if (!withinLimit) {
    await recordIpAbuseStrike(clientIp);
    res.status(429).json({ error: "リクエストが多すぎます。しばらくしてから再度お試しください。" });
    return;
  }

  try {
    const gmailUser = process.env.GMAIL_USER;
    const gmailAppPassword = process.env.GMAIL_APP_PASSWORD;

    if (!gmailUser || !gmailAppPassword) {
      res.status(500).json({ error: "サーバー側にGMAIL_USERまたはGMAIL_APP_PASSWORDが設定されていません。" });
      return;
    }

    const { to, questions, title } = req.body || {};

    if (!to || !Array.isArray(questions) || questions.length === 0) {
      res.status(400).json({ error: "to と questions(配列) は必須です" });
      return;
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

    res.status(200).json({ success: true, count: questions.length });
  } catch (err) {
    res.status(500).json({ error: "送信エラー: " + err.message });
  }
};
