# Yui AI

Discord 上で動作する個人用 AI エージェントです。GitHub Copilot SDK を利用し、ユーザーからのタスクを自律的に実行します。

## 特徴

- **Discord 連携** — Bot をメンションしてセッション開始、スレッド内で継続対話
- **承認フロー** — ホストマシン操作や Discord API 呼び出しにはユーザー承認が必要
- **永続メモリ** — セッションをまたいで知識を保存・参照
- **自動復旧** — Orchestrator による障害検知と自動リカバリ

## 必要環境

| 項目 | 要件 |
|------|------|
| Node.js | **22 以上**（`node:sqlite` を使用） |
| Docker Compose | v2 |
| 1Password CLI | シークレット管理に使用（任意） |

## クイックスタート

```bash
# 依存インストール
yarn install

# 環境変数ファイル作成（1Password 使用時）
cp .env.op.example .env.op
# .env.op を編集

# スラッシュコマンド登録（初回のみ）
yarn register:commands

# 起動
yarn dev
```

詳細は [セットアップガイド](docs/guide/setup.md) を参照してください。

## ドキュメント

### ガイド

| ドキュメント | 内容 |
|-------------|------|
| [セットアップ](docs/guide/setup.md) | 環境構築・初回起動 |
| [Discord Bot 操作](docs/guide/discord-usage.md) | コマンド・承認フローの使い方 |
| [運用](docs/guide/operations.md) | 起動・停止・復旧・バックアップ |
| [Copilot CLI 権限再設定](docs/development/copilot-cli-permissions.md) | CLI再起動後の許可設定手順 |

### リファレンス

| ドキュメント | 内容 |
|-------------|------|
| [アーキテクチャ](docs/reference/architecture.md) | システム構成・データフロー |
| [環境変数](docs/reference/environment-variables.md) | 設定項目一覧 |
| [API エンドポイント](docs/reference/api-endpoints.md) | Gateway / Agent API 仕様 |
| [MCP ツール](docs/reference/mcp-tools.md) | 利用可能なツール一覧 |
| [トラブルシューティング](docs/reference/troubleshooting.md) | よくある問題と対処法 |

### 開発者向け

設計書・実装詳細は [docs/development/](docs/development/) を参照してください。

## プロジェクト構成

```
apps/
├── agent/           # Agent Runtime（Docker 内で実行）
│   └── src/runtime/ # Copilot SDK 統合・タスク実行
└── gateway/
    ├── api/         # Discord Bot + Gateway API（ホストで実行）
    │   └── src/
    │       ├── bot.ts           # Bot エントリポイント
    │       ├── server.ts        # Gateway API サーバー
    │       ├── orchestration/   # Orchestrator
    │       ├── mcp/             # MCP ツールサービス
    │       └── gateway/         # セッション・タスク管理
    └── state/       # 永続層（マイグレーション・ストア）
```

## 主要コマンド

| コマンド | 説明 |
|---------|------|
| `yarn dev` | Bot 起動（Orchestrator 込み） |
| `yarn dev:local` | 同上（1Password なし） |
| `yarn build` | TypeScript ビルド |
| `yarn compose:up` | Docker Compose 起動 |
| `yarn compose:down` | Docker Compose 停止 |
| `yarn db:migrate` | マイグレーション実行 |
| `yarn register:commands` | Discord コマンド登録 |

## ライセンス

Private
