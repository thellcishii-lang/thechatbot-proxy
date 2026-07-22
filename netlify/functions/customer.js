// netlify/functions/customer.js
//
// 顧客(お客様)ごとのアカウント管理を行う関数です。
// Netlify Blobsという、追加のデータベース契約なしで使えるNetlify標準の
// 保存機能を使って、6桁ID・パスワード・学習データを保管します。
//
// 対応するアクション(POSTのbody内の action で指定):
//   action: "create"        → 新しい顧客を作成し、6桁ID+初期パスワードを発行
//   action: "login"         → ID+パスワードを照合し、正しければ顧客データを返す
//   action: "update"        → 顧客データ(学習内容など)を更新保存
//   action: "check"         → IDが存在するかだけを確認(パスワード不要、production画面用)

const { getStore } = require("@netlify/blobs");

function generateId() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6桁の数字
}

function generatePassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 紛らわしい文字(0,O,1,I)を除外
  let pw = "";
  for (let i = 0; i < 8; i++) {
    pw += chars[Math.floor(Math.random() * chars.length)];
  }
  return pw;
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
      name: "customers",
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_API_TOKEN,
    });
    const req = JSON.parse(event.body);

    // ① 新規顧客の作成
    if (req.action === "create") {
      let id;
      // 万一同じIDが既にあれば作り直す(衝突回避)
      do {
        id = generateId();
      } while (await store.get(id));

      const password = generatePassword();
      const record = {
        id,
        password,
        customerName: req.customerName || "",
        status: "setup", // setup(学習中) → ready(公開準備完了) → live(本番稼働)
        systemPrompt: "",
        faqDraft: "",
        createdAt: new Date().toISOString(),
      };
      await store.setJSON(id, record);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ id, password }),
      };
    }

    // ② ログイン確認(admin/setup画面用)
    if (req.action === "login") {
      const record = await store.get(req.id, { type: "json" });
      if (!record) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: "そのIDは存在しません" }) };
      }
      if (record.password !== req.password) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: "パスワードが違います" }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ record }) };
    }

    // ③ データ更新(学習内容・ステータスの保存)
    if (req.action === "update") {
      const record = await store.get(req.id, { type: "json" });
      if (!record) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: "そのIDは存在しません" }) };
      }
      if (record.password !== req.password) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: "パスワードが違います" }) };
      }
      const updated = { ...record, ...req.updates };
      await store.setJSON(req.id, updated);
      return { statusCode: 200, headers, body: JSON.stringify({ record: updated }) };
    }

    // ④ 存在確認のみ(本番チャット画面が起動時に使う。パスワード不要)
    if (req.action === "check") {
      const record = await store.get(req.id, { type: "json" });
      if (!record) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: "そのIDは存在しません" }) };
      }
      // パスワードなど機密情報は返さず、必要な分だけ返す
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          id: record.id,
          customerName: record.customerName,
          status: record.status,
          systemPrompt: record.systemPrompt,
        }),
      };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "不明なactionです" }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "内部エラー: " + err.message }) };
  }
};
