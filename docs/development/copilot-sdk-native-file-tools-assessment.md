# Copilot SDK ネイティブファイル操作活用可否の検討

## 目的

現状の `Gateway MCP -> container/host adapter` 経路に対して、Copilot SDK が持つネイティブのファイル系ツール（例: `read_file`, `edit_file`）を活用できるかを評価する。

---

## 前提（現行の必須要件）

- ツール実行は **Gateway 経由のみ**（`gateway_only`）
- 外部 MCP は無効（`external_mcp_disabled`）
- host 操作は明示承認必須
- 既定作業領域は `/agent/session/<session_id>`
- 監査・操作ログは Gateway/Discord で一貫して把握する

現行実装では `apps/agent/src/runtime/sdkProvider.ts` で custom tool のみを `availableTools` に登録し、`onPermissionRequest` でも `custom-tool` 以外を拒否している。

---

## 調査結果（Copilot SDK 側の事実）

1. SDK には built-in tool があり、`tools.list` や README 上で `read_file` / `edit_file` などが想定されている。
2. `availableTools` / `excludedTools` で利用可能ツールを制御できる。
3. custom tool は `overridesBuiltInTool: true` で built-in 名を上書きできる。
4. permission request は `read` / `write` / `shell` / `mcp` / `url` / `custom-tool` などの kind を持つ。
5. `hooks`（pre/post tool use）で追加制御は可能。
6. `session.rpc.workspace.readFile/createFile` も存在するが、これは SDK 利用側 API であり、LM が自律実行する tool とは別物。

---

## 実装案の比較

| 案 | 概要 | 要件適合 | 主な利点 | 主な懸念 |
|---|---|---|---|---|
| A. 現行維持 | custom tool (`container.*`,`host.*`) を Gateway へ委譲 | ◎ | 承認・監査・境界制御が一貫 | Gateway 往復ぶんの遅延 |
| B. built-in 直接利用 | `read_file/edit_file/bash` を SDK 標準で実行 | △ | 実行経路が短く高速 | Gateway 経由原則と衝突、host/container 区別が崩れやすい |
| C. built-in 名を override | `read_file` などを custom tool で上書きし Gateway へ委譲 | ○ | ツール名の自然さと Gateway 統制を両立 | 実装とマッピングが増える |

---

## 結論

- **技術的には可能**（B/C いずれも実装可能）。
- ただし現行要件（Gateway 経由のみ、承認・監査の一元化）を守る前提では、**B（built-in 直接利用）は本番採用非推奨**。
- 要件準拠で「ネイティブっぽい操作感」を得るなら、**C（built-in 名の override + Gateway 委譲）が現実的**。
- よって現時点の推奨は:
  - 運用: **A 維持**
  - 将来拡張: **C を段階導入**

---

## C 案（推奨拡張）の最小実装イメージ

1. `sdkProvider` で `defineTool("read_file" | "edit_file" | ...)` を `overridesBuiltInTool: true` 付きで登録
2. handler 内で `container.file_*`（必要時 `host.file_*`）へ Gateway 委譲
3. パス規約を `/agent/session/<session_id>` 基準で正規化
4. 既存の `onPermissionRequest` は `custom-tool` のみ許可を維持
5. Bot 操作ログは override tool 名と実際の Gateway tool 名の両方を記録
6. smoke に「override 経由での read/write/list」回帰を追加

---

## B 案を採る場合に必要な追加対応（参考）

- `onPermissionRequest` で `read/write/shell/url` を Gateway 承認フローへ接続
- `hooks` でパス境界（`/agent/session/<session_id>`）を強制
- session event 由来の tool 実行ログを監査テーブルへ保存
- host/container 区別の再設計（built-in は `host.*` / `container.*` の概念を持たない）

上記を入れても、「実行そのものは Gateway ではなく Copilot CLI 側」である点は変わらないため、現行方針とのズレは残る。

---

## 追記: ハイブリッド案（コンテナ内は built-in、コンテナ外は Gateway）の追加懸念

方針としては有効だが、A/C 案より運用設計が難しくなる。主な懸念は以下。

1. 境界判定の曖昧化  
   built-in 側には `container.*` / `host.*` の名前空間がないため、LM の判断ミスで「本来 Gateway 経由にすべき操作」が built-in 側に流れやすい。
→ System Message で対応可能、Gateway はその名の通り「LMの作業場とその外の境界」として動作する
→ 対応方針に同意。加えて、**System Message だけに依存せず** `availableTools` の厳格 allowlist と `onPreToolUse` hooks による機械的ガードを必須にする（ポリシー文言 + 実行時制約の二層化）。


2. 承認モデルの二重化  
   現在の承認は Gateway Approval Manager 中心。hybrid では SDK の `read/write/shell/url` permission と Gateway 承認を整合させる追加実装が必要。
→ 現在実装と同様、コンテナ内の操作には承認を必要としない

3. 監査ログの分断  
   Gateway 実行ログと SDK session event（built-in 実行）が別系統になる。`task_id/session_id/thread_id` 単位で相関保存しないと追跡不能になる。
→ これについてはそう

4. Bot 操作ログ UX の不一致  
   現在の絵文字ログは Gateway tool 呼び出し前提。built-in 実行も同等表示しないと、ユーザー視点で「何をしたか」が欠落する。
→ 同等表示へのハードルは3で述べられている通りだと思う

5. パス境界の強制難易度  
   `workingDirectory` 指定だけでは不十分。絶対パス、`..`、symlink、bind mount 先を含めて `/agent/session/<session_id>` 境界を hook で強制する必要がある。
→ これによる破壊リスクを回避するためにコンテナ化しているので、ある程度の強制力でよいと思う

6. ホスト保護要件との競合リスク  
   コンテナがホストをマウントしている場合、built-in から実質 host 領域に触れる経路が生まれる。設計上「コンテナ内＝安全」とは限らない。
→ コンテナがマウントしているのはホストではなく yui-ai_agent_workspace_data という独立した Docker Volume のため、この心配はない

7. 再現性とテストコストの増加  
   同じ「ファイル操作」でも built-in 経路と Gateway 経路で失敗モードが異なる。smoke/E2E を経路別に持つ必要があり、保守負荷が上がる。
→ これについてはそう

8. 障害切り分けの複雑化  
   失敗時に「SDK built-in 側の失敗か、Gateway 側の失敗か」を判定する追加メタデータ（execution plane）が必要になる。
→ 複雑にはなるが必要であって当然だと思う、実行方法自体が違うので切り分けは容易 (Copilot SDK 側で失敗として記録されるはず)

### ハイブリッド採用時の最低ガード

- `availableTools` を allowlist で厳密管理し、built-in は必要最小限（例: `read_file`/`edit_file`）のみ許可
- `url` / `mcp` / 広範な `shell` は原則 Gateway 側に寄せる
- `onPermissionRequest` + hooks でパス境界チェックを二重化
- built-in 実行イベントを Gateway 監査ログ形式へ正規化して保存
- Bot 操作ログに built-in 実行も同じコードブロック形式で表示

→ パス境界については先述の通り、それ以外は異論なし

※補足: 境界ガードの実装優先度は `availableTools` 制約 > hooks 検証 > System Message 誘導。  
System Message は意図誘導には有効だが、最終的な安全性は機械的制約で担保する。

---

## 最終判断（本ドキュメント時点）

- 本プロジェクトの設計原則を優先し、**当面は Gateway custom tool 方式を継続**する。
- ネイティブファイル操作の活用は、**built-in 名 override による互換レイヤ（C案）として検討継続**とする。
- hybrid（コンテナ内 built-in / コンテナ外 Gateway）を採る場合は、上記ガードを満たす設計を前提に段階導入する。
