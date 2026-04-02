# API エンドポイント

Gateway API と Agent Runtime API のエンドポイント一覧です。

## 目次

1. [Gateway API](#gateway-api)
2. [Agent Runtime API](#agent-runtime-api)
3. [認証](#認証)
4. [エラーレスポンス](#エラーレスポンス)

---

## Gateway API

ベース URL: `http://127.0.0.1:3800`（UDS 利用時は `${RUNTIME_SOCKET_DIR:-${XDG_RUNTIME_DIR:-/tmp}/yui-ai}/gateway-api.sock`）

### ヘルスチェック

#### `GET /health`

認証: 不要

```json
{
  "status": "ok",
  "service": "gateway-api"
}
```

---

### セッション管理

#### `POST /v1/discord/mentions/start`

メンションからセッションを開始します。

認証: `BOT_TO_GATEWAY_INTERNAL_TOKEN`

**リクエスト:**
```json
{
  "userId": "123456789",
  "username": "user#1234",
  "nickname": "ニックネーム",
  "channelId": "111111111",
  "channelName": "general",
  "threadId": "222222222",
  "threadName": "タスクスレッド",
  "prompt": "こんにちは",
  "attachmentNames": ["file.txt"]
}
```

**レスポンス (201):**
```json
{
  "session": {
    "sessionId": "sess-xxx",
    "status": "running"
  },
  "taskId": "task-xxx"
}
```

---

#### `POST /v1/threads/:threadId/messages`

スレッド内メッセージを処理します。

認証: `BOT_TO_GATEWAY_INTERNAL_TOKEN`

**リクエスト:**
```json
{
  "userId": "123456789",
  "username": "user#1234",
  "prompt": "続けて処理してください",
  "attachmentNames": []
}
```

**レスポンス:**
```json
{
  "session": { "sessionId": "sess-xxx", "status": "running" },
  "taskId": "task-xxx",
  "resumedFromIdle": true
}
```

---

#### `GET /v1/threads/:threadId/status`

スレッドのセッション状態を取得します。

認証: `BOT_TO_GATEWAY_INTERNAL_TOKEN`

**クエリパラメータ:**
- `userId` (必須): ユーザー ID

**レスポンス:**
```json
{
  "session": {
    "sessionId": "sess-xxx",
    "status": "idle_waiting",
    "lastActivityAt": "2024-01-01T00:00:00.000Z"
  },
  "task": null
}
```

---

#### `POST /v1/threads/:threadId/cancel`

実行中のタスクをキャンセルします。

認証: `BOT_TO_GATEWAY_INTERNAL_TOKEN`

**リクエスト:**
```json
{
  "userId": "123456789"
}
```

---

#### `POST /v1/threads/:threadId/close`

セッションを終了します。

認証: `BOT_TO_GATEWAY_INTERNAL_TOKEN`

**リクエスト:**
```json
{
  "userId": "123456789"
}
```

---

#### `POST /v1/threads/:threadId/resume`

終了したセッションを再開します。

認証: `BOT_TO_GATEWAY_INTERNAL_TOKEN`

**リクエスト:**
```json
{
  "userId": "123456789"
}
```

---

#### `GET /v1/sessions`

ユーザーのセッション一覧を取得します。

認証: `BOT_TO_GATEWAY_INTERNAL_TOKEN`

**クエリパラメータ:**
- `userId` (必須): ユーザー ID
- `limit` (任意): 最大件数（デフォルト: 20）

---

### 承認

#### `POST /v1/threads/:threadId/approvals/request`

承認をリクエストします。

認証: `BOT_TO_GATEWAY_INTERNAL_TOKEN`

**リクエスト:**
```json
{
  "userId": "123456789",
  "operation": "read",
  "path": "/path/to/file"
}
```

---

#### `POST /v1/approvals/:approvalId/respond`

承認に応答します。

認証: `BOT_TO_GATEWAY_INTERNAL_TOKEN`

**リクエスト:**
```json
{
  "userId": "123456789",
  "decision": "approved"
}
```

`decision`: `approved` | `rejected` | `timeout`

---

#### `POST /v1/agent/approvals/request-and-wait`

承認をリクエストし、結果を待機します（Agent → Gateway）。

認証: `AGENT_TO_GATEWAY_INTERNAL_TOKEN`

**リクエスト:**
```json
{
  "taskId": "task-xxx",
  "sessionId": "sess-xxx",
  "toolName": "host.file_read",
  "operation": "read",
  "path": "/path/to/file",
  "timeoutSec": 120
}
```

**レスポンス:**
```json
{
  "decision": "approved",
  "approval": {
    "approval_id": "appr-xxx",
    "status": "approved",
    "operation": "read",
    "path": "/path/to/file"
  }
}
```

---

### Agent タスク

#### `POST /v1/agent/tasks/run`

Agent タスクを実行します。

認証: `BOT_TO_GATEWAY_INTERNAL_TOKEN`

**リクエスト:**
```json
{
  "taskId": "task-xxx",
  "sessionId": "sess-xxx",
  "userId": "123456789",
  "prompt": "ファイルを読んでください",
  "attachmentNames": [],
  "contextEnvelope": { ... },
  "toolCalls": []
}
```

---

#### `GET /v1/agent/tasks/:taskId/status`

タスクの状態を取得します。

認証: `BOT_TO_GATEWAY_INTERNAL_TOKEN`

**クエリパラメータ:**
- `userId` (必須): ユーザー ID
- `includeTaskEvents` (任意): タスクイベントを含める
- `afterTimestamp` (任意): この時刻以降のイベントのみ
- `eventTypes` (任意): イベントタイプでフィルタ
- `eventsLimit` (任意): イベント最大件数

---

#### `POST /v1/agent/tasks/:taskId/cancel`

タスクをキャンセルします。

認証: `BOT_TO_GATEWAY_INTERNAL_TOKEN`

**リクエスト:**
```json
{
  "userId": "123456789"
}
```

---

### MCP ツール

#### `POST /v1/mcp/tool-call`

MCP ツールを実行します。

認証: `AGENT_TO_GATEWAY_INTERNAL_TOKEN`

**リクエスト:**
```json
{
  "task_id": "task-xxx",
  "session_id": "sess-xxx",
  "call_id": "call-xxx",
  "tool_name": "container.file_read",
  "execution_target": "container.file_read",
  "arguments": { "path": "workspace/file.txt" },
  "reason": "ファイルを読み取る"
}
```

**レスポンス:**
```json
{
  "success": true,
  "tool_name": "container.file_read",
  "result": { "content": "ファイル内容..." },
  "error": null
}
```

---

## Agent Runtime API

ベース URL: `http://127.0.0.1:3801`（UDS 利用時は `${RUNTIME_SOCKET_DIR:-${XDG_RUNTIME_DIR:-/tmp}/yui-ai}/agent-runtime.sock`）

### ヘルスチェック

#### `GET /health`

認証: 不要

```json
{
  "status": "ok",
  "service": "agent-runtime",
  "uptime_sec": 3600,
  "active_sessions": 1,
  "active_tasks": 0
}
```

#### `GET /ready`

認証: 不要

```json
{
  "status": "ready",
  "service": "agent-runtime",
  "started_at": "2024-01-01T00:00:00.000Z"
}
```

---

### タスク

#### `POST /v1/tasks/run`

タスクを実行します。

認証: `GATEWAY_TO_AGENT_INTERNAL_TOKEN`

**リクエスト:**
```json
{
  "task_id": "task-xxx",
  "session_id": "sess-xxx",
  "prompt": "こんにちは",
  "sdk_execution_mode": "single_send_and_wait",
  "session_bootstrap_mode": "create_or_resume",
  "runtime_policy": {
    "tool_routing": {
      "mode": "hybrid_container_builtin_gateway_host",
      "allow_external_mcp": false
    }
  },
  "system_memory_refs": [],
  "tool_calls": []
}
```

**レスポンス (202):**
```json
{
  "task_id": "task-xxx",
  "session_id": "sess-xxx",
  "status": "running",
  "bootstrap_mode": "create"
}
```

---

#### `GET /v1/tasks/:taskId`

タスクの状態を取得します。

認証: `GATEWAY_TO_AGENT_INTERNAL_TOKEN`

**レスポンス:**
```json
{
  "task_id": "task-xxx",
  "session_id": "sess-xxx",
  "status": "completed",
  "result": {
    "final_answer": "回答テキスト",
    "tool_results": [...]
  },
  "tool_events": [...],
  "error": null
}
```

---

#### `POST /v1/tasks/:taskId/cancel`

タスクをキャンセルします。

認証: `GATEWAY_TO_AGENT_INTERNAL_TOKEN`

---

#### `POST /v1/tasks/:taskId/attachments/stage`

添付ファイルをステージングします。

認証: `GATEWAY_TO_AGENT_INTERNAL_TOKEN`

**リクエスト:**
```json
{
  "session_id": "sess-xxx",
  "attachment_mount_path": "/agent/session/sess-xxx/attachments",
  "attachments": [
    { "name": "file.txt", "source_url": "https://..." }
  ]
}
```

---

## 認証

### ヘッダー

```
x-internal-token: <token>
```

### トークンの使い分け

| 経路 | トークン |
|-----|---------|
| Bot → Gateway | `BOT_TO_GATEWAY_INTERNAL_TOKEN` |
| Gateway → Agent | `GATEWAY_TO_AGENT_INTERNAL_TOKEN` |
| Agent → Gateway | `AGENT_TO_GATEWAY_INTERNAL_TOKEN` |

### 認証エラー

```json
{
  "error": "internal_auth_required",
  "message": "Valid internal token is required.",
  "details": { "path": "/v1/..." }
}
```

---

## エラーレスポンス

### 形式

```json
{
  "error": "error_code",
  "message": "エラーメッセージ",
  "details": { ... }
}
```

### 主要なエラーコード

| コード | HTTP | 説明 |
|-------|------|------|
| `session_not_found` | 404 | セッションが存在しない |
| `task_not_found` | 404 | タスクが存在しない |
| `task_already_exists` | 409 | タスクが既に存在する |
| `session_closed` | 400 | セッションが終了している |
| `session_not_owned` | 403 | セッションの所有者ではない |
| `approval_not_found` | 404 | 承認が存在しない |
| `invalid_*_request` | 400 | リクエストが不正 |
| `internal_auth_required` | 401 | 認証が必要 |
| `container_path_out_of_scope` | 400 | コンテナパスがスコープ外 |
| `host_command_not_allowed` | 400 | ホストコマンドが許可されていない |

---

## 次のステップ

- [MCP ツール](mcp-tools.md) — ツール仕様
- [トラブルシューティング](troubleshooting.md) — 問題解決
