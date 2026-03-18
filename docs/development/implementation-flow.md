# 実装フローガイド（次フェーズ）

このドキュメントは、現在の `apps/gateway/api` モック実装を起点に、  
`copilot-agent-system-design.md` / `copilot-agent-nodejs-requirements.md` に沿って
本実装へ進めるための具体手順をまとめたものです。

前提: Gateway 系（`apps/gateway/*`）は **ホストマシン上の Node.js プロセス**として実行し、  
Docker Compose は Agent / DB などコンテナが必要な要素に限定します。

---

## 1. 現在地（着手時点）

- 仕様・要件ドキュメントは作成済み
- リポジトリ構造は規定どおりに整備済み
- `apps/gateway/api` に Discord UX モック実装あり
- 本実装としては以下が未着手
  - Agent Runtime（Copilot SDK 実行）
  - Gateway MCP / Approval / State / Memory / Container Tools の実体
  - 永続層マイグレーション・運用ジョブ
  - Agent / DB 用 Docker Compose とホスト Gateway の実行統合

---

## 2. 実装順序（推奨）

| Phase | 目的 | 主担当ディレクトリ | 完了条件 |
|---|---|---|---|
| P1 | 実行基盤の固定 | ルート, `apps/gateway/api` | Compose で `agent/postgres` 起動 + ホスト Gateway 疎通 |
| P2 | 永続層の実装 | `apps/gateway/state`, `apps/gateway/memory` | マイグレーション適用と CRUD |
| P3 | Gateway API 実装 | `apps/gateway/api` | `/threads/*`, `/sessions`, `/approvals/*` が動作 |
| P4 | Approval 実装 | `apps/gateway/approvals` | Embed 承認が状態遷移に反映 |
| P5 | MCP + Tool Adapter 実装 | `apps/gateway/mcp`, `apps/gateway/container-tools` | `container.*` / `host.*` のポリシー制御 |
| P6 | Agent Runtime 実装 | `apps/agent` | `create/resume + sendAndWait(1回)` 実行 |
| P7 | 統合・復旧性 | 全体 | pause/resume, cancel, reboot をE2E確認 |
| P8 | 運用品質 | 全体 | 監査ログ、冪等、バックアップ運用を満たす |

---

## 3. Phase 詳細

### P1. 実行基盤（Compose + secrets）

1. `docker-compose.yml` を作成し、最低限 `agent` `postgres` を定義（Gateway は Compose に含めない）  
2. Compose 管理対象サービスに `healthcheck` と `depends_on` を設定  
3. ホスト実行の Gateway 起動と Compose 起動の双方で、シークレット注入を `op run` 経由に統一  
4. `.env.op` は `op://...` のみ（平文禁止）

成果物例:

- `docker-compose.yml`
- `.env.op.example`（値は `op://` 参照のみ）
- `apps/agent/Dockerfile`
- `apps/gateway/api` 起動スクリプト（host 実行前提）

---

### P2. 永続層（PostgreSQL）

1. マイグレーション基盤を追加（任意: `node-pg-migrate` / `drizzle` / `knex`）  
2. 要件書の最小テーブルを作成
   - `sessions`, `tasks`, `task_events`, `approvals`
   - `session_path_permissions`, `session_snapshots`
   - `memory_entries`, `audit_logs`
3. インデックス作成
   - `sessions(thread_id)` unique 推奨
   - `memory_entries(user_id, namespace, key)` unique
4. 保持ポリシー向けのクリーンアップジョブを追加

---

### P3. Gateway API（モック置換）

1. `apps/gateway/api` の in-memory 状態を DB ベースへ置換  
2. API と Discord Interaction を明確に分離
   - Controller（Discord）
   - Application Service（ユースケース）
   - Repository（DB）
3. 以下のハンドラを本実装化
   - `POST /v1/discord/mentions/start`
   - `POST /v1/threads/:threadId/messages`
   - `GET /v1/threads/:threadId/status`
   - `POST /v1/threads/:threadId/cancel`
   - `POST /v1/threads/:threadId/close`
   - `GET /v1/sessions`

---

### P4. Approval Manager

1. 承認要求の永続化（`approvals`）  
2. Discord Embed の Approve/Reject を `approval_id` に紐づけて反映  
3. `approval_timeout` をジョブで監視しステータス更新  
4. 判定結果を Agent へ返す橋渡しを追加

---

### P5. Gateway MCP + Tool Adapters

1. MCP endpoint を実装（`tool.call` 受信）  
2. ポリシー判定（allow / require_approval / deny）を実装  
3. ツールを2系統で分離
   - `container.*`（承認不要、セッション領域限定）
   - `host.*`（承認必須）
4. 必須エラーコードを統一
   - `external_mcp_disabled`
   - `approval_required`, `approval_rejected`, `approval_timeout`
   - `path_not_approved_for_session`, `container_path_out_of_scope`

---

### P6. Agent Runtime

1. `apps/agent` で Copilot SDK クライアントを実装  
2. 実行シーケンスを固定
   - `createSession` または `resumeSession`
   - `sendAndWait`（タスク本体 1 回）
3. `onPermissionRequest` と tool callback を Gateway に接続  
4. `session.idle` 時に `idle_waiting` へ遷移、無発言で `idle_paused`

---

### P7. 統合フロー確認（E2E）

最低限の通し確認:

1. チャンネルメンションでスレッド生成  
2. 承認が必要な host 操作で Embed 承認が出る  
3. 承認/拒否/タイムアウトが結果に反映される  
4. 10分無発言で `idle_paused`、次発言で自動再開  
5. `/cancel` `/close` `/exit` `/reboot` が期待動作  
6. Discord 再送時に二重起動しない（冪等）

---

### P8. 運用品質

1. 監査ログに `task_id/session_id/thread_id/correlation_id` を必須付与  
2. 起動時と障害時の通知を system channel へ送信  
3. バックアップ/リストア runbook を作成  
4. 障害注入（DB停止、承認未応答、SDK失敗）で復旧性を確認

---

## 4. 1タスクの実行フロー（実装時の参照）

1. Discord メンション受信  
2. スレッド作成・`session_id` 採番  
3. 添付をセッション領域へ配置  
4. Agent で `create/resume + sendAndWait`  
5. tool call ごとに Gateway ポリシー判定  
6. 承認が必要なら Embed で確認  
7. 結果をスレッド返信（LM出力は可能な限り生テキスト）  
8. `idle_waiting` 遷移、期限で `idle_paused`  
9. 次発言で `resumeSession + sendAndWait`

---

## 5. コミット運用（推奨）

- 小さく分割してフェーズごとにコミット
- 接頭辞は以下を使用
  - `[Add]` 新規追加
  - `[Change]` 振る舞い変更
  - `[Fix]` 不具合修正
  - `[Remove]` 削除
- メッセージは「理由重視・簡潔」

例:

- `[Add] Compose基盤を追加`
- `[Change] 承認判定を永続化へ変更`
- `[Fix] idle再開時の二重実行を修正`
