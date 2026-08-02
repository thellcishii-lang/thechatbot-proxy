// api/admin-webauthn-auth-start.js (Vercel版)
//
// パスワード認証が通った後に呼ばれる、Face ID認証(ログイン)の開始関数です。
// 登録済みの端末の鍵情報をもとに、認証用のチャレンジ(乱数)を発行します。
// 保存先はNetlify BlobsからUpstash Redisに切り替え。ロジック自体は変更ありません。

const { kv } = require("@vercel/kv");
const { generateAuthenticationOptions } = require("@simplewebauthn/server");

const RP_ID = "the-chatbot.com";

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

    const credentialRecord = await kv.get("webauthn:credential");
    if (!credentialRecord) {
      res.status(400).json({ error: "Face IDが登録されていません。先に登録を行ってください。" });
      return;
    }

    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: "required",
      // 特定の鍵IDを指定せず、この端末に保存されている
      // the-chatbot.com向けのパスキーであれば何でも使えるようにする
    });

    await kv.set("webauthn:authChallenge", { challenge: options.challenge, createdAt: Date.now() });

    res.status(200).json(options);
  } catch (err) {
    res.status(500).json({ error: "内部エラー: " + err.message });
  }
};
