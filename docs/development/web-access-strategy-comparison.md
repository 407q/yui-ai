# Webアクセス方式の比較検討

`host.http_request` を検索対応に拡張する案と、Copilot SDK 内蔵 Web ツールを使う案を、現行コードベースの制約を前提に比較した結果をまとめます。

## 1. 比較対象

- 案A: 既存 `host.http_request` を拡張し、検索用途（クエリ -> 検索結果整形）を扱えるようにする
- 案B: Copilot SDK 側の built-in Web ツール（`url` permission 系）を直接使う

---

## 2. 現行実装で確認できる事実

### 2.1 Gateway 経由が基本設計

- Persona policy は `Use gateway-mediated tools only.` を明記  
  (`apps/agent/src/runtime/personaPolicy.ts`)
- `tool_routing_mode: gateway_only` が system message に注入される  
  (`apps/agent/src/runtime/sdkProvider.ts`)
- `gateway_only` 時は `request.kind !== "custom-tool"` を deny  
  (`createPermissionHandler`, `apps/agent/src/runtime/sdkProvider.ts`)

### 2.2 `host.http_request` は既に承認/監査配線済み

- ツール実装は `HostToolAdapter.httpRequest()`（`fetch` 実行）  
  (`apps/gateway/api/src/mcp/hostAdapter.ts`)
- Scope は URL 全体ではなく `origin` 単位で承認判定  
  (`resolveApprovalScopeFromGatewayToolCall`, `apps/agent/src/runtime/sdkProvider.ts`)
- Gateway 側でも `operation="http_request"` + `scope=origin` で承認確認  
  (`assertHostScopeAllowed`, `apps/gateway/api/src/mcp/service.ts`)
- 承認は `approval.requested/approved/rejected/timeout` として task event に記録され、Bot UI でも `HTTP リクエスト` として表示される  
  (`apps/gateway/api/src/gateway/service.ts`, `apps/gateway/api/src/bot.ts`)

### 2.3 Copilot SDK 側は built-in 利用可能だが制御が必要

- SDK は built-in tool の上書き (`overridesBuiltInTool`) をサポート  
  (`node_modules/@github/copilot-sdk/README.md`)
- permission kind には `url` が存在  
  (`node_modules/@github/copilot-sdk/dist/types.d.ts`)
- ただし現行実装では:
  - `gateway_only` は non-custom を拒否
  - `hybrid` でも `read/write/shell` のみ許可し `url` は拒否
  (`createPermissionHandler`, `apps/agent/src/runtime/sdkProvider.ts`)

---

## 3. 案A: `host.http_request` 検索拡張

## 概要

`host.http_request` に検索向け入力を追加し、Gateway 側で検索API呼び出し + 結果正規化を行う。

## 実装イメージ

- 入力拡張（例）
  - `mode: "request" | "search"`（既定 `request`）
  - `query`, `provider`, `limit`, `language`
- 検索時は provider API を呼び、以下の共通形式で返却
  - `items: [{ title, url, snippet, source }]`
- 承認スコープは現行どおり origin 単位を維持（provider origin）
- `mcp.tool.call/result`, `approval.*`, audit log は既存経路をそのまま利用

## 利点

- 現行方針（Gateway一元制御、監査、承認UI）と整合
- Bot の承認表示・運用runbook・障害切り分けを維持
- 既存 `host.http_request` の延長で導入コストが低い

## 懸念

- 検索品質は provider API に依存（ランキング/鮮度の差）
- provider key 管理（環境変数）とレート制御が必要

---

## 4. 案B: Copilot SDK built-in Web ツール利用

## 概要

SDK built-in の Web 系ツールを `availableTools` へ許可し、モデルに直接実行させる。

## 利点

- 実装量が少ない可能性
- モデルネイティブの探索体験を得やすい

## 懸念（現行構成では大きい）

- 現状は permission が `url` を許可しておらず、そのままでは使えない
- Gateway 承認（origin粒度）/監査テーブルとの整合が崩れる
- `gateway_only` 原則（設計・persona）に反する
- built-in 経路の event を Gateway 監査形式へ正規化する追加実装が必要

---

## 5. 比較表

| 観点 | 案A: `host.http_request` 拡張 | 案B: SDK built-in Web |
|---|---|---|
| Gateway 経由原則との整合 | 高い | 低い（追加改修必須） |
| 承認UI/承認スコープ再利用 | そのまま可能 | 別途再設計が必要 |
| 監査ログ一元化 | そのまま可能 | 追加ブリッジ実装が必要 |
| 実装コスト（現行への追加） | 中 | 中〜高（ポリシー変更含む） |
| 将来の柔軟性 | 高い（provider差し替え可能） | 中（SDK依存が強い） |
| 運用安全性（現行方針） | 高い | 低い（初期状態） |

---

## 6. 結論

現行要件（Gateway 経由・明示承認・監査一元化）を守る前提では、**案A（`host.http_request` 検索拡張）を推奨**します。

案Bは技術的には可能ですが、実運用に乗せるには permission/policy/event bridge を含む設計変更が必要で、今回の目的（Webアクセス強化）に対しては過剰です。

---

## 7. 推奨実装ステップ（案A）

1. `host.http_request` の引数スキーマに検索モードを追加  
2. `HostToolAdapter` に provider 別検索実装（まず1 provider）を追加  
3. 返却形式を `items[]` に正規化し、Bot表示で要約しやすくする  
4. `api:smoke` に以下を追加  
   - 検索の成功ケース  
   - 未承認 origin で `approval_required` になるケース  
   - timeout/error ハンドリング

