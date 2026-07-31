// netlify/functions/admin-webauthn-register-start.js
//
// Face ID(WebAuthn)の「初回登録」を開始する関数です。
// 管理者パスワードが正しい場合のみ、登録用のチャレンジ(乱数)を発行します。
// 既に別の端末が登録済みの場合でも、パスワードさえ分かれば再登録(機種変更等)
// できる仕様にしています(パスワードが漏れない限り、ここは突破されません)。

const { getStore } = require("@netlify/blobs");
const { generateRegistrationOptions } = require("@simplewebauthn/server");
const crypto = require("crypto");

const RP_NAME = "the.chatBOT 秘書Zoe";
const RP_ID = "the-chatbot.com";
// 管理者は1人固定のため、userIDは毎回ランダムにせず固定値にする。
// これにより、再登録時に端末(iCloudキーチェーン等)側が「同一人物の
// 新しい鍵」として扱い、古いパスキーを自然に上書きしてくれるようになる。
// (以前は毎回ランダムなuserIDを発行していたため、登録するたびに
//  「別人」の新しいパスキーとして追加され続け、2つ・3つと増えてしまっていた)
const FIXED_USER_ID = crypto.createHash("sha256").update("the-chatbot-admin").digest().subarray(0, 32);

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

    // 既に登録済みのパスキーがあれば、excludeCredentialsとして渡し、
    // 同じ端末で重複登録されるのを防ぐ(機種変更等で別端末に登録する場合は
    // そのまま新規登録が進む。同一端末の場合はブラウザ側が「既に登録済み」と
    // 教えてくれるため、意図せず増殖することもなくなる)
    const existing = await store.get("credential", { type: "json" });
    const excludeCredentials = existing
      ? [{ id: existing.credentialID, transports: existing.transports || [] }]
      : [];

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userID: FIXED_USER_ID,
      userName: "admin",
      attestationType: "none",
      excludeCredentials,
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "required",
        authenticatorAttachment: "platform", // iPhone本体のFace ID/Touch IDを想定
      },
    });

    await store.setJSON("regChallenge", { challenge: options.challenge, createdAt: Date.now() });

    return { statusCode: 200, headers, body: JSON.stringify(options) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "内部エラー: " + err.message }) };
  }
};
