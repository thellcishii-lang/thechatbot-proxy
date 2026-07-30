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

async function checkRateLimit(ip, applyBlacklist) {
  try {
    const store = getStore({
      name: "rate-limit-chat",
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_API_TOKEN,
    });

    const SHORT_WINDOW_MS = 5 * 60 * 1000;   // 5分間
    const SHORT_LIMIT = 20;                  // 5分間に20回まで
    const DAY_WINDOW_MS = 24 * 60 * 60 * 1000; // 1日
    const DAY_LIMIT = 50;                    // 1日に50回まで。超えたら永久ブラックリスト入り(applyBlacklistがtrueの場合のみ)

    const now = Date.now();
    const record = (await store.get(ip, { type: "json" })) || {};

    // 一度ブラックリスト入りしたら、期限なくずっと拒否する(ブラックリスト対象の呼び出し元のみ)
    if (applyBlacklist && record.blacklisted) {
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

    // 1日50回を超えたら、恒久的にブラックリスト入り(ブラックリスト対象の呼び出し元のみ)
    const blacklisted = applyBlacklist && dayCount > DAY_LIMIT;

    await store.setJSON(ip, { shortStart, shortCount, dayStart, dayCount, blacklisted: !!(record.blacklisted || blacklisted) });

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
   b. 5項目が揃ったら、聞き取った内容を復唱し、「こちらでよろしいですか?」と確認を求める(この時点ではまだgenerate_applicationは使わない)
   c. 相手が「はい」等、内容に相違ない旨を答えたら、generate_applicationツールで申込書を生成し、チャット内にダウンロードリンクを表示させ、「こちらが申込書になります」と伝える。相手が内容の修正を申し出た場合は、新しい内容で聞き直し、再度bから確認する
   d. 申込書を見せた直後、まずcreate_customerツールで設定用ID・パスワードを発行する。その後send_emailツールで、申込書を添付ファイルとして、「お申込み内容を承りました。申込書を添付いたします。発行いたしましたID・パスワードにて、下記の本申込み用リンクよりお申込み手続きをお願いいたします」という旨・ID・パスワード・設定画面URL(本申込み用リンク)を本人宛に送信する。あなた自身のチャット返信でも、「設定用のメールアドレスに、申込書を添付してお送りしました。発行いたしましたIDとパスワードで、本申込みのリンクよりお手続きください」と伝え、「Zoeのご導入、誠にありがとうございます!お申込みをお待ちしております😊 ご不明な点があればいつでもお声がけください」と締めくくる。この時点では決済リンクはまだ案内しない(決済リンクは、お客様が本申込み画面で正式にお申込みされた後にご案内される)
6. 前向きな意思がまだ明確でない場合(単なる問い合わせ・相談段階)は、会社名・お名前・連絡先(メール)を聞いて、send_emailツールで相談内容のまとめと「担当者より改めてご連絡します」という旨のメールを送るだけに留める(create_customer・generate_applicationは使わない)

# generate_applicationツールについて
- 5項目(会社名・ご担当者名・所在地・メールアドレス・会社URL)がすべて揃い、かつ相手が内容の確認に「よろしい」と答えた後に使う。確認前に使わない
- 生成後はすぐcreate_customer・send_emailに進んでよい(生成後にもう一度「内容にお間違いないですか」と聞き直す必要はない、確認は既に済んでいるため)

# create_customerツールについて
- 明確な導入意思の確認(内容確認・同意)が済んだ段階でのみ使う。単なる問い合わせ段階では絶対に使わない
- 発行されたID・パスワードは、必ずsend_emailツールで本人に送る(チャット画面上には表示しない)

# send_emailツールについて
- メールアドレスを聞き出せた場合のみ使用できる
- 相手の同意なく勝手に送らない。「内容をまとめてメールでお送りしますね」のように一言伝えてから使う
- 件名・本文は丁寧な日本語のビジネスメール調にする
- 本文の冒頭の宛名は、会社名が分かっている場合は必ず「(会社名) (ご担当者名)様」の形にする(ご担当者名だけを書かない)
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

const APPLICATION_PROMPT_TEMPLATE = `あなたは「Zoe(ゾーイ)」という対話型AIで、今は「申込みサポートモード」で動いています。相手はthe.chatBOTへのお申込み手続き中のお客様({{customerName}})で、まだご決済が完了していません。

# 前提
申込み内容の確認と、正式なお申込みの確定は、画面上のボタン操作(「この内容で申し込む」)で既に完結しています。あなたが呼ばれるのは、その後の追加の質問や会話に対応する場面です。

# あなたの役割
1. 決済に関する質問(うまく決済できない、カードの登録方法が分からない等)には丁寧に対応する。ただし、お支払い方法はクレジットカード決済のみであり、他の決済手段には対応していないことを正直に伝える
2. 決済以外の質問(サービス内容の再確認等)がある場合は、「恐れ入りますが、その他のご質問は一度サイトのチャット画面にお戻りいただき、そちらでご相談いただけますでしょうか」と案内する
3. 万が一、まだお申込みが確定していない状態(ボタン操作が済んでいない状態)で話しかけられた場合は、「画面上部にございます内容をご確認のうえ、『この内容で申し込む』ボタンを押してお進みください」と案内する

# トーンと制約
- 丁寧で簡潔な話し方(1回の返信は3〜4文程度)
- お客様に不安を与えないよう、落ち着いたトーンを保つ`;

async function buildApplicationSystemPrompt(customerName){
  const template = await getEffectiveTemplate("Zoe001-application", APPLICATION_PROMPT_TEMPLATE);
  return template.replace(/\{\{customerName\}\}/g, customerName || 'お客様');
}

const APPLICATION_TOOLS = [
  {
    name: "record_submission",
    description: "お客様が申込書の内容を貼り付けて、お申込みを正式に確定させた時に呼ぶ。",
    input_schema: { type: "object", properties: {} },
  },
];

const SETUP_PROMPT_TEMPLATE = `あなたは「Zoe(ゾーイ)」という対話型AIで、今は「設定モード」で動いています。相手はthe.chatBOTを契約したお客様({{customerName}})で、これから自社サイトに設置する本番用chatBOTのFAQを、あなたと一緒に育てていきます。

{{emailNote}}

{{stageStatusNote}}

# 全体像
学習は「ステージ1(必須)」と「ステージ2(任意)」の2段階。ステージ1が終わらないと公開できない。ステージ1完了後、画面にステージ2ボタン・公開ボタンが表示される。

# 初回の挨拶について
これが初めての会話(まだ何もヒアリングしていない状態)の場合は、まず以下の内容を、この通りの順番で丁寧に伝えてから、ステージ1のヒアリング(取扱商品・サービスについて聞く)に入ること。

「この度は、the.chatBOT Zoeを導入頂き誠に有難うございます。御社の事業の力になれますよう、最大限の努力をしてまいりますので、これから末長くよろしくお願い申し上げます。

まずはじめに、公開から運営までの流れをご説明いたします。学習プログラムは主に2つのステージに分類されております。

まず、ステージ1を終了させます。これは必須項目となり、これを終了しないで公開すると御社製品について何もわからない状態になりますので、ステージ1を完了させないと公開できません。ステージ1は実際のチャット訓練をしないで製品の基礎FAQを覚えただけの仕様となり、分からないことが沢山出る可能性があり力不足です。

ステージ2は基礎FAQをベースに、お客様にあらゆる質問を投げかけてきます。そのお客様の回答をベースに学習していく仕組みとなっております。

ステージ1は、お客様の取り扱い製品の数や特異性によっても変わりますが、大体1日から2日で完了出来るイメージです。ステージ2に関しましては、取り扱い商品、特異性で実際どれだけの量になるかは、実際行わないとわかりません。ただ、これはやればやるだけ幅が広がります。質問が重複してきたりこれ以上はとZoeが判断するとここまでで、公開を促します。

公開後も毎月1日にブラッシュアップが行われますので、その時新たな質問などにも答えられるようになります。また、定期ブラッシュアップ以外でも、いつでも任意のタイミングで新たな質問と答えを覚えさせることが可能です。」

その後、続けて「それでは、まず御社の事業内容や商品・サービスについて教えてください」とヒアリングに入る。

## ステージ1: 商品・サービスの理解(必須)
1. まず取扱商品・サービスについて聞く。点数が少なければ会話で、多ければ「販売ページのURL」または「一覧を画像・PDFで送ってもらう」ことを提案する
2. 内容を踏まえて、FAQ(よくある質問と回答)の叩き台を作成し、お客様に提示する
3. お客様が叩き台を精査し、追加・削除・訂正した内容を返してくる
4. 提示された内容の中で、あなたが理解できない/不明な点をリストアップする
   - **不明点が5件以内**: そのままチャットで質問する
   - **不明点が6件以上**: send_questions_fileツールを使い、メールで確認事項リストを送る(内容はチャットに書き出さない)
5. お客様から回答が来たら、再度不明点をチェックする。それでも解決しない不明点が残る場合、同じ基準で再度確認する
6. これを繰り返しても、なお解決しない不明点が一定数(目安5件以上)残る場合は、お客様に「①分かる範囲まで詳しく教えていただき精度を作り直すか」「②今の内容のまま一旦進めて、残りは運用開始後に追加していくか」を選んでもらう
7. **不明点がゼロになった時点で初めて**、「ステージ1はここで終了となりますがよろしいですか?」と確認する。「はい」が得られたら、complete_stage1ツールを呼ぶ。ステージ1は「画面のステージ1ボタンを押す」ことでも開始の合図になるが、実質的な会話の流れ自体はこれと同じ

## ステージ2: 深掘り学習(任意、画面のステージ2ボタンから開始される)
- お客様が「ステージ2を始めたい」と言ったら(画面のボタン経由)、「これよりステージ2を始めます。準備はよろしいですか?」と確認し、「はい」でstart_stage2ツールを呼ぶ
- 開始後は、あなた自身が、優秀な社員に商品知識を叩き込むようなイメージで、お客様の商品・サービスについて次々と質問を投げかける。商品数が多い場合は、商品同士の関連(併売・比較・組み合わせ等)についても踏み込む
- お客様が画面のステージ2ボタンをもう一度押すと、その時点までの内容を保存して中断する(この場合、pause_stage2ツールを呼ぶ。「保存して終了」と伝えるだけでよい)
- 新しい質問が思いつかなくなり、内容が重複してきたら、「これ以上の質問はなさそうです。ステージ2はここで終了となりますがよろしいですか?」と確認し、「はい」が得られたらcomplete_stage2ツールを呼ぶ

## 公開について(画面の公開ボタンから開始される)
- お客様が「公開したい」と言ったら(画面のボタン経由)、現在の状態を踏まえて確認する
  - ステージ1のみ完了(ステージ2は未完了/未実施)の場合:「現在ステージ1のみ完了しております。ステージ2は未完了ですが、本当に公開してもよろしいですか?」
  - ステージ1・2両方完了している場合:「公開しますか?」とだけ聞く
- 「はい」が得られたら、これまでの会話で確定している知識(FAQ)を整理した全文を、publishツールのknowledge引数に渡して呼ぶ(本番チャットのリンクをお伝えするメールが送られる)
- 公開は既に一度行っていても、その後ステージ2で内容を追加した場合は、もう一度公開ボタン→確認→publishツールを実行しないと、本番には反映されない(自動反映はされない旨は聞かれたら伝える)

## FAQ資料の出力
- お客様が「今のFAQを資料でちょうだい」等と言ったら、これまでの会話で確定しているFAQの内容を整理し、export_faqツールにその全文を渡して資料化する

## チャット名・配色の変更
- お客様が「チャット名を変えたい」等と言ったら、希望のチャット名と、背景色(白/黒)×文字色(黒/青/黄/赤/オレンジ/緑、背景と重複しない組み合わせ)を伺い、update_chat_displayツールで保存する

## adminパスワードについて
- お客様が「adminパスワードをください」「テスト用のパスワードが欲しい」等と言ったら、issue_my_admin_passwordツールを呼び、発行されたパスワードを伝える。あわせて「本番チャットのURLの末尾に ?admin=(発行されたパスワード) を付けてアクセスいただくと、テスト目的でのご利用がアクセス制限の集計対象外になります」と説明する

# 調べものについて
- web_searchやweb_fetchツールで、外部の情報を調べることができる。商品登録時に一般的な特徴や競合情報を調べたり、FAQ作成中に業界的によくある質問を補ったりするのに使ってよい
- code_executionツールで、簡単な集計・データ整理もその場で行える

# ファイル添付について
- お客様は画像やPDF(商品リスト、カタログ、マニュアルなど)を直接送ってくることがある。内容をよく読み取り、そこから読み取れる商品名・仕様・価格などを踏まえてFAQの叩き台に反映する
- 添付内容だけでは分からない部分は、遠慮なく質問する

# トーンと制約
- 1回の返信は3〜6文程度に収める
- 専門的すぎる/事業特有すぎる内容は、お客様に確認しながら進める(勝手に決めつけない)
- 業務的だが親しみやすい話し方
- 節目の確認(ステージ1完了、ステージ2完了、公開)は、必ず本人の明確な意思表示を待ってから次に進む`;

async function getEffectiveTemplate(botId, fallbackTemplate) {
  try {
    const data = await callBotConfig({ action: "get", botId });
    if (data.record && data.record.systemPrompt && data.record.systemPrompt.trim()) {
      return data.record.systemPrompt;
    }
  } catch (e) {
    // 取得に失敗した場合は、安全のためコード側のテンプレートを使う
  }
  return fallbackTemplate;
}

async function buildSetupSystemPrompt(customerName, email, stage1Complete, stage2Active, stage2Complete, published){
  const emailNote = email
    ? `お客様の連絡先メールアドレスは ${email} です。send_emailやsend_questions_fileを使う際は、改めて聞き直さずこのアドレス宛に送ってください。`
    : `お客様の連絡先メールアドレスは登録されていません。send_emailやsend_questions_fileを使う前に、必ず会話の中でメールアドレスを確認してください。`;

  const stageStatusNote = `現在の状態: ステージ1=${stage1Complete ? "完了" : "未完了"} / ステージ2=${stage2Complete ? "完了" : (stage2Active ? "実施中" : "未実施")} / 公開=${published ? "公開済み" : "未公開"}`;

  const template = await getEffectiveTemplate("Zoe001-setup", SETUP_PROMPT_TEMPLATE);
  return template
    .replace(/\{\{customerName\}\}/g, customerName || '契約者様')
    .replace(/\{\{emailNote\}\}/g, emailNote)
    .replace(/\{\{stageStatusNote\}\}/g, stageStatusNote);
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

const SETUP_STAGE_TOOLS_EXTRA = [
  {
    name: "complete_stage1",
    description: "不明点がゼロになり、お客様が「はい」と明確に同意した時に呼ぶ。ステージ1を完了扱いにする。",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "start_stage2",
    description: "お客様がステージ2の開始に同意した時に呼ぶ。",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "pause_stage2",
    description: "お客様がステージ2を途中で中断したい時に呼ぶ(内容は保存され、後で再開できる)。",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "complete_stage2",
    description: "重複質問が増え、お客様が終了に同意した時に呼ぶ。ステージ2を完了扱いにする。",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "publish",
    description: "お客様が公開に同意した時に呼ぶ。現在の状態(ステージ1のみ/ステージ1+2)を問わず、公開済みかどうかに関わらず、呼ばれるたびに公開(または再公開)処理を行う。これまでの会話で確定している知識(FAQ)の全文を、本番チャットで使う内容としてそのまま渡すこと。",
    input_schema: {
      type: "object",
      properties: {
        knowledge: { type: "string", description: "本番チャットで使う、確定済みのFAQ・受け答え知識の全文" },
      },
      required: ["knowledge"],
    },
  },
  {
    name: "export_faq",
    description: "お客様が現在のFAQを資料として欲しいと言った時に使う。これまでの会話で確定しているFAQの内容を整理した全文を渡すこと。",
    input_schema: {
      type: "object",
      properties: { content: { type: "string", description: "資料化するFAQの全文(見出しには■を使う)" } },
      required: ["content"],
    },
  },
  {
    name: "update_chat_display",
    description: "お客様がチャット名・配色を変更したい時に使う。",
    input_schema: {
      type: "object",
      properties: {
        displayName: { type: "string", description: "新しいチャット名" },
        bgColor: { type: "string", description: "背景色(white/black)" },
        textColor: { type: "string", description: "文字色(black/blue/yellow/red/orange/green)" },
      },
      required: ["displayName", "bgColor", "textColor"],
    },
  },
  {
    name: "issue_my_admin_password",
    description: "お客様が「adminパスワードをください」「テスト用のパスワードが欲しい」等と言った場合に使う。ご自身の本番チャットをテストする際、アクセス制限にかからないようにするための合言葉を発行する。",
    input_schema: { type: "object", properties: {} },
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
1. 「Zoe001教育モード」のように言われたら、get_bot_configツールでそのbotIdの現在のシステムプロンプトを取得し、内容を要約して見せる。その後、運営者との会話の中で、どう変更したいかをヒアリングし、変更後の完全なシステムプロンプト案を組み立てていく。「今のままで良い」「変更なし」と言われた場合は、必ずconfirm_no_changeツールを使うこと(set_bot_configで全文を書き直す必要はなく、そちらの方が速く確実)。管理対象のbotIdは「Zoe001」(受付Zoe)だけでなく、「Zoe001-setup」(設定Zoe)、「Zoe001-application」(申込みZoe)も含む。「設定Zoeの〇〇はどうなってる?」のように聞かれたら、Zoe001-setupのことだと理解して対応する
1a. これらのプロンプトには、会社名やお客様の状況など、その場で変わる部分に{{customerName}}のような二重中括弧の目印(プレースホルダー)が使われている。編集する際は、この目印を絶対に消したり書き換えたりせず、そのまま残すこと。運営者が「会社名の後にお客様と付けて」のような指示をした場合も、目印自体はそのまま残しつつ、その前後の文言だけを調整する
2. 「Zoe001教育モード終了」と言われたら、「保存しますか?」と確認する。「保存」と言われたら、それまでの会話で合意した完全なシステムプロンプトの内容で、set_bot_configツールを呼んで保存する。保存しない場合は、そのまま変更を破棄して通常モードに戻る
3. 「管理Zoe登録」と言われたら、割り当てたいリポジトリ名を尋ね、register_botツールで次の空き番号(Zoe002等)を発行する
4. 6桁のお客様IDを伝えられたら、get_customer_infoツールでそのお客様の情報(会社名・連絡先・ステータス・支払い状況等)を取得して分かりやすく伝える
5. 「(6桁ID)を停止して」「再開して」と言われたら、set_customer_suspendedツールで停止/再開を行う
6. list_botsツールで、登録済みのZoe一覧を確認できる
7. 「お客様一覧」「6桁IDを取った人の一覧」のように言われたら、list_customersツールで全顧客(会社名・ステータス・支払い状況等)の一覧を取得して分かりやすく伝える
8. 「アクセス数」「チャットに入ってきた数」「今日の実績」のように言われたら、get_analyticsツールで指定されたbotId(未指定ならZoe001)・日付(未指定なら今日)のサイトアクセス数・チャット開始数を取得して伝える
9. 運営者がコード側の初期設定を直接更新した後、「Zoe001をリセットして」のように言われたら、reset_bot_configツールで保存済みの設定を削除し、コード側の最新デフォルトに戻す
10. 「(6桁ID)を削除して」と言われたら、必ず「本当に削除してよろしいですか?元に戻せません」と一度確認してから、delete_customerツールで削除する
11. 「お客様リストをリセットして」「全部削除して」のように言われたら、必ず「登録済みの全顧客データを削除しますが、本当によろしいですか?元に戻せません」と明確に確認し、同意が得られてからreset_customer_listツールを使う
12. 運営者が「サイトのチャットもブロック解除して」「自分のIPのブロックを解除して」のように言ったら、unblock_this_ipツールで、今話しかけている運営者自身のIPアドレスにかかったzoe-chat等の公開チャット向けのブロックを解除する
12. web_searchツールで、外部サイトの情報を調べることができる。競合調査や最新情報の確認等に使ってよい
13. 画像やPDFが送られてきた場合、その内容を読み取って回答に活かす
14. お客様一覧やアクセス数などのデータを見せる時は、読みやすいMarkdownの表(| 列 | 列 |の形式)で出すこと。生のJSONをそのまま貼り付けない
15. code_executionツールで、集計・計算・簡単なデータ処理をその場で行える
16. 記憶(メモ)機能を持っている。会話の最初に見せられる一覧(下記)を踏まえ、重要な話が出たら聞かれなくても適切なファイルに書き留めてよい。「〇〇フォルダ作って、これ入れておいて」と言われたらmemory_write/memory_appendで保存し、「〇〇フォルダ見せて」と言われたらmemory_readで中身を見せる。ファイルパスは/areas/〇〇.mdのような形式にする

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
    description: "指定したbotIdの新しいシステムプロンプトを保存する。運営者との会話で合意した完全な内容を渡すこと。何も変更がない場合は、これではなくconfirm_no_changeツールを使うこと(処理が速く済むため)。",
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
    name: "confirm_no_change",
    description: "運営者が「今のままで良い」「変更なし」と言った場合に使う。get_bot_configで取得済みの現在の内容を、書き直すことなくそのまま保存する(高速)。",
    input_schema: {
      type: "object",
      properties: {
        botId: { type: "string", description: "例: Zoe001" },
      },
      required: ["botId"],
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
  {
    name: "list_customers",
    description: "登録済みの全顧客(申込み・資料請求問わず)の一覧を取得する。会社名・ステータス・支払い状況などが分かる。「6桁IDを取った人の一覧」「お客様一覧」等と言われたら使う。",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_analytics",
    description: "指定したbotId(例: Zoe001)の、指定した日(省略時は今日)のサイトアクセス数・チャット開始数を取得する。「アクセス数」「チャットに入ってきた数」等と言われたら使う。",
    input_schema: {
      type: "object",
      properties: {
        botId: { type: "string", description: "例: Zoe001。省略時はZoe001" },
        date: { type: "string", description: "YYYY-MM-DD形式。省略時は今日(日本時間)" },
      },
    },
  },
  {
    name: "reset_bot_config",
    description: "指定したbotIdの保存済みシステムプロンプトを削除し、コード側の最新デフォルト設定に戻す。運営者がコードを直接更新した後、「Zoe001をリセットして」「コードの最新版に戻して」等と言われたら使う。",
    input_schema: {
      type: "object",
      properties: { botId: { type: "string", description: "例: Zoe001" } },
      required: ["botId"],
    },
  },
  {
    name: "delete_customer",
    description: "指定した6桁IDの顧客データを1件削除する。テストデータの整理等に使う。破壊的な操作なので、必ず運営者に確認を取ってから使うこと。",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "削除する6桁ID" } },
      required: ["id"],
    },
  },
  {
    name: "reset_customer_list",
    description: "登録済みの全顧客データを一括削除する(テストデータの全リセット用)。非常に破壊的な操作なので、「本当に全部削除して良いですか?」と必ず明確な確認を取ってから使うこと。",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "unblock_this_ip",
    description: "運営者が「サイトのチャットもブロック解除して」「自分のIPのブロックを解除して」等と言った場合に使う。今この会話をしている運営者自身のIPアドレスにかかった、zoe-chat等の公開チャット向けのブロック(ブラックリスト)を解除する。",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "issue_admin_password",
    description: "運営者が「(botIdまたは6桁ID)のadminパスワード発行して」と言った場合に使う。発行されたパスワードでチャットURLに?admin=パスワードを付けてアクセスすると、そのアクセスはブラックリスト集計の対象外になる。targetがZoeで始まる場合はbot(受付Zoe等)、6桁の数字の場合はお客様のIDとして扱う。",
    input_schema: {
      type: "object",
      properties: { target: { type: "string", description: "例: Zoe001、または6桁のお客様ID" } },
      required: ["target"],
    },
  },
  {
    name: "memory_list",
    description: "保存されている記憶(メモ)のファイル一覧を取得する。会話の最初に自動で見せているが、必要なら随時呼び出してよい。",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "memory_read",
    description: "指定したパスの記憶(メモ)の中身を読む。",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "例: /areas/秘書Zoe改善.md" } },
      required: ["path"],
    },
  },
  {
    name: "memory_write",
    description: "指定したパスに、記憶(メモ)を新規作成、または全文を書き換えて保存する。",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "例: /areas/秘書Zoe改善.md" },
        content: { type: "string", description: "保存する内容(全文)" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "memory_append",
    description: "指定したパスの記憶(メモ)の末尾に、新しい内容を追記する。ファイルがまだ無ければ新規作成する。",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "例: /areas/秘書Zoe改善.md" },
        content: { type: "string", description: "追記する内容" },
      },
      required: ["path", "content"],
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

async function getEffectiveBotPrompt(botId) {
  const data = await callBotConfig({ action: "get", botId });
  if (data.record && data.record.systemPrompt && data.record.systemPrompt.trim()) {
    return data.record.systemPrompt;
  }
  if (botId === "Zoe001") {
    return SALES_SYSTEM_PROMPT;
  }
  if (botId === "Zoe001-setup") {
    return SETUP_PROMPT_TEMPLATE;
  }
  if (botId === "Zoe001-application") {
    return APPLICATION_PROMPT_TEMPLATE;
  }
  return null;
}

async function callTrackEvent(body) {
  const res = await fetch("https://chatbot-proxy.netlify.app/.netlify/functions/track-event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, secret: process.env.INTERNAL_FUNCTION_SECRET }),
  });
  return await res.json();
}

async function callSecretaryMemory(body) {
  const res = await fetch("https://chatbot-proxy.netlify.app/.netlify/functions/secretary-memory", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, secret: process.env.INTERNAL_FUNCTION_SECRET }),
  });
  return await res.json();
}

async function executeSecretaryTool(name, input, requesterIp) {
  try {
    if (name === "get_bot_config") {
      const prompt = await getEffectiveBotPrompt(input.botId);
      if (prompt === null) {
        return JSON.stringify({ record: { botId: input.botId, systemPrompt: "", note: "未登録またはまだ何も設定されていません" } });
      }
      const isDefault = ["Zoe001", "Zoe001-setup", "Zoe001-application"].includes(input.botId) && prompt === (input.botId === "Zoe001" ? SALES_SYSTEM_PROMPT : (input.botId === "Zoe001-setup" ? SETUP_PROMPT_TEMPLATE : APPLICATION_PROMPT_TEMPLATE));
      return JSON.stringify({
        record: { botId: input.botId, systemPrompt: prompt },
        note: isDefault ? "これは現在実際に動いている初期設定です(まだ秘書Zoe経由では編集されていません)" : undefined,
      });
    }
    if (name === "set_bot_config") {
      const data = await callBotConfig({ action: "set", botId: input.botId, systemPrompt: input.systemPrompt });
      return data.saved ? `${input.botId} の設定を保存しました。` : "保存に失敗しました: " + (data.error || "不明なエラー");
    }
    if (name === "confirm_no_change") {
      const prompt = await getEffectiveBotPrompt(input.botId);
      if (prompt === null) {
        return "現在の内容が取得できませんでした。先にget_bot_configで内容を確認してください。";
      }
      const data = await callBotConfig({ action: "set", botId: input.botId, systemPrompt: prompt });
      return data.saved ? `${input.botId} を変更なしでそのまま保存しました。` : "保存に失敗しました: " + (data.error || "不明なエラー");
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
    if (name === "list_customers") {
      const data = await callCustomerAdmin({ action: "adminList" });
      return JSON.stringify(data);
    }
    if (name === "get_analytics") {
      const data = await callTrackEvent({ action: "get", botId: input.botId, date: input.date });
      return JSON.stringify(data);
    }
    if (name === "reset_bot_config") {
      const data = await callBotConfig({ action: "reset", botId: input.botId });
      return data.reset ? `${input.botId} をコード側の最新デフォルト設定に戻しました。` : "リセットに失敗しました: " + (data.error || "不明なエラー");
    }
    if (name === "delete_customer") {
      const data = await callCustomerAdmin({ action: "adminDelete", id: input.id });
      return data.deleted ? `ID ${data.id} を削除しました。` : "削除に失敗しました: " + (data.error || "不明なエラー");
    }
    if (name === "reset_customer_list") {
      const data = await callCustomerAdmin({ action: "adminDeleteAll", confirm: true });
      return data.deleted ? `${data.count}件の顧客データをすべて削除しました。` : "削除に失敗しました: " + (data.error || "不明なエラー");
    }
    if (name === "unblock_this_ip") {
      try {
        const store = getStore({
          name: "rate-limit-chat",
          siteID: process.env.NETLIFY_SITE_ID,
          token: process.env.NETLIFY_API_TOKEN,
        });
        if (requesterIp) {
          await store.delete(requesterIp);
          return `IPアドレス(${requesterIp})のブロックを解除しました。`;
        }
        return "IPアドレスが取得できなかったため、解除できませんでした。";
      } catch (e) {
        return "解除中にエラーが発生しました: " + e.message;
      }
    }
    if (name === "issue_admin_password") {
      const target = input.target;
      try {
        if (/^\d{6}$/.test(target)) {
          const data = await callCustomerAdmin({ action: "generateAdminPassword", id: target });
          return data.adminPassword
            ? `お客様ID ${target} のadminパスワード: ${data.adminPassword}(URLに ?admin=${data.adminPassword} を付けてアクセスするとブラックリスト対象外になります)`
            : "発行に失敗しました: " + (data.error || "不明なエラー");
        } else {
          const data = await callBotConfig({ action: "generateAdminPassword", botId: target });
          return data.adminPassword
            ? `${target} のadminパスワード: ${data.adminPassword}(URLに ?admin=${data.adminPassword} を付けてアクセスするとブラックリスト対象外になります)`
            : "発行に失敗しました: " + (data.error || "不明なエラー");
        }
      } catch (e) {
        return "発行中にエラーが発生しました: " + e.message;
      }
    }
    if (name === "memory_list") {
      const data = await callSecretaryMemory({ action: "list" });
      return JSON.stringify(data);
    }
    if (name === "memory_read") {
      const data = await callSecretaryMemory({ action: "read", path: input.path });
      return JSON.stringify(data);
    }
    if (name === "memory_write") {
      const data = await callSecretaryMemory({ action: "write", path: input.path, content: input.content });
      return data.saved ? `${input.path} に保存しました。` : "保存に失敗しました: " + (data.error || "不明なエラー");
    }
    if (name === "memory_append") {
      const data = await callSecretaryMemory({ action: "append", path: input.path, content: input.content });
      return data.saved ? `${input.path} に追記しました。` : "追記に失敗しました: " + (data.error || "不明なエラー");
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

function extractImages(contentArray) {
  // コード実行の結果などに含まれるbase64画像を、階層を問わず再帰的に探して集める
  const images = [];
  function walk(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "image" && node.source && node.source.type === "base64" && node.source.data) {
      images.push({ mediaType: node.source.media_type || "image/png", data: node.source.data });
    }
    for (const key of Object.keys(node)) {
      const val = node[key];
      if (Array.isArray(val)) val.forEach(walk);
      else if (val && typeof val === "object") walk(val);
    }
  }
  (contentArray || []).forEach(walk);
  return images;
}

async function runSecretaryAgent(messages, requesterIp) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  let currentMessages = messages.slice();
  const collectedImages = [];

  // 会話の最初に、今どんな記憶(メモ)が保存されているかを取得し、システムプロンプトに含めておく。
  // これにより、聞かれなくても秘書Zoe自身が「このファイルに書けばいい」と判断できるようになる。
  let memoryListingText = "(取得できませんでした)";
  try {
    const listData = await callSecretaryMemory({ action: "list" });
    if (listData.items) {
      memoryListingText = listData.items.length
        ? listData.items.map((it) => `- ${it.path} — ${it.preview}`).join("\n")
        : "(まだ何も保存されていません)";
    }
  } catch (e) {
    // 取得に失敗しても、通常の会話は続行する
  }
  const systemPromptWithMemory = SECRETARY_SYSTEM_PROMPT + `\n\n# 現在保存されている記憶(メモ)一覧\n${memoryListingText}`;

  for (let i = 0; i < 8; i++) { // 無限ループ防止のため上限を設ける
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 1500,
        system: systemPromptWithMemory,
        messages: currentMessages,
        tools: [
          ...SECRETARY_TOOLS,
          { type: "web_search_20260209", name: "web_search" },
          { type: "web_fetch_20260209", name: "web_fetch" },
          { type: "code_execution_20260120", name: "code_execution" },
        ],
      }),
    });
    const data = await response.json();
    if (data.error) return { text: "エラーが発生しました: " + JSON.stringify(data.error), images: [] };

    collectedImages.push(...extractImages(data.content));

    const toolUseBlocks = (data.content || []).filter((b) => b.type === "tool_use");
    if (toolUseBlocks.length > 0) {
      const toolResultBlocks = [];
      for (const block of toolUseBlocks) {
        const toolResultText = await executeSecretaryTool(block.name, block.input, requesterIp);
        toolResultBlocks.push({ type: "tool_result", tool_use_id: block.id, content: toolResultText });
      }
      currentMessages = currentMessages.concat([
        { role: "assistant", content: data.content },
        { role: "user", content: toolResultBlocks },
      ]);
      continue;
    }

    const textBlock = (data.content || []).find((b) => b.type === "text");
    return { text: textBlock ? textBlock.text : "(応答の取得に失敗しました)", images: collectedImages };
  }
  return { text: "処理が複雑すぎたため、途中で打ち切りました。もう一度お試しください。", images: collectedImages };
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

  let requestBody;
  try {
    requestBody = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "リクエストの形式が不正です" }) };
  }

  const clientIp = getClientIp(event);
  // 秘書Zoe(mode:secretary)は、Face ID認証という別の強固な保護があるため、
  // 誰でもアクセスできる公開画面向けのIPレート制限の対象外とする
  if (requestBody.mode !== "secretary") {
    // adminパスワードが渡され、かつ正しく一致する場合は、レート制限自体を丸ごとスキップする
    let adminBypass = false;
    if (requestBody.adminPassword) {
      try {
        if (requestBody.mode === "zoe-chat") {
          const cfg = await callBotConfig({ action: "get", botId: "Zoe001" });
          if (cfg.record && cfg.record.adminPassword && cfg.record.adminPassword === requestBody.adminPassword) {
            adminBypass = true;
          }
        } else if ((requestBody.mode === "zoe-setup" || requestBody.mode === "zoe-application" || requestBody.mode === "zoe-production") && requestBody.id) {
          const cust = await callCustomerAdmin({ action: "adminGet", id: requestBody.id });
          if (cust.record && cust.record.adminPassword && cust.record.adminPassword === requestBody.adminPassword) {
            adminBypass = true;
          }
        }
      } catch (e) {
        // 確認に失敗した場合は、安全側に倒して通常のレート制限を適用する
      }
    }

    if (!adminBypass) {
      // ブラックリスト(1日50回超で永久ブロック)は、ID認証を経ない完全公開の
      // 受付Zoe(zoe-chat)だけに適用する。設定Zoe・申込みZoeは、既にID・パスワードで
      // 認証済みの正規のお客様が使うものなので、誤って締め出さないよう短期の
      // レート制限のみとする
      const applyBlacklist = requestBody.mode === "zoe-chat" || requestBody.mode === "zoe-production";
      const rateLimitResult = await checkRateLimit(clientIp, applyBlacklist);
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
    }
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

    if (requestBody.mode === "secretary") {
      const valid = await isValidAdminSession(requestBody.sessionToken);
      if (!valid) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: "セッションが無効です。再度ログインしてください。" }) };
      }
      const result = await runSecretaryAgent(requestBody.messages || [], clientIp);
      return { statusCode: 200, headers, body: JSON.stringify({ reply: result.text, images: result.images }) };
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
      anthropicRequest.system = await buildSetupSystemPrompt(
        requestBody.customerName,
        requestBody.email,
        requestBody.stage1Complete,
        requestBody.stage2Active,
        requestBody.stage2Complete,
        requestBody.published
      );
      anthropicRequest.tools = [
        ...SETUP_TOOLS,
        ...SETUP_STAGE_TOOLS_EXTRA,
        { type: "web_search_20260209", name: "web_search" },
        { type: "web_fetch_20260209", name: "web_fetch" },
        { type: "code_execution_20260120", name: "code_execution" },
      ];
    } else if (requestBody.mode === "zoe-application") {
      anthropicRequest.system = await buildApplicationSystemPrompt(requestBody.customerName);
      anthropicRequest.tools = APPLICATION_TOOLS;
    } else if (requestBody.mode === "zoe-production") {
      if (!requestBody.id) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "idが指定されていません" }) };
      }
      const cust = await callCustomerAdmin({ action: "adminGet", id: requestBody.id });
      if (!cust.record) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: "そのチャットは見つかりませんでした" }) };
      }
      if (!cust.record.published) {
        return { statusCode: 200, headers, body: JSON.stringify({ content: [{ type: "text", text: "現在、このチャットはご利用いただけません。" }] }) };
      }
      const knowledge = (cust.record.productionKnowledge || "").trim();
      anthropicRequest.system = `あなたは「${cust.record.chatDisplayName || "Zoe"}」という対話型AIです。${cust.record.customerName || "御社"}の窓口として、以下の知識をもとに、お客様からの質問に丁寧に答えてください。\n\n# 知識\n${knowledge || "(まだ知識が登録されていません)"}\n\n# 制約\n- 分からないことは正直に「分かりかねます」と伝え、担当者への確認を案内する\n- 1回の返信は簡潔に(3〜5文程度)`;
      anthropicRequest.tools = [];
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
