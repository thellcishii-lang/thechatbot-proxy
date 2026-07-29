// netlify/functions/bot-config.js
//
// 「Zoe001」「Zoe002」のような番号(bot ID)ごとに、システムプロンプトと
// 登録情報(どのリポジトリ/事業に割り当てられているか)を保存・取得する
// 内部専用の関数です。秘書Zoe(chat.jsのmode:"secretary")からのみ呼ばれ、
// フロントエンドから直接叩けないよう、内部シークレットで保護しています。
//
// action:
//   "get"      → 指定したbotIdの現在の設定(プロンプト・登録情報)を取得
//   "set"      → 指定したbotIdのシステムプロンプトを保存
//   "register" → 空いている次の番号(Zoe001, Zoe002...)を割り当て、リポジトリ名を紐づけて登録
//   "list"     → 登録済みの全bot一覧を取得

const { getStore } = require("@netlify/blobs");

function checkSecret(req) {
  return process.env.INTERNAL_FUNCTION_SECRET && req.secret === process.env.INTERNAL_FUNCTION_SECRET;
}

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
    const req = JSON.parse(event.body);
    if (!checkSecret(req)) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: "許可されていません" }) };
    }

    const store = getStore({
      name: "bot-configs",
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_API_TOKEN,
    });

    if (req.action === "get") {
      if (!req.botId) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "botIdが指定されていません" }) };
      }
      const record = await store.get(req.botId, { type: "json" });
      if (!record) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: "そのbotIdは登録されていません" }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ record }) };
    }

    if (req.action === "set") {
      if (!req.botId || typeof req.systemPrompt !== "string") {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "botIdとsystemPromptは必須です" }) };
      }
      const existing = (await store.get(req.botId, { type: "json" })) || {};
      const updated = {
        ...existing,
        botId: req.botId,
        systemPrompt: req.systemPrompt,
        updatedAt: new Date().toISOString(),
      };
      await store.setJSON(req.botId, updated);
      return { statusCode: 200, headers, body: JSON.stringify({ saved: true, record: updated }) };
    }

    if (req.action === "register") {
      if (!req.repoName) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "repoNameが指定されていません" }) };
      }
      const { blobs } = await store.list();
      const usedNumbers = blobs
        .map((b) => b.key.match(/^Zoe(\d{3})$/))
        .filter(Boolean)
        .map((m) => parseInt(m[1], 10));
      let n = 1;
      while (usedNumbers.includes(n)) n++;
      const botId = "Zoe" + String(n).padStart(3, "0");

      const record = {
        botId,
        repoName: req.repoName,
        systemPrompt: "",
        createdAt: new Date().toISOString(),
      };
      await store.setJSON(botId, record);
      return { statusCode: 200, headers, body: JSON.stringify({ botId, record }) };
    }

    if (req.action === "list") {
      const { blobs } = await store.list();
      const records = [];
      for (const b of blobs) {
        const record = await store.get(b.key, { type: "json" });
        if (record) records.push(record);
      }
      records.sort((a, b) => (a.botId > b.botId ? 1 : -1));
      return { statusCode: 200, headers, body: JSON.stringify({ records }) };
    }

    if (req.action === "reset") {
      if (!req.botId) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "botIdが指定されていません" }) };
      }
      // 保存済みのシステムプロンプトだけを空にする(登録情報自体は残す)。
      // これにより、次回からはchat.js内のコード側デフォルト設定が使われるようになる。
      const existing = (await store.get(req.botId, { type: "json" })) || { botId: req.botId };
      const updated = { ...existing, systemPrompt: "", updatedAt: new Date().toISOString() };
      await store.setJSON(req.botId, updated);
      return { statusCode: 200, headers, body: JSON.stringify({ reset: true }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "不明なactionです" }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "内部エラー: " + err.message }) };
  }
};
