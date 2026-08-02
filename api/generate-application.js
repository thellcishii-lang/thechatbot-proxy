// api/generate-application.js (Vercel版)
//
// お客様ごとの申込書(.docx)をその場で生成する関数です。
// 会社名・担当者名・所在地・メールアドレス・会社URLを受け取り、
// 雛形に流し込んでWordファイル(base64)として返します。
// 保存先(レート制限・IPトラッカー)はNetlify BlobsからUpstash Redisに切り替え。ロジック自体は変更ありません。

const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, ShadingType, BorderStyle, AlignmentType, VerticalAlign,
} = require("docx");
const { kv } = require("@vercel/kv");

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "unknown";
}

async function checkRateLimit(ip) {
  try {
    const key = `ratelimit:generate-application:${ip}`;
    const WINDOW_MS = 5 * 60 * 1000;
    const LIMIT = 15;
    const now = Date.now();
    const record = await kv.get(key);
    if (!record || now - record.windowStart > WINDOW_MS) {
      await kv.set(key, { windowStart: now, count: 1 }, { ex: 300 });
      return true;
    }
    if (record.count >= LIMIT) return false;
    await kv.set(key, { windowStart: record.windowStart, count: record.count + 1 }, { ex: 300 });
    return true;
  } catch (e) {
    return true;
  }
}

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

const AMBER = "C9750A";
const DARKGRAY = "333333";
const LINEGRAY = "CCCCCC";
const BG = "F5F2EC";

function fieldRow(label, value) {
  return new TableRow({
    children: [
      new TableCell({
        width: { size: 2600, type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, fill: BG },
        verticalAlign: VerticalAlign.CENTER,
        margins: { top: 120, bottom: 120, left: 160, right: 120 },
        children: [new Paragraph({ children: [new TextRun({ text: label, bold: true, size: 20, color: DARKGRAY })] })],
      }),
      new TableCell({
        width: { size: 6400, type: WidthType.DXA },
        verticalAlign: VerticalAlign.CENTER,
        margins: { top: 120, bottom: 120, left: 160, right: 120 },
        children: [new Paragraph({ children: [new TextRun({ text: value || "", size: 22 })] })],
      }),
    ],
  });
}

function buildDocument(data) {
  const today = new Date();
  const dateStr = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;

  return new Document({
    sections: [
      {
        properties: {
          page: {
            size: { width: 11907, height: 16840 },
            margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 },
          },
        },
        children: [
          new Paragraph({
            children: [new TextRun({ text: "the.chatBOT", bold: true, size: 20, color: AMBER })],
            spacing: { after: 60 },
          }),
          new Paragraph({
            children: [new TextRun({ text: "the.chatBOT Zoe　お申込書", bold: true, size: 40 })],
            spacing: { after: 100 },
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: AMBER, space: 8 } },
          }),
          new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [new TextRun({ text: `発行日: ${dateStr}`, size: 20, color: DARKGRAY })],
            spacing: { after: 300 },
          }),
          new Paragraph({
            children: [new TextRun({
              text: "以下の内容にて、the.chatBOT Zoeのお申込みを承ります。内容にお間違いがないかご確認ください。",
              size: 22,
            })],
            spacing: { after: 260 },
          }),

          new Paragraph({
            children: [new TextRun({ text: "■ お申込み内容", bold: true, size: 24, color: AMBER })],
            spacing: { after: 120 },
          }),
          new Table({
            width: { size: 9000, type: WidthType.DXA },
            columnWidths: [2600, 6400],
            rows: [
              fieldRow("会社名", data.customerName),
              fieldRow("ご担当者名", data.contactPerson),
              fieldRow("所在地", data.address),
              fieldRow("メールアドレス", data.email),
              fieldRow("会社URL", data.companyUrl),
            ],
          }),
          new Paragraph({ text: "", spacing: { after: 280 } }),

          new Paragraph({
            children: [new TextRun({ text: "■ お申込みプラン", bold: true, size: 24, color: AMBER })],
            spacing: { after: 120 },
          }),
          new Table({
            width: { size: 9000, type: WidthType.DXA },
            columnWidths: [2600, 6400],
            rows: [
              fieldRow("プラン名", "the.chatBOT Zoe"),
              fieldRow("月額料金", "300,000円(税別)"),
              fieldRow("お支払い方法", "クレジットカード決済(月次自動更新)"),
            ],
          }),
          new Paragraph({ text: "", spacing: { after: 320 } }),

          new Paragraph({
            children: [new TextRun({ text: "■ ご確認事項", bold: true, size: 24, color: AMBER })],
            spacing: { after: 140 },
          }),
          new Paragraph({
            children: [new TextRun({
              text: "・決済の際にメールアドレスの入力を求められますが、必ず本申込書のメールアドレスと同じものをご入力ください。一致しない場合、入金確認処理が遅れる可能性がございますので、あらかじめご了承ください。",
              size: 20,
            })],
            spacing: { after: 140 },
          }),
          new Paragraph({
            children: [new TextRun({
              text: "・本申込書の記載内容に基づき、お申込み手続きを進めさせていただきます。内容を変更される場合は、お手数ですが最初からお申込み手続きをやり直していただきますようお願い申し上げます。",
              size: 20,
            })],
            spacing: { after: 140 },
          }),
          new Paragraph({
            children: [new TextRun({
              text: "・お申込み後、1週間以内にご決済いただけない場合、本お申込みは無効となります。あらためてお申込み手続きよりお願いいたします。",
              size: 20,
            })],
            spacing: { after: 420 },
          }),

          new Paragraph({
            border: { top: { style: BorderStyle.SINGLE, size: 4, color: LINEGRAY, space: 8 } },
            children: [new TextRun({ text: "the合同会社", bold: true, size: 20 })],
            spacing: { before: 100, after: 40 },
          }),
          new Paragraph({
            children: [new TextRun({
              text: "〒357-0123 埼玉県飯能市中藤下郷602-6　電話: 050-6881-6160",
              size: 18, color: DARKGRAY,
            })],
          }),
        ],
      },
    ],
  });
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
    const data = req.body || {};
    if (!data.customerName || !data.email) {
      res.status(400).json({ error: "customerNameとemailは必須です" });
      return;
    }

    const doc = buildDocument(data);
    const buffer = await Packer.toBuffer(doc);

    res.status(200).json({
      filename: "the-chatbot-zoe-application.docx",
      fileBase64: buffer.toString("base64"),
    });
  } catch (err) {
    res.status(500).json({ error: "内部エラー: " + err.message });
  }
};
