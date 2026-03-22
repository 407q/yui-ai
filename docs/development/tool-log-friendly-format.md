# Tool Log Friendly Format 仕様（テンプレート運用版）

このドキュメントは、Discord ツールログの**表示テンプレート仕様**です。  
失敗時に「何が起きたか」が伝わることを重視し、以下を満たします。

- 見やすい（4行で要点把握）
- 編集しやすい（辞書差し替え中心）
- 実態がわかる（対象 / 原因を明示）

---

## 0. 編集ルール（最初に読む）

変更は原則この順序で行います。

1. `A. レイアウト`（表示の骨格）
2. `B. 文言辞書`（絵文字・状態文言）
3. `C. エラー原因辞書`（失敗理由の標準語彙）
4. `D. カテゴリ定義`（ツール分類）
5. `E. ツール別テンプレート`（成功/失敗の個別文言）

---

## A. レイアウト（共通）

### A-1. 標準4行

```text
<icon> <tool_label>
<target_line>
<status_line>
<result_line>
```

### A-2. 失敗時の拡張（推奨）

```text
<icon> <tool_label>
<target_line>
❌ 失敗
<error_summary_line>
```

> `error_summary_line` は「対象 + 原因」を含める。  
> 不明なエラー（辞書未定義）は、**システムのエラーメッセージをそのまま表示**する。

---

## B. 文言辞書（差し替えポイント）

### B-1. 状態辞書

| key | default |
|---|---|
| `pending` | `⏳ 実行中` |
| `waiting_approval` | `🛂 承認待ち` |
| `ok` | `✅ 成功` |
| `error` | `❌ 失敗` |

### B-2. アイコン辞書（カテゴリ）

| category | icon |
|---|---|
| `builtin_file` | `📄` |
| `builtin_edit` | `✍️` |
| `builtin_search` | `🔎` |
| `builtin_list` | `📂` |
| `container_file` | `📄` |
| `container_edit` | `✍️` |
| `container_delete` | `🗑️` |
| `container_list` | `📂` |
| `container_cli` | `💻` |
| `container_deliver` | `📦` |
| `host_file` | `📄` |
| `host_edit` | `✍️` |
| `host_delete` | `🗑️` |
| `host_list` | `📂` |
| `host_cli` | `💻` |
| `host_http` | `🌐` |
| `memory` | `🧠` |
| `discord` | `💬` |
| `unknown` | `🛠️` |

## C. エラー原因辞書（実態把握用）

> 失敗時は `error_code` をこの辞書に正規化して表示します。  
> `summary_template` は必ず「対象 + 原因」が分かる文にします。

| error_code | summary_template |
|---|---|
| `approval_required` | `{{target}} の実行には承認が必要です` |
| `approval_rejected` | `{{target}} の実行が拒否されました` |
| `approval_timeout` | `{{target}} の承認がタイムアウトしました` |
| `external_mcp_disabled` | `{{target}} は許可されていない実行経路です` |
| `invalid_tool_arguments` | `{{target}} の入力値が不正です` |
| `container_path_out_of_scope` | `{{target}} が許可されたコンテナ範囲外です` |
| `container_path_not_found` | `{{target}} が見つかりません` |
| `container_path_not_file` | `{{target}} はファイルではありません` |
| `container_file_too_large` | `{{target}} はサイズ上限を超えています` |
| `policy_denied_command` | `{{target}} は許可リスト外コマンドです` |
| `path_not_approved_for_session` | `{{target}} はこのセッションで未承認です` |
| `tool_execution_failed` | `{{system_error_message_raw}}` |
| `unknown_error` | `{{system_error_message_raw}}` |

### C-1. 失敗表示フォーマット（推奨）

```text
詳細: {{short_detail}}
```

`tool_execution_failed` / `unknown_error` / 辞書未定義エラー の場合は次を使用:

```text
❌ 失敗
{{system_error_message_raw}}
```

---

## D. カテゴリ定義（網羅）

### D-1. tool -> category

| tool_name | category |
|---|---|
| `read_file`, `view` | `builtin_file` |
| `edit_file`, `str_replace_editor` | `builtin_edit` |
| `grep` | `builtin_search` |
| `glob` | `builtin_list` |
| `container.file_read` | `container_file` |
| `container.file_write` | `container_edit` |
| `container.file_delete` | `container_delete` |
| `container.file_list` | `container_list` |
| `container.cli_exec`, `bash` | `container_cli` |
| `container.file_deliver` | `container_deliver` |
| `host.file_read` | `host_file` |
| `host.file_write` | `host_edit` |
| `host.file_delete` | `host_delete` |
| `host.file_list` | `host_list` |
| `host.cli_exec` | `host_cli` |
| `host.http_request` | `host_http` |
| `memory.search`, `memory.get`, `memory.upsert`, `memory.delete` | `memory` |
| `discord.channel_history`, `discord.channel_list` | `discord` |
| その他 | `unknown` |

### D-2. target_line ルール

| category | target_line |
|---|---|
| `*_file`, `*_edit`, `*_delete` | `path`（短縮） |
| `*_list` | `path` or `scope` |
| `*_cli` | `$ <command>` |
| `host_http` | `<METHOD> <url-short>` |
| `memory` | `namespace/key` または `namespace: query` |
| `discord.channel_history` | `#channel-name (channelId短縮)` |
| `discord.channel_list` | `Guild channels` |
| `unknown` | `対象不明` |

---

## E. ツール別テンプレート（編集用）

> 成功文言は簡潔、失敗文言は「対象 + 原因 + 対応」を必須化します。

### E-1. Built-in

- `read_file` / `view`
  - success: `{{line_count}}行を取得`
  - error_summary: `{{path}} の読み取りに失敗しました（{{error_reason}}）`

- `edit_file` / `str_replace_editor`
  - success: `更新完了（+{{add}}/-{{del}}）`
  - error_summary: `{{path}} の更新に失敗しました（{{error_reason}}）`

- `grep`
  - success: `{{match_count}}件ヒット: {{top_hits}}`
  - error_summary: `{{scope}} の検索に失敗しました（{{error_reason}}）`

- `glob`
  - success: `{{item_count}}件: {{top_items}}`
  - error_summary: `{{scope}} の一覧取得に失敗しました（{{error_reason}}）`

### E-2. Container

- `container.file_read`
  - success: `{{line_count}}行を取得`
  - error_summary: `{{path}} の読み取りに失敗しました（{{error_reason}}）`

- `container.file_write`
  - success: `{{bytes}} bytes 書き込み`
  - error_summary: `{{path}} への書き込みに失敗しました（{{error_reason}}）`

- `container.file_delete`
  - success: `削除しました`
  - error_summary: `{{path}} の削除に失敗しました（{{error_reason}}）`

- `container.file_list`
  - success: `{{item_count}}件: {{top_items}}`
  - error_summary: `{{scope}} の一覧取得に失敗しました（{{error_reason}}）`

- `container.cli_exec` / `bash`
  - success: `{{stdout_1line}}`
  - error_summary: `コマンド実行に失敗しました（exit={{exit_code}} / {{error_reason}}）`

- `container.file_deliver`
  - success: `{{file_name}} ({{size_human}}) を返却`
  - error_summary: `{{path}} の返却に失敗しました（{{error_reason}}）`

### E-3. Host

- `host.file_read`
  - waiting_approval: `承認が必要です`
  - success: `{{line_count}}行を取得`
  - error_summary: `{{path}} の読み取りに失敗しました（{{error_reason}}）`

- `host.file_write`
  - waiting_approval: `承認が必要です`
  - success: `書き込みました`
  - error_summary: `{{path}} への書き込みに失敗しました（{{error_reason}}）`

- `host.file_delete`
  - waiting_approval: `承認が必要です`
  - success: `削除しました`
  - error_summary: `{{path}} の削除に失敗しました（{{error_reason}}）`

- `host.file_list`
  - waiting_approval: `承認が必要です`
  - success: `{{item_count}}件: {{top_items}}`
  - error_summary: `{{scope}} の一覧取得に失敗しました（{{error_reason}}）`

- `host.cli_exec`
  - waiting_approval: `承認が必要です`
  - success: `{{stdout_1line}}`
  - error_summary: `コマンド実行に失敗しました（exit={{exit_code}} / {{error_reason}}）`

- `host.http_request`
  - waiting_approval: `承認が必要です`
  - success: `HTTP {{status_code}}`
  - error_summary: `{{method}} {{url_short}} で失敗しました（HTTP {{status_code_or_unknown}} / {{error_reason}}）`

### E-4. Memory

- `memory.search`
  - success: `{{hit_count}}件ヒット: {{top_keys}}`
  - error_summary: `{{namespace}} の検索に失敗しました（{{error_reason}}）`

- `memory.get`
  - success(found): `見つかりました`
  - success(not_found): `見つかりません`
  - error_summary: `{{namespace}}/{{key}} の取得に失敗しました（{{error_reason}}）`

- `memory.upsert`
  - success: `保存しました`
  - error_summary: `{{namespace}}/{{key}} の保存に失敗しました（{{error_reason}}）`

- `memory.delete`
  - success: `削除しました`
  - error_summary: `{{namespace}}/{{key}} の削除に失敗しました（{{error_reason}}）`

### E-5. Discord

- `discord.channel_history`
  - success: `{{username}}: {{content_preview}}（他{{remaining}}件）`
  - error_summary: `{{channel_display}} の履歴取得に失敗しました（{{error_reason}}）`

  例:

  ```text
  💬 discord.channel_history
  #backend (928371)
  ❌ 失敗
  #backend の履歴取得に失敗しました（Discord API timeout）
  ```

- `discord.channel_list`
  - success: `{{channel_count}}件: {{top_channels}}`
  - error_summary: `チャンネル一覧の取得に失敗しました（{{error_reason}}）`

### E-6. Unknown

- `unknown`
  - success: `処理が完了しました`
  - error_summary: `処理に失敗しました（{{error_reason}}）`

---

## F. 整形ルール（可読性）

- 1行80文字目安
- ID短縮: `123456789012345678` -> `123456`
- 長文は `…` で省略
- 改行は空白連結
- `error_reason` は 40 文字目安で短縮

---

## G. 実装マッピング（bot.ts）

- `resolveToolEmoji` -> `B-2`
- `resolveToolDetail` -> `D-2`
- `buildToolProgressMessageContent` -> `A` + `E`
- `error_code` -> `C` を参照して `error_reason` を生成
- `tool_execution_failed` / `unknown_error` / `C` に存在しない `error_code` は `system_error_message_raw` をそのまま表示

---

## H. 変更チェックリスト

- [ ] 失敗文言に「対象」が入っている
- [ ] 失敗文言に「原因（error_reason）」が入っている
- [ ] 承認待ちは `🛂 承認待ち` で統一されている
- [ ] `tool_execution_failed` / `unknown_error` / 不明エラー時に `system_error_message_raw` をそのまま表示する
- [ ] 4行（必要時のみ補足行）で収まっている

---

## I. 承認リクエスト表示テンプレート（追加）

> ツール実行ログと同じ方針で、承認フローも「短く・分かる・編集しやすい」を維持する。  
> この節は `requestApproval` / `handleApprovalButton` 系メッセージの表示仕様テンプレートとして扱う。

### I-1. 承認リクエスト（標準4行）

```text
🛂 承認リクエスト
<tool_label>
<target_line>
⏳ 承認待ち
```

- `tool_label` 例: `host.file_read`, `discord.channel_history`
- `target_line` 例:
  - `ファイル読み取り: /path/to/file`
  - `#backend (928371)`
  - `GET https://api.example.com`

### I-2. 複数承認（同一実行内）

```text
🛂 承認リクエスト ({{index}}/{{total}})
<tool_label>
<target_line>
⏳ 承認待ち
```

例: `🛂 承認リクエスト (2/3)`

### I-3. 承認結果（簡潔）

| 状態 | 表示 |
|---|---|
| approved | `✅ 承認しました` |
| rejected | `❌ 拒否しました` |
| timeout | `⏱️ 承認がタイムアウトしました` |
| canceled | `🛑 承認待ちを終了しました` |

### I-4. 承認結果の詳細（任意1行）

```text
対象: <tool_label> / <target_line>
```

必要時のみ表示（通常は不要）。

### I-5. 承認連携エラー（Gateway反映失敗など）

```text
🛂 承認結果の反映
<tool_label>
<target_line>
❌ 失敗
{{system_error_message_raw}}
```

`tool_execution_failed` / `unknown_error` / 辞書未定義と同様、  
不明系はシステムメッセージをそのまま表示する。

### I-6. 承認 operation ラベル辞書（編集ポイント）

| operationCode | label |
|---|---|
| `read` | `ファイル読み取り` |
| `write` | `ファイル書き込み` |
| `delete` | `ファイル削除` |
| `list` | `ファイル一覧` |
| `exec` | `コマンド実行` |
| `http_request` | `HTTP リクエスト` |
| `discord_channel_history` | `チャンネル履歴参照` |
| `discord_channel_list` | `チャンネル一覧参照` |
