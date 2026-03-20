# LM への必須指示ギャップ監査（PR-3 メモリ系を除外）

## 目的

PR-1（Persona/Policy）と PR-2（Context Envelope）実装後の現状について、
「システムとして成立させるために LM に明示注入すべきだが、まだ渡せていない指示」を洗い出す。

本ドキュメントは **PR-3 で扱うメモリ関連指示を除外** する。

---

## 現在 LM に明示注入できているもの（基準）

- Persona/Policy（`systemMessage`）
  - 実装: `apps/agent/src/runtime/personaPolicy.ts`
  - 注入: `apps/agent/src/runtime/sdkProvider.ts` (`buildActiveSystemMessage`)
- Context Envelope（PR-2）
  - Attachment 名、Behavior Context、Runtime Feedback Context
  - 実装: `apps/gateway/api/src/prompt/contextEnvelope.ts`
  - 組み立て: `apps/gateway/api/src/gateway/service.ts`
- ツール定義（Gateway 経由 custom tool 群）
  - 実装: `apps/agent/src/runtime/sdkProvider.ts`

---

## 明示不足の「必須指示」と必要場面

## 1) 添付の実体配置パス（最優先）

- 欠落している指示:
  - 「今回の実行で添付実体が配置された正規パス（`attachment_mount_path`）」。
  - 例: `/agent/session/<session_id>`
- 必要になる場面:
  - ユーザーが「添付を読んで」「このファイルを見て」と指示したとき。
- 現状の問題:
  - `attachment_mount_path` は Runtime には渡しているが、LM の prompt/system には注入していない。
  - 結果として LM が `/root/.copilot/session-state/...` 側を参照し、`/agent/session` に到達できないケースが起きる。

## 2) 添付名 -> 実ファイル名/実パスの対応表

- 欠落している指示:
  - 元の添付名と、staging 後の実ファイル名/実パスの対応。
- 必要になる場面:
  - 添付名に記号や重複があり、サニタイズ/リネームが発生したとき。
- 現状の問題:
  - Agent staging は安全化のためファイル名を加工し得るが、その結果を LM が知らない。
  - 「attachment name で探すが見つからない」失敗が発生し得る。

## 3) 「添付探索の優先経路」ルール

- 欠落している指示:
  - 添付探索時の優先順（例: `attachment_mount_path` を最優先、`/root/.copilot/session-state` を前提にしない）。
- 必要になる場面:
  - 添付が存在するはずなのに見えないときのリトライ/フォールバック判断。
- 現状の問題:
  - LM 側が内蔵既定の探索パスに引っ張られ、実装上の正規経路とズレる。

## 4) 作業ルート (`session_workspace_root` / `workingDirectory`) の明示

- 欠落している指示:
  - 「作業対象のルートは `/agent/session/<session_id>`（`session_workspace_root`）」という明示。
- 必要になる場面:
  - 「このリポジトリのファイルを編集して」「このパスを読んで」など、相対/絶対パス解釈が必要なとき。
- 現状の問題:
  - 旧来の `/root/.copilot/session-state/...` を前提に探索してしまう可能性がある。

## 5) Gateway container tools のパス規約

- 欠落している指示:
  - `container.file_*` は「セッション用ルート配下の**相対パス**」前提であること。
- 必要になる場面:
  - `container.file_read/write/list/delete` を LM が選択するとき。
- 現状の問題:
  - 絶対パスを渡すと `container_path_out_of_scope` になりやすい。
  - LM に「どう書けば成功するか」の短い規約が不足している。

## 6) host 操作での承認待ち遷移ルール（エラーコード別）

- 欠落している指示:
  - `approval_required` / `approval_rejected` / `approval_timeout` を受けた際の次アクション契約。
- 必要になる場面:
  - `host.file_*`, `host.cli_exec`, `host.http_request` を伴うタスク。
- 現状の問題:
  - Policy レベルの抽象指示はあるが、エラーコードに対する具体行動が未明示。
  - 「勝手に継続しない」「承認後に同一意図で再試行」の一貫性が落ちる。

## 7) インフラ状態 (`booting/failed`) 時の応答契約

- 欠落している指示:
  - `infrastructure_status != ready` の場合に、実行断定を避ける応答ルール。
- 必要になる場面:
  - 再起動直後や障害復旧中の問い合わせ。
- 現状の問題:
  - 状態値自体は渡っているが、その値に対する「振る舞い規約」を明示していない。

---

## 優先度（提案）

- P0（直ちに必要）
  - 1) 添付実体配置パス
  - 2) 添付名->実ファイル対応
  - 3) 添付探索優先経路
- P1（次点）
  - 4) workingDirectory 明示
  - 5) container tool パス規約
  - 6) 承認エラーコード別遷移
  - 7) インフラ状態時の応答契約

---

## 注入先の推奨

- `systemMessage`（固定契約）
  - 3, 4, 5, 6, 7 を短く固定文で定義
- `Context Envelope`（実行ごと変動）
  - 1, 2 を毎回注入
  - 例: `Attachment Runtime Context` ブロックを追加し、`attachment_mount_path` と `staged_files[]` を渡す

---

## 参考実装箇所（現状）

- System Message:
  - `apps/agent/src/runtime/personaPolicy.ts`
  - `apps/agent/src/runtime/sdkProvider.ts`
- Context Envelope:
  - `apps/gateway/api/src/prompt/contextEnvelope.ts`
  - `apps/gateway/api/src/gateway/service.ts`
- 添付 staging:
  - `apps/agent/src/server.ts` (`/v1/tasks/:taskId/attachments/stage`)
  - `apps/agent/src/runtime/service.ts`
  - `apps/gateway/api/src/gateway/service.ts`
