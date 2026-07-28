// netlify/functions/generate-application.js
//
// お客様ごとの申込書(.docx)をその場で生成する関数です。
// 会社名・担当者名・所在地・メールアドレス・会社URLを受け取り、
// 雛形に流し込んでWordファイル(base64)として返します。
// フロント側(zoe-chat.html)は、これをBlobに変換してダウンロードリンクとして表示します。

const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, ShadingType, BorderStyle, AlignmentType, VerticalAlign,
} = require("docx");
const { getStore } = require("@netlify/blobs");

function getClientIp(event) {
  return (
    event.headers["x-nf-client-connection-ip"] ||
    (event.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    "unknown"
  );
}

async function checkRateLimit(ip) {
  try {
    const store = getStore({
      name: "rate-limit-generate-application",
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_API_TOKEN,
    });
    const WINDOW_MS = 5 * 60 * 1000;
    const LIMIT = 15;
    const now = Date.now();
    const record = await store.get(ip, { type: "json" });
    if (!record || now - record.windowStart > WINDOW_MS) {
      await store.setJSON(ip, { windowStart: now, count: 1 });
      return true;
    }
    if (record.count >= LIMIT) return false;
    await store.setJSON(ip, { windowStart: record.windowStart, count: record.count + 1 });
    return true;
  } catch (e) {
    return true;
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
    const data = JSON.parse(event.body);
    if (!data.customerName || !data.email) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "customerNameとemailは必須です" }) };
    }

    const doc = buildDocument(data);
    const buffer = await Packer.toBuffer(doc);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        filename: "the-chatbot-zoe-application.docx",
        fileBase64: buffer.toString("base64"),
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "内部エラー: " + err.message }) };
  }
};
