# yui-ai

GitHub Copilot SDK ベースの個人用エージェント実装リポジトリです。

## Project Structure

```text
apps/
  agent/
  gateway/
    api/              # Discord Bot UX mock (実装済み)
    mcp/
    attachments/
    approvals/
    state/
    memory/
    container-tools/
```

## Runtime Topology

- Gateway 系（`apps/gateway/*`）: ホストマシン上で実行
- コンテナ実行（Docker Compose）: `apps/agent` と `postgres`

仕様ドキュメント:

- `docs/development/copilot-agent-system-design.md`
- `docs/development/copilot-agent-nodejs-requirements.md`
- `docs/development/implementation-flow.md`（実装手順ガイド）
- `docs/development/runtime-environment-template.md`（実行環境定義）

## 実装済みモック（Discord Bot）

- 実装場所: `apps/gateway/api`
- 詳細: `apps/gateway/api/README.md`

## 共通コマンド

```bash
yarn install
yarn register:commands
yarn dev
yarn build
yarn start
```

## P1 実行基盤コマンド

```bash
cp .env.op.example .env.op
yarn compose:up
yarn compose:ps
yarn dev
```

停止:

```bash
yarn compose:down
```

## P2 永続層コマンド

```bash
yarn db:migrate
yarn db:smoke
yarn db:cleanup
```

ローカル環境変数（`op run` なし）で実行する場合は `:local` サフィックスを利用します。

## P3 Gateway API コマンド

```bash
yarn dev:api
yarn api:smoke
```

## P4 Approval フロー（API 追加）

- `POST /v1/threads/:threadId/approvals/request`
- `POST /v1/approvals/:approvalId/respond`

## P5 MCP / Tool Adapter（API 追加）

- `POST /v1/mcp/tool-call`
- `container.*` / `host.*` / `memory.*` を Gateway で実行
- `api:smoke` に P5（approval_required, container scope, memory CRUD）検証を追加

## P6 Agent Runtime（API/コマンド追加）

- `apps/agent` に `create/resume + sendAndWait(1回)` 実行モデルを実装（mock provider）
- `POST /v1/agent/tasks/run`
- `GET /v1/agent/tasks/:taskId/status`
- `POST /v1/agent/tasks/:taskId/cancel`
- `yarn dev:agent`, `yarn agent:smoke`

## 次フェーズ（実装計画）

- P7: システム統合（Bot主導）
  - Discord -> Gateway API -> Agent Runtime の実行導線を接続し、E2Eで挙動を確認
- P8: Copilot SDK 実装
  - `AGENT_SDK_PROVIDER=copilot` を追加し、実 SDK 実行へ切り替え可能にする
- P9: 運用品質
  - 監査ログ、冪等、バックアップ、監視復旧運用を整備

詳細は `docs/development/implementation-flow.md` を参照してください。
