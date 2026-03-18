# Approval Manager

P4/P5 で承認フローを実装済みです。

- API:
  - `POST /v1/threads/:threadId/approvals/request`
  - `POST /v1/approvals/:approvalId/respond`
- 永続化:
  - `approvals`
  - `session_path_permissions`
- P5 連携:
  - `host.*` tool call 実行時に承認状態を照合
  - 未承認時は `approval_required` / `approval_rejected` / `approval_timeout` / `path_not_approved_for_session` を返却
