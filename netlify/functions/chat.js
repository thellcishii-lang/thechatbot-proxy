<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Zoe と話す | the.chatBOT</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Shippori+Mincho:wght@500;700&family=JetBrains+Mono:wght@400;500;700&family=Inter:wght@400;500;600;700&display=swap');

  :root{
    --bg:#14120f;
    --panel:#1c1a15;
    --panel-2:#221f19;
    --line:#33301f;
    --text:#e9e4d8;
    --text-dim:#948d78;
    --amber:#ff9524;
    --amber-hot:#ff5c05;
    --amber-dim:rgba(255,149,36,0.14);
  }
  *{box-sizing:border-box;}
  body{
    margin:0;
    background:
      radial-gradient(ellipse 900px 500px at 15% -10%, rgba(255,92,5,0.10), transparent 60%),
      var(--bg);
    color:var(--text);
    font-family:'Inter',sans-serif;
    height:100vh;
    display:flex;
    flex-direction:column;
  }
  header{
    padding:16px 18px;
    border-bottom:1px solid var(--line);
    display:flex;
    align-items:center;
    gap:12px;
    flex-shrink:0;
  }
  .avatar{
    width:38px;height:38px;border-radius:10px;
    background:linear-gradient(135deg, var(--amber), var(--amber-hot));
    display:flex;align-items:center;justify-content:center;
    font-family:'Shippori Mincho',serif;font-weight:700;color:#1a0f00;font-size:16px;
    flex-shrink:0;
  }
  .header-text .name{font-weight:700;font-size:14.5px;font-family:'Shippori Mincho',serif;}
  .header-text .status{font-size:11.5px;color:var(--text-dim);}
  .status .dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#7fbf6a;margin-right:5px;}

  #chatArea{
    flex:1;
    overflow-y:auto;
    padding:18px;
    display:flex;
    flex-direction:column;
    gap:14px;
    max-width:720px;
    width:100%;
    margin:0 auto;
  }
  .msg{
    max-width:82%;
    padding:11px 14px;
    border-radius:14px;
    font-size:14px;
    line-height:1.65;
    white-space:pre-wrap;
  }
  .msg.bot{
    background:var(--panel);
    border:1px solid var(--line);
    align-self:flex-start;
    border-bottom-left-radius:4px;
  }
  .msg.user{
    background:linear-gradient(135deg, var(--amber-dim), rgba(255,92,5,0.18));
    border:1px solid var(--amber);
    color:var(--text);
    align-self:flex-end;
    border-bottom-right-radius:4px;
  }
  .msg.typing{
    background:var(--panel);
    border:1px solid var(--line);
    align-self:flex-start;
    border-bottom-left-radius:4px;
    display:flex;
    gap:4px;
    padding:14px 16px;
  }
  .typing .d{
    width:6px;height:6px;border-radius:50%;background:var(--text-dim);
    animation:bounce 1.2s infinite ease-in-out;
  }
  .typing .d:nth-child(2){animation-delay:0.15s;}
  .typing .d:nth-child(3){animation-delay:0.3s;}
  @keyframes bounce{0%,60%,100%{transform:translateY(0);opacity:0.5;}30%{transform:translateY(-4px);opacity:1;}}

  .quick-replies{
    display:flex;
    flex-wrap:wrap;
    gap:8px;
    padding:0 18px 14px;
    max-width:720px;
    width:100%;
    margin:0 auto;
    flex-shrink:0;
  }
  .quick-reply{
    background:var(--panel-2);
    border:1px solid var(--line);
    color:var(--text);
    padding:8px 14px;
    border-radius:20px;
    font-size:13px;
    cursor:pointer;
    touch-action:manipulation;
  }
  .quick-reply:active{border-color:var(--amber);color:var(--amber);}

  #inputArea{
    display:flex;
    gap:10px;
    padding:14px 18px;
    border-top:1px solid var(--line);
    flex-shrink:0;
    background:var(--bg);
    max-width:720px;
    width:100%;
    margin:0 auto;
    box-sizing:border-box;
  }
  #userInput{
    flex:1;
    background:var(--panel-2);
    border:1px solid var(--line);
    color:var(--text);
    padding:12px 14px;
    border-radius:10px;
    font-family:'Inter',sans-serif;
    font-size:14.5px;
    outline:none;
    resize:none;
  }
  #userInput:focus{border-color:var(--amber);}
  #sendBtn{
    background:linear-gradient(135deg, var(--amber), var(--amber-hot));
    color:#1a0f00;
    border:none;
    border-radius:10px;
    padding:0 20px;
    font-weight:700;
    font-size:14px;
    cursor:pointer;
    touch-action:manipulation;
    flex-shrink:0;
  }
  #sendBtn:disabled{opacity:0.5;}
</style>
</head>
<body>

<header>
  <div class="avatar">Z</div>
  <div class="header-text">
    <div class="name">Zoe</div>
    <div class="status"><span class="dot"></span>オンライン</div>
  </div>
</header>

<div id="chatArea"></div>
<div class="quick-replies" id="quickReplies"></div>

<div id="inputArea">
  <textarea id="userInput" rows="1" placeholder="メッセージを入力..."></textarea>
  <button id="sendBtn">送信</button>
</div>

<script>
const SYSTEM_PROMPT = `あなたは「Zoe(ゾーイ)」という、the.chatBOTが開発した対話型AIです。親しみやすく、簡潔に、日本語で会話してください。

# あなた(Zoe)について
- 名前の由来:ギリシャ語で「生命・命・生きること」を意味する
- 御社の経営に新しいいのちを吹き込む存在、というコンセプト
- 問い合わせ対応やカスタマーサービスから、クロージングまでを一貫してこなせる対話AI
- 24時間365日休まず対応し、社会保険やボーナスは不要
- 1台で10人分の作業を同時にこなせる
- 「以下からお選びください」で終わる旧来の選択肢メニュー型チャットボットとは違い、曖昧な質問には聞き返しながら、本当に知りたいことへ寄り添う

# 料金
- Zoe 1台: 月額300,000円(税別)
- 問い合わせ〜クロージングまで一貫対応
- メール送信機能を搭載しており、仕組み化すればクロージングまでZoeが担当することも可能

# あなたの役割(この順番で自然に会話を進める)
1. まず、どんな業種か、今どうやってお客様対応をしているか(電話、メールのみ、他社のチャットボットなど)を聞く
2. 欲しい機能・困っていること(問い合わせ対応の負担、対応時間の制約、クロージングまで任せたいなど)を聞く
3. ヒアリング内容をもとに、Zoeがどう役立てるか具体的に説明する
4. 相手が興味を示したら、料金(月額30万円)を伝える
5. 最後に、会社名・お名前・連絡先(メール)を聞く。メールアドレスを教えてもらえたら、send_emailツールを使って、相談内容のまとめと「担当者より改めてご連絡します」という旨のメールを本人宛に送信する

# send_emailツールについて
- メールアドレスを聞き出せた場合のみ使用できる
- 相手の同意なく勝手に送らない。「内容をまとめてメールでお送りしますね」のように一言伝えてから使う
- 件名・本文は丁寧な日本語のビジネスメール調にする
- 送信後は「送信しました」の確認を待たず、そのまま自然に会話を締めくくって良い

# トーンと制約
- 1回の返信は3〜5文程度に収め、長々と説明しすぎない
- 押し売り感を出さない。相手のペースに合わせる
- 具体的な料金や機能の話は、上記の情報の範囲内で答える。分からないことを聞かれたら「詳細は担当者からご連絡します」と正直に答える
- 会話の早い段階では料金を提示しない。最低限、相手の状況と困りごとが分かってから提示する
- 抽象的・曖昧な質問には、いきなり分からないと返さず、聞き返して意図を掘り下げる
- 世間話や雑談程度の脱線には短く自然に相槌を打って良い。ただし、サービスと全く関係のない話題が続く場合は、冷たく拒否せず「そのあたりは私では詳しくお答えできないので」と一言添えたうえで、自然に本題へ話を戻す
- 連絡先を受け取ったら、丁寧にお礼を言って会話を締めくくる`;

let conversationHistory = [];
let isWaitingForResponse = false;

const chatArea = document.getElementById('chatArea');
const userInput = document.getElementById('userInput');
const sendBtn = document.getElementById('sendBtn');
const quickRepliesEl = document.getElementById('quickReplies');

function addMessage(role, text){
  const div = document.createElement('div');
  div.className = 'msg ' + (role === 'user' ? 'user' : 'bot');
  div.textContent = text;
  chatArea.appendChild(div);
  chatArea.scrollTop = chatArea.scrollHeight;
  return div;
}

function showTyping(){
  const div = document.createElement('div');
  div.className = 'msg typing';
  div.id = 'typingIndicator';
  div.innerHTML = '<div class="d"></div><div class="d"></div><div class="d"></div>';
  chatArea.appendChild(div);
  chatArea.scrollTop = chatArea.scrollHeight;
}

function hideTyping(){
  const el = document.getElementById('typingIndicator');
  if(el) el.remove();
}

function setQuickReplies(options){
  quickRepliesEl.innerHTML = '';
  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'quick-reply';
    btn.textContent = opt;
    btn.addEventListener('click', () => {
      quickRepliesEl.innerHTML = '';
      sendMessage(opt);
    });
    quickRepliesEl.appendChild(btn);
  });
}

const EMAIL_TOOL = {
  name: "send_email",
  description: "訪問者にメールを送信する。クロージング時に申し込み案内を送る、相談内容のまとめを送る、担当者への取り次ぎが必要な場合などに使う。訪問者からメールアドレスを聞き出せた場合のみ使用可能。",
  input_schema: {
    type: "object",
    properties: {
      to: { type: "string", description: "送信先メールアドレス" },
      subject: { type: "string", description: "件名" },
      text: { type: "string", description: "本文" }
    },
    required: ["to", "subject", "text"]
  }
};

async function sendEmailTool(input){
  try{
    const res = await fetch("https://chatbot-proxy.netlify.app/.netlify/functions/send-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    });
    const data = await res.json();
    if(res.ok && data.success){
      return "送信成功しました。";
    }
    return "送信に失敗しました: " + (data.error || "不明なエラー");
  }catch(e){
    return "送信中にエラーが発生しました: " + e.message;
  }
}

async function callZoe(messages){
  let currentMessages = messages.slice();

  while(true){
    const response = await fetch("https://chatbot-proxy.netlify.app/.netlify/functions/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        messages: currentMessages,
        tools: [EMAIL_TOOL]
      })
    });
    const data = await response.json();

    const toolUseBlock = data.content.find(b => b.type === 'tool_use');
    if(toolUseBlock){
      // Zoeがメール送信を要求してきた場合、実行してから会話を続ける
      const toolResultText = await sendEmailTool(toolUseBlock.input);
      currentMessages = currentMessages.concat([
        { role: 'assistant', content: data.content },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseBlock.id, content: toolResultText }] }
      ]);
      continue; // もう一度Zoeに問い合わせて、最終的な返信テキストを得る
    }

    const textBlock = data.content.find(b => b.type === 'text');
    return { text: textBlock ? textBlock.text : '(応答の取得に失敗しました)', finalMessages: currentMessages };
  }
}

async function sendMessage(text){
  if(!text || isWaitingForResponse) return;
  isWaitingForResponse = true;
  sendBtn.disabled = true;
  quickRepliesEl.innerHTML = '';

  addMessage('user', text);
  conversationHistory.push({role:'user', content: text});
  userInput.value = '';
  autoResize();

  showTyping();
  try{
    const result = await callZoe(conversationHistory);
    hideTyping();
    addMessage('bot', result.text);
    conversationHistory = result.finalMessages.concat([{role:'assistant', content: result.text}]);
  }catch(e){
    hideTyping();
    addMessage('bot', 'すみません、通信エラーが発生しました。もう一度お試しいただくか、フォームからお問い合わせください。');
  }
  isWaitingForResponse = false;
  sendBtn.disabled = false;
}

function autoResize(){
  userInput.style.height = 'auto';
  userInput.style.height = Math.min(userInput.scrollHeight, 120) + 'px';
}

userInput.addEventListener('input', autoResize);
userInput.addEventListener('keydown', function(e){
  if(e.key === 'Enter' && !e.shiftKey){
    e.preventDefault();
    sendMessage(userInput.value.trim());
  }
});
sendBtn.addEventListener('click', () => sendMessage(userInput.value.trim()));

// URLパラメータ(会社名・担当者名・業種・メール・相談内容)を読み取り、入力があればZoeの最初の挨拶に活かす
const urlParams = new URLSearchParams(window.location.search);
const prefillCompany = urlParams.get('company');
const prefillPerson = urlParams.get('person');
const prefillIndustry = urlParams.get('industry');
const prefillEmail = urlParams.get('email');
const prefillMsg = urlParams.get('msg');

function buildOpening(){
  if(prefillCompany || prefillPerson || prefillIndustry || prefillEmail || prefillMsg){
    let contextLine = '事前情報 — ';
    if(prefillCompany) contextLine += `会社名: ${prefillCompany}　`;
    if(prefillPerson) contextLine += `ご担当者様名: ${prefillPerson}　`;
    if(prefillIndustry) contextLine += `業種: ${prefillIndustry}　`;
    if(prefillEmail) contextLine += `連絡先: ${prefillEmail}　`;
    if(prefillMsg) contextLine += `相談内容: ${prefillMsg}`;
    contextLine += '\n\n上記の情報を踏まえて、挨拶と最初の質問をしてください。会社名とご担当者様名が分かる場合は「(会社名)の(お名前)様」のように呼びかけてください。';
    conversationHistory.push({role:'user', content: contextLine});
    return true;
  }
  return false;
}

// Opening message
if(buildOpening()){
  (async () => {
    showTyping();
    try{
      const result = await callZoe(conversationHistory);
      hideTyping();
      addMessage('bot', result.text);
      conversationHistory = result.finalMessages.concat([{role:'assistant', content: result.text}]);
    }catch(e){
      hideTyping();
      addMessage('bot', 'こんにちは、Zoeです。御社の業務について、簡単にお話を伺えればと思います。まず、どんなお仕事をされてますか?');
      setQuickReplies(['美容・サロン系', '製造・卸・物販系', 'その他の業種']);
    }
  })();
} else {
  addMessage('bot', 'こんにちは、Zoeです。御社の業務について、簡単にお話を伺えればと思います。まず、どんなお仕事をされてますか?');
  setQuickReplies(['美容・サロン系', '製造・卸・物販系', 'その他の業種']);
}
</script>
</body>
</html>
