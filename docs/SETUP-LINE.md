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

## A. プロバイダーとチャネルの作成

1. https://developers.line.biz/console/ を開き、LINEアカウントでログイン
2. **プロバイダー**を作成（なければ）。名前は自由（例: `personal-dev`）
3. プロバイダーのページで **「新規チャネル作成」→「Messaging API」** を選択
4. 入力して作成：
   - チャネル名（例: `backlog-with-line`）
   - チャネル説明
   - 大業種・小業種（個人利用なら「個人」系で可）
   - メールアドレス
   - プライバシーポリシーURL・利用規約URLは任意
5. 作成直後に表示される利用規約に同意

### ここで控える値

チャネルページの **「チャネル基本設定」タブ**：

| 値 | 場所 | SSMパラメータ名 |
|---|---|---|
| チャネルID | 上部の基本情報欄 | `/backlog-with-line/line/channel-id` |
| チャネルシークレット | 基本情報欄（表示ボタン） | `/backlog-with-line/line/channel-secret` |

## B. Messaging API設定タブ

チャネルページの **「Messaging API設定」タブ** で以下を実施：

1. **チャネルアクセストークン**：「チャネルアクセストークン（長期）」→「発行」→ 有効期限を選んで発行 → 値を控える
   - SSM: `/backlog-with-line/line/channel-access-token`
2. **「グループトーク・複数人トークへの参加を許可する」をON**（デフォルトOFF。**これを忘れるとボットをグループに招待できません**）
3. **Webhook URL**：デプロイ後に戻ってきて設定（→ F項）
4. ページ下部「応答メッセージ」「あいさつメッセージ」は LINE Official Account Manager へのリンク。後でOFFにする（→ G項）

ボットのQRコード・ベーシックIDもこのタブにあります（友だち追加用）。

## C. LIFF アプリの作成

LIFFはMessaging APIチャネルの **「LIFF」タブ** から追加します。

1. 「LIFF」タブ → 「追加」
2. 入力：
   - **LIFFアプリ名**：例 `Backlog連携設定`（「LINE」を含む名前は不可）
   - **サイズ**：`Full`
   - **エンドポイントURL**：この時点ではデプロイ先URLが未確定なので **`https://example.com` 等の仮URLでOK**（後で必ず本物に差し替え）
   - **Scope**：**`openid` を必ずチェック**（`liff.getIDToken()` に必須。`profile` は任意でOK）
   - ボットリンク機能・友だち追加オプション：不要
3. 「追加」すると **LIFF ID**（例: `1234567890-AbcdEfgh`）と **LIFF URL**（`https://liff.line.me/1234567890-AbcdEfgh`）が発行される
   - SSM: `/backlog-with-line/line/liff-id` にLIFF IDを入れる

## D. AWS 側（先にここまで終わらせる）

```bash
# Bedrock コンソール(us-west-2) → モデルアクセス → Grok 4.6 を有効化（初回のみ・数分で反映）
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

Outputs の `FunctionUrl`（例: `https://xxxx.lambda-url.ap-northeast-1.on.aws/`）を控える。

## E. Backlog側の準備

1. 専用ユーザー「LINE通知bot」等をBacklogに追加し、対象プロジェクトに参加させる
2. そのユーザーで **個人設定 → API → APIキー発行**（読み取り+書き込み権限）
3. APIキーはLIFF設定画面から登録するのでここでは控えておくだけでOK

## F. コンソールに戻る：Webhook URL

1. チャネルの **「Messaging API設定」タブ →「Webhook設定」**
2. **Webhook URL** に `https://<FunctionUrl>/webhook/line` を入力 → 「更新」
3. 「検証」ボタンで「成功」が出ることを確認（失敗する場合はSSMのchannel-secret未設定 or URL間違い）
4. **「Webhookの利用」をON**

## G. LINE Official Account Manager

https://account.line.biz/ → 対象アカウント → 右上「設定」→「応答設定」：

- **あいさつメッセージ**：OFF（botのjoin挨拶と二重になるため）
- **応答メッセージ**：OFF（Messaging APIに任せるため）
- **Webhook**：ON（Fで設定済みなら自動でONになっているはず）

## H. LIFF エンドポイントの本設定

1. チャネルの「LIFF」タブ → 作ったアプリを選択
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
| Grokが応答しない | us-west-2 でモデルアクセス有効化済みか / LambdaのIAMに bedrock:InvokeModel があるか |

## SSMパラメータ一覧

| パス | 種別 | どこで取る/入れる |
|---|---|---|
| `/backlog-with-line/line/channel-id` | String | チャネル基本設定タブ |
| `/backlog-with-line/line/channel-secret` | SecureString | チャネル基本設定タブ |
| `/backlog-with-line/line/channel-access-token` | SecureString | Messaging API設定タブで発行 |
| `/backlog-with-line/line/liff-id` | String | LIFFタブで発行 |
| `/backlog-with-line/groups/{groupId}/backlog-api-key` | SecureString | LIFF設定画面から自動登録（手動でも可） |
