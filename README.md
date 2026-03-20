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
- `docs/development/copilot-e2e-test-runbook.md`（Copilot E2E テスト手順）

## 実装済みモック（Discord Bot / デバッグ退避）

- 実装場所: `apps/gateway/api`
- 本体エントリポイント: `apps/gateway/api/src/bot.ts`（通常/Copilot 経路）
- mock エントリポイント: `apps/gateway/api/src/debug/mock-bot.ts`（`BOT_MODE=mock` で起動）
- 詳細: `apps/gateway/api/README.md`

## 共通コマンド

```bash
yarn install
yarn register:commands
yarn dev
yarn dev:mock
yarn build
yarn start
yarn start:mock
yarn orchestrator:smoke
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
- `container.file_deliver` でコンテナ内ファイルを base64 返却し、Bot が Discord 添付として送信可能
- `api:smoke` に P5（approval_required, container scope, memory CRUD）検証を追加

## P6 Agent Runtime（API/コマンド追加）

- `apps/agent` に `create/resume + sendAndWait(1回)` 実行モデルを実装（mock provider）
- `POST /v1/agent/tasks/run`
- `GET /v1/agent/tasks/:taskId/status`
- `POST /v1/agent/tasks/:taskId/cancel`
- `yarn dev:agent`, `yarn agent:smoke`

### P8 初回（Copilot SDK provider）

- `BOT_MODE=standard` で Copilot provider を利用
- Node.js 22 以上が必要（`node:sqlite`）
- `COPILOT_GITHUB_TOKEN` 必須（未設定時は Agent 起動エラー）
- `COPILOT_MODEL`（既定: `claude-sonnet-4.6`）
- `COPILOT_WORKING_DIRECTORY`（Docker では `/app` 推奨） / `COPILOT_SEND_TIMEOUT_MS` / `COPILOT_SDK_LOG_LEVEL` を追加
- `BOT_MODE=mock` では mock provider を利用（`agent:smoke` 回帰維持）
- runtime policy は `hybrid_container_builtin_gateway_host` を標準化し、コンテナ内 built-in tools と host Gateway tools を分離

## P7 システム統合（Bot主導）

- Discord Bot が `POST /v1/agent/tasks/run` / `GET /v1/agent/tasks/:taskId/status` / `POST /v1/agent/tasks/:taskId/cancel` を利用
- `/cancel` `/close` `/exit` `/reboot` で Agent Runtime 側キャンセルと Gateway セッション状態を同期
- `#host-read: <path>` を含むプロンプトで `host.file_read` を要求し、Discord 承認 UI と再試行フローを確認可能
- `#host-read` は承認後に同一 path / operation の permission が付与され、再試行で承認ループしない
- `#tool: <tool_name> <JSON object>` を含むプロンプトで mock Agent に Gateway MCP ツール呼び出しを実行させるデモが可能
- 例: `#tool: container.file_deliver {"path":"workspace/report.txt","maxBytes":1048576}`
- P7 時点では Copilot SDK provider は `mock` を使用（P8 初回で `copilot` を追加）
- Bot 起動時に Orchestrator が `docker compose up -d --build` -> `db:migrate` -> `gateway-api` 起動を行い、`agent/postgres/gateway-api` を監視
- 起動失敗時は Orchestrator が起動処理を中断して関連コンポーネントを停止し、プロセスを graceful に終了
- 稼働中障害時は `対象再起動 -> 全体再起動 -> 失敗時は全体終了` の順で復旧を試行
- `yarn orchestrator:smoke` で Orchestrator の起動/復旧ロジックを検証可能

## 次フェーズ（実装計画）

- P8: Copilot SDK 実装
  - `BOT_MODE` による provider 切替で、実 SDK 実行へ切り替え可能にする
- P9: 運用品質
  - 監査ログ、冪等、バックアップ、監視復旧運用を整備

詳細は `docs/development/implementation-flow.md` を参照してください。
