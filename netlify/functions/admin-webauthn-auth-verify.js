// netlify/functions/admin-webauthn-auth-verify.js
//
// Face ID認証の結果を検証し、問題なければログインセッション(合言葉)を
// 発行します。このセッションを、以降の秘書Zoeとの会話リクエストに
// 添えることで、「Face ID認証済みの本人からのリクエストであること」を
// chat.js側で確認できるようにします。セッションは12時間で失効します。

const { getStore } = require("@netlify/blobs");
const { verifyAuthenticationResponse } = require("@simplewebauthn/server");
const crypto = require("crypto");

const RP_ID = "the-chatbot.com";
const ORIGIN = "https://the-chatbot.com";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12時間

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
    const { response } = JSON.parse(event.body);

    const store = getStore({
      name: "admin-webauthn",
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_API_TOKEN,
    });

    const challengeRecord = await store.get("authChallenge", { type: "json" });
    const credentialRecord = await store.get("credential", { type: "json" });
    if (!challengeRecord || !credentialRecord) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "認証手続きの有効期限が切れました。もう一度やり直してください。" }) };
    }

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challengeRecord.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: credentialRecord.credentialID,
        publicKey: Buffer.from(credentialRecord.credentialPublicKey, "base64"),
        counter: credentialRecord.counter,
        transports: credentialRecord.transports,
      },
    });

    if (!verification.verified) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: "Face ID認証に失敗しました" }) };
    }

    // カウンター(リプレイ攻撃対策用)を更新
    credentialRecord.counter = verification.authenticationInfo.newCounter;
    await store.setJSON("credential", credentialRecord);
    await store.delete("authChallenge");

    // ログインセッションを発行
    const sessionToken = crypto.randomBytes(32).toString("hex");
    const sessionStore = getStore({
      name: "admin-sessions",
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_API_TOKEN,
    });
    await sessionStore.setJSON(sessionToken, { createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS });

    return { statusCode: 200, headers, body: JSON.stringify({ verified: true, sessionToken }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "内部エラー: " + err.message }) };
  }
};
