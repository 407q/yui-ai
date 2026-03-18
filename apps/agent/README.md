# Agent Runtime

P6 で Agent Runtime を実装し、`createSession/resumeSession + sendAndWait(1回)` の実行モデルを提供しています。  
現状の SDK provider は `AGENT_SDK_PROVIDER=mock` を利用します（実 SDK provider は次段階で置換）。

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
