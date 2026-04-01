# セットアップガイド

Yui AI を初めて起動するまでの手順を説明します。

## 目次

1. [必要環境](#必要環境)
2. [インストール](#インストール)
3. [Discord アプリケーションの作成](#discord-アプリケーションの作成)
4. [環境変数の設定](#環境変数の設定)
5. [初回起動](#初回起動)
6. [動作確認](#動作確認)

---

## 必要環境

| ツール | バージョン | 確認コマンド | 備考 |
|--------|-----------|-------------|------|
| Node.js | **22 以上** | `node -v` | Copilot SDK が `node:sqlite` を使用 |
| Yarn | 1.x | `yarn -v` | |
| Docker Compose | v2 | `docker compose version` | |
| 1Password CLI | 最新 | `op --version` | シークレット管理（任意） |

### Node.js 22 のインストール

```bash
# nvm を使用する場合
nvm install 22
nvm use 22

# 確認
node -v  # v22.x.x
```

---

## インストール

```bash
# リポジトリをクローン
git clone <repository-url>
cd yui-ai

# 依存関係をインストール
yarn install

# ビルド
yarn build
```

---

## Discord アプリケーションの作成

### 1. アプリケーション作成

1. [Discord Developer Portal](https://discord.com/developers/applications) にアクセス
2. 「New Application」をクリック
3. 名前を入力して作成

### 2. Bot 設定

1. 左メニュー「Bot」を選択
2. 「Reset Token」で **Bot Token** を取得（後で使用）
3. 「Privileged Gateway Intents」で以下を有効化:
   - **MESSAGE CONTENT INTENT** ✅

### 3. OAuth2 設定

1. 左メニュー「OAuth2」→「URL Generator」を選択
2. Scopes:
   - `bot`
   - `applications.commands`
3. Bot Permissions:
   - Read Messages/View Channels
   - Send Messages
   - Send Messages in Threads
   - Create Public Threads
   - Manage Threads
   - Read Message History
   - Attach Files
   - Add Reactions
4. 生成された URL でサーバーに招待

### 4. クライアント ID の確認

「General Information」ページの **Application ID** を控えておきます。

---

## 環境変数の設定

### 1Password を使用する場合（推奨）

```bash
cp .env.op.example .env.op
```

`.env.op` を編集し、1Password 参照を設定:

```bash
DISCORD_BOT_TOKEN="op://Vault/Item/token"
DISCORD_CLIENT_ID="123456789012345678"
COPILOT_GITHUB_TOKEN="op://Vault/Item/github_token"
# ...
```

### 直接指定する場合

```bash
cp .env.example .env
```

`.env` を編集して値を直接記入します。

UDS を使う既定構成では、以下を設定します。

```bash
GATEWAY_API_SOCKET_PATH=/tmp/sockets/gateway-api.sock
AGENT_RUNTIME_SOCKET_PATH=/tmp/sockets/agent-runtime.sock
AGENT_SOCKET_PATH=/tmp/sockets/agent-runtime.sock
AGENT_GATEWAY_API_SOCKET_PATH=/tmp/sockets/gateway-api.sock
RUNTIME_SOCKET_DIR=/tmp/sockets
INTERNAL_CONNECTION_MODE=tcp
POSTGRES_SOCKET_DIR=/tmp/postgres-socket
POSTGRES_SOCKET_PATH=/tmp/postgres-socket
POSTGRES_SOCKET_PORT=5432
DB_SOCKET_MOUNT_PATH=/tmp/postgres-socket
```

`INTERNAL_CONNECTION_MODE` は必須です。`tcp`（既定）または `uds` を設定してください。

### 必須の環境変数

| 変数 | 説明 |
|-----|------|
| `DISCORD_BOT_TOKEN` | Discord Bot トークン |
| `DISCORD_CLIENT_ID` | Discord アプリケーション ID |
| `COPILOT_GITHUB_TOKEN` | GitHub PAT（Copilot API アクセス用） |
| `POSTGRES_*` | データベース接続情報 |
| `*_INTERNAL_TOKEN` | コンポーネント間認証トークン |

詳細は [環境変数リファレンス](../reference/environment-variables.md) を参照。

---

## 初回起動

### 1. スラッシュコマンドの登録

Discord にコマンドを登録します（初回のみ）:

```bash
# 1Password 使用時
yarn register:commands

# 直接環境変数使用時
yarn register:commands:local
```

### 2. システム起動

Orchestrator が自動で以下を実行します:

1. Docker Compose 起動（PostgreSQL, Agent）
2. データベースマイグレーション
3. Gateway API 起動
4. ヘルスチェック

```bash
# 1Password 使用時
yarn dev

# 直接環境変数使用時
yarn dev:local
```

起動ログ例:

```
[Orchestrator] boot: compose up
[Orchestrator] boot: db migrate
[Orchestrator] boot: gateway-api start
[Orchestrator] boot: infrastructure is healthy
[bot:standard] Discord client ready as YuiAI#1234
```

---

## 動作確認

### Discord で動作確認

1. Bot を招待したサーバーのチャンネルで Bot をメンション:
   ```
   @YuiAI こんにちは
   ```
2. Bot がスレッドを作成し、応答を返すことを確認

### ヘルスチェック

```bash
# Gateway API (UDS)
curl --unix-socket /tmp/sockets/gateway-api.sock http://localhost/health

# Agent Runtime (UDS)
curl --unix-socket /tmp/sockets/agent-runtime.sock http://localhost/health
```

### スラッシュコマンド

スレッド内で以下のコマンドが使用可能:

- `/status` — セッション状態を表示
- `/cancel` — 実行中タスクをキャンセル
- `/close` — セッションを終了
- `/resume` — 終了したセッションを再開

---

## 次のステップ

- [Discord Bot 操作ガイド](discord-usage.md) — 詳しい使い方
- [環境変数リファレンス](../reference/environment-variables.md) — カスタマイズ
- [運用ガイド](operations.md) — 本番運用
