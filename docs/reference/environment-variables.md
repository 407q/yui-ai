# 環境変数リファレンス

Yui AI の設定に使用する環境変数の一覧です。

## 目次

1. [Discord](#discord)
2. [Copilot SDK](#copilot-sdk)
3. [内部 API 認証](#内部-api-認証)
4. [Gateway API](#gateway-api)
5. [Agent Runtime](#agent-runtime)
6. [データベース](#データベース)
7. [Orchestrator](#orchestrator)
8. [MCP ツール](#mcp-ツール)
9. [その他](#その他)

---

## Discord

| 変数 | 必須 | デフォルト | 説明 |
|------|------|-----------|------|
| `DISCORD_BOT_TOKEN` | ✅ | - | Discord Bot トークン |
| `DISCORD_CLIENT_ID` | ✅ | - | Discord アプリケーション ID |
| `DISCORD_GUILD_ID` | - | - | ギルド ID（指定時はギルドコマンドとして登録） |
| `DISCORD_API_BASE_URL` | - | `https://discord.com/api/v10` | Discord API ベース URL |
| `BOT_SYSTEM_ALERT_CHANNEL_ID` | - | - | システムアラート送信先チャンネル ID |
| `BOT_MODE` | - | `standard` | `standard`: Copilot SDK, `mock`: モックモード |

---

## Copilot SDK

| 変数 | 必須 | デフォルト | 説明 |
|------|------|-----------|------|
| `COPILOT_GITHUB_TOKEN` | ※ | - | GitHub PAT（`BOT_MODE=standard` 時は必須） |
| `COPILOT_MODEL` | - | `claude-sonnet-4.6` | 使用するモデル |
| `COPILOT_WORKING_DIRECTORY` | - | `/app` | SDK 作業ディレクトリ |
| `COPILOT_SEND_TIMEOUT_MS` | - | `180000` | 推論タイムアウト（ms）※最後のツール実行から計測 |
| `COPILOT_SDK_LOG_LEVEL` | - | `info` | SDK ログレベル（`none`/`error`/`warning`/`info`/`debug`/`all`） |

---

## 内部 API 認証

コンポーネント間通信の認証トークンです。任意の秘密文字列を設定してください。

| 変数 | 必須 | 説明 |
|------|------|------|
| `BOT_TO_GATEWAY_INTERNAL_TOKEN` | ✅ | Bot → Gateway API |
| `GATEWAY_TO_AGENT_INTERNAL_TOKEN` | ✅ | Gateway → Agent Runtime |
| `AGENT_TO_GATEWAY_INTERNAL_TOKEN` | ✅ | Agent → Gateway（MCP/承認） |

トークン生成例:
```bash
openssl rand -hex 32
```

---

## Gateway API

| 変数 | 必須 | デフォルト | 説明 |
|------|------|-----------|------|
| `GATEWAY_API_HOST` | - | `127.0.0.1` | バインドホスト |
| `GATEWAY_API_PORT` | - | `3800` | バインドポート |
| `GATEWAY_API_BASE_URL` | - | `http://127.0.0.1:3800` | Gateway API ベース URL |
| `AGENT_RUNTIME_BASE_URL` | - | `http://127.0.0.1:3801` | Agent Runtime ベース URL |
| `AGENT_RUNTIME_TIMEOUT_SEC` | - | `30` | Agent API タイムアウト（秒） |
| `SESSION_IDLE_TIMEOUT_SEC` | - | `600` | セッションアイドルタイムアウト（秒） |

---

## Agent Runtime

| 変数 | 必須 | デフォルト | 説明 |
|------|------|-----------|------|
| `AGENT_BIND_HOST` | - | `0.0.0.0` | バインドホスト |
| `AGENT_PORT` | - | `3801` | バインドポート |
| `AGENT_GATEWAY_BASE_URL` | - | `http://host.docker.internal:3800` | Gateway API ベース URL（コンテナから見た） |
| `AGENT_MCP_TIMEOUT_SEC` | - | `30` | MCP ツール呼び出しタイムアウト（秒） |
| `AGENT_SESSION_ROOT_DIR` | - | `/agent/session` | セッション作業ディレクトリルート |

---

## データベース

| 変数 | 必須 | デフォルト | 説明 |
|------|------|-----------|------|
| `POSTGRES_DB` | ✅ | - | データベース名 |
| `POSTGRES_USER` | ✅ | - | ユーザー名 |
| `POSTGRES_PASSWORD` | ✅ | - | パスワード |
| `POSTGRES_HOST` | - | `127.0.0.1` | ホスト |
| `POSTGRES_PORT` | - | `55432` | ポート |
| `STATE_STORE_DSN` | ✅ | - | 状態ストア DSN |
| `MEMORY_STORE_DSN` | ✅ | - | メモリストア DSN |

DSN 形式:
```
postgres://user:password@host:port/database
```

---

## Orchestrator

| 変数 | 必須 | デフォルト | 説明 |
|------|------|-----------|------|
| `BOT_ORCHESTRATOR_ENABLED` | - | `true` | Orchestrator の有効化 |
| `BOT_ORCHESTRATOR_MONITOR_INTERVAL_SEC` | - | `15` | 監視間隔（秒） |
| `BOT_ORCHESTRATOR_FAILURE_THRESHOLD` | - | `3` | 復旧開始までの失敗回数 |
| `BOT_ORCHESTRATOR_COMMAND_TIMEOUT_SEC` | - | `240` | コマンドタイムアウト（秒） |
| `BOT_ORCHESTRATOR_CLEANUP_ENABLED` | - | `true` | クリーンアップの有効化 |
| `BOT_ORCHESTRATOR_CLEANUP_INTERVAL_SEC` | - | `86400` | クリーンアップ間隔（秒） |
| `BOT_ORCHESTRATOR_COMPOSE_BUILD` | - | `true` | compose 起動時に `--build` を付与 |

---

## MCP ツール

### コンテナツール

| 変数 | 必須 | デフォルト | 説明 |
|------|------|-----------|------|
| `CONTAINER_SESSION_ROOT` | - | `/agent/session` | セッションルート |
| `CONTAINER_CLI_TIMEOUT_SEC` | - | `60` | CLI タイムアウト（秒） |
| `CONTAINER_TOOL_EXECUTION_MODE` | - | `docker_exec` | 実行モード（`docker_exec`/`host`） |
| `AGENT_CONTAINER_NAME` | - | `yui-ai-agent` | Agent コンテナ名 |
| `CONTAINER_DOCKER_CLI_TIMEOUT_SEC` | - | `60` | docker exec タイムアウト（秒） |
| `DOCKER_PROJECT_ROOT` | - | `.` | Docker プロジェクトルート |

### ホストツール

| 変数 | 必須 | デフォルト | 説明 |
|------|------|-----------|------|
| `HOST_CLI_TIMEOUT_SEC` | - | `60` | CLI タイムアウト（秒） |
| `HOST_HTTP_TIMEOUT_SEC` | - | `60` | HTTP タイムアウト（秒） |
| `HOST_CLI_ALLOWLIST` | - | `git,node,npm,yarn,curl` | 許可コマンドリスト（カンマ区切り） |
| `HOST_CLI_ENV_ALLOWLIST` | - | (空) | 子プロセスに渡す環境変数（カンマ区切り） |

### メモリ

| 変数 | 必須 | デフォルト | 説明 |
|------|------|-----------|------|
| `MEMORY_NAMESPACE_VALIDATION_MODE` | - | `warn` | 名前空間検証モード（`warn`/`enforce`） |

---

## その他

### Bot 設定

| 変数 | 必須 | デフォルト | 説明 |
|------|------|-----------|------|
| `BOT_IDLE_TIMEOUT_SEC` | - | `600` | アイドルタイムアウト（秒） |
| `BOT_AGENT_STATUS_TIMEOUT_SEC` | - | `180` | Agent ステータス取得タイムアウト（秒） |
| `BOT_AGENT_POLL_INTERVAL_MS` | - | `800` | Agent ポーリング間隔（ms） |
| `BOT_OPERATION_LOG_ENABLED` | - | `true` | 操作ログの Discord 表示 |
| `BOT_OPERATION_LOG_MAX_FIELD_CHARS` | - | `320` | 操作ログフィールド最大文字数 |
| `BOT_DELIVERED_FILE_MAX_BYTES` | - | `2097152` | 配信ファイル最大サイズ（2MB） |
| `BOT_DELIVERED_FILE_MAX_COUNT` | - | `3` | 配信ファイル最大数 |

### データ保持

| 変数 | 必須 | デフォルト | 説明 |
|------|------|-----------|------|
| `TASK_EVENTS_RETENTION_DAYS` | - | `90` | タスクイベント保持日数 |
| `AUDIT_LOGS_RETENTION_DAYS` | - | `180` | 監査ログ保持日数 |

---

## 設定例

### 最小構成（開発用）

```bash
# .env
DISCORD_BOT_TOKEN=your-token
DISCORD_CLIENT_ID=123456789012345678
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

### 本番構成（1Password）

`.env.op.example` を参照してください。

---

## 次のステップ

- [セットアップガイド](../guide/setup.md) — 環境構築
- [トラブルシューティング](troubleshooting.md) — 問題解決
