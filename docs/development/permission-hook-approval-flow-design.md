# Permission Hook を用いた承認フロー改善設計（改訂）

## 目的

承認付きツールの実行を「`approval_required` で一度失敗させて再実行する方式」から、  
**ツール呼び出し前に承認を確定してから実行する方式**へ移行する。

本改訂では、ユーザー表示をさらに簡潔化し、**承認待ちメッセージは表示しない**方針を明示する。

---

## 合意した表示方針（ユーザー体験）

ユーザー向け表示は次の 2 種類のみとする。

1. 承認ダイアログ（Approve / Reject）
2. 承認後に実行された通常のツールログ（start/result）

補足:

- 「承認待ち」は承認ダイアログ自体で認識できるため、別メッセージは出さない
- 拒否/タイムアウト時のみ、承認結果メッセージを表示する
- 内部状態としての `waiting_approval` は維持する（監査・整合のため）

---

## 目標アーキテクチャ（実行順序）

1. Agent で Permission Hook (`onPermissionRequest`) が発火
2. Runtime が Gateway に承認要求を発行
3. Discord で承認ダイアログを提示し、決定を待機
4. 承認結果を Hook に返却（`approved` / `denied`）
5. `approved` の場合のみツール実行
6. 実行後に通常のツールログを表示

この順序により、承認は「エラー処理」ではなく「実行前ゲート」として扱われる。

---

## 論点1: Runtime → Gateway の承認導線

### 要件

- Hook から承認要求を発行できること
- Hook が承認結果まで安全に待機できること（timeout/cancel 対応）
- 同一要求の重複発行を防ぐこと（idempotency）

### API 方針

既存 API（`/v1/threads/:threadId/approvals/request`, `/v1/approvals/:approvalId/respond`）を活かしつつ、Runtime 側実装を単純化するため、以下を推奨する。

- `request_and_wait` 相当 API を Gateway 側に追加し、Runtime は単一呼び出しで承認結果を受け取る

最小入力:

- `task_id`, `session_id`, `thread_id`, `user_id`
- `request.kind`（`read/write/shell/url/custom-tool` など）
- `tool_name`
- 承認スコープ（path / command / origin）
- timeout 設定

---

## 論点2: 表示・ログ設計（承認待ち非表示）

### 表示ルール

- 承認ダイアログは表示する
- 承認待ち専用メッセージは表示しない
- `approved` 後にのみ通常ツールの start/result ログを表示する
- `rejected` / `timeout` は承認結果のみ通知し、ツール start/result は表示しない

### ログ整合ルール

- ユーザー向けログが簡素でも、監査ログには必ず承認イベントを保存する
- 相関キー（`task_id/session_id/approval_id/tool_call_id`）を統一する
- `summarizeToolErrors()` には承認待ち由来の疑似エラーを含めない

---

## 論点3: 状態同期（`waiting_approval` は内部保持）

承認待ちメッセージを非表示にしても、内部状態管理は必要。

### 同期ルール

- `pendingApproval` がある間は `waiting_approval` を優先
- 承認解決後に `running` / `failed` などへ遷移
- `cancel` 時は pending approval も `canceled` へ確実に解決
- timeout と遅延クリック（late response）の競合を吸収する

---

## 移行方針（現行）

1. built-in 系 (`read/write/shell/url`) は Permission Hook で実行前承認
2. `host.*` / `discord.*` custom tool も同方式へ統一
3. `approval_required` 起点の再実行ループは廃止済み（Bot は pending approval を status/event で同期）

---

## 受け入れ基準

- 承認が必要な操作で、**承認後に単一 run 内で実行完了**する
- 承認前にツール start/result ログが表示されない
- 承認待ち専用メッセージを表示しない
- 拒否/タイムアウト時は承認結果のみ通知される
- 監査ログで承認と実行の相関追跡ができる

---

## テスト観点（最小）

- approve: ツールが承認後にのみ実行される
- reject: ツール未実行で終了する
- timeout: ツール未実行で終了する
- cancel: 承認待機と実行の双方が中断される
- multi-approval: 複数承認が順序・件数ともに正しく処理される
