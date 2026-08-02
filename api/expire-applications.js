// api/expire-applications.js (Vercel版)
//
// 毎日1回自動実行されるVercel Cron Jobです(vercel.jsonでスケジュールを設定)。
// customer.jsに保存されている申込み(stageが'lead'以外=導入申込み)のうち、
// まだ支払いが確認できていない(paid !== true)ものについて、申込み完了日
// (createdAt)を起算日として、経過日数に応じて以下の処理を行います。
//
//   6日目: リマインドメール送信
//   7日目: status を "expired" に変更
//   8日目: 最終通知メール送信(ID・パスワード・申込みZoeへのリンクを再掲)
//
// 保存先はNetlify BlobsからUpstash Redisに切り替え(customer.jsと同じキー設計を使用)。

const { kv } = require("@vercel/kv");

const DAY_MS = 24 * 60 * 60 * 1000;
const SIX_DAYS_MS = 6 * DAY_MS;
const SEVEN_DAYS_MS = 7 * DAY_MS;
const EIGHT_DAYS_MS = 8 * DAY_MS;

const APPLICATION_URL = "https://the-chatbot.com/zoe-application.html";
const SEND_EMAIL_API_URL = "https://thechatbot-proxy.vercel.app/api/send-email";

async function sendEmail(to, subject, text) {
  try {
    const res = await fetch(SEND_EMAIL_API_URL, {
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
// 実際の日数経過を待たず、指定IDのレコードだけを「あたかもN日経過したかのように」処理する
async function runTest(testId, testElapsedDays) {
  const record = await kv.get(`customer:${testId}`);
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

module.exports = async (req, res) => {
  try {
    // テストモード:POSTで内部シークレット・testId・testElapsedDaysが渡された場合のみ、
    // 通常のバッチ処理の代わりにテスト用の単発処理を行う
    if (req.method === "POST" && req.body) {
      const testReq = req.body;
      if (
        process.env.INTERNAL_FUNCTION_SECRET &&
        testReq.secret === process.env.INTERNAL_FUNCTION_SECRET &&
        testReq.testId &&
        typeof testReq.testElapsedDays === "number"
      ) {
        const result = await runTest(testReq.testId, testReq.testElapsedDays);
        res.status(result.error ? 404 : 200).json(result);
        return;
      }
    }

    // Vercel Cronからの定期実行では、CRON_SECRETを設定していれば
    // Authorizationヘッダーで検証できる(未設定ならスキップ)
    if (process.env.CRON_SECRET) {
      const authHeader = req.headers["authorization"];
      if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        res.status(401).json({ error: "許可されていません" });
        return;
      }
    }

    const ids = (await kv.smembers("customer:all_ids")) || [];
    const now = Date.now();
    let checkedCount = 0;
    let reminderCount = 0;
    let expiredCount = 0;
    let finalNoticeCount = 0;

    for (const id of ids) {
      const record = await kv.get(`customer:${id}`);
      if (!record) continue;

      if (record.stage === "lead") continue;
      if (record.paid === true) continue;
      if (!record.createdAt) continue;

      checkedCount++;
      const createdAtMs = new Date(record.createdAt).getTime();
      const elapsedMs = now - createdAtMs;

      // 6日目: リマインドメール(まだ送っていない場合のみ)
      if (record.status !== "expired" && !record.reminderSentAt && elapsedMs >= SIX_DAYS_MS && record.email) {
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
          await kv.set(`customer:${id}`, { ...record, reminderSentAt: new Date().toISOString() });
          reminderCount++;
        }
        continue;
      }

      // 7日目: 期限切れ処理
      if (record.status !== "expired" && elapsedMs >= SEVEN_DAYS_MS) {
        await kv.set(`customer:${id}`, { ...record, status: "expired", expiredAt: new Date().toISOString() });
        expiredCount++;
        continue;
      }

      // 8日目: 期限切れ通知メール(まだ送っていない場合のみ)
      if (record.status === "expired" && !record.expiredNoticeSentAt && elapsedMs >= EIGHT_DAYS_MS && record.email) {
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
          await kv.set(`customer:${id}`, { ...record, expiredNoticeSentAt: new Date().toISOString() });
          finalNoticeCount++;
        }
      }
    }

    console.log(`期限切れチェック完了: ${checkedCount}件確認、リマインド${reminderCount}件、失効${expiredCount}件、最終通知${finalNoticeCount}件`);
    res.status(200).json({ checked: checkedCount, reminded: reminderCount, expired: expiredCount, finalNotice: finalNoticeCount });
  } catch (err) {
    console.error("期限切れチェック中にエラー:", err.message);
    res.status(500).json({ error: err.message });
  }
};
