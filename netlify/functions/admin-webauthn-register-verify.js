// netlify/functions/admin-webauthn-register-verify.js
//
// ブラウザ側でFace ID登録が行われた後、その結果が本物か検証し、
// 問題なければ「この端末の鍵」をNetlify Blobsに保存します。
// 以後、この鍵を使ってFace ID認証(ログイン)ができるようになります。

const { getStore } = require("@netlify/blobs");
const { verifyRegistrationResponse } = require("@simplewebauthn/server");

const RP_ID = "the-chatbot.com";
const ORIGIN = "https://the-chatbot.com";

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
    const { password, response } = JSON.parse(event.body);
    if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: "パスワードが違います" }) };
    }

    const store = getStore({
      name: "admin-webauthn",
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_API_TOKEN,
    });

    const challengeRecord = await store.get("regChallenge", { type: "json" });
    if (!challengeRecord) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "登録手続きの有効期限が切れました。もう一度やり直してください。" }) };
    }

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challengeRecord.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Face IDの登録に失敗しました" }) };
    }

    // ライブラリのバージョンによって、credential情報が registrationInfo.credential に
    // ネストされている場合と、registrationInfo に直接入っている場合の両方があるため、両対応する
    const info = verification.registrationInfo;
    let credentialIDRaw, credentialPublicKeyRaw, counter, transports;
    if (info.credential) {
      credentialIDRaw = info.credential.id;
      credentialPublicKeyRaw = info.credential.publicKey;
      counter = info.credential.counter;
      transports = info.credential.transports || [];
    } else {
      credentialIDRaw = info.credentialID;
      credentialPublicKeyRaw = info.credentialPublicKey;
      counter = info.counter;
      transports = (response && response.response && response.response.transports) || [];
    }

    if (!credentialIDRaw || !credentialPublicKeyRaw) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: "登録情報の取得に失敗しました(ライブラリの応答形式が想定と異なります)" }) };
    }

    // credentialIDが既に文字列(base64url)ならそのまま、Buffer/Uint8Arrayならbase64urlに変換する
    const credentialID = typeof credentialIDRaw === "string"
      ? credentialIDRaw
      : Buffer.from(credentialIDRaw).toString("base64url");
    const credentialPublicKey = Buffer.from(credentialPublicKeyRaw).toString("base64");

    await store.setJSON("credential", {
      credentialID,
      credentialPublicKey,
      counter,
      transports,
      registeredAt: new Date().toISOString(),
    });
    await store.delete("regChallenge");

    return { statusCode: 200, headers, body: JSON.stringify({ verified: true }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "内部エラー: " + err.message }) };
  }
};
