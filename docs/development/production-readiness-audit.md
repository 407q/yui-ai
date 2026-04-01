# 本番運用監査レポート（API 間通信・構成差分・修正チェックリスト）

このドキュメントは、現行実装（Discord Bot -> Gateway API -> Agent Runtime）を
本番運用に載せる前の**修正点洗い出し**を目的とした監査レポートです。  
特に、API 間通信・名前解決・認証/認可・可観測性・運用自動化を中心に、
「必須 / 推奨 / 任意」で整理しています。

---

## 1. 監査スコープと前提

対象:

- `apps/gateway/api`（Bot / Gateway API / MCP / Orchestrator）
- `apps/agent`（Agent Runtime / Copilot SDK provider）
- `docker-compose.yml`
- `.env.example` / `.env.op.example`
- 主要 README / development docs

現行トポロジ（実装ベース）:

- Bot + Gateway API: ホスト上 Node.js
- Agent + Postgres: Docker Compose
- Agent -> Gateway: `AGENT_GATEWAY_BASE_URL`（same-host 既定 `http://127.0.0.1:3800`）
- Bot -> Gateway / Bot -> Agent: `http://127.0.0.1:*`

---

## 2. 結論サマリ（先に要点）

現状は「開発～検証向けとしては成立」していますが、本番運用向けには以下が主要ギャップです。

1. **内部 API 認証が未実装**（Bot↔Gateway, Gateway↔Agent, Agent↔Gateway MCP）→ ✅ static token 導入済み
2. **通信経路を内部 UDS 優先に移行する**
3. **サービス間名前解決が host 依存**（`host.docker.internal` / `127.0.0.1`）
4. **Agent セッション復元がプロセス内 Map 依存**（再起動時の resume 信頼性ギャップ）→ ✅ runtime session/task snapshot 永続化を実装
5. **保持データ cleanup が手動実行前提**（定期ジョブ未統合）→ ✅ Orchestrator 定期 cleanup 実装
6. **ドキュメント不整合**（Node 20 記載 vs `BOT_MODE=standard` 実行要件 Node >=22）→ ✅ Node 22 必須へ統一

---

## 3. 優先度別チェックリスト

### 3.1 必須（Go-Live 前に対応）

#### [M-01] 内部 API 認証を導入する

問題:

- `gatewayApiRequest`（Bot -> Gateway）に認証ヘッダなし
- `HttpAgentRuntimeClient`（Gateway -> Agent）に認証ヘッダなし
- `GatewayMcpClient`（Agent -> Gateway）に認証ヘッダなし

該当:

- `apps/gateway/api/src/bot.ts`
- `apps/gateway/api/src/agent/runtimeClient.ts`
- `apps/agent/src/runtime/gatewayMcpClient.ts`
- `apps/gateway/api/src/gateway/routes.ts`
- `apps/gateway/api/src/mcp/routes.ts`
- `apps/agent/src/server.ts`

対応方針:

- 最低限 static token 方式を追加（例: `X-Internal-Token`）
- 経路ごとに token 分離:
  - Bot -> Gateway
  - Gateway -> Agent
  - Agent -> Gateway
- ルートで必須化（health/ready を除くかは運用方針次第）
- 401/403 監査ログを追加

受け入れ:

- token 不一致で API が拒否される
- token 一致時のみ既存 smoke が通る

---

#### [M-02] 本番トポロジを固定し、名前解決を構成に反映する

問題:

- 既定値が `127.0.0.1` / `host.docker.internal` 前提
- Linux 本番で `host.docker.internal` 依存は環境差が出やすい

該当:

- `docker-compose.yml`
- `.env.example`
- `.env.op.example`
- `apps/agent/src/server.ts`（Gateway URL fallback）
- `apps/gateway/api/src/server.ts`（Agent URL fallback）
- `apps/gateway/api/src/bot.ts`（Gateway/Agent URL fallback）

対応方針（どちらかを採用）:

- **A. ホスト Gateway 維持案（現行踏襲）**
  - `AGENT_GATEWAY_BASE_URL` を固定値で明示設定（環境別）
  - `extra_hosts` 依存を運用手順に明示
- **B. Compose 集約案（推奨）**
  - Bot/Gateway も compose service 化
  - `http://gateway-api:3800`, `http://agent:3801` の service DNS に統一
  - `ports` 公開は必要最小限へ縮小

受け入れ:

- デフォルト値だけで疎通可能（環境依存の暗黙設定不要）
- restart 後も通信経路が変わらない

---

#### [M-03] Agent セッション復元を永続化する（✅ 対応済み）

問題:

- `AgentRuntimeService` は `sessions/tasks` をプロセス内 `Map` で保持
- 再起動後は `bootstrapMode` 判定が常に `create` 側に寄り得る
- NFR の「再起動後 resume」を満たしきれない可能性

該当:

- `apps/agent/src/runtime/service.ts`
- `apps/agent/src/runtime/sdkProvider.ts`

対応方針:

- 最低限、`session_id -> sdk_session_id` の復元情報を永続ストア化
- 起動時に復元して `resumeSession` を優先
- task status も最終状態を再構築可能にする

受け入れ:

- Agent 再起動後に既存スレッドで継続実行できる
- `session_not_found` や create 再作成に落ちない

---

#### [M-04] cleanup の定期実行を運用へ組み込む（✅ 対応済み）

問題:

- `db:cleanup` は手動コマンドのみ
- retention は定義されているが自動適用されない

該当:

- `apps/gateway/state/src/cleanup.ts`
- `package.json` (`db:cleanup`)

対応方針:

- systemd timer / cron / scheduler いずれかで日次実行
- 失敗時の system alert を通知
- 実行ログ（削除件数）を運用監視へ連携

受け入れ:

- retention 期間を超えたデータが定期的に削除される

---

#### [M-05] API 面の権限チェックを追加（Bot 依存を減らす）

問題:

- `respondApproval` などで API 層の「セッション所有者」検証が薄い
- Bot 側で制御していても、API 直叩きで越権可能性が残る

該当:

- `apps/gateway/api/src/gateway/service.ts`
- `apps/gateway/api/src/gateway/routes.ts`

対応方針:

- `userId` を必須にし、対象 session/task/approval の所有者一致を service 層で検証
- 不一致時は `403 forbidden` を返却

受け入れ:

- API 単体で越権操作が拒否される

---

### 3.2 推奨（初期運用で早期対応）

#### [R-01] Node 実行要件の不整合を解消（✅ 対応済み）

問題:

- `runtime-environment-template.md` 実働 Node 20 記載
- `apps/agent/src/server.ts` は `BOT_MODE=standard` で Node >=22 必須

対応方針:

- docs を Node 22 前提へ統一
- 本番ホストも Node 22 系へ更新

---

#### [R-02] ネットワーク露出を最小化

問題:

- compose で `postgres` / `agent` が host port 公開
- 使わない外部公開が攻撃面を増やす

対応方針:

- 外部公開不要なら `ports` を削除し内部 network のみ
- 必要時のみ reverse proxy 経由で公開

---

#### [R-03] Host 実行時の環境露出を縮小（✅ 対応済み）

問題:

- `execCommand` が `env: process.env` を継承
- `host.cli_exec` 実行プロセスへ不要環境変数が渡る

該当:

- `apps/gateway/api/src/mcp/exec.ts`

対応方針:

- 必要最小限 env allowlist を実装
- 秘密値を含む env をデフォルト除外

---

#### [R-04] Discord イベント冪等性の明示実装

問題:

- 要件上は冪等必須だが、message/interaction 単位の重複排除が薄い

該当:

- `apps/gateway/api/src/bot.ts`

対応方針:

- `message.id` / `interaction.id` をキーに短期重複防止キャッシュを実装
- 二重 task 起動を防止

---

#### [R-05] 内部通信の TLS 方針を明確化

問題:

- 現行は HTTP 前提
- 同一ホスト前提を崩すと平文通信になる

対応方針:

- 1ホスト完結なら loopback + FW 制限を明文化
- 複数ノード化するなら mTLS/mesh/proxy で TLS 終端を導入

---

### 3.3 任意（中期改善）

#### [O-01] readiness を依存先チェック付きに強化

- 現状 `/ready` が実質軽量応答中心
- DB/Agent 依存先の到達性も評価対象に含める

#### [O-02] operation log の機密マスキング強化

- 引数ログに URL/パス等が含まれるため、必要に応じて redact ルールを追加

#### [O-03] 本番 runbook の一本化

- 起動、再起動、障害復旧、secret rotate、backup/restore を1ファイルに統合

---

## 4. API 間通信の推奨構成（コンテナ名解決）

### 推奨: Compose 集約（service DNS 統一）

例:

- Bot -> Gateway: `http://gateway-api:3800`
- Gateway -> Agent: `http://agent:3801`
- Agent -> Gateway MCP: `http://gateway-api:3800`
- Gateway/Agent/Postgres を同一 compose network に配置

効果:

- `host.docker.internal` 依存を除去
- 環境差分を削減
- デプロイ手順を単純化

注意:

- host の Discord token / 1Password 注入方式との整合を先に決めること

---

## 5. 具体修正ポイント（ファイル別）

- `apps/gateway/api/src/bot.ts`
  - Gateway 呼び出し時に内部認証ヘッダ付与
  - message/interaction 冪等制御追加

- `apps/gateway/api/src/agent/runtimeClient.ts`
  - Agent 呼び出し時に内部認証ヘッダ付与

- `apps/agent/src/runtime/gatewayMcpClient.ts`
  - Gateway 呼び出し時に内部認証ヘッダ付与

- `apps/gateway/api/src/gateway/routes.ts`
  - 内部 API 認証ミドルウェア導入
  - approval 系 user ownership 検証のため payload 契約見直し

- `apps/agent/src/server.ts`
  - internal token 検証導入（run/status/cancel/stage）

- `apps/agent/src/runtime/service.ts`
  - session/task 状態の永続復元導入

- `docker-compose.yml`
  - （採用案に応じて）Bot/Gateway を compose 化
  - internal network 前提へ `ports` 見直し

- `.env.example`, `.env.op.example`
  - 内部 token 変数追加（例: `INTERNAL_GATEWAY_TOKEN`, `INTERNAL_AGENT_TOKEN`）
  - URL 既定値を service DNS ベースへ更新（compose 集約時）

- `docs/development/runtime-environment-template.md`
  - Node 22 要件に更新

---

## 6. リリース判定ゲート（最小）

Go-Live 判定として、最低限以下を満たしてください。

1. 内部 API が未認証で呼べない
2. Agent 再起動後に `/resume` + task 実行が通る
3. cleanup が定期実行される
4. Node 22 要件と実運用環境が一致している
5. 本番トポロジ（名前解決方式）が docs / env / compose で一致している

---

## 7. 既知の方針決定ポイント（要確定）

最終的に次の2点は運用方針として固定が必要です。

1. **Gateway/Bot をホスト実行で維持するか、compose 集約するか**
2. **内部 API 認証方式（static token / mTLS / 署名ヘッダ）を何にするか**

この2点が決まれば、残る修正は実装チェックリストに沿って機械的に進められます。
