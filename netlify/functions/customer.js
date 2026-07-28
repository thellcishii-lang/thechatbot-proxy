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
//   action: "findByEmail"   → メールアドレスから該当顧客を検索(決済Webhook用)

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

function getClientIp(event) {
  return (
    event.headers["x-nf-client-connection-ip"] ||
    (event.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    "unknown"
  );
}

// 同一IPからの短時間の大量アクセス(6桁IDの総当たり等)を防ぐための簡易レート制限。
// 5分間に30回まで。Netlify Blobsにカウンターを保存して判定する。
async function checkRateLimit(ip) {
  try {
    const store = getStore({
      name: "rate-limit-customer",
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_API_TOKEN,
    });
    const WINDOW_MS = 5 * 60 * 1000;
    const LIMIT = 30;
    const now = Date.now();
    const record = await store.get(ip, { type: "json" });
    if (!record || now - record.windowStart > WINDOW_MS) {
      await store.setJSON(ip, { windowStart: now, count: 1 });
      return true;
    }
    if (record.count >= LIMIT) {
      return false;
    }
    await store.setJSON(ip, { windowStart: record.windowStart, count: record.count + 1 });
    return true;
  } catch (e) {
    // レート制限の判定自体が失敗しても、本来の機能は止めない
    return true;
  }
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

  const clientIp = getClientIp(event);
  const withinLimit = await checkRateLimit(clientIp);
  if (!withinLimit) {
    return { statusCode: 429, headers, body: JSON.stringify({ error: "リクエストが多すぎます。しばらくしてから再度お試しください。" }) };
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
        contactPerson: req.contactPerson || "",
        address: req.address || "",
        email: req.email || "",
        companyUrl: req.companyUrl || "",
        stage: req.stage || "closing", // "lead"(資料請求・未成約の記録) / "closing"(導入申込み)
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

    // ⑤ メールアドレスによる検索(決済Webhookが、支払いに使われたメールから該当顧客を探すために使う)
    if (req.action === "findByEmail") {
      if (!req.email) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "emailが指定されていません" }) };
      }
      const { blobs } = await store.list();
      for (const blob of blobs) {
        const record = await store.get(blob.key, { type: "json" });
        if (record && record.email && record.email.toLowerCase() === req.email.toLowerCase()) {
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              id: record.id,
              customerName: record.customerName,
              email: record.email,
              status: record.status,
            }),
          };
        }
      }
      return { statusCode: 404, headers, body: JSON.stringify({ error: "該当する顧客が見つかりません" }) };
    }

    // ⑥ 資料請求などの「見込み客」記録。メールアドレスが一致する既存レコードがあれば更新、
    //   なければ新規に6桁IDを発行して作成する(パスワード確認は不要、社内管理用の記録のため)
    if (req.action === "upsertLead") {
      if (!req.email) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "emailが指定されていません" }) };
      }
      const { blobs } = await store.list();
      let existingKey = null;
      for (const blob of blobs) {
        const record = await store.get(blob.key, { type: "json" });
        if (record && record.email && record.email.toLowerCase() === req.email.toLowerCase()) {
          existingKey = blob.key;
          break;
        }
      }

      if (existingKey) {
        const record = await store.get(existingKey, { type: "json" });
        const updated = {
          ...record,
          customerName: req.customerName || record.customerName,
          contactPerson: req.contactPerson || record.contactPerson,
          phone: req.phone || record.phone,
          companyUrl: req.companyUrl || record.companyUrl,
          updatedAt: new Date().toISOString(),
        };
        await store.setJSON(existingKey, updated);
        return { statusCode: 200, headers, body: JSON.stringify({ id: updated.id, updated: true }) };
      }

      let id;
      do {
        id = generateId();
      } while (await store.get(id));
      const password = generatePassword();
      const record = {
        id,
        password,
        customerName: req.customerName || "",
        contactPerson: req.contactPerson || "",
        phone: req.phone || "",
        email: req.email || "",
        companyUrl: req.companyUrl || "",
        stage: "lead",
        status: "setup",
        systemPrompt: "",
        faqDraft: "",
        createdAt: new Date().toISOString(),
      };
      await store.setJSON(id, record);
      return { statusCode: 200, headers, body: JSON.stringify({ id, created: true }) };
    }

    // ⑦ 支払い確認済みフラグを立てる(square-webhook.jsが決済完了時に呼ぶ。パスワード不要の内部専用アクション)
    if (req.action === "markPaid") {
      // 内部専用アクション:合言葉(INTERNAL_FUNCTION_SECRET)が一致しない限り実行不可にする。
      // これがないと、6桁IDさえ分かれば誰でも「支払い済み」を偽装できてしまうため。
      if (!process.env.INTERNAL_FUNCTION_SECRET || req.secret !== process.env.INTERNAL_FUNCTION_SECRET) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: "許可されていません" }) };
      }
      if (!req.id) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "idが指定されていません" }) };
      }
      const record = await store.get(req.id, { type: "json" });
      if (!record) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: "そのIDは存在しません" }) };
      }
      const updated = { ...record, paid: true, paidAt: new Date().toISOString() };
      await store.setJSON(req.id, updated);
      return { statusCode: 200, headers, body: JSON.stringify({ id: req.id, paid: true }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "不明なactionです" }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "内部エラー: " + err.message }) };
  }
};
