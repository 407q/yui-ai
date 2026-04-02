# トラブルシューティング

Yui AI のよくある問題と対処法です。

## 目次

1. [起動時の問題](#起動時の問題)
2. [Discord 関連](#discord-関連)
3. [Copilot SDK 関連](#copilot-sdk-関連)
4. [データベース関連](#データベース関連)
5. [ツール実行関連](#ツール実行関連)
6. [認証関連](#認証関連)
7. [デバッグ方法](#デバッグ方法)

---

## 起動時の問題

### `Cannot find module 'node:sqlite'`

**原因**: Node.js のバージョンが 22 未満

**解決策**:
```bash
# バージョン確認
node -v

# Node.js 22 をインストール
nvm install 22
nvm use 22
```

---

### `DISCORD_BOT_TOKEN is required`

**原因**: 環境変数が設定されていない

**解決策**:
1. `.env.op` または `.env` ファイルが存在するか確認
2. 必要な環境変数が設定されているか確認
3. 1Password を使用する場合は `op signin` でサインイン

```bash
# 環境変数の確認
cat .env.op

# 1Password サインイン
op signin
```

---

### `COPILOT_GITHUB_TOKEN is required when BOT_MODE=standard`

**原因**: Copilot SDK を使用する設定だが GitHub トークンがない

**解決策**:
1. `COPILOT_GITHUB_TOKEN` を設定
2. または `BOT_MODE=mock` に変更（テスト用）

---

### `Port 3800 already in use`

**原因**: 別のプロセスがポートを使用中

**解決策**:
```bash
# 使用中のプロセスを確認
lsof -i :3800

# プロセスを終了
kill <PID>
```

---

### `docker compose` 起動失敗

**原因**: Docker デーモンが起動していない、または環境変数不足（`INTERNAL_CONNECTION_MODE` 未設定/不正含む）

**解決策**:
```bash
# Docker の状態確認
docker info

# 接続モード確認（tcp / uds）
echo "$INTERNAL_CONNECTION_MODE"

# 手動で compose up
docker compose -f docker-compose.${INTERNAL_CONNECTION_MODE}.yml up -d

# ログ確認
docker compose -f docker-compose.${INTERNAL_CONNECTION_MODE}.yml logs
```

---

### `ENOENT` / `connect` で UDS に接続できない

**原因**: socket ファイルが未作成、またはパス不一致

**解決策**:
```bash
# socket ディレクトリ/ファイル確認
SOCKET_DIR="${RUNTIME_SOCKET_DIR:-${XDG_RUNTIME_DIR:-/tmp}/yui-ai}"
ls -la "$SOCKET_DIR"

# Gateway health (UDS)
curl --unix-socket "$SOCKET_DIR/gateway-api.sock" http://localhost/health

# Agent health (UDS)
curl --unix-socket "$SOCKET_DIR/agent-runtime.sock" http://localhost/health

# 再起動で再作成
yarn compose:down && yarn compose:up
```

---

## Discord 関連

### Bot が応答しない

**確認項目**:
1. Bot Token が有効か（Developer Portal で確認）
2. MESSAGE CONTENT INTENT が有効か
3. Bot がサーバーに招待されているか
4. `yarn dev` のログにエラーがないか

**ログ確認**:
```bash
yarn dev 2>&1 | tee bot.log
```

---

### スラッシュコマンドが表示されない

**原因**: コマンドが登録されていない

**解決策**:
```bash
# コマンドを登録
yarn register:commands

# ギルド指定の場合は DISCORD_GUILD_ID を設定
```

**注意**: グローバルコマンドの反映には最大 1 時間かかる場合があります。

---

### 承認ボタンが機能しない

**確認項目**:
1. Bot のインタラクション権限
2. 承認タイムアウト（デフォルト 120 秒）
3. セッション状態（`/status` で確認）

---

## Copilot SDK 関連

### タスクがタイムアウトする

**原因**: `COPILOT_SEND_TIMEOUT_MS` を超えた

**解決策**:
1. タイムアウト値を延長
   ```bash
   COPILOT_SEND_TIMEOUT_MS=300000  # 5分
   ```
2. タスクを分割して投入

---

### `BOT_MODE=standard` でエラー

**確認項目**:
1. Node.js 22 以上か
2. `COPILOT_GITHUB_TOKEN` が有効か
3. GitHub Copilot へのアクセス権があるか

**テスト**:
```bash
# mock モードで動作確認
BOT_MODE=mock yarn dev
```

---

## データベース関連

### `Connection refused`

**原因**: PostgreSQL が起動していない

**解決策**:
```bash
# compose 状態確認
docker compose -f docker-compose.${INTERNAL_CONNECTION_MODE}.yml ps

# PostgreSQL を起動
docker compose -f docker-compose.${INTERNAL_CONNECTION_MODE}.yml up -d postgres

# 接続確認
docker compose -f docker-compose.${INTERNAL_CONNECTION_MODE}.yml exec postgres pg_isready
```

---

### `getaddrinfo ENOTFOUND postgres`

**原因**: ホスト上プロセス（`db:migrate` / `api:smoke` / `agent:smoke`）が、コンテナ内向け DSN（`host=postgres`）をそのまま使っている

**解決策**:
```bash
# まず DSN の host/port を確認
echo "$STATE_STORE_DSN"

# ホスト実行時は明示上書き（推奨）
POSTGRES_HOST=127.0.0.1 POSTGRES_PORT=55432 yarn db:migrate:local
```

補足:
- 現在の実装では、`POSTGRES_HOST/PORT` 未指定でも **host実行時に DSN の `postgres:5432` を自動で `127.0.0.1:55432` へ補正** します。
- コンテナ内実行時は補正しません（`postgres:5432` のまま）。

---

### マイグレーションエラー

**解決策**:
```bash
# 手動でマイグレーション
yarn db:migrate

# PostgreSQL ログ確認
docker compose -f docker-compose.${INTERNAL_CONNECTION_MODE}.yml logs postgres

# マイグレーション状態確認
docker compose -f docker-compose.${INTERNAL_CONNECTION_MODE}.yml exec postgres psql -U yui -d yui_ai -c "SELECT * FROM migrations;"
```

---

### `relation "sessions" does not exist`

**原因**: マイグレーションが実行されていない

**解決策**:
```bash
yarn db:migrate
```

---

## ツール実行関連

### `container_path_out_of_scope`

**原因**: アクセスしようとしたパスがセッションスコープ外

**解決策**:
- コンテナツールはセッション作業ディレクトリ内のみアクセス可能
- ホストファイルにアクセスする場合は `host.file_read` を使用（承認必要）

---

### `host_command_not_allowed`

**原因**: コマンドが allowlist にない

**解決策**:
```bash
# allowlist を確認/拡張
HOST_CLI_ALLOWLIST=git,node,npm,yarn,curl,python
```

---

### `policy_denied_command`

**原因**: ポリシーでコマンドが拒否された

**解決策**:
- 許可されたコマンドのみ使用
- `HOST_CLI_ALLOWLIST` を確認

---

### `host_scope_not_allowed` / 承認が通らない

**原因**: ホスト操作の承認が行われていない

**解決策**:
1. Discord で承認ボタンをクリック
2. 承認タイムアウト前に応答
3. セッション状態を確認（`/status`）

---

## 認証関連

### `internal_auth_required`

**原因**: 内部 API トークンが不正または未設定

**解決策**:
1. 以下の環境変数が全て設定されているか確認:
   - `BOT_TO_GATEWAY_INTERNAL_TOKEN`
   - `GATEWAY_TO_AGENT_INTERNAL_TOKEN`
   - `AGENT_TO_GATEWAY_INTERNAL_TOKEN`
2. 各コンポーネントで同じ値が使用されているか確認

---

### `session_not_owned`

**原因**: 他のユーザーのセッションにアクセスしようとした

**解決策**:
- 自分が開始したセッション（スレッド）で操作

---

## デバッグ方法

### ログレベルを上げる

```bash
LOG_LEVEL=debug COPILOT_SDK_LOG_LEVEL=debug yarn dev
```

### 各コンポーネントのログ確認

```bash
# Agent
docker compose -f docker-compose.${INTERNAL_CONNECTION_MODE}.yml logs agent -f --tail 100

# PostgreSQL
docker compose -f docker-compose.${INTERNAL_CONNECTION_MODE}.yml logs postgres -f --tail 100

# 全て
docker compose -f docker-compose.${INTERNAL_CONNECTION_MODE}.yml logs -f --tail 100
```

### ヘルスチェック

```bash
# Gateway API
curl -s http://127.0.0.1:3800/health | jq

# Agent Runtime
curl -s http://127.0.0.1:3801/health | jq

# PostgreSQL
docker compose -f docker-compose.${INTERNAL_CONNECTION_MODE}.yml exec postgres pg_isready
```

### Smoke テスト

```bash
# Gateway API テスト
yarn api:smoke

# Agent Runtime テスト
yarn agent:smoke

# Orchestrator テスト
yarn orchestrator:smoke

# データベーステスト
yarn db:smoke
```

### Mock モードでの動作確認

Copilot SDK を使用せずに動作確認:

```bash
BOT_MODE=mock yarn dev
```

---

## エラーコード一覧

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
| `host_scope_not_allowed` | 400 | ホスト操作が未承認 |
| `discord_scope_not_allowed` | 400 | Discord 操作が未承認 |
| `memory_system_entry_read_only` | 400 | システムメモリへの書き込み |
| `external_mcp_disabled` | 400 | 外部 MCP が無効 |
| `copilot_token_missing` | 500 | Copilot トークンがない |
| `copilot_node_version_unsupported` | 500 | Node.js バージョンが古い |

---

## サポート

問題が解決しない場合:
1. ログを収集
2. 再現手順を整理
3. Issue を作成
