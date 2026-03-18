# 実装フローガイド（次フェーズ）

このドキュメントは、現在の `apps/gateway/api` モック実装を起点に、  
`copilot-agent-system-design.md` / `copilot-agent-nodejs-requirements.md` に沿って
本実装へ進めるための具体手順をまとめたものです。

前提: Gateway 系（`apps/gateway/*`）は **ホストマシン上の Node.js プロセス**として実行し、  
Docker Compose は Agent / DB などコンテナが必要な要素に限定します。

---

## 1. 現在地（着手時点）

- P1〜P6（基盤/永続層/Gateway API/Approval/MCP/Agent Runtime 基盤）は実装済み
- `apps/gateway/api` の Discord UX はモック実装として稼働済み
- `apps/agent` の Runtime は `create/resume + sendAndWait(1回)` を満たすが、SDK Provider は `mock` のみ実装済み
- 次フェーズで未着手なのは以下
  - Discord 経路と Agent Runtime API の本統合（Bot 主導オーケストレーション）
  - 実 Copilot SDK Provider 実装（`AGENT_SDK_PROVIDER=copilot`）
  - 統合後の運用品質（監査/冪等/復旧運用）強化

---

## 2. 実装順序（推奨）

| Phase | 目的 | 主担当ディレクトリ | 完了条件 |
|---|---|---|---|
| P1 | 実行基盤の固定 | ルート, `apps/gateway/api` | Compose で `agent/postgres` 起動 + ホスト Gateway 疎通 |
| P2 | 永続層の実装 | `apps/gateway/state`, `apps/gateway/memory` | マイグレーション適用と CRUD |
| P3 | Gateway API 実装 | `apps/gateway/api` | `/threads/*`, `/sessions`, `/approvals/*` が動作 |
| P4 | Approval + Bot連携実装 | `apps/gateway/approvals`, `apps/gateway/api` | Embed 承認が状態遷移と Bot オーケストレーションに反映 |
| P5 | MCP + Tool Adapter 実装 | `apps/gateway/mcp`, `apps/gateway/container-tools` | `container.*` / `host.*` のポリシー制御と Bot 経由実行が成立 |
| P6 | Agent Runtime 基盤実装 | `apps/agent`, `apps/gateway/api` | `create/resume + sendAndWait(1回)` と Gateway API 契約が成立（`mock` provider） |
| P7 | システム統合（Bot主導） | 全体 | Discord -> Gateway API -> Agent Runtime の実行導線が成立し、pause/resume/cancel/reboot をE2E確認 |
| P8 | Copilot SDK 実装 | `apps/agent`, `apps/gateway/mcp` | `AGENT_SDK_PROVIDER=copilot` で実 SDK 実行、tool callback/permission が Gateway 経由で成立 |
| P9 | 運用品質（Bot監視含む） | 全体 | 監査ログ、冪等、バックアップ、監視復旧運用を満たす |

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
3. `approval_timeout` は Bot 常駐プロセス側の監視ループで判定しステータス更新  
4. 承認結果イベントを Bot オーケストレータへ通知し、Agent 実行再開/中断へ接続

---

### P5. Gateway MCP + Tool Adapters

1. MCP endpoint を実装（`tool.call` 受信）  
2. ポリシー判定（allow / require_approval / deny）を実装  
3. ツールを2系統で分離
   - `container.*`（承認不要、セッション領域限定）
   - `host.*`（承認必須）
4. Bot オーケストレータ経由で実行制御（キャンセル/再試行/タイムアウト）を受け取れるようにする
5. 必須エラーコードを統一
   - `external_mcp_disabled`
   - `approval_required`, `approval_rejected`, `approval_timeout`
   - `path_not_approved_for_session`, `container_path_out_of_scope`

---

### P6. Agent Runtime 基盤（mock provider）

1. `apps/agent` で SDK Provider 抽象を実装し、`mock` provider を標準として動作確認可能にする  
2. 実行シーケンスを固定
    - `createSession` または `resumeSession`
    - `sendAndWait`（タスク本体 1 回）
3. `onPermissionRequest` と tool callback を Gateway（Approval/MCP）に接続  
4. `session.idle` 時に `idle_waiting` へ遷移、無発言で `idle_paused`  
5. Bot オーケストレータが Agent 実行の開始・監視・停止を管理できるインターフェースを整備

---

### P7. システム統合（Bot主導E2E）

最低限の通し確認:

1. Bot 起動時に `compose:up` -> `db:migrate` -> Gateway API 準備完了まで到達する  
2. チャンネルメンションでスレッド生成・セッション開始  
3. Bot が `POST /v1/agent/tasks/run` を呼び、Agent Runtime 実行を開始できる  
4. `GET /v1/agent/tasks/:taskId/status` / `POST /v1/agent/tasks/:taskId/cancel` と Bot 状態表示が同期する  
5. 承認が必要な host 操作で Embed 承認が出て、承認/拒否/タイムアウトが結果に反映される  
6. 10分無発言で `idle_paused`、次発言で自動再開  
7. `/cancel` `/close` `/exit` `/reboot` が期待動作  
8. gateway-api 停止/agent 異常時に Bot 監視ループが復旧を試行する  
9. Discord 再送時に二重起動しない（冪等）

---

### P8. Copilot SDK 実装（実 provider）

1. `apps/agent/src/runtime/sdkProvider.ts` に `copilot` provider を追加し、`mock` と切替可能にする  
2. `createSession` / `resumeSession` / `sendAndWait` を実 Copilot SDK に接続  
3. SDK の tool callback を Gateway MCP (`POST /v1/mcp/tool-call`) に統一委譲  
4. `onPermissionRequest` を必須化し、Gateway Approval の結果と整合させる  
5. SDK 失敗時のエラーコードを Runtime/Gateway/Discord 表示で一貫化する  
6. 検証を追加
   - `agent:smoke`（mock）を維持
   - 実 SDK 接続用の統合確認手順（手動または別 smoke）を定義
7. 完了条件: Discord からの1タスクが実 Copilot SDK 経由で最後まで完走し、tool call/approval/cancel が破綻しない

---

### P9. 運用品質

1. 監査ログに `task_id/session_id/thread_id/correlation_id` を必須付与  
2. 起動時と障害時の通知を system channel へ送信  
3. バックアップ/リストア runbook を作成  
4. 障害注入（DB停止、承認未応答、SDK失敗、gateway-api停止）で復旧性を確認  
5. Bot 監視ループの閾値・再起動回数・通知抑制の運用値を確定

---

## 4. 1タスクの実行フロー（実装時の参照）

1. Bot が Discord メンションを受信し、実行前チェック（compose/API health）を確認  
2. スレッド作成・`session_id` 採番  
3. 添付をセッション領域へ配置  
4. Bot オーケストレータ経由で Agent 実行（`create/resume + sendAndWait`）  
5. tool call ごとに Gateway ポリシー判定  
6. 承認が必要なら Embed で確認  
7. 結果をスレッド返信（LM出力は可能な限り生テキスト）  
8. `idle_waiting` 遷移、期限で `idle_paused`  
9. 次発言で Bot が `resumeSession + sendAndWait` を再開

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

---

## 6. ホスト常駐 Bot によるオーケストレーション/監視定義

運用形態は「Bot 部がホストで常駐し、Discord 入力を受けながらシステム全体をオーケストレーションする」方式を採用する。  
シェルスクリプト常駐は前提にしない。

### 6.1 実行モデル

- エントリポイントは Bot プロセス（Gateway 側）
- Bot 起動時に以下を順に実行
  1. `compose:up`（Agent/Postgres 起動）
  2. `db:migrate`
  3. `gateway-api` の起動（同一プロセス内モジュールまたは子プロセス）
  4. Discord 受信ループ開始
- 起動後は Bot が監視ループを持ち、health と compose 状態を継続確認する

### 6.2 Bot 内の責務分割（定義）

| モジュール | 役割 | 主な処理 |
|---|---|---|
| `Orchestrator` | 起動/停止統括 | 起動順序制御、終了処理、再起動制御 |
| `RuntimeSupervisor` | 子要素監視 | gateway-api・agent・postgres の稼働判定 |
| `HealthProbe` | 死活確認 | `/health` と `docker compose ps` の定期確認 |
| `RecoveryController` | 自動復旧 | 段階的再起動（API -> Compose） |
| `AlertDispatcher` | 障害通知 | system channel への通知送信 |

### 6.3 実行ポリシー

- 標準実行は 1Password 注入つきで行う  
  例: `op run --env-file=.env.op -- yarn start`
- Bot の内部からコマンドを呼ぶ場合は `:local` コマンドを使用（外側の `op run` 注入を前提）
- health 判定は以下を必須とする
  - `http://127.0.0.1:${GATEWAY_API_PORT:-3800}/health`
  - `http://127.0.0.1:3801/health`（Agent）
  - `docker compose ps` の `postgres` / `agent` 状態

### 6.4 監視・自動復旧ルール

- 監視間隔: 15 秒（既定）
- 連続失敗閾値: 3 回（既定）
- 閾値到達時:
  1. gateway-api の再起動を先行
  2. 回復しない場合は `docker compose restart agent postgres`
  3. それでも失敗する場合は system channel に障害通知

### 6.5 完了条件（P9 連携）

- Bot 1プロセス起動で全構成（Bot/Gateway API/Agent/Postgres）が稼働する
- Bot 内監視ループが障害時に自動復旧を試行し、失敗時に通知できる
- 再起動後に `db:migrate` と API health が通る
