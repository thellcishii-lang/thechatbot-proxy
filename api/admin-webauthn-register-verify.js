// api/admin-webauthn-register-verify.js (Vercel版)
//
// ブラウザ側でFace ID登録が行われた後、その結果を検証し、
// 問題なければ「この端末の鍵」を保存します。保存先はNetlify BlobsからUpstash Redisに切り替え。
// ロジック自体は変更ありません。

const { kv } = require("@vercel/kv");
const { verifyRegistrationResponse } = require("@simplewebauthn/server");

const RP_ID = "the-chatbot.com";
const ORIGIN = "https://the-chatbot.com";

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
    const { password, response } = req.body || {};
    if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) {
      res.status(401).json({ error: "パスワードが違います" });
      return;
    }

    const challengeRecord = await kv.get("webauthn:regChallenge");
    if (!challengeRecord) {
      res.status(400).json({ error: "登録手続きの有効期限が切れました。もう一度やり直してください。" });
      return;
    }

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challengeRecord.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    });

    if (!verification.verified || !verification.registrationInfo) {
      res.status(400).json({ error: "Face IDの登録に失敗しました" });
      return;
    }

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
      res.status(500).json({ error: "登録情報の取得に失敗しました(ライブラリの応答形式が想定と異なります)" });
      return;
    }

    const credentialID = typeof credentialIDRaw === "string"
      ? credentialIDRaw
      : Buffer.from(credentialIDRaw).toString("base64url");
    const credentialPublicKey = Buffer.from(credentialPublicKeyRaw).toString("base64");

    await kv.set("webauthn:credential", {
      credentialID,
      credentialPublicKey,
      counter,
      transports,
      registeredAt: new Date().toISOString(),
    });
    await kv.del("webauthn:regChallenge");

    res.status(200).json({ verified: true });
  } catch (err) {
    res.status(500).json({ error: "内部エラー: " + err.message });
  }
};
