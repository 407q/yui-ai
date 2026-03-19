# Discord Bot

`apps/gateway/api/src/bot.ts` が標準の Bot 実装です。  
Copilot SDK 経路での通常運用はこのエントリポイントを使用します。  
`apps/gateway/api/src/debug/mock-bot.ts` は **mock モード専用ラッパー** として、`BOT_MODE=mock` を有効化して `bot.ts` を起動します。

## 実装している UX

- チャンネルで Bot をメンションしてセッション開始
- セッション専用スレッドを自動作成
- スレッド投稿ごとに Gateway API -> Agent Runtime で `run/status/cancel` を実行
- 受付した投稿には `:eyes:` リアクションで確認を返却（開始通知Embed/タスク開始通知は送信しない）
- スラッシュコマンド運用: `/status` `/cancel` `/close`（スレッド内）、`/list` `/exit` `/reboot`（どこでも）
- `/list` で自分のセッション一覧
- 承認フローは Discord Embed ボタン（Approve / Reject、先頭メンション）
- 承認依頼は `使用したいツール` / `行う操作` / `ターゲットとなる場所` の3項目表示
- `#host-read: <path>` を含むプロンプトで `host.file_read` の承認フローを確認可能
- `#tool: <tool_name> <JSON object>` を複数行で指定し、mock Agent から Gateway MCP ツール呼び出しデモを実行可能
- `#host-read` 承認後は同一 path / operation の permission を利用して再実行が進行（承認ループを回避）
- スレッド無発言で `idle_paused`、次の発言で自動再開
- LM 出力は可能な限りプレーンテキストでそのまま転送（Embed 非変換）
- LM 思考中を想定した `入力中`（typing）表示
- 起動・監視・復旧を含むシステムログとエラーは `BOT_SYSTEM_ALERT_CHANNEL_ID` に通知

### モード差分

- `standard`（既定: `bot.ts`）  
  - Copilot 実行の通常経路
  - `#tool:` / `#host-read:` の mock ディレクティブは無効
  - `/exit` `/reboot` は有効（全セッション終了 + システム制御）
- `mock`（`debug/mock-bot.ts`）  
  - `#tool:` / `#host-read:` ディレクティブ有効
  - `/exit` `/reboot` 有効（全セッション終了 + システム制御）

## セットアップ

```bash
yarn install
cp .env.example .env
```

`.env` の最低限:

- `DISCORD_BOT_TOKEN`
- `DISCORD_CLIENT_ID`（Slash 登録時）
- `DISCORD_GUILD_ID`（任意。指定時はギルドコマンドとして登録）
- `BOT_SYSTEM_ALERT_CHANNEL_ID`（任意。システムログ/エラー通知先）
- `GATEWAY_API_BASE_URL`（任意。既定: `http://127.0.0.1:3800`）
- `BOT_ORCHESTRATOR_ENABLED`（任意。既定: `true`）
- `BOT_ORCHESTRATOR_MONITOR_INTERVAL_SEC`（任意。既定: `15`）
- `BOT_ORCHESTRATOR_FAILURE_THRESHOLD`（任意。既定: `3`）
- `BOT_ORCHESTRATOR_COMMAND_TIMEOUT_SEC`（任意。既定: `240`）
- `BOT_ORCHESTRATOR_COMPOSE_BUILD`（任意。既定: `true`）

## 実行

1Password 経由（標準）:

```bash
yarn register:commands
yarn dev
```

mock モードで起動する場合:

```bash
yarn dev:mock
```

ローカル環境変数（`op run` なし）:

```bash
yarn register:commands:local
yarn dev:local
```

本番相当ビルド:

```bash
yarn build
yarn start
```

mock モードをビルド成果物から起動する場合:

```bash
yarn start:mock
```

ローカル環境変数（`op run` なし）:

```bash
yarn start:local
```

## コマンドの意味

- `/status`: 対応セッション状態を表示
- `/cancel`: 実行中タスクを停止
- `/close`: セッション終了
- `/exit`: **全セッション終了** + Bot システム終了（ステータスを即時オフライン化）
- `/reboot`: **全セッション終了** + Bot システム再起動（終了コード `75`）

## 1Password CLI 経由で実行する場合

`.env.op` に `op://...` 参照を置きます。  
`yarn dev` / `yarn register:commands` / `yarn start` は `op run` 経由で実行されます。

P7 の標準起動（推奨）:

```bash
yarn dev
```

`yarn dev` 起動時に Bot 内 Orchestrator が `docker compose up -d --build` -> `db:migrate` -> `gateway-api` 起動を実行し、`agent/postgres/gateway-api` の監視と段階復旧を行います。

- 起動中に失敗した場合は起動処理を中断し、Gateway API/compose を停止して graceful に終了
- 稼働中の障害時は `対象再起動 -> 全体再起動 -> 失敗時は全体終了` の順で試行

Gateway API を別プロセスで手動起動したい場合は、以下で Orchestrator を無効化してください。

```bash
BOT_ORCHESTRATOR_ENABLED=false yarn dev
```

手動分離起動（必要時のみ）:

```bash
yarn compose:up
yarn db:migrate
yarn dev:api
yarn dev:local
```

## Gateway API（P3-P7）

P3 で Fastify ベースの Gateway API を追加し、P5 で MCP tool endpoint と adapter 実行、P6 で Agent Runtime オーケストレーション API を追加し、P7 で Discord Bot から実呼び出しする統合を行っています。

次フェーズ（計画）:

- P8: 実 Copilot SDK provider 連携時の実行結果/エラー整合を反映

### 起動

1Password 経由（標準）:

```bash
yarn dev:api
```

ローカル環境変数（`op run` なし）:

```bash
yarn dev:api:local
```

### エンドポイント

- `POST /v1/discord/mentions/start`
- `POST /v1/threads/:threadId/messages`
- `GET /v1/threads/:threadId/status`
- `POST /v1/threads/:threadId/cancel`
- `POST /v1/threads/:threadId/close`
- `POST /v1/threads/:threadId/approvals/request`
- `POST /v1/approvals/:approvalId/respond`
- `POST /v1/mcp/tool-call`
- `POST /v1/agent/tasks/run`
- `GET /v1/agent/tasks/:taskId/status`
- `POST /v1/agent/tasks/:taskId/cancel`
- `GET /v1/sessions`
- `GET /health`

### MCP で扱う主なツール（P5）

- `container.file_read/write/delete/list`
- `container.cli_exec`
- `host.file_read/write/delete/list`
- `host.cli_exec`
- `host.http_request`
- `memory.upsert/search/get/delete`

### スモークテスト

```bash
yarn orchestrator:smoke
yarn db:migrate
yarn api:smoke
```

`api:smoke` は実行時に、各検証ステップの request/response 要約を標準出力へ表示します。

### Discord でのツール呼び出しデモ（mock Agent）

スレッド内で以下のように `#tool:` 行を送ると、mock Agent が `toolCalls` として Gateway API に渡します。

```text
#tool: memory.upsert {"namespace":"demo","key":"hello","value":{"text":"world"}}
#tool: memory.search {"namespace":"demo","query":"hello","limit":5}
実行結果を教えて
```

- 1行につき1つのツール指定（複数行可）
- 形式: `#tool: <tool_name> <JSON object>`
- Host 系は従来どおり `#host-read: <path>` も利用可能（承認 UI が必要）
