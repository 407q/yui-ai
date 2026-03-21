# Gateway MCP Endpoint

P5 で MCP endpoint を実装済みです。現状は API パッケージ内に統合しています。

- 実装場所: `apps/gateway/api/src/mcp`
- 受口: `POST /v1/mcp/tool-call`
- 役割:
  - `tool.call` 受信
  - `execution_target=gateway_adapter` の強制
  - `container.*` / `host.*` / `memory.*` / `discord.*` へのルーティング
  - 承認・許可判定（`approval_required` など）
  - `task_events` / `audit_logs` 記録
