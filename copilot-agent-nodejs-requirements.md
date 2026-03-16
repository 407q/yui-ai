# 個人用 AI エージェント Node.js 実装要件定義書

関連設計: `copilot-agent-system-design.md`

---

## 1. 目的と制約

GitHub Copilot SDK を用いた個人用 AI エージェントを Node.js で実装する。  
必須制約:

- ツール実行は **Gateway 経由のみ**
- 外部 MCP サーバーは **使用しない**
- Copilot SDK は **create/resume + sendAndWait(1回)** で実行する
- 実行基盤は **Docker Compose** を用いる
- シークレット注入は **1Password CLI (`op run`)** 経由で行う
- ホスト上のファイル/CLI操作は **read を含め全操作で承認必須**
- 添付ファイルは Agent コンテナへ転送し、LM が自由に読み書き可能
- Agent コンテナ内の CLI（Python 等）によるファイル操作・解析は **承認不要** とする
- セッション再開可能な State 永続化を持つ
- セッション開始は **チャンネルメンション起点 + スレッド運用**
- セッションは **`/close` で明示終了、10分無発言で `idle_paused` へ自動停止し次発言で自動再開**
- 永続 Memory をツールとして提供する

---

## 1.1 SDK 呼び出しモデル（実装実情）

- 1タスクの実行は「`createSession` または `resumeSession`」と「`sendAndWait`」の2段階で行う
- 本要件での「1回実行」は **タスク本体の `sendAndWait` 呼び出しが1回** であることを意味する
- SDK 側仕様として、`createSession` / `resumeSession` には `onPermissionRequest` ハンドラを渡す
- `sendAndWait` 実行中に発生する Agentic な tool call は Gateway 側ポリシーで制御する
- `sendAndWait` 完了後もセッションは即終了せず、ユーザー追加入力待ち状態を維持する

---

## 2. スコープ

### 2.1 In Scope

- Discord Bot / チャンネルメンション起動 + スレッドコマンド
- Gateway API / MCP Endpoint / Policy / Approval
- Agent Runtime（Docker）
- Attachment 転送とコンテナ配置
- Container Tool Adapters（FS / CLI）
- Host Tool Adapters（FS / CLI / HTTP）
- Session State Store と Resume
- Memory Tool（永続）

### 2.2 Out of Scope

- 外部 MCP 連携
- GUI 管理画面
- マルチテナント課金
- Discord Developer Portal 上の App 設定作業（ユーザー実施）

---

## 3. 技術要件

### 3.1 ランタイム

- Node.js: **22 LTS 以上**
- TypeScript: **5.x**, `strict: true`
- モジュール: ESM

### 3.2 パッケージ管理

- **Yarn Classic 1.x を採用**（ユーザー要望）
- `yarn.lock` を唯一のロックファイルとして運用
- `pnpm-lock.yaml` / `package-lock.json` は生成・運用しない
- ワークスペース利用時は Yarn 1 互換構成に限定

### 3.3 推奨ライブラリ

- API: Fastify
- バリデーション: zod
- ログ: pino
- HTTP: undici（または Node fetch）
- CLI 実行: execa
- Discord: discord.js

### 3.4 コンテナ実行基盤（Docker Compose）

- Docker Compose v2 で構成管理すること
- 最低限のサービス: `gateway`, `agent`, `postgres`
- `gateway` と `agent` は同一 Compose ネットワーク内で名前解決可能であること
- 永続ボリューム例: `postgres_data`, `attachment_data`, `gateway_state`
- `depends_on + healthcheck` で起動順序を制御すること

### 3.5 シークレット管理（1Password CLI）

- 機密値は 1Password 管理とし、実行時に `op run` で環境変数注入すること
- Compose 起動は `op run --env-file=.env.op -- docker compose ...` 形式で行うこと
- `.env.op` は `op://` 参照のみを保持し、平文シークレットを置かないこと
- 非対話実行（サーバー/CI）は `OP_SERVICE_ACCOUNT_TOKEN` を利用可能にすること

---

## 4. 論理コンポーネント要件

### 4.1 Agent Runtime（`apps/agent`）

- `createSession` または `resumeSession` でセッションを確立し、タスク本体は `sendAndWait` を1回実行すること
- ツール実行は SDK の tool callback 経由で Gateway MCP に委譲すること
- `execution_target !== "gateway_adapter"` は即時拒否すること
- `approval_required` / `deny` を受けた結果を同一 SDK 実行内の文脈に返すこと

### 4.2 Gateway API（`apps/gateway/api`）

- チャンネルメンション起点のタスク開始（スレッド作成）API を提供すること
- スレッド単位の状態参照、キャンセル、明示終了（`/status` `/cancel` `/close`）API を提供すること
- スレッド 10 分無発言で `idle_paused` へ遷移させ、同一スレッド発言で自動再開すること
- Discord Interaction（スラッシュコマンド + Embed 操作）と連携すること

### 4.3 Gateway MCP Endpoint（`apps/gateway/mcp`）

- tool call 受口、Policy 判定、Adapter 実行、結果返却を担うこと
- 外部 MCP 宛の要求を `external_mcp_disabled` で拒否すること

### 4.4 Attachment Service（`apps/gateway/attachments`）

- Discord 添付を受信し、セッション単位で Agent コンテナへ配置すること
- 配置先例: `/agent/session/<session_id>/attachments`
- 添付領域内ファイルは LM が read/write 可能であること
- コンテナ作業領域（例: `/agent/session/<session_id>/workspace`）を準備できること
- `container.file_*` / `container.cli_exec` の入出力がこの領域で完結すること

### 4.5 Approval Manager（`apps/gateway/approvals`）

- 承認対象: `host.file_read/write/delete/list`, `host.cli_exec`, 必要な `host.http_request`
- 承認単位: **セッション + パス（ファイル/ディレクトリ）+ 操作**
- 承認 UI は Discord Embed（Approve / Reject）で提供すること
- 応答: `approval_granted` / `approval_rejected` / `approval_timeout`
- `container.file_*` / `container.cli_exec` は承認対象外であること

### 4.6 Session State Store（`apps/gateway/state`）

- セッション再開に必要な状態を永続化すること
- `last_thread_activity_at` と `idle_deadline_at` を永続化すること
- SDK の復元機能が利用可能なら併用可。ただし **アプリ側保存は必須**

### 4.7 Memory Service（`apps/gateway/memory`）

- 永続記憶ツール群を提供すること（`memory.upsert/search/get/delete`）
- `user_id + namespace` で論理分離すること

### 4.8 Container Tool Adapter（`apps/gateway/container-tools`）

- `container.file_read/write/delete/list` を提供すること
- `container.cli_exec` を提供し、`python` / `python3` を含む CLI を実行可能にすること
- 実行スコープを対象セッションのコンテナ領域に固定すること

---

## 5. 機能要件（Functional Requirements）

| ID | 要件 |
|---|---|
| FR-001 | チャンネルでの `@Bot` メンション受付時に `task_id` と `session_id` を発行し、対応スレッドを作成する |
| FR-002 | Agent は 1 タスクにつき `createSession/resumeSession` 後、`sendAndWait` を1回だけ実行する |
| FR-003 | SDK 実行中の tool call はすべて Gateway MCP にルーティングする |
| FR-004 | `tool_routing.mode=gateway_only` を強制する |
| FR-005 | 外部 MCP 指定は `external_mcp_disabled` で拒否する |
| FR-006 | 添付ファイルを Agent コンテナに転送し、LM が自由に read/write できる |
| FR-007 | `host.file_*` 全操作は承認必須とする |
| FR-008 | 承認済みでないパスへのアクセスは `path_not_approved_for_session` を返す |
| FR-009 | ホストファイル操作に workspace 制限を設けない（承認ベース制御） |
| FR-010 | `host.cli_exec`（ホスト）は承認必須かつコマンド allowlist 制御する |
| FR-011 | 承認要求を Discord Embed で Approve/Reject できる |
| FR-012 | `approval_timeout` を扱い、Agent に返せる |
| FR-013 | スレッド内 `/status` で進捗（queued/running/waiting_approval/idle_waiting/idle_paused/completed/failed/closed_by_user）取得可能 |
| FR-014 | スレッド内 `/cancel` で実行中タスクを停止できる |
| FR-015 | `idle_paused` セッションは同一スレッドの新規ユーザー発言で自動再開できる |
| FR-016 | セッション再開に必要な state snapshot を永続化する |
| FR-017 | `memory.upsert/search/get/delete` を tool として利用可能にする |
| FR-018 | 全 tool call の判定・結果を `audit_logs` に記録する |
| FR-019 | 全主要イベントを `task_events` に記録する |
| FR-020 | 最終回答に「結果・実行操作・未実施理由」を含める |
| FR-021 | `createSession/resumeSession` 実行時に `onPermissionRequest` ハンドラを必須設定する |
| FR-022 | `sendAndWait` 完了後もセッションを継続し、即終了しない |
| FR-023 | スレッド内 `/close` 実行時にセッションを `closed_by_user` で終了できる |
| FR-024 | スレッド内ユーザー発言が10分ない場合、セッションを `idle_paused` へ自動遷移できる |
| FR-025 | アイドルタイマーは同一スレッドのユーザー発言（通常メッセージおよびスレッド内コマンド）で再計算される |
| FR-026 | `container.file_*` は承認不要で実行できる（スコープはセッションのコンテナ領域に限定） |
| FR-027 | `container.cli_exec` は承認不要で実行でき、Python を含む CLI でファイル解析を行える |
| FR-028 | Docker Compose で `gateway` `agent` `postgres` を起動し、サービス間疎通できる |
| FR-029 | 実行時シークレットは `op run` 経由でのみ注入する |
| FR-030 | 永続層は PostgreSQL を主DBとして実装し、`sessions/tasks/approvals/events/memory/audit` を保持する |
| FR-031 | Discord メッセージ/Interaction の重複配送を冪等に処理し、タスク二重起動を防止する |

---

## 6. Discord インターフェース要件

| コマンド | 説明 | 引数 |
|---|---|---|
| `@Bot <prompt>`（チャンネル） | 新規セッション開始（スレッド生成） | `prompt`（必須）, `attachments`（任意） |
| `/status`（スレッド内） | 対応セッション状態照会 | なし |
| `/cancel`（スレッド内） | 対応セッションのタスク停止 | なし |
| `/close`（スレッド内） | 対応セッション終了 | なし |
| `/list` | セッション一覧 | なし |

状態表示要件:

- `/status` は最新ステップ、待機理由、最終更新時刻を返す
- `waiting_approval` の場合、`approval_id` と対象操作を表示する
- `idle_waiting` / `idle_paused` の場合、`idle_deadline_at` と再開方法（同一スレッドで発言）を表示する

---

## 7. API / メッセージ契約要件

### 7.1 Gateway API

- `POST /v1/discord/mentions/start`
- `POST /v1/threads/:threadId/messages`
- `GET /v1/threads/:threadId/status`
- `POST /v1/threads/:threadId/cancel`
- `POST /v1/threads/:threadId/close`
- `GET /v1/sessions`
- `POST /v1/approvals/:approvalId/respond`

### 7.2 SDK -> Gateway MCP (`tool.call`) 必須項目

- `task_id`
- `session_id`
- `call_id`
- `tool_name`（`container.*` / `host.*` / `memory.*`）
- `execution_target`（`gateway_adapter` 固定）
- `arguments`
- `reason`

### 7.3 標準エラーコード

- `external_mcp_disabled`
- `approval_required`
- `approval_rejected`
- `approval_timeout`
- `path_not_approved_for_session`
- `container_path_out_of_scope`
- `policy_denied_command`
- `invalid_tool_arguments`
- `tool_execution_failed`

---

### 7.4 SDK 呼び出しシーケンス要件

1. `createSession`（新規）または `resumeSession`（再開）を呼ぶ  
2. タスク本体を `sendAndWait` で1回実行する  
3. `session.idle` 到達後、セッション状態を `idle_waiting` に遷移する  
4. スレッド内ユーザー発言が10分ない場合、セッション状態を `idle_paused` に遷移する  
5. `idle_paused` 後の同一スレッド発言で `resumeSession + sendAndWait` を実行する  
6. スレッド内 `"/close"` 実行時に `closed_by_user` で終了する

### 7.5 セッション停止・終了条件要件

- 明示終了: スレッド内 `/close` により `closed_by_user`
- 自動停止: 直近スレッドユーザー発言から10分経過で `idle_paused`
- 自動再開: `idle_paused` 後の同一スレッド発言で再開
- タイマーはスレッド内のユーザー発言時に更新する

---

## 8. ポリシー要件

### 8.1 ルーティング

- `allow_external_mcp: false` を固定
- 起動時に外部 MCP 設定が存在すればエラー終了

### 8.2 コンテナ内操作（承認不要）

- 対象: `container.file_read/write/delete/list`, `container.cli_exec`
- 実行範囲: `/agent/session/<session_id>/attachments` および `/agent/session/<session_id>/workspace` 配下
- Python を含む CLI 実行を許可する
- コンテナ外パス指定は `container_path_out_of_scope` で拒否する

### 8.3 ホストファイル承認

- 対象: read/write/delete/list すべて
- 承認単位: `session_id + path + operation`
- path はファイル単位またはディレクトリ単位で許可可能
- 未承認なら必ず拒否

### 8.4 ホスト CLI

- allowlist（例: `git`, `node`, `npm`, `yarn`, `curl`）
- 承認必須
- 実行タイムアウト（例: 60 秒）

---

## 9. State 永続化・再開要件

保存対象:

- 入力、SDK 実行メタ、出力
- tool call/result 履歴
- 承認履歴
- セッション要約
- セッションライフサイクルイベント（`idle_paused` / `resumed` / `closed_by_user`）
- `last_thread_activity_at` / `idle_deadline_at`

再開要件:

- `session_id` 指定で復元できる
- 中断時点の pending approval を復元できる
- SDK ネイティブ復元が使えない場合でも、アプリ側保存データのみで再開可能にする

---

## 10. Memory ツール要件

### 10.1 提供ツール

- `memory.upsert({namespace, key, value, tags[]})`
- `memory.search({namespace, query, limit})`
- `memory.get({namespace, key})`
- `memory.delete({namespace, key})`

### 10.2 データ要件

- 永続化必須（プロセス再起動後も保持）
- `user_id` 境界でアクセス制御
- 監査ログ記録（read/write/delete）

---

## 11. データモデル要件（最小）

- `sessions(session_id, user_id, channel_id, thread_id, status, last_thread_activity_at, idle_deadline_at, closed_reason, closed_at, created_at, updated_at)`
- `tasks(task_id, session_id, user_id, status, created_at, updated_at)`
- `task_events(event_id, task_id, event_type, payload_json, timestamp)`
- `approvals(approval_id, task_id, session_id, operation, path, status, requested_at, responded_at, responder_id)`
- `session_path_permissions(session_id, operation, path, granted_by, granted_at, expires_at)`
- `session_snapshots(session_id, snapshot_json, created_at)`
- `memory_entries(memory_id, user_id, namespace, key, value_json, tags_json, updated_at)`
- `audit_logs(log_id, correlation_id, actor, decision, reason, raw, timestamp)`

---

## 11.1 永続層詳細設計（委任分）

採用方針:

- 主DBは PostgreSQL（Compose 上の `postgres` サービス）を採用
- `STATE_STORE_DSN` と `MEMORY_STORE_DSN` は同一 PostgreSQL を指してよい
- 添付実体・生成物は `ATTACHMENT_ROOT`（Compose volume）に保存し、メタ情報は PostgreSQL 管理

推奨インデックス:

- `sessions(user_id, status, updated_at DESC)`
- `sessions(thread_id)`（UNIQUE 推奨）
- `tasks(session_id, status, updated_at DESC)`
- `approvals(session_id, status, requested_at DESC)`
- `task_events(task_id, timestamp)`
- `session_path_permissions(session_id, operation, path)`
- `memory_entries(user_id, namespace, key)`（UNIQUE）
- `audit_logs(correlation_id, timestamp)`

保持方針（既定）:

- `task_events`: 90日
- `audit_logs`: 180日
- 添付/生成物: 30日（明示保持対象を除く）

運用要件:

- マイグレーションは起動前に自動適用できること
- PostgreSQL 障害時の復旧手順（バックアップ/リストア）を runbook 化すること

---

## 12. 非機能要件（NFR）

| ID | 要件 |
|---|---|
| NFR-001 | 100% の tool call に対し audit log を残す |
| NFR-002 | すべての tool 引数を zod で検証する |
| NFR-003 | すべてのイベントに `task_id` と `session_id` を紐づける |
| NFR-004 | 承認不要タスクは 3 秒以内に初回進捗通知を返す |
| NFR-005 | 一時失敗は指数バックオフで最大 3 回再試行する |
| NFR-006 | 再起動後もセッション再開と memory 参照が可能である |
| NFR-007 | アイドルタイムアウト（10分）の `idle_paused` 遷移判定誤差は±10秒以内 |
| NFR-008 | Discord イベント重複配送時でも副作用は1回に収まる（冪等） |
| NFR-009 | `/cancel` 受信後、実行中ジョブは速やかに中断シグナルを受ける |
| NFR-010 | Compose の各サービスは `healthcheck` を実装する |
| NFR-011 | 平文シークレットをリポジトリに保存しない（`op run` 前提） |

---

## 13. 受け入れ基準（Definition of Done）

- [ ] Yarn 1 で `install`, `build`, `test` が成立する
- [ ] 1 タスクで `create/resume` の後に `sendAndWait` 1回で完了まで到達する
- [ ] 外部 MCP 指定が常に拒否される
- [ ] 添付ファイルが Agent コンテナで read/write 可能
- [ ] `container.cli_exec` で Python を含む CLI 解析が承認なしで実行できる
- [ ] `host.file_read` を含むホストファイル全操作で承認要求が発生する
- [ ] `host.cli_exec` は常に承認要求が発生する
- [ ] 未承認パスアクセスで `path_not_approved_for_session` が返る
- [ ] `/status`, `/cancel`, `/close`（スレッド内）と `/list` が動作する
- [ ] `/close` で `closed_by_user` 終了になる
- [ ] 10分間スレッド内ユーザー発言がないセッションが `idle_paused` へ遷移する
- [ ] `idle_paused` セッションが同一スレッド発言で自動再開する
- [ ] `memory.*` ツールで保存・検索・取得・削除できる
- [ ] `op run --env-file=.env.op -- docker compose up -d` で主要サービスが起動する
- [ ] DB/ボリューム再起動後に `sessions/tasks/memory` の永続データが維持される
- [ ] Discord イベント重複時にタスクが二重起動しない

---

## 14. 環境変数要件（例）

- `DISCORD_BOT_TOKEN`
- `COPILOT_SDK_API_KEY`
- `GATEWAY_BASE_URL`
- `MCP_BIND_HOST`, `MCP_BIND_PORT`
- `ATTACHMENT_ROOT`
- `STATE_STORE_DSN`
- `MEMORY_STORE_DSN`
- `APPROVAL_TIMEOUT_SEC`
- `SESSION_IDLE_TIMEOUT_SEC`（既定: `600`）
- `LOG_LEVEL`
- `OP_SERVICE_ACCOUNT_TOKEN`（非対話実行時）
- `OP_ENV_FILE`（例: `.env.op`）

---

## 15. 実装時の追加注意事項（必須）

- `/cancel` は API 応答のみで終わらせず、実行中プロセス/ジョブの停止完了まで追跡する
- すべてのログに `task_id` `session_id` `thread_id` `correlation_id` を付与する
- 監査ログは allow/deny/approval の判断根拠を必ず残す
- 添付ファイルの MIME / サイズ検証を実施し、危険拡張子は隔離または拒否する
- idempotency key（`interaction_id` / `message_id`）で Discord 再送を重複処理しない
