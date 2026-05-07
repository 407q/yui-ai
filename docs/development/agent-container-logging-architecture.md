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

## 4. 二層ログ出力モデル（即時要約 + 完全ログ）

### 4.1 方針

1. **コンソール即時ログ（短文）**
   - 1 イベント 1 行、120 文字前後を上限
   - 通信の要点（誰→誰、何をしたか、結果、遅延）だけ表示
   - すべての行に `trace_id` を含める
2. **完全ログ（JSONL 永続化）**
   - 共通エンベロープ + 詳細 payload を保存
   - 事後調査は `trace_id` で抽出して展開

### 4.2 保存先

- Agent は**コンテナ内パス**に JSONL を追記保存（例: `/var/log/yui-ai/agent-trace.jsonl`）
- 運用では上記ディレクトリを **bind mount でホストへ永続化**する（推奨）
  - 例: `host:/srv/yui-ai/logs/agent` -> `container:/var/log/yui-ai`
- 既存の `task_events` / `audit_logs` と `trace_id` で相互参照可能にする
- ローテーションは日次 + サイズ閾値（例: 100MB）で実施

### 4.3 展開インターフェース

コンソールには必ず `trace=<trace_id>` を表示し、必要時に次で展開できるようにする。

- 例1: helper コマンド（推奨）
  - `yarn logs:trace --trace <trace_id>`
- 例2: 直接抽出
  - `jq 'select(.trace_id=="<trace_id>")' /var/log/yui-ai/agent-trace.jsonl`

---

## 5. イベント分類（4 者の通信線で統一）

### 5.1 Gateway -> Agent

| event | actor | direction | 必須追加項目 |
|---|---|---|---|
| `gateway.agent.run.request` | gateway | outbound | `runtime_policy`, `bootstrap_mode_hint` |
| `agent.gateway.run.accepted` | agent | inbound | `bootstrap_mode`, `send_and_wait_count` |
| `gateway.agent.status.poll` | gateway | outbound | `poll_reason` |
| `agent.gateway.status.snapshot` | agent | inbound | `status`, `completed_at` |

### 5.2 Agent -> Copilot SDK -> LM

| event | actor | direction | 必須追加項目 |
|---|---|---|---|
| `agent.sdk.session.create.start/result` | agent | internal | `sdk_session_id_hint`, `result` |
| `agent.sdk.session.resume.start/result` | agent | internal | `sdk_session_id_hint`, `result` |
| `agent.sdk.send_and_wait.start` | agent | outbound | `prompt_chars`, `tool_call_count` |
| `copilot_sdk.turn.event` | copilot_sdk | inbound | `sdk_event_type`, `has_content` |
| `lm.response.chunk` | lm | inbound | `chunk_chars` |
| `agent.sdk.send_and_wait.result` | agent | inbound | `final_answer_chars`, `tool_result_count` |

### 5.3 Agent <-> Gateway MCP（tool）

| event | actor | direction | 必須追加項目 |
|---|---|---|---|
| `agent.mcp.tool_call.start` | agent | outbound | `call_id`, `tool_name`, `execution_target` |
| `gateway.mcp.tool_call.received` | gateway | inbound | `call_id`, `approval_required` |
| `gateway.mcp.tool_call.result` | gateway | outbound | `call_id`, `status`, `error_code` |
| `agent.mcp.tool_call.result` | agent | inbound | `call_id`, `status`, `latency_ms` |

---

## 6. 実装配置（最小侵襲）

### 6.1 Agent 側（主対象）

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

### 6.2 Gateway 側（相関補完）

- `apps/gateway/api/src/gateway/service.ts`
  - `runTask`, `status`, `cancel`, `approval` 呼び出し時に同じ `trace_id` を payload に含める
  - 既存 `task_events` に `trace_id` を埋める
- 必要に応じて `audit_logs.raw` に `trace_id/task_id/session_id` を強制格納

---

## 7. コンソール要約ログの表示仕様（具体メッセージ）

### 7.1 共通フォーマット

```text
[<hop>][<event>][trace=<trace_id>] <summary> | <status> <latency_ms>ms
```

- `<hop>` は通信区間を短縮表示
  - `G2A` (Gateway -> Agent)
  - `A2S` (Agent -> Copilot SDK)
  - `S2L` (SDK -> LM)
  - `A2M` (Agent -> Gateway MCP)
- `<summary>` は具体通信内容を 1 要素だけ含める（例: endpoint, sdk_event_type, tool_name）

### 7.2 表示メッセージ例

1. Gateway -> Agent run 要求
   - `[G2A][run.request][trace=task_abc] POST /v1/agent/tasks/run mode=hybrid | sent 3ms`
2. Agent が run を受理
   - `[G2A][run.accepted][trace=task_abc] bootstrap=create send_wait=0 | accepted 1ms`
3. Agent -> SDK sendAndWait 開始
   - `[A2S][send_wait.start][trace=task_abc] prompt=842ch tools=2 | started 0ms`
4. SDK から LM イベント受信
   - `[S2L][turn.event][trace=task_abc] type=assistant.message_delta has_content=true | ok 12ms`
5. Agent -> Gateway MCP ツール実行
   - `[A2M][tool_call][trace=task_abc] tool=host.file_read call=call_17 | ok 44ms`
6. 承認待ち発生
   - `[A2M][approval.wait][trace=task_abc] op=host_read path=/repo/.env | waiting 0ms`
7. 失敗（タイムアウト）
   - `[A2M][tool_call][trace=task_abc] tool=host.cli_exec call=call_21 | timeout 30000ms`
8. 最終回答確定
   - `[A2S][send_wait.result][trace=task_abc] answer=532ch source=assistant.message | completed 1842ms`

### 7.3 ノイズ抑制ルール

1. `message_delta` は一定間隔で集約（例: 1 秒ごとに 1 行）
2. 同一 `call_id` の中間進捗は抑制し、`start/result` を優先表示
3. `debug` レベルは完全ログにのみ保存し、コンソール既定は `info` 以上

---

## 8. マスキング/機密対策

ログ対象は原則メタデータ中心。本文は次の制御を入れる:

1. `prompt` / `final_answer` はデフォルト全文保存しない（文字数・ハッシュのみ）
2. `payload` は allowlist 方式で出力
3. トークン・認証ヘッダ・秘密値は redact（`***`）
4. 添付ファイル内容はログしない（ファイル名/サイズのみ）

---

## 9. 設定値案

| env | default | 用途 |
|---|---|---|
| `AGENT_LOG_FORMAT` | `json` | `json` / `text` |
| `AGENT_LOG_LEVEL` | `info` | 出力レベル |
| `AGENT_LOG_INCLUDE_PAYLOAD` | `false` | payload 詳細出力 |
| `AGENT_LOG_REDACT_KEYS` | `token,authorization,secret,password` | redact 対象キー |
| `AGENT_LOG_EVENT_SAMPLE_RATE` | `1.0` | 高頻度イベントのサンプリング |
| `AGENT_CONSOLE_SUMMARY` | `true` | 即時要約ログを出すか |
| `AGENT_TRACE_LOG_PATH` | `/var/log/yui-ai/agent-trace.jsonl` | コンテナ内の完全ログ保存先（bind mount でホスト永続化） |
| `AGENT_CONSOLE_DELTA_AGGREGATE_MS` | `1000` | delta 集約間隔 |

---

## 10. ロールアウト段階

1. **Phase 1: Agent 内部統一**
   - `service.ts` / `sdkProvider.ts` / `gatewayMcpClient.ts` を共通エンベロープ化
2. **Phase 2: Gateway 相関**
   - `task_events` / `audit_logs` へ `trace_id` を通し、Agent ログと突合可能にする
3. **Phase 3: 運用導線**
   - runbook に「障害時の追跡手順（trace_id 起点）」を追加
   - `debug/*` 収集ログのフォーマットを同一化

---

## 11. 受け入れ基準

1. 単一 `task_id` で Gateway/Agent/SDK/LM の主要イベントが時系列で復元できる
2. `gateway_mcp_timeout` / `approval_timeout` / `task_execution_failed` をログだけで識別できる
3. 「LM 無応答」時に、SDK イベント欠落なのか最終回答抽出失敗なのかを判別できる
4. 既存の `yarn build` と smoke 系（agent/orchestrator）を維持できる
5. コンソールは短文のまま、`trace_id` 指定で完全ログを即展開できる

---

## 12. 期待効果

- 本番障害の初動で「通信断点」を数分で特定しやすくなる
- 「Bot は動いているが Agent が返していない」状況を、SDK/LM 層まで分解して説明できる
- 既存の `task_events` / `audit_logs` を活かしたまま段階導入できる
