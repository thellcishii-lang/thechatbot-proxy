// netlify/functions/send-questions-pdf.js
//
// Zoeが「不明点が5件を超えた」と判断した時に呼び出す関数です。
// 質問リスト(questions配列)をテキストファイル(.txt)にまとめ、メールに添付して送信します。
// PDFではなくテキストファイルにしているのは、日本語フォント埋め込みの制約を避け、
// メモ帳やメモアプリなど、どんな環境でも文字化けなく開けるようにするためです。

const nodemailer = require("nodemailer");

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
      text: `添付のテキストファイルに、確認させていただきたい項目(${questions.length}件)をまとめました。ご確認のうえ、詳細をお知らせください。`,
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
