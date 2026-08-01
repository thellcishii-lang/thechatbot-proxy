// netlify/functions/update-spec.js
//
// 「現在の仕様」タブ用のFAQ資料を、チャットの裏側でバックグラウンド更新するための
// Netlify Scheduled Functionです(expire-applications.jsと同じ仕組み、5分おきに実行)。
//
// 考え方:
// - 設定Zoe(zoe-setup.html)は、メッセージを送るたびに顧客レコードのlastMessageAtを更新する
// - この関数は5分おきに全顧客を確認し、「最後のメッセージから5分以上経過していて、
//   まだその内容を資料に反映していない(specLastCountedAtとlastMessageAtが違う)」顧客を見つけたら、
//   その回を「更新待ち1件」として数える(specQueueCountを+1)
// - specStatusが"idle"の顧客は、その場で更新処理(Claudeにcurrent systemPromptからFAQ内容を
//   書かせ、generate-faq-document.jsでWord化)を開始し、完了したらspecQueueCountを-1する
// - 更新中(specStatus:"updating")にさらに新しいチャットが終わっていたら、それは既に
//   zoe-setup.html側でspecQueueCountに積み上げられているので、この関数はそれを検知して
//   処理を続ける(1回のスケジュール実行で、待ちが0になるまで連続処理する)
//
// これにより、チャット画面の「現在の仕様」ボタンは常に「裏側で作られた最新のファイルを
// ダウンロードするだけ」の動作になり、チャット中にその場で資料生成させてタイムアウトする
// 問題を回避する。

const { getStore } = require("@netlify/blobs");

const FIVE_MIN_MS = 5 * 60 * 1000;
const LOCK_STALE_MS = 8 * 60 * 1000; // このリース時間を過ぎたら「前回の実行が固まった」とみなし引き継ぐ
const INTERNAL_SECRET = process.env.INTERNAL_FUNCTION_SECRET;

async function callCustomer(body) {
  const res = await fetch("https://chatbot-proxy.netlify.app/.netlify/functions/customer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ ...body, secret: INTERNAL_SECRET }),
  });
  return await res.json();
}

async function generateFaqContentWithClaude(record) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const prompt =
    `あなたは設定Zoeです。以下は、これまでお客様と作り上げてきた本番チャットボットの` +
    `システムプロンプト(FAQの土台)です。この内容をもとに、お客様に見せる「現在の仕様」資料として、` +
    `見出し付きのFAQ形式(Q&A形式、または項目ごとの説明形式)に整理し直してください。` +
    `プロンプトの指示文としての体裁(「〜してください」等の指示口調)ではなく、` +
    `お客様が読んで内容を把握できる資料としての文章にしてください。\n\n` +
    `# 現在のシステムプロンプト\n${record.systemPrompt || "(まだ内容がありません)"}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    signal: AbortSignal.timeout(280000), // 資料整理は多少時間がかかる想定で長めに設定
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 8000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
  const textBlock = (data.content || []).find((b) => b.type === "text");
  return textBlock ? textBlock.text : "";
}

async function generateFaqDocument(customerName, content) {
  const res = await fetch("https://chatbot-proxy.netlify.app/.netlify/functions/generate-faq-document", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({ customerName, content }),
  });
  return await res.json();
}

// 1顧客分、キューが0になるまで連続して更新処理を行う
async function processCustomer(record) {
  let current = record;
  while ((current.specQueueCount || 0) > 0) {
    // この時点のlastMessageAtを「今回反映する版」として確定させる
    const versionBeingProcessed = current.lastMessageAt;

    // ロック(自分がこの顧客を処理中であることの印)を更新しておく。
    // 万一処理が長引いても、他のインスタンスが「まだ生きている」と分かるようにする
    await callCustomer({ action: "adminUpdate", id: current.id, updates: { specLockAt: new Date().toISOString() } });

    try {
      const content = await generateFaqContentWithClaude(current);
      const docResult = await generateFaqDocument(current.customerName, content);

      const updates = {
        specQueueCount: Math.max(0, (current.specQueueCount || 0) - 1),
        specLastCountedAt: versionBeingProcessed,
      };
      if (docResult && docResult.fileBase64) {
        updates.specDocBase64 = docResult.fileBase64;
        updates.specDocFilename = docResult.filename;
        updates.specUpdatedAt = new Date().toISOString();
      }
      if (updates.specQueueCount === 0) {
        updates.specStatus = "idle";
      }
      const result = await callCustomer({ action: "adminUpdate", id: current.id, updates });
      if (!result.record) break; // 更新に失敗した場合は無限ループを避けて打ち切る
      current = result.record;
    } catch (e) {
      console.error(`update-spec: 顧客${current.id}の資料生成に失敗しました:`, e.message);
      // 失敗しても「updating」のまま止まらないよう、idleに戻して次回の巡回に委ねる
      await callCustomer({ action: "adminUpdate", id: current.id, updates: { specStatus: "idle" } });
      break;
    }
  }
}

exports.handler = async () => {
  try {
    const listData = await callCustomer({ action: "adminList" });
    const records = listData.records || [];
    const now = Date.now();
    let checkedCount = 0;
    let queuedCount = 0;
    let processedCount = 0;

    for (const record of records) {
      // ステージ1未完了、または一度もチャットしていない顧客は対象外
      if (!record.stage1Complete || !record.lastMessageAt) continue;
      checkedCount++;

      const lastMessageMs = new Date(record.lastMessageAt).getTime();
      const alreadyCounted = record.specLastCountedAt === record.lastMessageAt;
      const sessionEnded = now - lastMessageMs >= FIVE_MIN_MS;

      let current = record;

      // まだ数えていない「終わったチャット」があれば、キューに1件積む
      if (sessionEnded && !alreadyCounted) {
        const newQueueCount = (record.specQueueCount || 0) + 1;
        const result = await callCustomer({
          action: "adminUpdate",
          id: record.id,
          updates: { specQueueCount: newQueueCount, specStatus: "updating" },
        });
        if (result.record) {
          current = result.record;
          queuedCount++;
        }
      }

      // 現在idleでなければ(=何か処理すべきものが積まれていれば)、その場で処理する。
      // ただし、既に別のインスタンスが処理中(ロックがまだ新しい)場合は、
      // 二重処理を避けるためスキップする
      const lockAgeMs = current.specLockAt ? now - new Date(current.specLockAt).getTime() : Infinity;
      const lockedByAnother = lockAgeMs < LOCK_STALE_MS;
      if (current.specStatus === "updating" && (current.specQueueCount || 0) > 0 && !lockedByAnother) {
        await processCustomer(current);
        processedCount++;
      }
    }

    console.log(`update-spec完了: ${checkedCount}件確認、${queuedCount}件を新規キュー投入、${processedCount}件処理`);
    return { statusCode: 200, body: JSON.stringify({ checked: checkedCount, queued: queuedCount, processed: processedCount }) };
  } catch (err) {
    console.error("update-spec実行中にエラー:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

// 5分おきに自動実行する設定
exports.config = {
  schedule: "*/5 * * * *",
};
