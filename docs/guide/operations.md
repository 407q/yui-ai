# 運用ガイド

Yui AI の起動・停止・復旧・バックアップについて説明します。

## 目次

1. [起動と停止](#起動と停止)
2. [Orchestrator](#orchestrator)
3. [ヘルスチェック](#ヘルスチェック)
4. [障害復旧](#障害復旧)
5. [データベース管理](#データベース管理)
6. [バックアップ](#バックアップ)
7. [アップデート](#アップデート)

---

## 起動と停止

### 通常起動

```bash
# 1Password 使用時
yarn dev

# 直接環境変数使用時
yarn dev:local
```

Orchestrator が自動で以下を実行します:
1. `docker compose -f docker-compose.${INTERNAL_CONNECTION_MODE}.yml up -d --build`
2. `yarn db:migrate`
3. Gateway API 起動
4. ヘルスチェック

`INTERNAL_CONNECTION_MODE`（`tcp`/`uds`）は必須です。

### プロダクションビルドからの起動

```bash
yarn build
yarn start      # 1Password 使用時
yarn start:local  # 直接環境変数使用時
```

### 安全な停止

**推奨: Discord から `/exit` コマンドを使用**

```
/exit
```

手動停止:

```bash
# Ctrl+C で Bot を停止後
yarn compose:down
```

### 再起動

Discord から `/reboot` コマンドを使用:

```
/reboot
```

---

## Orchestrator

Orchestrator は Bot 起動時に自動で動作し、以下を担当します:

- **インフラ起動**: Docker Compose, マイグレーション, Gateway API
- **監視**: 定期的なヘルスチェック（デフォルト: 15秒間隔）
- **障害復旧**: 自動リカバリ
- **クリーンアップ**: 古いデータの定期削除（デフォルト: 24時間間隔）

### 設定

| 環境変数 | デフォルト | 説明 |
|---------|-----------|------|
| `BOT_ORCHESTRATOR_ENABLED` | `true` | Orchestrator の有効化 |
| `BOT_ORCHESTRATOR_MONITOR_INTERVAL_SEC` | `15` | 監視間隔（秒） |
| `BOT_ORCHESTRATOR_FAILURE_THRESHOLD` | `3` | 復旧開始までの失敗回数 |
| `BOT_ORCHESTRATOR_COMMAND_TIMEOUT_SEC` | `240` | コマンドタイムアウト（秒） |
| `BOT_ORCHESTRATOR_CLEANUP_ENABLED` | `true` | クリーンアップの有効化 |
| `BOT_ORCHESTRATOR_CLEANUP_INTERVAL_SEC` | `86400` | クリーンアップ間隔（秒） |

### アラート

`BOT_SYSTEM_ALERT_CHANNEL_ID` を設定すると、障害検知時に通知を受け取れます:

```
⚠️ [orchestrator] health degraded, starting recovery: ...
✅ [orchestrator] recovered after targeted restart.
```

---

## ヘルスチェック

### 手動チェック

```bash
# Gateway API (UDS)
curl --unix-socket /tmp/sockets/gateway-api.sock http://localhost/health

# Agent Runtime (UDS)
curl --unix-socket /tmp/sockets/agent-runtime.sock http://localhost/health

# PostgreSQL
docker compose -f docker-compose.${INTERNAL_CONNECTION_MODE}.yml exec postgres pg_isready
```

### ヘルスチェック対象

| コンポーネント | エンドポイント | チェック内容 |
|---------------|---------------|-------------|
| Gateway API | `/tmp/sockets/gateway-api.sock + GET /health` | HTTP 200 応答 |
| Agent Runtime | `/tmp/sockets/agent-runtime.sock + GET /health` | HTTP 200 応答 |
| PostgreSQL | `pg_isready` | 接続可能性 |

---

## 障害復旧

### 自動復旧フロー

Orchestrator は以下の順序で復旧を試みます:

1. **対象コンポーネントの再起動**
   - Gateway 停止 → Gateway 再起動
   - Agent 停止 → `docker compose -f docker-compose.${INTERNAL_CONNECTION_MODE}.yml restart agent postgres` + `db:migrate`

2. **全体再起動**
   - `docker compose -f docker-compose.${INTERNAL_CONNECTION_MODE}.yml down` → `docker compose -f docker-compose.${INTERNAL_CONNECTION_MODE}.yml up` → `db:migrate` → Gateway 起動

3. **致命的障害**
   - 復旧失敗 → アラート送信 → プロセス終了

### 手動復旧

**Agent が応答しない:**

```bash
docker compose -f docker-compose.${INTERNAL_CONNECTION_MODE}.yml logs agent --tail 100
docker compose -f docker-compose.${INTERNAL_CONNECTION_MODE}.yml restart agent
```

**PostgreSQL が応答しない:**

```bash
docker compose -f docker-compose.${INTERNAL_CONNECTION_MODE}.yml logs postgres --tail 100
docker compose -f docker-compose.${INTERNAL_CONNECTION_MODE}.yml restart postgres
```

**Gateway が応答しない:**

```bash
# Bot を停止 (Ctrl+C)
yarn dev  # 再起動
```

---

## データベース管理

### マイグレーション

```bash
yarn db:migrate       # 1Password 使用時
yarn db:migrate:local # 直接環境変数使用時
```

マイグレーションファイル: `apps/gateway/state/migrations/`

### クリーンアップ

古いデータを削除します:

```bash
yarn db:cleanup       # 1Password 使用時
yarn db:cleanup:local # 直接環境変数使用時
```

保持期間は環境変数で設定:
- `TASK_EVENTS_RETENTION_DAYS`: タスクイベント（デフォルト: 90日）
- `AUDIT_LOGS_RETENTION_DAYS`: 監査ログ（デフォルト: 180日）

### 接続確認

```bash
# psql で接続
docker compose -f docker-compose.${INTERNAL_CONNECTION_MODE}.yml exec postgres psql -U <user> -d <database>

# テーブル一覧
\dt

# セッション数
SELECT status, COUNT(*) FROM sessions GROUP BY status;
```

---

## バックアップ

### データベースバックアップ

```bash
# バックアップ
docker compose -f docker-compose.${INTERNAL_CONNECTION_MODE}.yml exec postgres pg_dump -U <user> <database> > backup.sql

# 圧縮バックアップ
docker compose -f docker-compose.${INTERNAL_CONNECTION_MODE}.yml exec postgres pg_dump -U <user> <database> | gzip > backup.sql.gz
```

### リストア

```bash
# Bot を停止

# リストア
cat backup.sql | docker compose -f docker-compose.${INTERNAL_CONNECTION_MODE}.yml exec -T postgres psql -U <user> <database>

# Bot を再起動
yarn dev
```

### 定期バックアップ（cron 例）

```bash
# crontab -e
0 3 * * * cd /path/to/yui-ai && docker compose -f docker-compose.${INTERNAL_CONNECTION_MODE}.yml exec -T postgres pg_dump -U yui yui_ai | gzip > /backups/yui_$(date +\%Y\%m\%d).sql.gz
```

---

## アップデート

### 通常のアップデート

```bash
# 1. Bot を停止（/exit または Ctrl+C）

# 2. 最新版を取得
git pull

# 3. 依存関係を更新
yarn install

# 4. ビルド
yarn build

# 5. マイグレーション（必要な場合）
yarn db:migrate

# 6. 起動
yarn dev
```

### Docker イメージの再ビルド

```bash
yarn compose:down
docker compose -f docker-compose.${INTERNAL_CONNECTION_MODE}.yml build --no-cache
yarn dev
```

---

## ログ確認

### Bot / Gateway

```bash
# フォアグラウンド実行時はターミナルに出力

# デバッグレベル
LOG_LEVEL=debug yarn dev
```

### Agent

```bash
docker compose -f docker-compose.${INTERNAL_CONNECTION_MODE}.yml logs agent -f --tail 100
```

### PostgreSQL

```bash
docker compose -f docker-compose.${INTERNAL_CONNECTION_MODE}.yml logs postgres -f --tail 100
```

### 全コンポーネント

```bash
docker compose -f docker-compose.${INTERNAL_CONNECTION_MODE}.yml logs -f --tail 100
```

---

## 次のステップ

- [トラブルシューティング](../reference/troubleshooting.md) — よくある問題
- [環境変数リファレンス](../reference/environment-variables.md) — 設定の調整
