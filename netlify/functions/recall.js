// netlify/functions/recall.js
//
// 「会社名」+「お名前」の両方が分かっている訪問者について、
// 過去の会話内容(特に最初に相談してきた件)を覚えておき、
// 次回同じ組み合わせで訪れた時に呼び出すための関数です。
//
// 名前だけ(会社名なし)の人は記憶しません(方針により対象外)。
//
// action:
//   "save"   → 会話を保存(company, person, firstTopic, history を渡す。既存があれば上書き更新)
//   "lookup" → company + person が一致するか確認し、あれば firstTopic を返す(本人確認用の相槌に使う)

const { getStore } = require("@netlify/blobs");

function makeKey(company, person){
  // 会社名+お名前を正規化(前後の空白除去・小文字化)して結合し、キーにする
  const norm = (s) => (s || "").trim().toLowerCase();
  return norm(company) + "::" + norm(person);
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
    const store = getStore({
      name: "conversations",
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_API_TOKEN,
    });
    const req = JSON.parse(event.body);

    if (!req.company || !req.person) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "companyとpersonは必須です(名前だけの場合は記憶対象外)" }),
      };
    }

    const key = makeKey(req.company, req.person);

    if (req.action === "save") {
      const record = {
        company: req.company,
        person: req.person,
        firstTopic: req.firstTopic || "",
        lastUpdated: new Date().toISOString(),
      };
      await store.setJSON(key, record);
      return { statusCode: 200, headers, body: JSON.stringify({ saved: true }) };
    }

    if (req.action === "lookup") {
      const record = await store.get(key, { type: "json" });
      if (!record) {
        return { statusCode: 200, headers, body: JSON.stringify({ found: false }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ found: true, record }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "不明なactionです" }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "内部エラー: " + err.message }) };
  }
};
