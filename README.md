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
