# Container Tool Adapter

P5 で `container.*` adapter を実装済みです。現状は API パッケージ内に統合しています。

- 実装場所: `apps/gateway/api/src/container-tools/adapter.ts`
- 対応ツール:
  - `container.file_read/write/delete/list/deliver`
  - `container.cli_exec`
- 制約:
  - `CONTAINER_SESSION_ROOT/<session_id>` 配下のみアクセス許可
  - canonical path（`/agent/session/<session_id>/...`）も同一セッション内に限り許可し、実体ルートへ解決
  - スコープ外パスは `container_path_out_of_scope` で拒否
- 実行モード:
  - 既定は `CONTAINER_TOOL_EXECUTION_MODE=docker_exec`
  - `docker exec` で `AGENT_CONTAINER_NAME`（既定: `yui-ai-agent`）内の `/agent/session` を直接操作
  - `CONTAINER_TOOL_EXECUTION_MODE=host` を指定した場合のみ、Gateway ホスト上の `CONTAINER_SESSION_ROOT` を直接操作

`container.file_deliver` は対象ファイルを base64 で返却し、Bot 側が Discord 添付として送信します。
サイズは呼び出し時 `maxBytes` と Bot 側 `BOT_DELIVERED_FILE_MAX_BYTES` で二重制限されます。
