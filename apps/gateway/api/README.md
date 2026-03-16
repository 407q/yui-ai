# Discord Bot UX Mockup

Discord 側 UX の確認用として、Bot 部分のみをモック実装したものです。  
Gateway / Agent 実処理は呼び出しません。

## 実装している UX

- チャンネルで Bot をメンションしてセッション開始
- セッション専用スレッドを自動作成
- 受付した投稿には `:eyes:` リアクションで確認を返却（開始通知Embed/タスク開始通知は送信しない）
- スラッシュコマンド運用: `/status` `/cancel` `/close`（スレッド内）、`/list` `/exit` `/reboot`（どこでも）
- `/list` で自分のセッション一覧
- 承認フローは Discord Embed ボタン（Approve / Reject、先頭メンション）
- 承認依頼は `使用したいツール` / `行う操作` / `ターゲットとなる場所` の3項目表示
- スレッド無発言で `idle_paused`、次の発言で自動再開
- LM 出力は可能な限りプレーンテキストでそのまま転送（Embed 非変換）
- LM 思考中を想定した `入力中`（typing）表示
- 起動時・エラー時は `MOCK_SYSTEM_ALERT_CHANNEL_ID` に通知

## セットアップ

```bash
yarn install
cp .env.example .env
```

`.env` の最低限:

- `DISCORD_BOT_TOKEN`
- `DISCORD_CLIENT_ID`（Slash 登録時）
- `DISCORD_GUILD_ID`（任意。指定時はギルドコマンドとして登録）
- `MOCK_SYSTEM_ALERT_CHANNEL_ID`（任意。起動/エラー通知先）

## 実行

```bash
yarn register:commands
yarn dev
```

本番相当ビルド:

```bash
yarn build
yarn start
```

## コマンドの意味

- `/status`: 対応セッション状態を表示
- `/cancel`: 実行中タスクを停止
- `/close`: セッション終了
- `/exit`: **全セッション終了** + モックシステム終了（ステータスを即時オフライン化）
- `/reboot`: **全セッション終了** + モックシステム再起動（終了コード `75`）

## 1Password CLI 経由で実行する場合

`.env.op` に `op://...` 参照を置き、`op run` で注入します。

```bash
op run --env-file=.env.op -- yarn dev
```
