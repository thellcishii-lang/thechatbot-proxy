// api/admin-webauthn-auth-verify.js (Vercel版)
//
// Face ID認証の結果を検証し、問題なければログインセッション(合言葉)を
// 発行します。保存先はNetlify BlobsからUpstash Redisに切り替え。
// ロジック自体は変更ありません。セッションキーはadmin-session:{token}として保存し、
// secretary-stream.mjs側のisValidAdminSessionもこのキー形式に合わせる必要があります。

const { kv } = require("@vercel/kv");
const { verifyAuthenticationResponse } = require("@simplewebauthn/server");
const crypto = require("crypto");

const RP_ID = "the-chatbot.com";
const ORIGIN = "https://the-chatbot.com";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12時間

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

  try {
    const { response } = req.body || {};

    const challengeRecord = await kv.get("webauthn:authChallenge");
    const credentialRecord = await kv.get("webauthn:credential");
    if (!challengeRecord || !credentialRecord) {
      res.status(400).json({ error: "認証手続きの有効期限が切れました。もう一度やり直してください。" });
      return;
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
      authenticator: {
        credentialID: Buffer.from(credentialRecord.credentialID, "base64url"),
        credentialPublicKey: Buffer.from(credentialRecord.credentialPublicKey, "base64"),
        counter: credentialRecord.counter,
        transports: credentialRecord.transports,
      },
    });

    if (!verification.verified) {
      res.status(401).json({ error: "Face ID認証に失敗しました" });
      return;
    }

    const newCounter =
      (verification.authenticationInfo && (verification.authenticationInfo.newCounter ?? verification.authenticationInfo.counter)) ??
      credentialRecord.counter;
    credentialRecord.counter = newCounter;
    await kv.set("webauthn:credential", credentialRecord);
    await kv.del("webauthn:authChallenge");

    const sessionToken = crypto.randomBytes(32).toString("hex");
    await kv.set(`admin-session:${sessionToken}`, { createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS });

    res.status(200).json({ verified: true, sessionToken });
  } catch (err) {
    res.status(500).json({ error: "内部エラー: " + err.message });
  }
};
