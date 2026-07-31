// netlify/functions/expire-applications.js
//
// 毎日1回自動実行されるNetlify Scheduled Functionです。
// customer.jsに保存されている申込み(stageが'lead'以外=導入申込み)のうち、
// まだ支払いが確認できていない(paid !== true)ものについて、申込み完了日
// (createdAt)を起算日として、経過日数に応じて以下の処理を行います。
//
//   6日目: 「まだ決済確認が取れていない旨・明日までに入金確認が取れないと
//           再度お申込みが必要になる旨」のリマインドメールを送信
//   7日目: status を "expired" に変更(既存の期限切れ処理)
//   8日目: 「ご確認が取れなかったので、導入される場合は再度お申込みを」
//           という通知メールを送信(ID・パスワード・申込みZoeへのリンクを再掲)
//
// (見込み客記録=stage:'lead' の資料請求データはこの対象外です)

const { getStore } = require("@netlify/blobs");

const DAY_MS = 24 * 60 * 60 * 1000;
const SIX_DAYS_MS = 6 * DAY_MS;
const SEVEN_DAYS_MS = 7 * DAY_MS;
const EIGHT_DAYS_MS = 8 * DAY_MS;

const APPLICATION_URL = "https://the-chatbot.com/zoe-application.html";

async function sendEmail(to, subject, text) {
  try {
    const res = await fetch("https://chatbot-proxy.netlify.app/.netlify/functions/send-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, subject, text }),
    });
    const data = await res.json();
    return !!(res.ok && data.success);
  } catch (e) {
    return false;
  }
}

// テストモード:内部シークレット + testId + testElapsedDays を指定してPOSTすると、
// 実際の日数経過を待たず、指定IDのレコードだけを「あたかもN日経過したかのように」処理する。
// createdAtを書き換える必要も、実際に何日も待つ必要もなく、6日目・8日目の挙動をその場で確認できる。
// (実際のレコードの状態は一切書き換えない。メール送信結果だけを確認するためのテスト専用処理)
async function runTest(store, testId, testElapsedDays) {
  const record = await store.get(testId, { type: "json" });
  if (!record) return { error: "指定されたIDが見つかりません" };

  const fakeElapsedMs = testElapsedDays * DAY_MS;
  const id = record.id || testId;
  const results = [];

  if (fakeElapsedMs >= EIGHT_DAYS_MS) {
    const ok = await sendEmail(
      record.email,
      "【the.chatBOT】お申込みについて(テスト送信)",
      `${record.customerName || "お客様"} 様\n\n` +
        `下記のお申し込みのご確認が取れませんでしたので、導入される場合は、再度お申込みをお願い致します。\n\n` +
        `ID: ${id}\n` +
        `パスワード: ${record.password || "(発行済みのパスワード)"}\n\n` +
        `申し込みZoe: ${APPLICATION_URL}\n\n` +
        `the.chatBOT`
    );
    results.push({ type: "expiredNotice(8日目)", sent: ok, to: record.email });
  } else if (fakeElapsedMs >= SEVEN_DAYS_MS) {
    results.push({ type: "expired(7日目、ステータス変更のみ・メールなし)" });
  } else if (fakeElapsedMs >= SIX_DAYS_MS) {
    const ok = await sendEmail(
      record.email,
      "【the.chatBOT】お申込みのご決済確認について(テスト送信)",
      `${record.customerName || "お客様"} 様\n\n` +
        `この度はお申込みありがとうございます。\n` +
        `恐れ入りますが、まだ決済のご確認が取れておりません。\n\n` +
        `お手数をおかけいたしますが、下記の決済リンクよりお手続きをお願い申し上げます。\n\n` +
        `なお、明日までにご入金の確認が取れない場合、恐れ入りますが再度お申込みからお願いする形となります。何卒ご了承ください。\n\n` +
        `the.chatBOT`
    );
    results.push({ type: "reminder(6日目)", sent: ok, to: record.email });
  } else {
    results.push({ type: "該当なし(指定日数ではまだどの処理も発生しません)" });
  }

  return { testId: id, testElapsedDays, results };
}

exports.handler = async (event) => {
  try {
    const store = getStore({
      name: "customers",
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_API_TOKEN,
    });

    // テストモード:POSTで内部シークレット・testId・testElapsedDaysが渡された場合のみ、
    // 通常のバッチ処理の代わりにテスト用の単発処理を行う
    if (event && event.httpMethod === "POST" && event.body) {
      let testReq;
      try {
        testReq = JSON.parse(event.body);
      } catch (e) {
        testReq = null;
      }
      if (
        testReq &&
        process.env.INTERNAL_FUNCTION_SECRET &&
        testReq.secret === process.env.INTERNAL_FUNCTION_SECRET &&
        testReq.testId &&
        typeof testReq.testElapsedDays === "number"
      ) {
        const result = await runTest(store, testReq.testId, testReq.testElapsedDays);
        return { statusCode: result.error ? 404 : 200, body: JSON.stringify(result) };
      }
    }

    const { blobs } = await store.list();
    const now = Date.now();
    let checkedCount = 0;
    let reminderCount = 0;
    let expiredCount = 0;
    let finalNoticeCount = 0;

    for (const blob of blobs) {
      const record = await store.get(blob.key, { type: "json" });
      if (!record) continue;

      // 資料請求(見込み客)の記録は対象外
      if (record.stage === "lead") continue;
      // 既に支払い済みのものはスキップ
      if (record.paid === true) continue;
      if (!record.createdAt) continue;

      checkedCount++;
      const createdAtMs = new Date(record.createdAt).getTime();
      const elapsedMs = now - createdAtMs;
      const id = record.id || blob.key;

      // 6日目: リマインドメール(まだ送っていない場合のみ)
      if (
        record.status !== "expired" &&
        !record.reminderSentAt &&
        elapsedMs >= SIX_DAYS_MS &&
        record.email
      ) {
        const ok = await sendEmail(
          record.email,
          "【the.chatBOT】お申込みのご決済確認について",
          `${record.customerName || "お客様"} 様\n\n` +
            `この度はお申込みありがとうございます。\n` +
            `恐れ入りますが、まだ決済のご確認が取れておりません。\n\n` +
            `お手数をおかけいたしますが、下記の決済リンクよりお手続きをお願い申し上げます。\n\n` +
            `なお、明日までにご入金の確認が取れない場合、恐れ入りますが再度お申込みからお願いする形となります。何卒ご了承ください。\n\n` +
            `the.chatBOT`
        );
        if (ok) {
          await store.setJSON(blob.key, { ...record, reminderSentAt: new Date().toISOString() });
          reminderCount++;
        }
        continue; // このバッチでは1件につき1アクションのみ行う
      }

      // 7日目: 期限切れ処理(既存ロジック)
      if (record.status !== "expired" && elapsedMs >= SEVEN_DAYS_MS) {
        const updated = { ...record, status: "expired", expiredAt: new Date().toISOString() };
        await store.setJSON(blob.key, updated);
        expiredCount++;
        continue;
      }

      // 8日目: 期限切れ通知メール(まだ送っていない場合のみ)
      if (
        record.status === "expired" &&
        !record.expiredNoticeSentAt &&
        elapsedMs >= EIGHT_DAYS_MS &&
        record.email
      ) {
        const ok = await sendEmail(
          record.email,
          "【the.chatBOT】お申込みについて",
          `${record.customerName || "お客様"} 様\n\n` +
            `下記のお申し込みのご確認が取れませんでしたので、導入される場合は、再度お申込みをお願い致します。\n\n` +
            `ID: ${id}\n` +
            `パスワード: ${record.password || "(発行済みのパスワード)"}\n\n` +
            `申し込みZoe: ${APPLICATION_URL}\n\n` +
            `the.chatBOT`
        );
        if (ok) {
          await store.setJSON(blob.key, { ...record, expiredNoticeSentAt: new Date().toISOString() });
          finalNoticeCount++;
        }
      }
    }

    console.log(
      `期限切れチェック完了: ${checkedCount}件確認、リマインド${reminderCount}件、失効${expiredCount}件、最終通知${finalNoticeCount}件`
    );
    return {
      statusCode: 200,
      body: JSON.stringify({
        checked: checkedCount,
        reminded: reminderCount,
        expired: expiredCount,
        finalNotice: finalNoticeCount,
      }),
    };
  } catch (err) {
    console.error("期限切れチェック中にエラー:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

// 毎日午前3時(UTC。日本時間 正午)に自動実行する設定
exports.config = {
  schedule: "0 3 * * *",
};
