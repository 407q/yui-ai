# Container Tool Adapter

P5 で `container.*` adapter を実装済みです。現状は API パッケージ内に統合しています。

- 実装場所: `apps/gateway/api/src/container-tools/adapter.ts`
- 対応ツール:
  - `container.file_read/write/delete/list`
  - `container.cli_exec`
- 制約:
  - `CONTAINER_SESSION_ROOT/<session_id>` 配下のみアクセス許可
  - canonical path（`/agent/session/<session_id>/...`）も同一セッション内に限り許可し、実体ルートへ解決
  - スコープ外パスは `container_path_out_of_scope` で拒否
