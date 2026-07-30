// netlify/functions/secretary-memory.js
//
// 秘書Zoe専用の「記憶」を保存・取得するための内部専用関数です。
// Claude自身が使っているメモリー機能の簡易版で、パス形式(例: /areas/秘書Zoe改善.md)を
// キーにして、フォルダ分けした形でメモを保存します。
//
// action:
//   "list"   → 保存されている全パスの一覧を取得
//   "read"   → 指定したパスの中身を取得
//   "write"  → 指定したパスの中身を新規作成・全文書き換え
//   "append" → 指定したパスの末尾に追記(存在しなければ新規作成)

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
      name: "secretary-memory",
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_API_TOKEN,
    });

    if (req.action === "list") {
      const { blobs } = await store.list();
      const items = [];
      for (const b of blobs) {
        const content = await store.get(b.key);
        const firstLine = (content || "").split("\n")[0].slice(0, 80);
        items.push({ path: b.key, preview: firstLine });
      }
      items.sort((a, b) => (a.path > b.path ? 1 : -1));
      return { statusCode: 200, headers, body: JSON.stringify({ items }) };
    }

    if (req.action === "read") {
      if (!req.path) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "pathが指定されていません" }) };
      }
      const content = await store.get(req.path);
      if (content === null) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: "そのパスは存在しません" }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ path: req.path, content }) };
    }

    if (req.action === "write") {
      if (!req.path || typeof req.content !== "string") {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "pathとcontentは必須です" }) };
      }
      await store.set(req.path, req.content);
      return { statusCode: 200, headers, body: JSON.stringify({ saved: true, path: req.path }) };
    }

    if (req.action === "append") {
      if (!req.path || typeof req.content !== "string") {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "pathとcontentは必須です" }) };
      }
      const existing = (await store.get(req.path)) || "";
      const updated = existing ? existing + "\n" + req.content : req.content;
      await store.set(req.path, updated);
      return { statusCode: 200, headers, body: JSON.stringify({ saved: true, path: req.path }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "不明なactionです" }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "内部エラー: " + err.message }) };
  }
};
