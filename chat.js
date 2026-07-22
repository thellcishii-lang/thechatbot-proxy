// netlify/functions/chat.js
//
// このファイルは、ブラウザから直接Claude APIを呼ぶ代わりに、
// このサーバー側の関数を経由させることで、APIキーを外部に一切
// 見せずに済むようにするための「中継役」です。
//
// 使い方:
//   フロント側(chatbot HTML)から fetch する先を
//   "https://api.anthropic.com/v1/messages" ではなく
//   "/.netlify/functions/chat" に変更するだけです。
//   リクエストの中身(system, messages など)はそのまま転送します。

exports.handler = async (event) => {
  // CORS対応(念のため。同一サイト埋め込みなら基本不要)
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "POSTのみ対応しています" }),
    };
  }

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: "サーバー側にANTHROPIC_API_KEYが設定されていません。Netlifyの環境変数設定を確認してください。",
        }),
      };
    }

    const requestBody = JSON.parse(event.body);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: requestBody.model || "claude-sonnet-4-6",
        max_tokens: requestBody.max_tokens || 1000,
        system: requestBody.system,
        messages: requestBody.messages,
      }),
    });

    const data = await response.json();

    return {
      statusCode: response.status,
      headers,
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "プロキシ内部でエラーが発生しました: " + err.message }),
    };
  }
};
