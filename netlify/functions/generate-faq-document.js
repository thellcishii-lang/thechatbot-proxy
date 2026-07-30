// netlify/functions/generate-faq-document.js
//
// 設定Zoeが「今のFAQを資料として出して」と頼まれた時に使う関数です。
// Zoe自身がその場でまとめたFAQの内容(テキスト)を受け取り、
// 見やすいWord文書(.docx)にして返します。

const {
  Document, Packer, Paragraph, TextRun, BorderStyle, AlignmentType,
} = require("docx");
const { getStore } = require("@netlify/blobs");

const AMBER = "C9750A";
const DARKGRAY = "333333";

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
      name: "rate-limit-generate-faq",
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
    const { customerName, content } = JSON.parse(event.body);
    if (typeof content !== "string" || !content.trim()) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "contentは必須です" }) };
    }

    const today = new Date();
    const dateStr = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;

    const bodyParagraphs = content.split("\n").map((line) => {
      const isHeading = /^■/.test(line.trim());
      return new Paragraph({
        children: [new TextRun({
          text: line,
          bold: isHeading,
          color: isHeading ? AMBER : undefined,
          size: isHeading ? 24 : 21,
        })],
        spacing: { after: isHeading ? 120 : 100 },
      });
    });

    const doc = new Document({
      sections: [{
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
            children: [new TextRun({ text: `${customerName || "お客様"}向け FAQ資料`, bold: true, size: 32 })],
            spacing: { after: 100 },
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: AMBER, space: 8 } },
          }),
          new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [new TextRun({ text: `出力日: ${dateStr}`, size: 20, color: DARKGRAY })],
            spacing: { after: 300 },
          }),
          ...bodyParagraphs,
        ],
      }],
    });

    const buffer = await Packer.toBuffer(doc);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        filename: "faq-document.docx",
        fileBase64: buffer.toString("base64"),
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "内部エラー: " + err.message }) };
  }
};
