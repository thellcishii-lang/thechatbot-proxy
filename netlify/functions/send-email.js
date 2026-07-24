// netlify/functions/send-email.js
//
// Gmail(the.chatbot.zoe@gmail.com)経由でメールを送信するための中継関数です。
// アプリパスワードはコードに直接書かず、Netlifyの環境変数から読み込みます。
//
// フロント側からは、宛先(to)・件名(subject)・本文(text)を渡してPOSTするだけです。

const nodemailer = require("nodemailer");

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
        body: JSON.stringify({
          error: "サーバー側にGMAIL_USERまたはGMAIL_APP_PASSWORDが設定されていません。",
        }),
      };
    }

    const { to, subject, text } = JSON.parse(event.body);

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

    await transporter.sendMail({
      from: `"Zoe (the.chatBOT)" <${gmailUser}>`,
      to: to,
      subject: subject,
      text: text,
    });

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
