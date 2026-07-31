// netlify/functions/chat-stream.mjs
//
// chat.js(mode:"zoe-setup")の「資料読み込み・深い調査」のように時間がかかる
// 処理専用の、ストリーミング配信版エンドポイントです。設定Zoe専用です。
// (秘書Zoeはsecretary-stream.mjsという別の独立したファイルを使っています)
//
// 通常のchat.js(classic形式のFunction)は、応答が完成するまで待ってから
// 一括で返す仕組みのため、Netlify Functionsの実行時間上限(標準30秒)に
// 達すると「通信エラー」で切れてしまうことがありました。
//
// このファイルは、Netlify Functions v2のストリーミング形式(ESM +
// Response + ReadableStream)を使い、Claudeからの応答を少しずつ
// クライアントに流し続けます。データが流れ続けている間は「無応答による
// タイムアウト」に該当しないため、資料読み込みや複数回の検索を挟む
// ような時間のかかるやり取りでも、最後まで通信を維持できます。
//
// プロンプト・ツール定義そのものはchat.js側で一元管理しているものを
// そのまま再利用し(chat.jsのexports._internals経由)、ここでは二重管理しません。

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const chatModule = require("./chat.js");
const {
  SETUP_TOOLS,
  SETUP_STAGE_TOOLS_EXTRA,
  buildSetupSystemPrompt,
  checkRateLimit,
  checkIpAbuse,
  recordIpAbuseStrike,
  callCustomerAdmin,
} = chatModule._internals;

// Anthropicのストリーミングイベント(SSE)を読みながら、
// ①テキストのdeltaをそのままcontrollerへ転送しつつ、
// ②content配列(tool_use含む)を組み立てて呼び出し元に返す、共通処理。
// secretaryモードの複数ラウンドloop・zoe-setupモードの単発呼び出し、両方から使う。
async function streamAnthropicCall(anthropicRequestBody, apiKey, controller, encoder) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ ...anthropicRequestBody, stream: true }),
  });
  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => "");
    throw new Error(errText || "Anthropic APIエラー");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const blocks = [];

  function ensureBlock(index, block) {
    if (!blocks[index]) {
      if (block.type === "text") blocks[index] = { type: "text", text: "" };
      else if (block.type === "tool_use") blocks[index] = { type: "tool_use", id: block.id, name: block.name, input: {}, _partialJson: "" };
      else if (block.type === "thinking") blocks[index] = { type: "thinking", thinking: "", signature: "" };
      else blocks[index] = block; // 画像等、テキスト・tool_use・thinking以外のブロックはそのまま保持する
    }
    return blocks[index];
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = rawEvent.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const jsonStr = line.slice(5).trim();
      if (!jsonStr || jsonStr === "[DONE]") continue;
      let evt;
      try {
        evt = JSON.parse(jsonStr);
      } catch (e) {
        continue;
      }

      if (evt.type === "content_block_start") {
        ensureBlock(evt.index, evt.content_block);
      } else if (evt.type === "content_block_delta") {
        const b = blocks[evt.index];
        if (!b) continue;
        if (evt.delta.type === "text_delta") {
          b.text += evt.delta.text;
          // テキストが増えるたびに、その場でクライアントへ転送(見た目上のストリーミング表示用)
          controller.enqueue(encoder.encode(JSON.stringify({ type: "text_delta", text: evt.delta.text }) + "\n"));
        } else if (evt.delta.type === "input_json_delta") {
          b._partialJson += evt.delta.partial_json || "";
        } else if (evt.delta.type === "thinking_delta") {
          b.thinking += evt.delta.thinking || "";
        } else if (evt.delta.type === "signature_delta") {
          b.signature += evt.delta.signature || "";
        }
      } else if (evt.type === "content_block_stop") {
        const b = blocks[evt.index];
        if (b && b.type === "tool_use") {
          try {
            b.input = b._partialJson ? JSON.parse(b._partialJson) : {};
          } catch (e) {
            b.input = {};
          }
          delete b._partialJson;
        }
      }
    }
  }
  return blocks.filter(Boolean);
}

function getClientIp(req) {
  return (
    req.headers.get("x-nf-client-connection-ip") ||
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    "unknown"
  );
}

export default async (req, context) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (req.method === "OPTIONS") {
    return new Response("", { status: 200, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POSTのみ対応しています" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const clientIp = getClientIp(req);

  const isAbuser = await checkIpAbuse(clientIp);
  if (isAbuser) {
    return new Response(
      JSON.stringify({ error: "このIPアドレスは、不審なアクセスが検知されたため利用を制限しています。" }),
      { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const withinLimit = await checkRateLimit(clientIp, false);
  if (!withinLimit.allowed) {
    await recordIpAbuseStrike(clientIp);
    return new Response(JSON.stringify({ error: "リクエストが多すぎます。しばらくしてから再度お試しください。" }), {
      status: 429,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let requestBody;
  try {
    requestBody = await req.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "リクエストの形式が不正です" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "サーバー側にANTHROPIC_API_KEYが設定されていません。" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (requestBody.mode !== "zoe-setup") {
    return new Response(JSON.stringify({ error: "現時点ではmode:'zoe-setup'のみ対応しています(秘書Zoeはsecretary-stream.mjsを使用してください)" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!requestBody.id) {
    return new Response(JSON.stringify({ error: "idが指定されていません" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        const system = await buildSetupSystemPrompt(
          requestBody.customerName,
          requestBody.email,
          requestBody.stage1Complete,
          requestBody.stage2Active,
          requestBody.stage2Complete,
          requestBody.published
        );
        const tools = [
          ...SETUP_TOOLS,
          ...SETUP_STAGE_TOOLS_EXTRA,
          { type: "web_search_20260209", name: "web_search" },
          { type: "web_fetch_20260209", name: "web_fetch" },
          { type: "code_execution_20260120", name: "code_execution" },
        ];
        const content = await streamAnthropicCall(
          { model: "claude-sonnet-4-6", max_tokens: 60000, system, tools, messages: requestBody.messages },
          apiKey, controller, encoder
        );
        controller.enqueue(encoder.encode(JSON.stringify({ type: "final", content }) + "\n"));
      } catch (err) {
        controller.enqueue(encoder.encode(JSON.stringify({ type: "error", error: err.message }) + "\n"));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
};

export const config = {
  path: "/.netlify/functions/chat-stream",
};
