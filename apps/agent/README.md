# Agent Runtime

P6 で Agent Runtime を実装し、`createSession/resumeSession + sendAndWait(1回)` の実行モデルを提供しています。  
P8 初回実装として SDK provider は `AGENT_SDK_PROVIDER=mock|copilot` を利用可能です。

フェーズ位置づけ:

- P7: Discord/Bot 経路との統合を実施済み（Gateway API 連携を E2E 接続）
- P8: `AGENT_SDK_PROVIDER=copilot` 実装（初回）

## 実装内容

- `GET /health`
- `GET /ready`
- `POST /v1/tasks/run`
- `GET /v1/tasks/:taskId`
- `POST /v1/tasks/:taskId/cancel`

`POST /v1/tasks/run` では以下を固定します。

- session bootstrap: `create` or `resume`（`session_id` で判定）
- task body execution: `sendAndWait` 1回
- tool callback: Gateway MCP (`/v1/mcp/tool-call`) へ委譲
- `execution_target != gateway_adapter` は Gateway 側で拒否

## SDK Provider 設定

### mock（既存）

```bash
AGENT_SDK_PROVIDER=mock
```

### copilot（P8 初回）

```bash
AGENT_SDK_PROVIDER=copilot
COPILOT_GITHUB_TOKEN=<GitHub token>
COPILOT_MODEL=gpt-5.3-codex
COPILOT_WORKING_DIRECTORY=/Volumes/nekodisk/github/yui-ai
COPILOT_SEND_TIMEOUT_MS=180000
COPILOT_SDK_LOG_LEVEL=info
```

補足:

- `COPILOT_GITHUB_TOKEN` は必須です（未設定時は起動失敗）。
- `COPILOT_MODEL` は任意（既定: `gpt-5.3-codex`）。
- Copilot provider は Runtime callback を維持し、tool callback を常に Gateway MCP に委譲します。

## 実行

1Password 経由（標準）:

```bash
yarn dev:agent
```

ローカル環境変数（`op run` なし）:

```bash
yarn dev:agent:local
```

## スモーク

```bash
yarn agent:smoke
```

ローカル環境変数（`op run` なし）:

```bash
yarn agent:smoke:local
```

## Docker 実行

`apps/agent/Dockerfile` を利用し、`docker-compose.yml` の `agent` サービスとして起動します。  
ホスト上の Gateway API と接続するため `AGENT_GATEWAY_BASE_URL` を使用します。
