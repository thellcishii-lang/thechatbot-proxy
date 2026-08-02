// api/generate-faq-document.js (Vercel版)
//
// 設定Zoeが「今のFAQを資料として出して」と頼まれた時に使うAPIです。
// 保存先(レート制限)はNetlify BlobsからUpstash Redisに切り替え。ロジック自体は変更ありません。

const {
  Document, Packer, Paragraph, TextRun, BorderStyle, AlignmentType,
} = require("docx");
const { kv } = require("@vercel/kv");

const AMBER = "C9750A";
const DARKGRAY = "333333";

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "unknown";
}

async function checkRateLimit(ip) {
  try {
    const key = `ratelimit:generate-faq:${ip}`;
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
  const withinLimit = await checkRateLimit(clientIp);
  if (!withinLimit) {
    res.status(429).json({ error: "リクエストが多すぎます。しばらくしてから再度お試しください。" });
    return;
  }

  try {
    const { customerName, content } = req.body || {};
    if (typeof content !== "string" || !content.trim()) {
      res.status(400).json({ error: "contentは必須です" });
      return;
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
    res.status(200).json({
      filename: "faq-document.docx",
      fileBase64: buffer.toString("base64"),
    });
  } catch (err) {
    res.status(500).json({ error: "内部エラー: " + err.message });
  }
};
