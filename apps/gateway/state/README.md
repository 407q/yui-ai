# Session State Store

`apps/gateway/state` は PostgreSQL ベースの State Store 実装を配置します。

## 実装内容（P2）

- `migrations/0001_initial_schema.sql`
  - `sessions`, `tasks`, `task_events`, `approvals`
  - `session_path_permissions`, `session_snapshots`
  - `memory_entries`, `audit_logs`
  - 推奨インデックス
- `src/migrate.ts`: マイグレーション適用
- `src/stateStore.ts`: セッション/タスク/承認/監査の CRUD
- `src/cleanup.ts`: 保持ポリシー向けクリーンアップ
- `src/smoke.ts`: P2 の疎通検証

## 実行コマンド

```bash
yarn db:migrate
yarn db:cleanup
yarn db:smoke
```

1Password 経由:

```bash
op run --env-file=.env.op -- yarn db:migrate
```
