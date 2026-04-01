# 環境変数リファレンス（コードベース棚卸し）

`process.env.*`（`apps/**`）と `docker-compose*.yml` の参照を棚卸しし、現行構成での必要性を再分類した一覧です。

## 必須度の見方

- **必須**: 未設定だと現行運用フローで起動/実行できない
- **条件付き必須**: 特定モードや特定コマンド実行時のみ必須
- **任意**: 未設定時にデフォルト値へフォールバック
- **互換**: 旧変数（後方互換用）。新規設定は非推奨
- **テスト専用**: smoke テスト内部でのみ使用

## 現行の標準運用で最低限必要な変数

前提: `BOT_MODE=standard` + `INTERNAL_CONNECTION_MODE=tcp` + `compose:*` 系コマンド。

- `DISCORD_BOT_TOKEN`
- `COPILOT_GITHUB_TOKEN`
- `BOT_TO_GATEWAY_INTERNAL_TOKEN`
- `GATEWAY_TO_AGENT_INTERNAL_TOKEN`
- `AGENT_TO_GATEWAY_INTERNAL_TOKEN`
- `INTERNAL_CONNECTION_MODE`
- `POSTGRES_DB`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `STATE_STORE_DSN`
- `MEMORY_STORE_DSN`

---

## Discord / Bot

| 変数 | 必須度 | デフォルト | 説明 |
|------|--------|-----------|------|
| `DISCORD_BOT_TOKEN` | 必須 | - | Bot 起動時に必須 |
| `DISCORD_CLIENT_ID` | 条件付き必須 | - | `yarn register:commands*` 実行時に必須 |
| `DISCORD_GUILD_ID` | 任意 | - | 指定時はギルドコマンドとして登録 |
| `DISCORD_API_BASE_URL` | 任意 | `https://discord.com/api/v10` | Discord API ベース URL |
| `BOT_SYSTEM_ALERT_CHANNEL_ID` | 任意 | - | システムアラート通知先 |
| `BOT_MODE` | 任意 | `standard` | `standard` / `mock` |
| `BOT_IDLE_TIMEOUT_SEC` | 任意 | `600` | Bot 側のアイドルタイムアウト（秒） |
| `BOT_AGENT_STATUS_TIMEOUT_SEC` | 任意 | `180` | Agent status ポーリングのタイムアウト（秒） |
| `BOT_AGENT_POLL_INTERVAL_MS` | 任意 | `800` | Agent status ポーリング間隔（ms） |
| `BOT_EVENT_DEDUP_TTL_MS` | 任意 | `300000` | Discord イベント重複排除の TTL（ms） |
| `BOT_OPERATION_LOG_ENABLED` | 任意 | `true` | 操作ログの Discord 表示有効化 |
| `BOT_OPERATION_LOG_MAX_FIELD_CHARS` | 任意 | `320` | 操作ログ表示時のフィールド最大文字数 |
| `BOT_DELIVERED_FILE_MAX_BYTES` | 任意 | `2097152` | `container.file_deliver` の Discord 配信サイズ上限（bytes） |
| `BOT_DELIVERED_FILE_MAX_COUNT` | 任意 | `3` | 1 回の返信で配信する最大ファイル数 |

---

## Copilot SDK / Agent Runtime

| 変数 | 必須度 | デフォルト | 説明 |
|------|--------|-----------|------|
| `COPILOT_GITHUB_TOKEN` | 条件付き必須 | - | `BOT_MODE=standard` の場合に必須 |
| `COPILOT_MODEL` | 任意 | `claude-sonnet-4.6` | 利用モデル |
| `COPILOT_WORKING_DIRECTORY` | 任意 | `/app`（compose時） | SDK 作業ディレクトリ |
| `COPILOT_SEND_TIMEOUT_MS` | 任意 | `180000` | send-and-wait タイムアウト（ms） |
| `COPILOT_SDK_LOG_LEVEL` | 任意 | `info` | `none/error/warning/info/debug/all` |
| `AGENT_BIND_HOST` | 任意 | `0.0.0.0` | Agent listen host |
| `AGENT_PORT` | 任意 | `3801` | Agent listen port |
| `AGENT_SOCKET_PATH` | 条件付き必須 | `/tmp/sockets/agent-runtime.sock` | `INTERNAL_CONNECTION_MODE=uds` 時の Agent listen socket |
| `AGENT_GATEWAY_BASE_URL` | 任意 | `http://host.docker.internal:3800` | Agent -> Gateway の HTTP ベース URL |
| `AGENT_GATEWAY_API_SOCKET_PATH` | 条件付き必須 | `/tmp/sockets/gateway-api.sock` | `INTERNAL_CONNECTION_MODE=uds` 時の Agent -> Gateway socket |
| `AGENT_MCP_TIMEOUT_SEC` | 任意 | `30` | Agent -> Gateway MCP 呼び出しタイムアウト（秒） |
| `AGENT_SESSION_ROOT_DIR` | 任意 | `/agent/session` | セッション作業ルート |
| `AGENT_ATTACHMENT_MAX_BYTES` | 任意 | `26214400`（25MB） | 添付 stage 時の 1 ファイル上限 |
| `BOT_APPROVAL_TIMEOUT_SEC` | 任意 | `120` | Agent 側 approval wait タイムアウト（秒） |

---

## 内部 API 認証

> 実装上は未設定でも起動できますが、未設定時は内部 API 認証が実質無効化されます。現行構成では**運用必須**として扱ってください。

| 変数 | 必須度 | 説明 |
|------|--------|------|
| `BOT_TO_GATEWAY_INTERNAL_TOKEN` | 必須 | Bot -> Gateway 認証トークン |
| `GATEWAY_TO_AGENT_INTERNAL_TOKEN` | 必須 | Gateway -> Agent 認証トークン |
| `AGENT_TO_GATEWAY_INTERNAL_TOKEN` | 必須 | Agent -> Gateway（MCP/approval）認証トークン |

トークン生成例:

```bash
openssl rand -hex 32
```

### 後方互換（旧トークン名）

| 変数 | 必須度 | 説明 |
|------|--------|------|
| `GATEWAY_INTERNAL_TOKEN` | 互換 | `BOT_TO_GATEWAY_INTERNAL_TOKEN` / `AGENT_TO_GATEWAY_INTERNAL_TOKEN` の互換フォールバック |
| `AGENT_INTERNAL_TOKEN` | 互換 | `GATEWAY_TO_AGENT_INTERNAL_TOKEN` の互換フォールバック |

---

## Gateway API / MCP ツール

| 変数 | 必須度 | デフォルト | 説明 |
|------|--------|-----------|------|
| `GATEWAY_API_HOST` | 任意 | `127.0.0.1`（Bot側）/`0.0.0.0`（API側） | Gateway listen host |
| `GATEWAY_API_PORT` | 任意 | `3800` | Gateway listen port |
| `GATEWAY_API_BASE_URL` | 任意 | `http://127.0.0.1:3800` | Bot -> Gateway ベース URL |
| `GATEWAY_API_SOCKET_PATH` | 条件付き必須 | `/tmp/sockets/gateway-api.sock` | `INTERNAL_CONNECTION_MODE=uds` 時の Bot/Agent -> Gateway socket |
| `AGENT_RUNTIME_BASE_URL` | 任意 | `http://127.0.0.1:3801` | Gateway/Bot -> Agent ベース URL |
| `AGENT_RUNTIME_SOCKET_PATH` | 条件付き必須 | `/tmp/sockets/agent-runtime.sock` | `INTERNAL_CONNECTION_MODE=uds` 時の Gateway/Bot -> Agent socket |
| `AGENT_RUNTIME_TIMEOUT_SEC` | 任意 | `30` | Gateway -> Agent API タイムアウト（秒） |
| `SESSION_IDLE_TIMEOUT_SEC` | 任意 | `600` | Gateway 側セッション idle timeout（秒） |
| `CONTAINER_SESSION_ROOT` | 任意 | `/agent/session` | container ツールのセッションルート |
| `CONTAINER_CLI_TIMEOUT_SEC` | 任意 | `60` | container CLI タイムアウト（秒） |
| `CONTAINER_TOOL_EXECUTION_MODE` | 任意 | `docker_exec` | `docker_exec` / `host` |
| `AGENT_CONTAINER_NAME` | 任意 | `yui-ai-agent` | `docker_exec` 対象コンテナ名 |
| `CONTAINER_DOCKER_CLI_TIMEOUT_SEC` | 任意 | `60` | docker CLI タイムアウト（秒） |
| `DOCKER_PROJECT_ROOT` | 任意 | `.` | Docker プロジェクトルート |
| `HOST_CLI_TIMEOUT_SEC` | 任意 | `60` | host CLI タイムアウト（秒） |
| `HOST_HTTP_TIMEOUT_SEC` | 任意 | `60` | host HTTP タイムアウト（秒） |
| `HOST_CLI_ALLOWLIST` | 任意 | `git,node,npm,yarn,curl` | host CLI 許可コマンド |
| `HOST_CLI_ENV_ALLOWLIST` | 任意 | (空) | host CLI 子プロセスへ渡す環境変数 |
| `MEMORY_NAMESPACE_VALIDATION_MODE` | 任意 | `warn` | `warn` / `enforce` |

---

## データベース / 接続モード

| 変数 | 必須度 | デフォルト | 説明 |
|------|--------|-----------|------|
| `INTERNAL_CONNECTION_MODE` | 必須 | - | `tcp` / `uds`。compose ファイル選択と内部 API/DB 接続モードを一括制御 |
| `POSTGRES_DB` | 必須（compose） | - | Postgres DB 名 |
| `POSTGRES_USER` | 必須（compose） | - | Postgres ユーザー |
| `POSTGRES_PASSWORD` | 必須（compose） | - | Postgres パスワード |
| `STATE_STORE_DSN` | 必須（compose/本番運用） | - | state 用 DSN |
| `MEMORY_STORE_DSN` | 必須（compose/本番運用） | - | memory 用 DSN（同一 DSN 可） |
| `POSTGRES_HOST` | 任意 | DSN準拠（host実行時は `postgres` を `127.0.0.1` へ自動補正） | DB host 上書き |
| `POSTGRES_PORT` | 任意 | `55432`（compose 公開ポート）/ DSN準拠（DB上書き未指定時） | compose の host 公開ポート。Node 側では DB port 上書きにも使われ、host実行時 `postgres:5432` は `55432` に自動補正 |
| `POSTGRES_SOCKET_DIR` | 任意 | `/tmp/postgres-socket` | UDS 用 socket ディレクトリ（主にホスト側） |
| `POSTGRES_SOCKET_PATH` | 任意 | `/tmp/postgres-socket` | `pg` 接続先 socket ディレクトリ |
| `POSTGRES_SOCKET_PORT` | 任意 | `5432` | UDS 利用時に `pg` へ渡す port 値 |
| `DB_SOCKET_MOUNT_PATH` | 条件付き必須（uds + container） | `/tmp/postgres-socket` | container 内から参照する socket mount path |
| `RUNTIME_SOCKET_DIR` | 任意 | `/tmp/sockets` | Agent/Gateway UDS 共有マウント |

### 後方互換（旧 DSN 名）

| 変数 | 必須度 | 説明 |
|------|--------|------|
| `DATABASE_URL` | 互換 | `STATE_STORE_DSN` / `MEMORY_STORE_DSN` 未設定時のフォールバック |

DSN 形式:

```text
postgres://user:password@host:port/database
```

`INTERNAL_CONNECTION_MODE=uds` の場合、Node プロセスは DSN の host/port より UDS 設定を優先します。container 内では `DB_SOCKET_MOUNT_PATH` が優先されます。

---

## Orchestrator / 定期処理

| 変数 | 必須度 | デフォルト | 説明 |
|------|--------|-----------|------|
| `BOT_ORCHESTRATOR_ENABLED` | 任意 | `true` | Orchestrator 有効化 |
| `BOT_ORCHESTRATOR_MONITOR_INTERVAL_SEC` | 任意 | `15` | 監視間隔（秒） |
| `BOT_ORCHESTRATOR_FAILURE_THRESHOLD` | 任意 | `3` | 復旧開始までの失敗回数 |
| `BOT_ORCHESTRATOR_COMMAND_TIMEOUT_SEC` | 任意 | `240` | Orchestrator 実行コマンドのタイムアウト（秒） |
| `BOT_ORCHESTRATOR_CLEANUP_ENABLED` | 任意 | `true` | cleanup 実行有効化 |
| `BOT_ORCHESTRATOR_CLEANUP_INTERVAL_SEC` | 任意 | `86400` | cleanup 実行間隔（秒） |
| `BOT_ORCHESTRATOR_COMPOSE_BUILD` | 任意 | `true` | compose up 時 `--build` を付与 |
| `TASK_EVENTS_RETENTION_DAYS` | 任意 | `90` | task_events 保持日数 |
| `AUDIT_LOGS_RETENTION_DAYS` | 任意 | `180` | audit_logs 保持日数 |

---

## テスト専用

| 変数 | 必須度 | 説明 |
|------|--------|------|
| `SMOKE_SECRET_HOST_CLI` | テスト専用 | `apps/gateway/api/src/smoke.ts` のみで使用 |

---

## 設定例（最小）

```bash
# .env
INTERNAL_CONNECTION_MODE=tcp
DISCORD_BOT_TOKEN=your-token
COPILOT_GITHUB_TOKEN=ghp_xxxx
BOT_TO_GATEWAY_INTERNAL_TOKEN=dev-secret-1
GATEWAY_TO_AGENT_INTERNAL_TOKEN=dev-secret-2
AGENT_TO_GATEWAY_INTERNAL_TOKEN=dev-secret-3
POSTGRES_DB=yui_ai
POSTGRES_USER=yui
POSTGRES_PASSWORD=password
STATE_STORE_DSN=postgres://yui:password@127.0.0.1:55432/yui_ai
MEMORY_STORE_DSN=postgres://yui:password@127.0.0.1:55432/yui_ai
```

---

## 関連ドキュメント

- [セットアップガイド](../guide/setup.md)
- [トラブルシューティング](troubleshooting.md)
