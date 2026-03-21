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
- ツール進捗は call_id ごとに「開始時メッセージ送信 -> 結果時に同一メッセージ編集」で表示
- 進捗メッセージは全文 ` ```text ` コードブロックで表示し、`tool_name` / `execution_target` / `arguments` を明示
- ツール成功・失敗の両方で、`result` / `message` / `details` 由来の実行ログ抜粋（`log_excerpt`）を同一メッセージに追記表示（集約エラー通知は送信しない）
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
- `BOT_OPERATION_LOG_ENABLED`（任意。既定: `true`）
- `BOT_OPERATION_LOG_MAX_FIELD_CHARS`（任意。既定: `320`）
- `BOT_DELIVERED_FILE_MAX_BYTES`（任意。既定: `2097152`）
- `BOT_DELIVERED_FILE_MAX_COUNT`（任意。既定: `3`）
- `CONTAINER_SESSION_ROOT`（任意。既定: `/agent/session`）
- `CONTAINER_TOOL_EXECUTION_MODE`（任意。既定: `docker_exec`）
- `AGENT_CONTAINER_NAME`（任意。既定: `yui-ai-agent`）
- `CONTAINER_DOCKER_CLI_TIMEOUT_SEC`（任意。既定: `60`）
- `DOCKER_PROJECT_ROOT`（任意。既定: `.`）

`BOT_OPERATION_LOG_ENABLED=true` の場合、Bot は実行中の操作を
「何をしたか」だけ（例: ファイル読込 / CLI 実行 / ツール呼び出し）で
絵文字付きの ` ```text ` コードブロックとしてスレッドへ出力します。  
無効化したい場合は `BOT_OPERATION_LOG_ENABLED=false` を設定してください。

`container.*` ツールは既定で `docker exec` 経由で Agent コンテナ内を操作し、
`/agent/session/<session_id>` を実体として扱います。
必要に応じて `CONTAINER_TOOL_EXECUTION_MODE=host` に切り替えると、Gateway ホスト上の
`CONTAINER_SESSION_ROOT` を直接操作します（開発・検証用途）。

Agent Runtime への `runtime_policy.tool_routing.mode` は
`hybrid_container_builtin_gateway_host` を使用し、以下を満たします。

- コンテナ内ファイル探索/編集は Copilot built-in tools（allowlist）を許可
- host 操作・memory 操作・承認フローは Gateway custom tools を継続利用
- 境界制御は System Message 依存ではなく、`availableTools` 制約と SDK hooks で機械的に強制
- 受領ファイルはコンテナ内で処理し、返却時は `container.file_deliver` を優先（不要な host パス変更を回避）

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
- `/exit`: **全セッション終了** + インフラ停止（compose down）+ Bot システム終了（ステータスを即時オフライン化）
- `/reboot`: **全セッション終了** + Bot を切断後に同一プロセス内で再起動

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

#### `POST /v1/agent/tasks/run` の Context Envelope（PR-2）

`/v1/agent/tasks/run` は、受信した `prompt` の前に Gateway 側で `Context Envelope` を前置して Agent Runtime へ送信します。  
Envelope は以下の4ブロックで構成されます。

- `Attachment Context`
- `Behavior Context`
- `Runtime Feedback Context`
- `Discord Context`

Bot から `contextEnvelope` を受け取る場合、主に次を使用します。

- `behavior.botMode` / `behavior.sessionStatus` / `behavior.infrastructureStatus`
- `runtimeFeedback.previousTaskTerminalStatus`
- `runtimeFeedback.previousToolErrors`
- `runtimeFeedback.retryHint`
- `runtimeFeedback.attachmentSources[]`（`{ name, sourceUrl }`）
- `runtimeFeedback.systemMemoryReferences[]`（`{ namespace, key, reason }`）
- `discord.userId` / `discord.username` / `discord.nickname`
- `discord.channelId` / `discord.channelName` / `discord.threadId` / `discord.threadName`

スレッド内の会話履歴はセッション履歴として標準参照されるため、`discord.recentMessages` は渡しません。

`attachmentNames` が指定されている場合、Gateway は各ファイルに対応する
`runtimeFeedback.attachmentSources` を必須として `POST /v1/tasks/:taskId/attachments/stage`
を Agent Runtime へ呼び出し、`/agent/session/<session_id>` に事前配置します。  
不足がある場合は `attachment_source_missing` で run を拒否します。

Context 生成に失敗した場合は監査ログ（`audit_logs`）へ `context_envelope_fallback` を記録し、通常の `prompt` でフォールバックします。

### MCP で扱う主なツール（P5）

- `container.file_read/write/delete/list`
- `container.file_deliver`
- `container.cli_exec`
- `host.file_read/write/delete/list`
- `host.cli_exec`
- `host.http_request`
- `memory.upsert/search/get/delete`
- `discord.channel_history`
- `discord.channel_list`

`discord.*` ツールはすべて承認制で、未承認時は `approval_required` を返します。
`discord.channel_history` は `channelId` 指定で対象を切り替えられ、Discord API（`/channels/:id/messages`）から取得したメッセージを優先し、失敗時はセッション記録へフォールバックします。  
返却 `entries[]` には本文に加えて `attachmentUrls`、`reference`（参照元メッセージ）、`replyTo`（返信先）、`forwardFrom`（転送元）を含みます（取得不可時は `null` / 空配列）。
`discord.channel_list` はサーバー全体のチャンネル一覧取得に利用できます。

`memory.*` には `system.*` namespace が追加されています。  
`memory.get/search` は system memory を参照可能ですが、`memory.upsert/delete` は `system.*` に対して `memory_system_entry_read_only` で拒否されます。

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
- 例: `#tool: container.file_deliver {"path":"workspace/report.txt","maxBytes":1048576}`

`container.file_deliver` が `tool_results` に成功で含まれると、Bot は base64 payload をデコードして
Discord 添付として自動送信します（`BOT_DELIVERED_FILE_MAX_BYTES` / `BOT_DELIVERED_FILE_MAX_COUNT` で制限）。
