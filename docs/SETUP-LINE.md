# LINE Developers プラットフォーム設定手順

> **LINE Notify について**：LINE Notify は **2025年3月31日にサービス終了**済み。本プロジェクトは後継の **Messaging API**（LINE公式アカウント）を使う構成です。無料プランは月200通のプッシュメッセージ上限があります。

全体の流れは「コンソールでチャネルを作る → AWSにデプロイ → コンソールに戻ってURL登録 → LINEアプリ側で招待」です。コンソールとAWSを往復するので順番に注意してください。

## 登場する画面

| 画面 | URL / 場所 |
|---|---|
| LINE Developersコンソール | https://developers.line.biz/console/ |
| LINE Official Account Manager | https://account.line.biz/ （チャネル作成時に自動で公式アカウントができる） |
| Backlog プロジェクト設定 | スペース → プロジェクト設定 → Webhook |
| AWS コンソール | Bedrock モデルアクセス / SSM / CDKデプロイ |

---

## A. プロバイダーと公式アカウントの作成

> 2026年時点、LINE DevelopersコンソールからMessaging APIチャネルを直接作ることはできません。先にLINE公式アカウントを作り、Official Account ManagerでMessaging APIを有効化します。

1. https://developers.line.biz/console/ を開き、LINEアカウントでログイン
2. **プロバイダー**を作成。**名前に「line」を含めると予約語エラー**になるので注意（例: `backlog-integration`）
3. プロバイダーのページで「Create a Messaging API channel」→「Create a LINE Official Account」から公式アカウント作成フォームへ
   - アカウント名（**「LINE」を含む名前は不可**。例: `Backlog連携bot`）
   - メールアドレス / 業種（個人なら大業種「個人」→ 小業種は任意）/ 運用目的 / 主な使い方
   - LINE公式アカウント利用規約・ビジネスマネージャー利用規約に同意（ビジネスマネージャー組織が自動作成される）
4. Official Account Manager（https://manager.line.biz/）で初回ログイン時の同意画面（情報利用・LINEヤフーグループへの情報提供）に同意
5. 「設定」→「Messaging API」→「Messaging APIを利用する」→ 手順2のプロバイダーを選択（**後から変更不可**）→ API利用規約に同意

### ここで控える値

| 値 | 場所 | SSMパラメータ名 |
|---|---|---|
| チャネルシークレット | OA Manager「Messaging API」画面 / Developersコンソール「Basic settings」 | `/backlog-with-line/line/channel-secret` |

> Messaging APIチャネルの **Channel ID はSSMに入れません**（`line/channel-id` は次のC項のLINE LoginチャネルIDを使う）。

## B. Messaging API設定

1. Developersコンソールの Messaging APIチャネル →「Messaging API」タブ →**チャネルアクセストークン（長期）**を「発行」→ 値を控える
   - SSM: `/backlog-with-line/line/channel-access-token`
2. OA Manager「設定」→「アカウント設定」→**「グループ・複数人トークへの参加を許可する」**（デフォルトは不許可。**忘れるとボットをグループに招待できません**）
3. Webhook URL：デプロイ後に設定（→ F項）

ボットのQRコード・ベーシックIDは「Messaging API」タブにあります（友だち追加用）。

## C. LINE Loginチャネル + LIFF アプリの作成

> **Messaging APIチャネルにはLIFFを追加できません**。同じプロバイダーにLINE Loginチャネルを作り、そこにLIFFを追加します（同じプロバイダーなのでユーザーIDはMessaging APIと一致する）。

1. プロバイダーのページ →「Create a LINE Login channel」
   - Region: Japan / チャネル名（例: `Backlog連携設定`）/ 説明 / App types: **Web app** / メールアドレス
   - LINE Developers Agreement に同意して作成
   - **Channel ID** を控える → SSM: `/backlog-with-line/line/channel-id`（LIFFのIDトークン検証の `client_id` に使う）
2. 「LIFF」タブ →「Add」
   - **LIFFアプリ名**：例 `Backlog連携設定`
   - **Size**：`Full`
   - **Endpoint URL**：`https://<FunctionUrl>/admin`（デプロイ前なら仮URLで作り、H項で差し替え）
   - **Scopes**：**`openid` を必ずチェック**（`liff.getIDToken()` に必須）
   - **Add friend option**：Off
3. 発行された **LIFF ID**（例: `2011951725-AbcdEfgh`）→ SSM: `/backlog-with-line/line/liff-id`
4. チャネル上部の「Developing」→**「Publish」**（開発中のままだとAdmin/テスター以外はLIFFを開けない。公開は取り消せない）

## D. AWS 側（先にここまで終わらせる）

```bash
# Bedrock コンソール(us-west-2) → モデルアクセス → Moonshot Kimi K3 を有効化（初回のみ・数分で反映）
# （xAI Grok 4.6 はアカウントによって開放されないため。使える場合は lib の BEDROCK_MODEL_ID を変更）
# https://us-west-2.console.aws.amazon.com/bedrock/home?region=us-west-2#/modelaccess

cdk bootstrap   # そのアカウント/リージョンで初回のみ

aws ssm put-parameter --name /backlog-with-line/line/channel-secret \
  --type SecureString --value "CHANNEL_SECRET" --overwrite
aws ssm put-parameter --name /backlog-with-line/line/channel-access-token \
  --type SecureString --value "CHANNEL_ACCESS_TOKEN" --overwrite
aws ssm put-parameter --name /backlog-with-line/line/channel-id \
  --type String --value "CHANNEL_ID" --overwrite
aws ssm put-parameter --name /backlog-with-line/line/liff-id \
  --type String --value "LIFF_ID" --overwrite

cdk deploy
```

Outputs の `FunctionUrl`（例: `https://xxxx.lambda-url.us-west-2.on.aws/`）を控える。

> このプロジェクトは **us-west-2** にデプロイする前提です（Bedrock のモデル提供リージョンに合わせた構成）。`cdk bootstrap` も us-west-2 で実行してください。

## E. Backlog側の準備

1. 専用ユーザー「LINE通知bot」等をBacklogに追加し、対象プロジェクトに参加させる
2. そのユーザーで **個人設定 → API → APIキー発行**（読み取り+書き込み権限）
3. APIキーはLIFF設定画面から登録するのでここでは控えておくだけでOK

## F. コンソールに戻る：Webhook URL

1. Messaging APIチャネルの **「Messaging API」タブ →「Webhook settings」**
2. **Webhook URL** に `https://<FunctionUrl>/webhook/line` を入力 → 「更新」
3. 「検証」ボタンで「成功」が出ることを確認（失敗する場合はSSMのchannel-secret未設定 or URL間違い）
4. **「Webhookの利用」をON**

## G. LINE Official Account Manager

https://account.line.biz/ → 対象アカウント → 右上「設定」→「応答設定」：

- **あいさつメッセージ**：OFF（botのjoin挨拶と二重になるため）
- **応答メッセージ**：OFF（Messaging APIに任せるため）
- **Webhook**：ON（Fで設定済みなら自動でONになっているはず）

## H. LIFF エンドポイントの本設定

1. **LINE Loginチャネル**の「LIFF」タブ → 作ったアプリを選択（C項で本番URLを入れていればこの項は不要）
2. **エンドポイントURL** を `https://<FunctionUrl>/admin` に変更（末尾スラッシュなし）
3. 保存

## I. LINE アプリでの動作開始

1. ボットを**友だち追加**（Messaging API設定タブのQRコードから）
2. 対象のLINEグループを開く → 右上メニュー →「招待」→ ボットを選択（友だち追加済みのメンバーなら誰でも招待可。**1グループに入れる公式アカウントは1つまで**）
3. ボットが参加すると挨拶メッセージ＋設定用LIFF URLが投稿される
4. LIFF URLを開いて設定：
   - Backlog スペースURL（`https://xxx.backlog.com`）
   - **Backlog APIキー**（Eで発行したもの → SSM SecureStringとして保存される）
   - プロジェクトキー・課題タイプ・優先度・デフォルト担当者
   - 保存成功すると **Backlog Webhook URL** が表示される
5. Backlogプロジェクト設定 → **Webhook** → 表示されたURL（`https://<FunctionUrl>/webhook/backlog/<token>`）を登録。イベントは「コメント」だけでOK
6. グループで `@bot テストです` → ボタンが出れば完成

## トラブルシュート

| 症状 | 確認先 |
|---|---|
| ボットを招待リストに出せない | 友だち追加済みか / グループ参加許可がONか / 他の公式アカウントが既に入っていないか |
| Webhook「検証」失敗 | Function URLが正しいか / `/webhook/line` パスまで含めたか / channel-secret のSSM登録済みか |
| メンションしても無反応 | Webhook利用ON / 応答メッセージOFF / CloudWatch Logsで署名エラー確認 |
| LIFFが「グループ内で開いてください」 | LIFF URLを**グループトーク内のリンクから**開いたか（外部ブラウザ直開きは不可） |
| LIFFが真っ白・初期化失敗 | エンドポイントURLが `…/admin` と完全一致か（liff.initはエンドポイント以下の階層でのみ動作） |
| 設定保存で「Backlog接続に失敗」 | スペースURL末尾スラッシュ / APIキー権限 / プロジェクトキー大文字 |
| AI整形が応答しない | us-west-2 でモデルアクセス有効化済みか / LambdaのIAMに bedrock:InvokeModel があるか（失敗時は未整形の下書きにフォールバック） |

## SSMパラメータ一覧

| パス | 種別 | どこで取る/入れる |
|---|---|---|
| `/backlog-with-line/line/channel-id` | String | **LINE Loginチャネル**の Basic settings（Messaging APIのIDではない） |
| `/backlog-with-line/line/channel-secret` | SecureString | Messaging APIチャネルの Basic settings |
| `/backlog-with-line/line/channel-access-token` | SecureString | Messaging API設定タブで発行 |
| `/backlog-with-line/line/liff-id` | String | LINE LoginチャネルのLIFFタブで発行 |
| `/backlog-with-line/groups/{groupId}/backlog-api-key` | SecureString | LIFF設定画面から自動登録（手動でも可） |
