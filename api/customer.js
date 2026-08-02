// api/customer.js (Vercel版)
//
// 顧客(お客様)ごとのアカウント管理を行うAPIです。
// 保存先はNetlify BlobsからUpstash Redis(Vercel経由のKV)に切り替えています。
//
// キー設計(Redisはフラットな名前空間なので、種類ごとにプレフィックスを付ける):
//   customer:{id}          → 顧客レコード本体(JSON)
//   customer:all_ids       → 全顧客IDのSet(findByEmail/adminList等の全件走査用)
//   ratelimit:customer:{ip} → レート制限カウンター
//   ipabuse:{ip}            → 共通IP不正利用トラッカー(chat.js等と共有)
//
// 対応アクションは元のNetlify版と同じです(下記ハンドラ内コメント参照)。

const { kv } = require("@vercel/kv");

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

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "unknown";
}

// 同一IPからの短時間の大量アクセス(6桁IDの総当たり等)を防ぐための簡易レート制限。
// 5分間に30回まで。
async function checkRateLimit(ip) {
  try {
    const key = `ratelimit:customer:${ip}`;
    const WINDOW_MS = 5 * 60 * 1000;
    const LIMIT = 30;
    const now = Date.now();
    const record = await kv.get(key);
    if (!record || now - record.windowStart > WINDOW_MS) {
      await kv.set(key, { windowStart: now, count: 1 }, { ex: 300 });
      return true;
    }
    if (record.count >= LIMIT) {
      return false;
    }
    await kv.set(key, { windowStart: record.windowStart, count: record.count + 1 }, { ex: 300 });
    return true;
  } catch (e) {
    // レート制限の判定自体が失敗しても、本来の機能は止めない
    return true;
  }
}

// ============================================================
// 共通IP不正利用トラッカー(全Function共通、キー"ipabuse:{ip}")
// ============================================================
async function checkIpAbuse(ip) {
  try {
    const record = await kv.get(`ipabuse:${ip}`);
    return !!(record && record.blacklisted);
  } catch (e) {
    return false;
  }
}

async function recordIpAbuseStrike(ip) {
  try {
    const key = `ipabuse:${ip}`;
    const record = (await kv.get(key)) || {};
    const strikes = (record.strikes || 0) + 1;
    const blacklisted = strikes >= 3;
    await kv.set(key, { ...record, strikes, blacklisted });
  } catch (e) {
    // 記録に失敗しても本来の処理は止めない
  }
}

// customer:all_ids に登録されている全IDのレコードをまとめて取得するヘルパー
async function getAllCustomerRecords() {
  const ids = (await kv.smembers("customer:all_ids")) || [];
  const records = [];
  for (const id of ids) {
    const record = await kv.get(`customer:${id}`);
    if (record) records.push(record);
  }
  return records;
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

  const clientIp = getClientIp(req);

  const isAbuser = await checkIpAbuse(clientIp);
  if (isAbuser) {
    res.status(403).json({ error: "このIPアドレスは、不審なアクセスが検知されたため利用を制限しています。" });
    return;
  }

  const withinLimit = await checkRateLimit(clientIp);
  if (!withinLimit) {
    await recordIpAbuseStrike(clientIp);
    res.status(429).json({ error: "リクエストが多すぎます。しばらくしてから再度お試しください。" });
    return;
  }

  try {
    // Vercelは Content-Type: application/json のリクエストボディを自動でパースしてくれる
    const reqBody = req.body || {};

    // ① 新規顧客の作成
    if (reqBody.action === "create") {
      let id;
      do {
        id = generateId();
      } while (await kv.get(`customer:${id}`));

      const password = generatePassword();
      const record = {
        id,
        password,
        customerName: reqBody.customerName || "",
        contactPerson: reqBody.contactPerson || "",
        address: reqBody.address || "",
        email: reqBody.email || "",
        companyUrl: reqBody.companyUrl || "",
        stage: reqBody.stage || "closing",
        status: "setup",
        systemPrompt: "",
        faqDraft: "",
        createdAt: new Date().toISOString(),
      };
      await kv.set(`customer:${id}`, record);
      await kv.sadd("customer:all_ids", id);

      res.status(200).json({ id, password });
      return;
    }

    // ② ログイン確認(admin/setup画面用)
    if (reqBody.action === "login") {
      const record = await kv.get(`customer:${reqBody.id}`);
      if (!record) {
        res.status(404).json({ error: "そのIDは存在しません" });
        return;
      }
      if (record.password === reqBody.password) {
        res.status(200).json({ record, loggedInAs: "owner" });
        return;
      }
      if (record.adminPassword && record.adminPassword === reqBody.password && record.adminPasswordExpiresAt && Date.now() < record.adminPasswordExpiresAt) {
        res.status(200).json({ record, loggedInAs: "admin" });
        return;
      }
      res.status(401).json({ error: "パスワードが違います" });
      return;
    }

    // ③ データ更新(学習内容・ステータスの保存)
    if (reqBody.action === "update") {
      const record = await kv.get(`customer:${reqBody.id}`);
      if (!record) {
        res.status(404).json({ error: "そのIDは存在しません" });
        return;
      }
      if (record.password !== reqBody.password) {
        res.status(401).json({ error: "パスワードが違います" });
        return;
      }
      const updated = { ...record, ...reqBody.updates };
      await kv.set(`customer:${reqBody.id}`, updated);
      res.status(200).json({ record: updated });
      return;
    }

    // ③.5 「現在の仕様」タブ用:保存済みの資料(base64)とキュー状況を取得する(パスワード必須)
    if (reqBody.action === "getSpecDoc") {
      const record = await kv.get(`customer:${reqBody.id}`);
      if (!record) {
        res.status(404).json({ error: "そのIDは存在しません" });
        return;
      }
      if (record.password !== reqBody.password) {
        res.status(401).json({ error: "パスワードが違います" });
        return;
      }
      res.status(200).json({
        specStatus: record.specStatus || "idle",
        specQueueCount: record.specQueueCount || 0,
        specDocBase64: record.specDocBase64 || null,
        specDocFilename: record.specDocFilename || null,
      });
      return;
    }

    // ④ 存在確認のみ(本番チャット画面が起動時に使う。パスワード不要)
    if (reqBody.action === "check") {
      const record = await kv.get(`customer:${reqBody.id}`);
      if (!record) {
        res.status(404).json({ error: "そのIDは存在しません" });
        return;
      }
      res.status(200).json({
        id: record.id,
        customerName: record.customerName,
        status: record.status,
        systemPrompt: record.systemPrompt,
        suspended: !!record.suspended,
        published: !!record.published,
        chatDisplayName: record.chatDisplayName || null,
        chatTheme: record.chatTheme || null,
        specStatus: record.specStatus || "idle",
        specQueueCount: record.specQueueCount || 0,
      });
      return;
    }

    // ⑤ メールアドレスによる検索(決済Webhookが、支払いに使われたメールから該当顧客を探すために使う)
    if (reqBody.action === "findByEmail") {
      if (!reqBody.email) {
        res.status(400).json({ error: "emailが指定されていません" });
        return;
      }
      const records = await getAllCustomerRecords();
      const found = records.find((r) => r.email && r.email.toLowerCase() === reqBody.email.toLowerCase());
      if (found) {
        res.status(200).json({ id: found.id, customerName: found.customerName, email: found.email, status: found.status });
        return;
      }
      res.status(404).json({ error: "該当する顧客が見つかりません" });
      return;
    }

    // ⑥ 資料請求などの「見込み客」記録
    if (reqBody.action === "upsertLead") {
      if (!reqBody.email) {
        res.status(400).json({ error: "emailが指定されていません" });
        return;
      }
      const records = await getAllCustomerRecords();
      const existing = records.find((r) => r.email && r.email.toLowerCase() === reqBody.email.toLowerCase());

      if (existing) {
        const updated = {
          ...existing,
          customerName: reqBody.customerName || existing.customerName,
          contactPerson: reqBody.contactPerson || existing.contactPerson,
          phone: reqBody.phone || existing.phone,
          companyUrl: reqBody.companyUrl || existing.companyUrl,
          updatedAt: new Date().toISOString(),
        };
        await kv.set(`customer:${existing.id}`, updated);
        res.status(200).json({ id: updated.id, updated: true });
        return;
      }

      let id;
      do {
        id = generateId();
      } while (await kv.get(`customer:${id}`));
      const password = generatePassword();
      const record = {
        id,
        password,
        customerName: reqBody.customerName || "",
        contactPerson: reqBody.contactPerson || "",
        phone: reqBody.phone || "",
        email: reqBody.email || "",
        companyUrl: reqBody.companyUrl || "",
        stage: "lead",
        status: "setup",
        systemPrompt: "",
        faqDraft: "",
        createdAt: new Date().toISOString(),
      };
      await kv.set(`customer:${id}`, record);
      await kv.sadd("customer:all_ids", id);
      res.status(200).json({ id, created: true });
      return;
    }

    // ⑦ 支払い確認済みフラグを立てる(square-webhook.jsが決済完了時に呼ぶ)
    if (reqBody.action === "markPaid") {
      if (!process.env.INTERNAL_FUNCTION_SECRET || reqBody.secret !== process.env.INTERNAL_FUNCTION_SECRET) {
        res.status(401).json({ error: "許可されていません" });
        return;
      }
      if (!reqBody.id) {
        res.status(400).json({ error: "idが指定されていません" });
        return;
      }
      const record = await kv.get(`customer:${reqBody.id}`);
      if (!record) {
        res.status(404).json({ error: "そのIDは存在しません" });
        return;
      }
      const updated = { ...record, paid: true, paidAt: new Date().toISOString() };
      await kv.set(`customer:${reqBody.id}`, updated);
      res.status(200).json({ id: reqBody.id, paid: true });
      return;
    }

    // ⑧ 秘書Zoe専用:指定IDの顧客情報を取得する(パスワードは含めない)
    if (reqBody.action === "adminGet") {
      if (!process.env.INTERNAL_FUNCTION_SECRET || reqBody.secret !== process.env.INTERNAL_FUNCTION_SECRET) {
        res.status(401).json({ error: "許可されていません" });
        return;
      }
      if (!reqBody.id) {
        res.status(400).json({ error: "idが指定されていません" });
        return;
      }
      const record = await kv.get(`customer:${reqBody.id}`);
      if (!record) {
        res.status(404).json({ error: "そのIDは存在しません" });
        return;
      }
      const { password, ...safeRecord } = record;
      res.status(200).json({ record: safeRecord });
      return;
    }

    // ⑨ 秘書Zoe専用:指定IDの顧客を停止/再開する
    if (reqBody.action === "adminSetSuspended") {
      if (!process.env.INTERNAL_FUNCTION_SECRET || reqBody.secret !== process.env.INTERNAL_FUNCTION_SECRET) {
        res.status(401).json({ error: "許可されていません" });
        return;
      }
      if (!reqBody.id) {
        res.status(400).json({ error: "idが指定されていません" });
        return;
      }
      const record = await kv.get(`customer:${reqBody.id}`);
      if (!record) {
        res.status(404).json({ error: "そのIDは存在しません" });
        return;
      }
      const updated = { ...record, suspended: !!reqBody.suspended };
      await kv.set(`customer:${reqBody.id}`, updated);
      res.status(200).json({ id: reqBody.id, suspended: updated.suspended });
      return;
    }

    // ⑩ 秘書Zoe専用:登録済みの全顧客を一覧取得する(パスワードは含めない)
    if (reqBody.action === "adminList") {
      if (!process.env.INTERNAL_FUNCTION_SECRET || reqBody.secret !== process.env.INTERNAL_FUNCTION_SECRET) {
        res.status(401).json({ error: "許可されていません" });
        return;
      }
      const records = await getAllCustomerRecords();
      const safeRecords = records.map((r) => {
        const { password, ...safe } = r;
        return safe;
      });
      safeRecords.sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));
      res.status(200).json({ count: safeRecords.length, records: safeRecords });
      return;
    }

    // ⑪ 秘書Zoe専用:指定IDの顧客を1件削除する
    if (reqBody.action === "adminDelete") {
      if (!process.env.INTERNAL_FUNCTION_SECRET || reqBody.secret !== process.env.INTERNAL_FUNCTION_SECRET) {
        res.status(401).json({ error: "許可されていません" });
        return;
      }
      if (!reqBody.id) {
        res.status(400).json({ error: "idが指定されていません" });
        return;
      }
      const record = await kv.get(`customer:${reqBody.id}`);
      if (!record) {
        res.status(404).json({ error: "そのIDは存在しません" });
        return;
      }
      await kv.del(`customer:${reqBody.id}`);
      await kv.srem("customer:all_ids", reqBody.id);
      res.status(200).json({ deleted: true, id: reqBody.id });
      return;
    }

    // ⑫ 秘書Zoe専用:登録済みの全顧客を削除する(誤操作防止のためconfirm:true必須)
    if (reqBody.action === "adminDeleteAll") {
      if (!process.env.INTERNAL_FUNCTION_SECRET || reqBody.secret !== process.env.INTERNAL_FUNCTION_SECRET) {
        res.status(401).json({ error: "許可されていません" });
        return;
      }
      if (reqBody.confirm !== true) {
        res.status(400).json({ error: "confirm:trueが必要です(誤操作防止)" });
        return;
      }
      const ids = (await kv.smembers("customer:all_ids")) || [];
      let deletedCount = 0;
      for (const id of ids) {
        await kv.del(`customer:${id}`);
        deletedCount++;
      }
      await kv.del("customer:all_ids");
      res.status(200).json({ deleted: true, count: deletedCount });
      return;
    }

    // ⑬ admin用パスワードの発行(本人 or 秘書Zoe)。15分の有効期限付き
    if (reqBody.action === "generateAdminPassword") {
      if (!reqBody.id) {
        res.status(400).json({ error: "idが指定されていません" });
        return;
      }
      const record = await kv.get(`customer:${reqBody.id}`);
      if (!record) {
        res.status(404).json({ error: "そのIDは存在しません" });
        return;
      }
      const authorizedBySecret = process.env.INTERNAL_FUNCTION_SECRET && reqBody.secret === process.env.INTERNAL_FUNCTION_SECRET;
      const authorizedByPassword = reqBody.password && reqBody.password === record.password;
      if (!authorizedBySecret && !authorizedByPassword) {
        res.status(401).json({ error: "許可されていません" });
        return;
      }
      const adminPassword = generatePassword();
      const adminPasswordExpiresAt = Date.now() + 15 * 60 * 1000;
      const updated = { ...record, adminPassword, adminPasswordExpiresAt };
      await kv.set(`customer:${reqBody.id}`, updated);
      res.status(200).json({ adminPassword });
      return;
    }

    // ⑭ 秘書Zoe専用:指定IDの個別設定(customSettings)を1件更新する
    if (reqBody.action === "adminSetCustomSetting") {
      if (!process.env.INTERNAL_FUNCTION_SECRET || reqBody.secret !== process.env.INTERNAL_FUNCTION_SECRET) {
        res.status(401).json({ error: "許可されていません" });
        return;
      }
      if (!reqBody.id || !reqBody.key) {
        res.status(400).json({ error: "idとkeyが指定されていません" });
        return;
      }
      const record = await kv.get(`customer:${reqBody.id}`);
      if (!record) {
        res.status(404).json({ error: "そのIDは存在しません" });
        return;
      }
      const customSettings = { ...(record.customSettings || {}), [reqBody.key]: reqBody.value };
      const updated = { ...record, customSettings };
      await kv.set(`customer:${reqBody.id}`, updated);
      res.status(200).json({ id: reqBody.id, customSettings });
      return;
    }

    // ⑮ 秘書Zoe専用:指定IDの個別設定ロックのON/OFFを切り替える
    if (reqBody.action === "adminSetSettingsLocked") {
      if (!process.env.INTERNAL_FUNCTION_SECRET || reqBody.secret !== process.env.INTERNAL_FUNCTION_SECRET) {
        res.status(401).json({ error: "許可されていません" });
        return;
      }
      if (!reqBody.id || typeof reqBody.locked !== "boolean") {
        res.status(400).json({ error: "idとlocked(true/false)が指定されていません" });
        return;
      }
      const record = await kv.get(`customer:${reqBody.id}`);
      if (!record) {
        res.status(404).json({ error: "そのIDは存在しません" });
        return;
      }
      const updated = { ...record, settingsLocked: reqBody.locked };
      await kv.set(`customer:${reqBody.id}`, updated);
      res.status(200).json({ id: reqBody.id, settingsLocked: reqBody.locked });
      return;
    }

    // ⑯ update-spec.js専用(Vercel移行後は不要になる見込み。当面は残置):
    //   内部シークレットで任意のフィールドを更新する汎用アクション
    if (reqBody.action === "adminUpdate") {
      if (!process.env.INTERNAL_FUNCTION_SECRET || reqBody.secret !== process.env.INTERNAL_FUNCTION_SECRET) {
        res.status(401).json({ error: "許可されていません" });
        return;
      }
      if (!reqBody.id) {
        res.status(400).json({ error: "idが指定されていません" });
        return;
      }
      const record = await kv.get(`customer:${reqBody.id}`);
      if (!record) {
        res.status(404).json({ error: "そのIDは存在しません" });
        return;
      }
      const updated = { ...record, ...reqBody.updates };
      await kv.set(`customer:${reqBody.id}`, updated);
      const { password, ...safeUpdated } = updated;
      res.status(200).json({ record: safeUpdated });
      return;
    }

    res.status(400).json({ error: "不明なactionです" });
  } catch (err) {
    res.status(500).json({ error: "内部エラー: " + err.message });
  }
};
