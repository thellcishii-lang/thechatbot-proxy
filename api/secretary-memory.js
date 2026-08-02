// api/secretary-memory.js (Vercel版)
//
// 秘書Zoe専用の「記憶」を保存・取得する内部専用APIです。
// 保存先はNetlify BlobsからUpstash Redisに切り替え。
//
// キー設計:
//   memory:{path}      → 該当パスの中身(文字列)
//   memory:all_paths   → 保存済みの全パスのSet(list用)

const { kv } = require("@vercel/kv");

function checkSecret(reqBody) {
  return process.env.INTERNAL_FUNCTION_SECRET && reqBody.secret === process.env.INTERNAL_FUNCTION_SECRET;
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

  try {
    const reqBody = req.body || {};
    if (!checkSecret(reqBody)) {
      res.status(401).json({ error: "許可されていません" });
      return;
    }

    if (reqBody.action === "list") {
      const paths = (await kv.smembers("memory:all_paths")) || [];
      const items = [];
      for (const p of paths) {
        const content = await kv.get(`memory:${p}`);
        const firstLine = (content || "").split("\n")[0].slice(0, 80);
        items.push({ path: p, preview: firstLine });
      }
      items.sort((a, b) => (a.path > b.path ? 1 : -1));
      res.status(200).json({ items });
      return;
    }

    if (reqBody.action === "read") {
      if (!reqBody.path) {
        res.status(400).json({ error: "pathが指定されていません" });
        return;
      }
      const content = await kv.get(`memory:${reqBody.path}`);
      if (content === null || content === undefined) {
        res.status(404).json({ error: "そのパスは存在しません" });
        return;
      }
      res.status(200).json({ path: reqBody.path, content });
      return;
    }

    if (reqBody.action === "write") {
      if (!reqBody.path || typeof reqBody.content !== "string") {
        res.status(400).json({ error: "pathとcontentは必須です" });
        return;
      }
      await kv.set(`memory:${reqBody.path}`, reqBody.content);
      await kv.sadd("memory:all_paths", reqBody.path);
      res.status(200).json({ saved: true, path: reqBody.path });
      return;
    }

    if (reqBody.action === "append") {
      if (!reqBody.path || typeof reqBody.content !== "string") {
        res.status(400).json({ error: "pathとcontentは必須です" });
        return;
      }
      const existing = (await kv.get(`memory:${reqBody.path}`)) || "";
      const updated = existing ? existing + "\n" + reqBody.content : reqBody.content;
      await kv.set(`memory:${reqBody.path}`, updated);
      await kv.sadd("memory:all_paths", reqBody.path);
      res.status(200).json({ saved: true, path: reqBody.path });
      return;
    }

    res.status(400).json({ error: "不明なactionです" });
  } catch (err) {
    res.status(500).json({ error: "内部エラー: " + err.message });
  }
};
