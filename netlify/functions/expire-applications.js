// netlify/functions/expire-applications.js
//
// 毎日1回自動実行されるNetlify Scheduled Functionです。
// customer.jsに保存されている申込み(stageが'lead'以外=導入申込み)のうち、
// 作成から7日以上経過していて、まだ支払いが確認できていない(paid !== true)ものを
// status: "expired" に変更します。
//
// これにより、期限切れの申込みは「再度お申込みからやり直し」の扱いになります。
// (見込み客記録=stage:'lead' の資料請求データはこの対象外です)

const { getStore } = require("@netlify/blobs");

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

exports.handler = async () => {
  try {
    const store = getStore({
      name: "customers",
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_API_TOKEN,
    });

    const { blobs } = await store.list();
    const now = Date.now();
    let expiredCount = 0;
    let checkedCount = 0;

    for (const blob of blobs) {
      const record = await store.get(blob.key, { type: "json" });
      if (!record) continue;

      // 資料請求(見込み客)の記録は対象外
      if (record.stage === "lead") continue;
      // 既に支払い済み、または既に失効済みのものはスキップ
      if (record.paid === true) continue;
      if (record.status === "expired") continue;
      if (!record.createdAt) continue;

      checkedCount++;
      const createdAtMs = new Date(record.createdAt).getTime();
      if (now - createdAtMs >= SEVEN_DAYS_MS) {
        const updated = { ...record, status: "expired", expiredAt: new Date().toISOString() };
        await store.setJSON(blob.key, updated);
        expiredCount++;
      }
    }

    console.log(`期限切れチェック完了: ${checkedCount}件確認、${expiredCount}件を失効`);
    return { statusCode: 200, body: JSON.stringify({ checked: checkedCount, expired: expiredCount }) };
  } catch (err) {
    console.error("期限切れチェック中にエラー:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

// 毎日午前3時(UTC。日本時間 正午)に自動実行する設定
exports.config = {
  schedule: "0 3 * * *",
};
