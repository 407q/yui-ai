# Memory Tool (`apps/memtool`)

`memory_entries` / `memory_links` を一覧・詳細表示し、更新・削除を行う独立Webアプリです。

## Local 起動

```bash
yarn mem:dev:local
```

## 1Password 経由起動（失敗時は local へフォールバック）

```bash
yarn mem:dev
```

## 利用する DB 接続環境変数

優先順:
1. `MEMTOOL_DATABASE_URL`
2. `MEMORY_STORE_DSN`
3. `STATE_STORE_DSN`
4. `DATABASE_URL`

`INTERNAL_CONNECTION_MODE=uds` 時は既存の DB socket 設定（`POSTGRES_SOCKET_*`, `DB_SOCKET_MOUNT_PATH`）を利用します。
