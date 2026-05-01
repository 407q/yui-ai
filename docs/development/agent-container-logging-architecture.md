# Agent コンテナ向け統合ロギング設計案（Gateway / Agent / Copilot SDK / LM）

このドキュメントは、**Agent コンテナの可観測性を強化**し、以下 4 者の通信と挙動を 1 つのトレースとして追えるようにする実装案です。

- Gateway
- Agent Runtime
- Copilot SDK
- LM

---

## 1. 目的

現状は `task_events` / `audit_logs` / コンテナ標準出力に情報が分散しており、障害時に「どこで止まったか」を横断的に追うコストが高い。  
本設計では、次を満たすことを目的にします。

1. 1 タスク単位で 4 者の因果関係を追跡できる
2. API 通信失敗・承認待ち・SDK 応答欠落・LM 無応答を切り分けできる
3. 本番常用可能な JSON 構造化ログに統一できる

---

## 2. 要件（ログで必ず答えられる問い）

1. Gateway から Agent への `runTask` 要求はいつ届き、受理されたか
2. Agent が Copilot SDK セッションを `create/resume` のどちらで扱ったか
3. SDK が LM へ送信し、どのイベント（message / delta / completion）を返したか
4. Tool call が Gateway MCP にどう到達し、成功/失敗したか
5. 最終回答が「LM 由来」か「フォールバック」か（将来の回 regressions 防止）
6. 失敗時に retry/cancel/timeout のどれで終了したか

---

## 3. 共通ログエンベロープ

全コンポーネントで共通化する最小キー:

| key | 必須 | 説明 |
|---|---|---|
| `ts` | 必須 | ISO8601 UTC |
| `level` | 必須 | `debug/info/warn/error` |
| `actor` | 必須 | `gateway` / `agent` / `copilot_sdk` / `lm` |
| `event` | 必須 | 例: `agent.sdk.send_and_wait.start` |
| `trace_id` | 必須 | 1 実行系列を束ねる ID（`task_id` と 1:1 推奨） |
| `session_id` | 必須 | Gateway/Agent セッション ID |
| `task_id` | 必須 | タスク ID |
| `sdk_session_id` | 任意 | SDK セッション ID |
| `call_id` | 任意 | tool call 単位 ID |
| `direction` | 任意 | `inbound` / `outbound` / `internal` |
| `peer` | 任意 | 相手コンポーネント名 |
| `status` | 任意 | `accepted` / `ok` / `error` / `timeout` など |
| `latency_ms` | 任意 | 区間処理時間 |
| `error` | 任意 | `{ code, message, details }` |
| `payload` | 任意 | マスク済み詳細 |

`trace_id` はまず `task_id` を採用し、必要時に `task_id:attempt` へ拡張します。

---

## 4. イベント分類（4 者の通信線で統一）

### 4.1 Gateway -> Agent

| event | actor | direction | 必須追加項目 |
|---|---|---|---|
| `gateway.agent.run.request` | gateway | outbound | `runtime_policy`, `bootstrap_mode_hint` |
| `agent.gateway.run.accepted` | agent | inbound | `bootstrap_mode`, `send_and_wait_count` |
| `gateway.agent.status.poll` | gateway | outbound | `poll_reason` |
| `agent.gateway.status.snapshot` | agent | inbound | `status`, `completed_at` |

### 4.2 Agent -> Copilot SDK -> LM

| event | actor | direction | 必須追加項目 |
|---|---|---|---|
| `agent.sdk.session.create.start/result` | agent | internal | `sdk_session_id_hint`, `result` |
| `agent.sdk.session.resume.start/result` | agent | internal | `sdk_session_id_hint`, `result` |
| `agent.sdk.send_and_wait.start` | agent | outbound | `prompt_chars`, `tool_call_count` |
| `copilot_sdk.turn.event` | copilot_sdk | inbound | `sdk_event_type`, `has_content` |
| `lm.response.chunk` | lm | inbound | `chunk_chars` |
| `agent.sdk.send_and_wait.result` | agent | inbound | `final_answer_chars`, `tool_result_count` |

### 4.3 Agent <-> Gateway MCP（tool）

| event | actor | direction | 必須追加項目 |
|---|---|---|---|
| `agent.mcp.tool_call.start` | agent | outbound | `call_id`, `tool_name`, `execution_target` |
| `gateway.mcp.tool_call.received` | gateway | inbound | `call_id`, `approval_required` |
| `gateway.mcp.tool_call.result` | gateway | outbound | `call_id`, `status`, `error_code` |
| `agent.mcp.tool_call.result` | agent | inbound | `call_id`, `status`, `latency_ms` |

---

## 5. 実装配置（最小侵襲）

### 5.1 Agent 側（主対象）

- `apps/agent/src/runtime/service.ts`
  - task 開始/完了/失敗/キャンセル時に共通エンベロープで出力
  - `trace_id = task_id` を常時付与
- `apps/agent/src/runtime/sdkProvider.ts`
  - SDK イベント受信点で `copilot_sdk.turn.event` を出力
  - final answer 解決経路（assistant.message / message_delta 由来）を `payload.answer_source` に記録
- `apps/agent/src/runtime/gatewayMcpClient.ts`
  - HTTP/UDS 両経路で start/result/error/timeout を構造化ログ化
  - `latency_ms`, `socket_path` or `base_url` を記録
- `apps/agent/src/server.ts`
  - ロガー初期化（JSONL, log level, redaction）と全体設定注入

### 5.2 Gateway 側（相関補完）

- `apps/gateway/api/src/gateway/service.ts`
  - `runTask`, `status`, `cancel`, `approval` 呼び出し時に同じ `trace_id` を payload に含める
  - 既存 `task_events` に `trace_id` を埋める
- 必要に応じて `audit_logs.raw` に `trace_id/task_id/session_id` を強制格納

---

## 6. マスキング/機密対策

ログ対象は原則メタデータ中心。本文は次の制御を入れる:

1. `prompt` / `final_answer` はデフォルト全文保存しない（文字数・ハッシュのみ）
2. `payload` は allowlist 方式で出力
3. トークン・認証ヘッダ・秘密値は redact（`***`）
4. 添付ファイル内容はログしない（ファイル名/サイズのみ）

---

## 7. 設定値案

| env | default | 用途 |
|---|---|---|
| `AGENT_LOG_FORMAT` | `json` | `json` / `text` |
| `AGENT_LOG_LEVEL` | `info` | 出力レベル |
| `AGENT_LOG_INCLUDE_PAYLOAD` | `false` | payload 詳細出力 |
| `AGENT_LOG_REDACT_KEYS` | `token,authorization,secret,password` | redact 対象キー |
| `AGENT_LOG_EVENT_SAMPLE_RATE` | `1.0` | 高頻度イベントのサンプリング |

---

## 8. ロールアウト段階

1. **Phase 1: Agent 内部統一**
   - `service.ts` / `sdkProvider.ts` / `gatewayMcpClient.ts` を共通エンベロープ化
2. **Phase 2: Gateway 相関**
   - `task_events` / `audit_logs` へ `trace_id` を通し、Agent ログと突合可能にする
3. **Phase 3: 運用導線**
   - runbook に「障害時の追跡手順（trace_id 起点）」を追加
   - `debug/*` 収集ログのフォーマットを同一化

---

## 9. 受け入れ基準

1. 単一 `task_id` で Gateway/Agent/SDK/LM の主要イベントが時系列で復元できる
2. `gateway_mcp_timeout` / `approval_timeout` / `task_execution_failed` をログだけで識別できる
3. 「LM 無応答」時に、SDK イベント欠落なのか最終回答抽出失敗なのかを判別できる
4. 既存の `yarn build` と smoke 系（agent/orchestrator）を維持できる

---

## 10. 期待効果

- 本番障害の初動で「通信断点」を数分で特定しやすくなる
- 「Bot は動いているが Agent が返していない」状況を、SDK/LM 層まで分解して説明できる
- 既存の `task_events` / `audit_logs` を活かしたまま段階導入できる
