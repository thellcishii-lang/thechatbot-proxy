// api/admin-webauthn-register-start.js (Vercel版)
//
// Face ID(WebAuthn)の「初回登録」を開始する関数です。保存先はNetlify Blobs
// からUpstash Redisに切り替え。ロジック自体(固定userID・excludeCredentials対応)は変更ありません。

const { kv } = require("@vercel/kv");
const { generateRegistrationOptions } = require("@simplewebauthn/server");
const crypto = require("crypto");

const RP_NAME = "the.chatBOT 秘書Zoe";
const RP_ID = "the-chatbot.com";
const FIXED_USER_ID = crypto.createHash("sha256").update("the-chatbot-admin").digest().subarray(0, 32);

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
    const { password } = req.body || {};
    if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) {
      res.status(401).json({ error: "パスワードが違います" });
      return;
    }

    const existing = await kv.get("webauthn:credential");
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
        authenticatorAttachment: "platform",
      },
    });

    await kv.set("webauthn:regChallenge", { challenge: options.challenge, createdAt: Date.now() });

    res.status(200).json(options);
  } catch (err) {
    res.status(500).json({ error: "内部エラー: " + err.message });
  }
};
