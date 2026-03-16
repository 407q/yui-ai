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

仕様ドキュメント:

- `copilot-agent-system-design.md`
- `copilot-agent-nodejs-requirements.md`

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
