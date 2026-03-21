# 改善所見の実装方針（具体化）

このドキュメントは、E2E 所見を「実装可能なタスク」に落とし込んだ設計メモです。  
対象は現行構成（Discord Bot -> Gateway API -> Agent Runtime(Copilot SDK)）です。

---

## 1. 背景（所見の再整理）

- LM が自身の役割・キャラクターを安定して維持できない
- 添付ファイル参照（「このファイル」）が曖昧で、意図した対象に到達しない
- メモリ利用が自由形式で、保持/想起の品質が安定しない
- 添付/メモリ以外の実行文脈（承認状態、ツール制約、出力方針など）が LM に十分渡っていない
- 完全なシステム指示を毎回渡すと長文化し、運用しづらい

---

## 2. 改善方針（全体像）

以下を段階導入する。

1) **Persona/Policy の固定化**  
2) **コンテキスト注入の拡張（添付 + 振る舞い）**  
3) **メモリ名前空間の型定義と語彙ルーティング**  
4) **「書き込み禁止メモリ」相当の固定ルール化（Gateway 管理）**

各施策は独立導入可能だが、順序は 1 -> 2 -> 3 -> 4 を推奨。

---

## 3. 施策A: Persona/Policy の固定化

### 3.1 目的

毎回の応答で「誰として振る舞うか」をぶらさない。

### 3.2 実装方法

Agent SDK セッション作成時の `systemMessage` を導入し、固定ルールを注入する。  
ただし設定源は **環境変数ではなくコード定義** とする。

- 変更対象:
  - `apps/agent/src/runtime/personaPolicy.ts`（新規）
  - `apps/agent/src/runtime/sdkProvider.ts`
  - `apps/agent/src/runtime/*`（必要に応じてテスト追加）

- 設定方式（コード定義）:
  - `PersonaProfile` 型（`name`, `role`, `tone`, `language`, `styleTraits` など）
  - `BehaviorPolicy` 型（`toolPolicy`, `approvalPolicy`, `memoryPolicy`, `safetyPolicy` など）
  - `PERSONA_REGISTRY`（複数 persona を versioned に保持）
  - `ACTIVE_PERSONA_ID`（コード上の定数）で適用対象を決定
  - `buildSystemMessage(profile, policy)` で Copilot SDK 向け文面を生成

### 3.3 実装ポイント

- `buildSessionConfigBase()` に `systemMessage` を追加
- `systemMessage` の文面生成ロジックは `personaPolicy.ts` に集約し、`sdkProvider.ts` から参照する
- Persona/Policy の更新はコードレビュー対象にし、意図しない実行時上書きを防ぐ
- 「ツール利用・承認・安全制約」は既存ルールを維持
- persona は短い固定文 + 箇条書きで安定化

### 3.4 受け入れ基準

- 連続 10 ターンで自己呼称・口調・役割の逸脱がない
- 既存の `run/status/cancel/approval` は回帰しない

---

## 4. 施策B: コンテキスト注入の拡張（添付 + 振る舞い）

### 4.1 目的

「このファイル」「現在どう振る舞うべきか」を、LM が毎回同じ解像度で参照できるようにする。

### 4.2 実装方法

Bot -> Gateway -> Agent の prompt に、`Context Envelope` を前置する。  
この Envelope は **添付情報だけでなく、メモリ以外の振る舞い文脈** を含む。

- 変更対象:
  - `apps/gateway/api/src/gateway/service.ts`
  - `apps/gateway/api/src/prompt/contextEnvelope.ts`（新規）
  - `apps/gateway/api/src/bot.ts`（必要に応じて入力情報の受け渡し整理）
  - （必要であれば）`apps/agent/src/runtime/service.ts`

### 4.3 Context Envelope の構成

1. Attachment Context（既存強化）  
2. Behavior Context（新規）  
3. Runtime Feedback Context（新規、直前実行の要約）

`Behavior Context` には、以下のような情報を含める。

- `bot_mode`（`standard` / `mock`）
- `session_status`（`running` / `idle_waiting` / `waiting_approval` など）
- `infrastructure_status`（`ready` / `booting` / `failed`）
- `tool_routing_policy`（`gateway_only` / `external_mcp_disabled`）
- `approval_policy`（host 操作は明示承認必須）
- `response_contract`（言語、簡潔性、根拠不足時の振る舞い）
- `execution_contract`（未承認 host 操作を進めない、禁止経路を使わない）

`Runtime Feedback Context` には、以下を短く含める。

- 直前 task の terminal status
- 直前 tool error 要約（最大 N 件）
- 再実行時の注意（例: 「前回は approval timeout」）

### 4.4 仕様上の注意

- 添付なしでも `Behavior Context` は注入する
- 既存 `#tool:` / `#host-read:` ディレクティブ解析には影響させない  
  （解析完了後、Agent 送信直前に Envelope を組み立てる）
- prompt 長大化を避けるため、Context は固定キー + 短文を徹底する
- コンテキスト生成失敗時は、失敗自体を監査ログへ残し、通常 prompt でフォールバック

### 4.5 前置ブロック例

```text
[Behavior Context]
- bot_mode: standard
- session_status: idle_waiting
- infrastructure_status: ready
- tool_routing_policy: gateway_only
- approval_policy: host_ops_require_explicit_approval
- response_contract: ja, concise, ask_when_ambiguous
- execution_contract: no_external_mcp, no_unapproved_host_ops
```

### 4.6 受け入れ基準

- 添付なしでも、応答の振る舞い（制約順守・口調）が安定する
- 添付1件の時、「このファイル」の参照成功率が向上する
- `waiting_approval` 中に未承認操作を勝手に継続しない
- 既存の `run/status/cancel/approval` と `#tool/#host-read` デモが回帰しない

---

## 5. 施策C: メモリ名前空間の型定義と語彙ルーティング

### 5.1 目的

メモリを「何でも保存」から「意味単位で保存」へ変え、想起精度を上げる。

### 5.2 実装方法

`memory.*` ツール引数に対し、推奨 namespace を導入。  
さらに、語彙（覚える/忘れる/思い出す）をツール使用方針として systemMessage に明示する。

- 変更対象:
  - `apps/agent/src/runtime/sdkProvider.ts`
  - `apps/gateway/api/src/mcp/service.ts`
  - `apps/gateway/api/src/mcp/types.ts`
  - `apps/gateway/api/src/smoke.ts`

### 5.3 推奨 namespace（初期）

- `profile.person`（人物プロフィール）
- `conversation.fact`（会話で確定した事実）
- `knowledge.note`（汎用知識メモ）
- `task.preference`（ユーザー嗜好・運用設定）

### 5.4 バリデーション方針

- v1: 許可リスト警告（保存は許可、監査ログに warning）
- v2: 許可リスト外は reject（`invalid_tool_arguments`）

### 5.5 受け入れ基準

- `memory.upsert/search/get/delete` の回帰テストが通る
- namespace ごとの検索結果が期待どおりに分離される
- 知識を要する質問では、推測より先に `memory.search/get` を参照する運用方針が system 指示とツール説明に反映される
- `memory.upsert` で memory 同士の backlink を保存でき、`memory.get/search` の結果から辿れる

---

## 6. 施策D: 書き込み禁止メモリ（固定ルール）

### 6.1 目的

長い固定指示を毎ターン prompt に載せず、改変不可の設定として保持する。

### 6.2 実装方法

Gateway 側に「system memory」概念を追加し、通常の `memory.*` からは変更不可にする。

- 変更対象:
  - `apps/gateway/api/src/gateway/repository.ts`
  - `apps/gateway/state/migrations/*`
  - `apps/gateway/api/src/mcp/service.ts`

### 6.3 データモデル案

- `memory_entries` に `is_system BOOLEAN DEFAULT false` を追加
- `is_system=true` は `memory.delete` 禁止、`memory.upsert` は管理者経路のみ許可

### 6.4 運用

- 初期投入は migration seed または起動時 bootstrap
- Persona 固定文、禁止事項、ツール運用方針を system memory として保存

### 6.5 受け入れ基準

- 一般ユーザー経路から system memory を変更できない
- Agent は system memory を参照して応答品質が安定する

---

## 7. 実装タスク分解（PR単位）

### PR-1 Persona 固定

- `apps/agent/src/runtime/personaPolicy.ts` を新設（型 + registry + message builder）
- `sdkProvider.ts` に `systemMessage` 注入（builder 呼び出し）
- Persona/Policy の設計意図を `apps/agent/README.md` に追記（環境変数依存なし）

### PR-2 Context Envelope（添付 + 振る舞い）

- `contextEnvelope.ts` を新設し、Attachment/Behavior/Runtime Feedback を生成
- `gateway/service.ts` で Agent 送信直前に Envelope を前置
- 既存 `#tool:` / `#host-read:` 解析順に影響しないことを検証
- E2E runbook に確認手順追記
- PR-2 実装後の「LM に未注入の必須指示（メモリ系除外）」監査は
  `docs/development/lm-critical-instructions-audit.md` を参照

### PR-3 メモリ namespace 強化

- namespace 定数とバリデーション導入
- `mcp/service.ts` のメモリ処理に警告/拒否ロジック追加
- 知識系質問時のメモリ優先参照方針を persona/policy と tool description に追加
- memory backlink（source -> target）を保存・取得できるよう repository/migration/smoke を更新
- smoke テスト更新

### PR-4 system memory（任意だが推奨）

- migration + repository + MCP 制約
- bootstrap データ投入
- 運用ドキュメント更新

---

## 8. リスクと対策

- **Prompt 長大化**: Envelope を固定キー短文化し、詳細は system memory へ移行
- **既存回帰**: `agent:smoke`, `api:smoke`, `orchestrator:smoke` を毎PRで実行
- **過剰制約**: namespace 制約は warn モードから開始
- **文脈の過信**: Behavior Context を「推奨」ではなく「実行契約」として明示

---

## 9. 直近の推奨着手順

1. PR-1（Persona 固定）  
2. PR-2（Context Envelope: 添付 + 振る舞い）  
3. PR-3（メモリ namespace warn モード）  
4. PR-4（system memory）

この順で、UX改善効果と実装リスクのバランスが良い。
