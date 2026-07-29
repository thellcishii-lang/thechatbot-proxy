// netlify/functions/admin-webauthn-auth-start.js
//
// パスワード認証が通った後に呼ばれる、Face ID認証(ログイン)の開始関数です。
// 登録済みの端末の鍵情報をもとに、認証用のチャレンジ(乱数)を発行します。

const { getStore } = require("@netlify/blobs");
const { generateAuthenticationOptions } = require("@simplewebauthn/server");

const RP_ID = "the-chatbot.com";

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
    const { password } = JSON.parse(event.body);
    if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: "パスワードが違います" }) };
    }

    const store = getStore({
      name: "admin-webauthn",
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_API_TOKEN,
    });

    const credentialRecord = await store.get("credential", { type: "json" });
    if (!credentialRecord) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Face IDが登録されていません。先に登録を行ってください。" }) };
    }

    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: "required",
      allowCredentials: [
        {
          id: credentialRecord.credentialID,
          transports: credentialRecord.transports,
        },
      ],
    });

    await store.setJSON("authChallenge", { challenge: options.challenge, createdAt: Date.now() });

    return { statusCode: 200, headers, body: JSON.stringify(options) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "内部エラー: " + err.message }) };
  }
};
