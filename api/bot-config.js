// api/bot-config.js (Vercel版)
//
// 「Zoe001」「Zoe002」のような番号(bot ID)ごとに、システムプロンプトと
// 登録情報を保存・取得するAPIです。秘書Zoeからのみ呼ばれる内部専用のもので、
// 内部シークレットで保護しています。保存先はNetlify BlobsからUpstash Redisに切り替え。
//
// キー設計:
//   bot:{botId}   → 該当botの設定レコード(JSON)
//   bot:all_ids   → 登録済みの全botIdのSet(list/register用)

const { kv } = require("@vercel/kv");

function generatePassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let pw = "";
  for (let i = 0; i < 8; i++) {
    pw += chars[Math.floor(Math.random() * chars.length)];
  }
  return pw;
}

function checkSecret(reqBody) {
  return process.env.INTERNAL_FUNCTION_SECRET && reqBody.secret === process.env.INTERNAL_FUNCTION_SECRET;
}

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
    const reqBody = req.body || {};
    if (!checkSecret(reqBody)) {
      res.status(401).json({ error: "許可されていません" });
      return;
    }

    if (reqBody.action === "get") {
      if (!reqBody.botId) {
        res.status(400).json({ error: "botIdが指定されていません" });
        return;
      }
      const record = await kv.get(`bot:${reqBody.botId}`);
      if (!record) {
        res.status(404).json({ error: "そのbotIdは登録されていません" });
        return;
      }
      res.status(200).json({ record });
      return;
    }

    if (reqBody.action === "set") {
      if (!reqBody.botId || typeof reqBody.systemPrompt !== "string") {
        res.status(400).json({ error: "botIdとsystemPromptは必須です" });
        return;
      }
      const existing = (await kv.get(`bot:${reqBody.botId}`)) || {};
      const updated = {
        ...existing,
        botId: reqBody.botId,
        systemPrompt: reqBody.systemPrompt,
        updatedAt: new Date().toISOString(),
      };
      await kv.set(`bot:${reqBody.botId}`, updated);
      await kv.sadd("bot:all_ids", reqBody.botId);
      res.status(200).json({ saved: true, record: updated });
      return;
    }

    // BASEチャット・bot別の設定値(systemPrompt以外)を保存する。botId:"BASE"がBASEチャット
    if (reqBody.action === "setSettings") {
      if (!reqBody.botId || typeof reqBody.settings !== "object") {
        res.status(400).json({ error: "botIdとsettingsは必須です" });
        return;
      }
      const existing = (await kv.get(`bot:${reqBody.botId}`)) || {};
      const updated = {
        ...existing,
        botId: reqBody.botId,
        settings: reqBody.settings,
        updatedAt: new Date().toISOString(),
      };
      await kv.set(`bot:${reqBody.botId}`, updated);
      await kv.sadd("bot:all_ids", reqBody.botId);
      res.status(200).json({ saved: true, record: updated });
      return;
    }

    if (reqBody.action === "register") {
      if (!reqBody.repoName) {
        res.status(400).json({ error: "repoNameが指定されていません" });
        return;
      }
      const ids = (await kv.smembers("bot:all_ids")) || [];
      const usedNumbers = ids
        .map((id) => id.match(/^Zoe(\d{3})$/))
        .filter(Boolean)
        .map((m) => parseInt(m[1], 10));
      let n = 1;
      while (usedNumbers.includes(n)) n++;
      const botId = "Zoe" + String(n).padStart(3, "0");

      const record = {
        botId,
        repoName: reqBody.repoName,
        systemPrompt: "",
        createdAt: new Date().toISOString(),
      };
      await kv.set(`bot:${botId}`, record);
      await kv.sadd("bot:all_ids", botId);
      res.status(200).json({ botId, record });
      return;
    }

    if (reqBody.action === "list") {
      const ids = (await kv.smembers("bot:all_ids")) || [];
      const records = [];
      for (const id of ids) {
        const record = await kv.get(`bot:${id}`);
        if (record) records.push(record);
      }
      records.sort((a, b) => (a.botId > b.botId ? 1 : -1));
      res.status(200).json({ records });
      return;
    }

    if (reqBody.action === "reset") {
      if (!reqBody.botId) {
        res.status(400).json({ error: "botIdが指定されていません" });
        return;
      }
      const existing = (await kv.get(`bot:${reqBody.botId}`)) || { botId: reqBody.botId };
      const updated = { ...existing, systemPrompt: "", updatedAt: new Date().toISOString() };
      await kv.set(`bot:${reqBody.botId}`, updated);
      res.status(200).json({ reset: true });
      return;
    }

    // admin用パスワードの発行(秘書Zoe専用)。15分の有効期限付き
    if (reqBody.action === "generateAdminPassword") {
      if (!reqBody.botId) {
        res.status(400).json({ error: "botIdが指定されていません" });
        return;
      }
      const existing = (await kv.get(`bot:${reqBody.botId}`)) || { botId: reqBody.botId };
      const adminPassword = generatePassword();
      const adminPasswordExpiresAt = Date.now() + 15 * 60 * 1000;
      const updated = { ...existing, adminPassword, adminPasswordExpiresAt };
      await kv.set(`bot:${reqBody.botId}`, updated);
      res.status(200).json({ adminPassword });
      return;
    }

    res.status(400).json({ error: "不明なactionです" });
  } catch (err) {
    res.status(500).json({ error: "内部エラー: " + err.message });
  }
};
