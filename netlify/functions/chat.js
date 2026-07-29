// netlify/functions/chat.js
//
// このファイルは、ブラウザから直接Claude APIを呼ぶ代わりに、
// このサーバー側の関数を経由させることで、APIキーを外部に一切
// 見せずに済むようにするための「中継役」です。
//
// セキュリティ強化(2026年7月28日):
// 従来は system(キャラ設定・営業ロジック)や tools(ツール定義)を
// フロント側からそのまま受け取って転送していたため、ブラウザの開発者
// ツールから中身が丸見えになっていました。
// これを塞ぐため、body.mode === "zoe-chat" が指定された場合は、
// フロントから送られてきた system / tools を無視し、このファイル内に
// 埋め込んだ SALES_SYSTEM_PROMPT / SALES_TOOLS を必ず使用します。
// フロント(zoe-chat.html)は、会話履歴(messages)だけを送ればよく、
// 中身のロジックは一切ブラウザに出ません。
//
// mode が指定されない場合(例: zoe-setup.htmlなど、まだ移行していない
// 画面)は、従来どおり body.system / body.tools をそのまま使う
// 後方互換モードで動作します。今後、他の画面も順次 mode 対応に
// 切り替えていく想定です。
//
// あわせて、誰でもアクセスできるLP埋め込みという性質上、大量メッセージ
// 送信によるAPIコスト消費攻撃を防ぐため、同一IPからのリクエストに
// 簡易レート制限をかけています(5分間に20回まで)。

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
      name: "rate-limit-chat",
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_API_TOKEN,
    });

    const SHORT_WINDOW_MS = 5 * 60 * 1000;   // 5分間
    const SHORT_LIMIT = 20;                  // 5分間に20回まで
    const DAY_WINDOW_MS = 24 * 60 * 60 * 1000; // 1日
    const DAY_LIMIT = 50;                    // 1日に50回まで。超えたら永久ブラックリスト入り

    const now = Date.now();
    const record = (await store.get(ip, { type: "json" })) || {};

    // 一度ブラックリスト入りしたら、期限なくずっと拒否する
    if (record.blacklisted) {
      return { allowed: false, reason: "blacklisted" };
    }

    // 5分間の短期カウンター
    let shortStart = record.shortStart || now;
    let shortCount = record.shortCount || 0;
    if (now - shortStart > SHORT_WINDOW_MS) {
      shortStart = now;
      shortCount = 0;
    }
    shortCount++;

    // 1日の長期カウンター
    let dayStart = record.dayStart || now;
    let dayCount = record.dayCount || 0;
    if (now - dayStart > DAY_WINDOW_MS) {
      dayStart = now;
      dayCount = 0;
    }
    dayCount++;

    // 1日50回を超えたら、恒久的にブラックリスト入り
    const blacklisted = dayCount > DAY_LIMIT;

    await store.setJSON(ip, { shortStart, shortCount, dayStart, dayCount, blacklisted });

    if (blacklisted) return { allowed: false, reason: "blacklisted" };
    if (shortCount > SHORT_LIMIT) return { allowed: false, reason: "rate_limited" };

    return { allowed: true };
  } catch (e) {
    return { allowed: true }; // 判定自体が失敗しても本来の機能は止めない
  }
}

const SALES_SYSTEM_PROMPT = `あなたは「Zoe(ゾーイ)」という、the.chatBOTが開発した対話型AIです。親しみやすく、簡潔に、日本語で会話してください。

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
- お支払い方法はクレジットカード決済のみ(他の決済手段には対応していない)

# 資料請求について
- 「資料が欲しい」「資料を送ってほしい」などと言われたら、まず会社名・ご担当者名・電話番号・メールアドレス・会社URLの5項目をヒアリングする(すでに分かっているものは聞き直さなくてよい)
- 会社URLを聞いたら、必ずverify_urlツール(会社名も一緒に渡す)で実在・会社名との一致を確認する。URLが確認できなかった場合はもう一度URLを伺う。URLは実在するが会社名との一致が確認できなかった場合は、「恐れ入りますが、こちらのURLで間違いございませんでしょうか?」と一言確認し、問題ないと言われればそのまま次に進んでよい
- 5項目が揃い、URLの確認も済んだら、check_lead_emailツールでそのメールアドレスの既存記録がないか確認する
  - 記録が見つからない場合 → そのままupsert_leadツールで新規保存し、send_brochureツールでダウンロードリンクを表示する
  - 記録が見つかり、登録されている会社名が今回聞いた会社名と同じ場合 → そのままupsert_leadツールで保存し、send_brochureツールでダウンロードリンクを表示する
  - 記録が見つかり、登録されている会社名が今回聞いた会社名と異なる場合 → お客様に「このメールアドレスは以前『(見つかった会社名)』としてご登録いただいておりますが、ご記憶にございますか?」と尋ねる
    - 「覚えている」旨の返答の場合 → 「別のメールアドレスをご入力いただくか、以前の記録を今回の内容に更新することもできますが、いかがいたしますか?」と尋ね、別のメールアドレスが来ればそのメールアドレスで再度check_lead_emailからやり直す。更新で良いと言われればupsert_leadツールで更新し、send_brochureツールでダウンロードリンクを表示する
    - 「覚えていない」旨の返答の場合 → 「実は、こちらのメールアドレスで以前もお問い合わせをいただいておりまして、こちらの手違いかもしれませんので、念のため今回の内容で更新させていただきますね」と伝え、upsert_leadツールで更新し、send_brochureツールでダウンロードリンクを表示する
- upsert_lead・check_lead_emailで発行・保持されるIDやパスワードは、いかなる場合もお客様には一切見せない、触れない
- ツールを呼んだ後は「こちらから資料をご覧いただけます」といった一言を添えるだけで大丈夫です
- 資料請求は、会話の早い段階(業種や困りごとがまだ分かっていない段階)で言われても構いません。案内した後は、そのまま自然に会話を続けてください

# あなたの役割(この順番で自然に会話を進める)
1. まず、どんな業種か、今どうやってお客様対応をしているか(電話、メールのみ、他社のチャットボットなど)を聞く
2. 欲しい機能・困っていること(問い合わせ対応の負担、対応時間の制約、クロージングまで任せたいなど)を聞く
3. ヒアリング内容をもとに、Zoeがどう役立てるか具体的に説明する
4. 相手が興味を示したら、料金(月額30万円)を伝える。その際、お支払い方法はクレジットカード決済のみであることも、あわせて一言伝えておく
5. 相手が「導入したい」「申し込みたい」等、はっきりと前向きな意思を示した場合(=クロージング成立)は、以下の順番で進める。
   a. 会社名・ご担当者名・所在地・メールアドレス・会社URLの5項目をヒアリングする(まだ分かっていないものだけ聞けばよい)
   b. 5項目が揃ったら、generate_applicationツールで申込書を生成し、チャット内にダウンロードリンクを表示させる。表示後は「こちらが申込書になります。内容にお間違いがないかご確認いただけますでしょうか?」と確認を求める
   c. 相手が修正を希望した場合は、新しい内容でgenerate_applicationを再度呼び出し、再度確認を求める。相手が「これで大丈夫です」「問題ありません」等、内容に相違ない旨を答えたら次のdへ進む
   d. まずcreate_customerツールで設定用ID・パスワードを発行し、その後send_emailツールで「お申し込みありがとうございます」という旨と、発行されたID・パスワード・設定画面URLを本人宛に送信する。さらに、その直後のあなた自身のチャット返信メッセージの中にも、必ず以下の決済リンクをそのまま貼り付け、「こちらから決済にお進みいただけます」といった一言を添えること。
      決済リンク: https://square.link/u/3x6AttjU
      (このリンクは月額33万円(税込)の固定プラン専用です)
6. 前向きな意思がまだ明確でない場合(単なる問い合わせ・相談段階)は、会社名・お名前・連絡先(メール)を聞いて、send_emailツールで相談内容のまとめと「担当者より改めてご連絡します」という旨のメールを送るだけに留める(create_customer・generate_applicationは使わない)

# generate_applicationツールについて
- 5項目(会社名・ご担当者名・所在地・メールアドレス・会社URL)がすべて揃うまでは使わない
- 生成後は必ず内容の確認を求め、相手が明確に同意するまでcreate_customerには進まない
- 修正があれば、新しい内容で再度このツールを呼び出す(古い内容のまま次に進まない)

# create_customerツールについて
- 明確な導入意思の確認(申込書の内容確認・同意)が済んだ段階でのみ使う。単なる問い合わせ段階では絶対に使わない
- 発行されたID・パスワードは、必ずsend_emailツールで本人に送る(チャット画面上には表示しない)

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

const SALES_TOOLS = [
  {
    name: "verify_url",
    description: "お客様から伺った会社URLが実在するか、また会社名とページ内容が一致しそうかを確認する。資料請求のヒアリングでURLを聞いた後、必ずこれで確認してから次に進む。",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "確認したい会社URL" },
        customerName: { type: "string", description: "お客様が名乗った会社名" },
      },
      required: ["url", "customerName"],
    },
  },
  {
    name: "check_lead_email",
    description: "資料請求のメールアドレスが、既に別の会社名で登録されていないかを確認する。upsert_leadを呼ぶ前に必ず使う。",
    input_schema: {
      type: "object",
      properties: {
        email: { type: "string", description: "確認したいメールアドレス" },
      },
      required: ["email"],
    },
  },
  {
    name: "upsert_lead",
    description: "資料請求の記録を保存する。メールアドレスが既存レコードと一致すればその内容を更新し、なければ新規に社内管理用の記録として作成する(お客様には見せない)。",
    input_schema: {
      type: "object",
      properties: {
        customerName: { type: "string", description: "会社名" },
        contactPerson: { type: "string", description: "ご担当者名" },
        phone: { type: "string", description: "電話番号" },
        email: { type: "string", description: "メールアドレス" },
        companyUrl: { type: "string", description: "会社URL" },
      },
      required: ["customerName", "email"],
    },
  },
  {
    name: "send_brochure",
    description: "訪問者が資料を欲しいと言った場合に使う。会社概要資料(PDF)へのダウンロードリンクをチャット内に表示する。",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "generate_application",
    description: "ヒアリングした会社名・担当者名・所在地・メールアドレス・会社URLをもとに、申込書(Word形式)を生成し、チャット内にダウンロードリンクとして表示する。導入意思が固まり、5項目がすべて揃った段階で使う。内容の修正があった場合は、新しい内容で再度このツールを呼び出す。",
    input_schema: {
      type: "object",
      properties: {
        customerName: { type: "string", description: "会社名" },
        contactPerson: { type: "string", description: "ご担当者名" },
        address: { type: "string", description: "所在地" },
        email: { type: "string", description: "メールアドレス" },
        companyUrl: { type: "string", description: "会社URL" },
      },
      required: ["customerName", "contactPerson", "address", "email", "companyUrl"],
    },
  },
  {
    name: "create_customer",
    description: "クロージング(お客様が導入に前向きな意思を示し、申込書の内容にも同意した)段階で、そのお客様専用の設定用ID・パスワードを発行する。資料請求など未成約の記録にはupsert_leadツールを使い、これは使わない。",
    input_schema: {
      type: "object",
      properties: {
        customerName: { type: "string", description: "会社名" },
        contactPerson: { type: "string", description: "ご担当者名" },
        address: { type: "string", description: "所在地" },
        email: { type: "string", description: "お客様の連絡先メールアドレス(必ず会話の中で確認してから渡すこと)" },
        companyUrl: { type: "string", description: "会社URL" },
      },
      required: ["customerName", "email"],
    },
  },
  {
    name: "send_email",
    description: "訪問者にメールを送信する。クロージング時に申し込み案内を送る、相談内容のまとめを送る、担当者への取り次ぎが必要な場合などに使う。訪問者からメールアドレスを聞き出せた場合のみ使用可能。",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "送信先メールアドレス" },
        subject: { type: "string", description: "件名" },
        text: { type: "string", description: "本文" },
      },
      required: ["to", "subject", "text"],
    },
  },
];

function buildSetupSystemPrompt(customerName, email){
  const emailNote = email
    ? `お客様の連絡先メールアドレスは ${email} です。send_emailやsend_questions_fileを使う際は、改めて聞き直さずこのアドレス宛に送ってください。`
    : `お客様の連絡先メールアドレスは登録されていません。send_emailやsend_questions_fileを使う前に、必ず会話の中でメールアドレスを確認してください。`;

  return `あなたは「Zoe(ゾーイ)」という対話型AIで、今は「設定モード」で動いています。相手はthe.chatBOTを契約したお客様(${customerName || '契約者様'})で、これから自社サイトに設置する本番用chatBOTのFAQを、あなたと一緒に育てていきます。

${emailNote}

# 全体の流れ

## フェーズ1: 商品・サービスの理解
1. まず取扱商品・サービスについて聞く。点数が少なければ会話で、多ければ「販売ページのURL」または「一覧を画像・PDFで送ってもらう」ことを提案する
2. 内容を踏まえて、FAQ(よくある質問と回答)の叩き台を作成し、お客様に提示する
3. お客様が叩き台を精査し、追加・削除・訂正した内容を返してくる

## フェーズ2: 精度を詰める(不明点のエスカレーション)
4. 提示された内容の中で、あなたが理解できない/不明な点をリストアップする
   - **不明点が5件以内**: そのままチャットで質問する
   - **不明点が6件以上**: send_questions_fileツールを使い、メールで確認事項リストを送る(内容はチャットに書き出さない)
5. お客様から回答が来たら、再度不明点をチェックする。それでも解決しない不明点が残る場合、同じ基準(5件以内はチャット、6件以上はファイル)で再度確認する
6. これを繰り返しても、なお解決しない不明点が一定数(目安5件以上)残る場合は、お客様に「① 分かる範囲まで詳しく教えていただき精度を作り直すか」「② 今の内容のまま一旦進めて、残りは運用開始後に追加していくか」を明示的に選んでもらう。この選択は必ず本人にさせ、勝手に決めない

## フェーズ3: 自己問答フェーズ(FAQの拡充)
7. フェーズ2が完了し、FAQがまとまった資料になったら、それを合図に次のフェーズへ移る
8. あなた自身が、お客様の商品・サービスについて想定されるお客様側からの質問を考え、ヒアリング相手(契約者様)に確認しながらFAQを拡充していく
9. 新しい質問が思いつかなくなり、内容が重複してきたら、フェーズ4に進む

## フェーズ4: 運用開始の合意と納品
10. 「大変お疲れ様でした。これ以上は重複した質問が多くなってまいりましたので、まずはこの形でサイトにアップロードし、実際の運用に入れればと思いますが、いかがでしょうか?」と、運用開始してよいか是非を尋ねる
11. 承諾を得たら「承知いたしました。それでは、御社のチャットボットにいのちを吹き込みます」と伝え、サイト埋め込み用のコード・設置手順をメールで送る旨を伝える(実際のメール送信・埋め込みコード発行は現時点では担当者が対応するため、send_emailツールで「担当者より埋め込みコードと設置手順をお送りします」という旨を送信する)
12. 最後に「ここまで大変ご苦労様でした。今後ともよろしくお願い申し上げます。わたくしZoeは、このまま御社のチャットボットコンシェルジュとして、いつでも分からないことや不具合などをお手伝いさせていただきます。どうぞ末長くよろしくお願い申し上げます」と伝えて締めくくる

# ファイル添付について
- お客様は画像やPDF(商品リスト、カタログ、マニュアルなど)を直接送ってくることがある。内容をよく読み取り、そこから読み取れる商品名・仕様・価格などを踏まえてFAQの叩き台に反映する
- 添付内容だけでは分からない部分は、遠慮なく質問する

# トーンと制約
- 1回の返信は3〜6文程度に収める
- 専門的すぎる/事業特有すぎる内容は、お客様に確認しながら進める(勝手に決めつけない)
- 業務的だが親しみやすい話し方
- フェーズの節目(②の選択、④の是非確認)は、必ず本人の明確な意思表示を待ってから次に進む`;
}

const SETUP_TOOLS = [
  {
    name: "send_questions_file",
    description: "お客様への確認事項(不明点)が6件以上ある場合に使う。5件以内ならこのツールは使わず、直接チャットで質問すること。",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "送信先メールアドレス" },
        title: { type: "string", description: "ファイルのタイトル(例:「〇〇株式会社様 確認事項リスト」)" },
        questions: { type: "array", items: { type: "string" }, description: "確認したい項目の一覧" },
      },
      required: ["to", "title", "questions"],
    },
  },
  {
    name: "send_email",
    description: "運用開始の合意ができた後、担当者からの埋め込みコード送付などを案内するメールを送るのに使う。",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "送信先メールアドレス" },
        subject: { type: "string", description: "件名" },
        text: { type: "string", description: "本文" },
      },
      required: ["to", "subject", "text"],
    },
  },
];

// ============================================================
// 秘書Zoe(mode: "secretary")関連
// ============================================================
// 秘書Zoeは全事業の設定を書き換えられる強力な存在のため、ツールの定義・
// 実行ロジックを一切ブラウザに出さず、この関数の中だけで完結させます。
// フロント(zoe-admin.html)は「送ったメッセージ」と「返ってきた返事」の
// やり取りだけを行い、途中のツール呼び出しは一切見えません。

const SECRETARY_SYSTEM_PROMPT = `あなたは「秘書Zoe」です。the合同会社が運営する複数の事業(the.chatBOT=Zoe001、今後追加されるPicoPay等)の設定を、会話だけで管理するための、社内専用のアシスタントです。話し相手は運営者本人だけです。

# できること
1. 「Zoe001教育モード」のように言われたら、get_bot_configツールでそのbotIdの現在のシステムプロンプトを取得し、内容を要約して見せる。その後、運営者との会話の中で、どう変更したいかをヒアリングし、変更後の完全なシステムプロンプト案を組み立てていく。「今のままで良い」「変更なし」と言われた場合は、取得できた現在の内容をそのままset_bot_configに渡すこと(空の内容で保存してはいけない)
2. 「Zoe001教育モード終了」と言われたら、「保存しますか?」と確認する。「保存」と言われたら、それまでの会話で合意した完全なシステムプロンプトの内容で、set_bot_configツールを呼んで保存する。保存しない場合は、そのまま変更を破棄して通常モードに戻る
3. 「管理Zoe登録」と言われたら、割り当てたいリポジトリ名を尋ね、register_botツールで次の空き番号(Zoe002等)を発行する
4. 6桁のお客様IDを伝えられたら、get_customer_infoツールでそのお客様の情報(会社名・連絡先・ステータス・支払い状況等)を取得して分かりやすく伝える
5. 「(6桁ID)を停止して」「再開して」と言われたら、set_customer_suspendedツールで停止/再開を行う
6. list_botsツールで、登録済みのZoe一覧を確認できる

# トーンと制約
- 簡潔で、業務的だが丁寧な話し方
- システムプロンプトを保存する前は、必ず変更内容の要約を見せて確認を取る
- 破壊的な操作(保存、停止)を行う前は、必ず一度確認を挟む
- 会話の内容から、明らかに教育モード中だと分かる場合は、そのまま自然に会話を続けてよい(毎回「教育モードです」と言い直す必要はない)`;

const SECRETARY_TOOLS = [
  {
    name: "get_bot_config",
    description: "指定したbotId(例: Zoe001)の現在のシステムプロンプト・登録情報を取得する。",
    input_schema: {
      type: "object",
      properties: { botId: { type: "string", description: "例: Zoe001" } },
      required: ["botId"],
    },
  },
  {
    name: "set_bot_config",
    description: "指定したbotIdの新しいシステムプロンプトを保存する。運営者との会話で合意した完全な内容を渡すこと。",
    input_schema: {
      type: "object",
      properties: {
        botId: { type: "string", description: "例: Zoe001" },
        systemPrompt: { type: "string", description: "保存する完全なシステムプロンプトの内容" },
      },
      required: ["botId", "systemPrompt"],
    },
  },
  {
    name: "register_bot",
    description: "新しい事業用に、次の空き番号(Zoe002等)を割り当てて登録する。",
    input_schema: {
      type: "object",
      properties: { repoName: { type: "string", description: "割り当てるリポジトリ名・事業名" } },
      required: ["repoName"],
    },
  },
  {
    name: "list_bots",
    description: "登録済みのZoe一覧(botId・割り当て先)を取得する。",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_customer_info",
    description: "6桁IDを指定して、そのお客様の情報(会社名・連絡先・ステータス・支払い状況・停止中かどうか等)を取得する。",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "6桁のお客様ID" } },
      required: ["id"],
    },
  },
  {
    name: "set_customer_suspended",
    description: "6桁IDを指定して、そのお客様のサービスを停止/再開する。",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "6桁のお客様ID" },
        suspended: { type: "boolean", description: "true=停止する、false=再開する" },
      },
      required: ["id", "suspended"],
    },
  },
];

async function callBotConfig(body) {
  const res = await fetch("https://chatbot-proxy.netlify.app/.netlify/functions/bot-config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, secret: process.env.INTERNAL_FUNCTION_SECRET }),
  });
  return await res.json();
}

async function callCustomerAdmin(body) {
  const res = await fetch("https://chatbot-proxy.netlify.app/.netlify/functions/customer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, secret: process.env.INTERNAL_FUNCTION_SECRET }),
  });
  return await res.json();
}

async function executeSecretaryTool(name, input) {
  try {
    if (name === "get_bot_config") {
      const data = await callBotConfig({ action: "get", botId: input.botId });
      // Zoe001はまだbot-configsストアが空でも、実際にはコード内の初期設定(SALES_SYSTEM_PROMPT)で
      // 動いているため、空の場合はその「今動いている実際の内容」を見せる
      if (input.botId === "Zoe001" && (!data.record || !data.record.systemPrompt || !data.record.systemPrompt.trim())) {
        return JSON.stringify({
          record: {
            botId: "Zoe001",
            systemPrompt: SALES_SYSTEM_PROMPT,
            note: "これは現在実際に動いている初期設定です(まだ秘書Zoe経由では編集されていません)",
          },
        });
      }
      return JSON.stringify(data);
    }
    if (name === "set_bot_config") {
      const data = await callBotConfig({ action: "set", botId: input.botId, systemPrompt: input.systemPrompt });
      return data.saved ? `${input.botId} の設定を保存しました。` : "保存に失敗しました: " + (data.error || "不明なエラー");
    }
    if (name === "register_bot") {
      const data = await callBotConfig({ action: "register", repoName: input.repoName });
      return data.botId ? `新しく ${data.botId} を「${input.repoName}」に割り当てました。` : "登録に失敗しました: " + (data.error || "不明なエラー");
    }
    if (name === "list_bots") {
      const data = await callBotConfig({ action: "list" });
      return JSON.stringify(data);
    }
    if (name === "get_customer_info") {
      const data = await callCustomerAdmin({ action: "adminGet", id: input.id });
      return JSON.stringify(data);
    }
    if (name === "set_customer_suspended") {
      const data = await callCustomerAdmin({ action: "adminSetSuspended", id: input.id, suspended: input.suspended });
      return data.id ? `ID ${data.id} を${data.suspended ? "停止" : "再開"}しました。` : "処理に失敗しました: " + (data.error || "不明なエラー");
    }
    return "不明なツールです";
  } catch (e) {
    return "ツール実行中にエラーが発生しました: " + e.message;
  }
}

async function isValidAdminSession(sessionToken) {
  if (!sessionToken) return false;
  try {
    const store = getStore({
      name: "admin-sessions",
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_API_TOKEN,
    });
    const record = await store.get(sessionToken, { type: "json" });
    if (!record) return false;
    return Date.now() < record.expiresAt;
  } catch (e) {
    return false;
  }
}

async function runSecretaryAgent(messages) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  let currentMessages = messages.slice();

  for (let i = 0; i < 8; i++) { // 無限ループ防止のため上限を設ける
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1500,
        system: SECRETARY_SYSTEM_PROMPT,
        messages: currentMessages,
        tools: SECRETARY_TOOLS,
      }),
    });
    const data = await response.json();
    if (data.error) return "エラーが発生しました: " + JSON.stringify(data.error);

    const toolUseBlock = (data.content || []).find((b) => b.type === "tool_use");
    if (toolUseBlock) {
      const toolResultText = await executeSecretaryTool(toolUseBlock.name, toolUseBlock.input);
      currentMessages = currentMessages.concat([
        { role: "assistant", content: data.content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseBlock.id, content: toolResultText }] },
      ]);
      continue;
    }

    const textBlock = (data.content || []).find((b) => b.type === "text");
    return textBlock ? textBlock.text : "(応答の取得に失敗しました)";
  }
  return "処理が複雑すぎたため、途中で打ち切りました。もう一度お試しください。";
}

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

  const clientIp = getClientIp(event);
  const rateLimitResult = await checkRateLimit(clientIp);
  if (!rateLimitResult.allowed) {
    if (rateLimitResult.reason === "blacklisted") {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({ error: "このIPアドレスは、不審なアクセスが検知されたため利用を制限しています。" }),
      };
    }
    return {
      statusCode: 429,
      headers,
      body: JSON.stringify({ error: "リクエストが多すぎます。しばらくしてから再度お試しください。" }),
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

    if (requestBody.mode === "secretary") {
      const valid = await isValidAdminSession(requestBody.sessionToken);
      if (!valid) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: "セッションが無効です。再度ログインしてください。" }) };
      }
      const reply = await runSecretaryAgent(requestBody.messages || []);
      return { statusCode: 200, headers, body: JSON.stringify({ reply }) };
    }

    const anthropicRequest = {
      model: requestBody.model || "claude-sonnet-4-6",
      max_tokens: requestBody.max_tokens || 1000,
      messages: requestBody.messages,
    };

    if (requestBody.mode === "zoe-chat") {
      // フロントから system / tools が送られてきても無視し、必ずサーバー側の内容を使う。
      // 秘書ZoeがZoe001の設定を編集していれば、その内容を優先する(bot-configsストア)。
      // まだ編集されていない(空)場合は、これまで通りの初期設定にフォールバックする。
      let systemPromptToUse = SALES_SYSTEM_PROMPT;
      try {
        const botConfigStore = getStore({
          name: "bot-configs",
          siteID: process.env.NETLIFY_SITE_ID,
          token: process.env.NETLIFY_API_TOKEN,
        });
        const zoe001 = await botConfigStore.get("Zoe001", { type: "json" });
        if (zoe001 && zoe001.systemPrompt && zoe001.systemPrompt.trim()) {
          systemPromptToUse = zoe001.systemPrompt;
        }
      } catch (e) {
        // 取得に失敗した場合は、安全のため初期設定のまま進める
      }
      anthropicRequest.system = systemPromptToUse;
      anthropicRequest.tools = SALES_TOOLS;
    } else if (requestBody.mode === "zoe-setup") {
      // 名前・メールアドレスはお客様本人が既に知っている情報なので受け取って埋め込むが、
      // プロンプトの文面(振る舞いの指示)自体はサーバー側で構築し、フロントには渡さない
      anthropicRequest.system = buildSetupSystemPrompt(requestBody.customerName, requestBody.email);
      anthropicRequest.tools = SETUP_TOOLS;
    } else {
      // 後方互換モード(まだmode対応していない画面用)。今後、他の画面も
      // 同様にサーバー側へロジックを移し、このelse分岐は無くしていく想定
      anthropicRequest.system = requestBody.system;
      if (requestBody.tools) {
        anthropicRequest.tools = requestBody.tools;
      }
    }
    if (requestBody.tool_choice) {
      anthropicRequest.tool_choice = requestBody.tool_choice;
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(anthropicRequest),
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
