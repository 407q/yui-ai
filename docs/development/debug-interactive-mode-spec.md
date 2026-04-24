# デバッグ対話シェル要件定義（`yarn debug` / `yarn debug:local`）

本書は、障害時に **デバッグシェル自体は終了せず**、そこから各種調査ツールへアクセスし続けられる運用モードの要件を定義する。

---

## 1. 基本方針

1. デバッグシェルはエラーで落ちない（明示 `exit` のみ終了）。
2. コンポーネント障害とシェル障害を分離する。
3. まず起動対象を選び、次に追加設定を調整する。
4. すべての操作は観測可能（ログ・履歴・スナップショット）である。

---

## 2. スコープ

### 2.1 対象

- `yarn debug:local`
- `yarn debug`（`op run --env-file=.env.op -- yarn debug:local`）
- Bot 本体と分離された debug 専用スクリプト
- Preflight、起動制御、観測、復旧、証跡採取

### 2.2 非対象

- 通常運用モード（`yarn dev`, `yarn start`）の既定挙動変更
- 各障害の根本修正そのもの

---

## 3. 実行モデル

デバッグモードは以下 2 段階で動作する。

1. **Preflight フェーズ**
   - 起動コンポーネント選択（既定: 全有効）
   - 追加設定の確認・編集
   - バリデーション
   - `start` で実行フェーズへ遷移
2. **Runtime フェーズ**
   - 起動後の監視・調査・復旧・証跡採取
   - エラー時もシェルを継続し、操作可能な状態を維持

---

## 4. シェル継続性（最重要要件）

### 4.1 継続性契約

- コマンド失敗（非ゼロ終了・例外・タイムアウト）でシェルは終了しない。
- 対象コンポーネント（discord bot / gateway / compose）が落ちてもシェルは終了しない。
- シェル終了は `exit` のみ。

### 4.2 失敗時の標準挙動

- 失敗は `error` イベントとして記録する（時刻、コマンド、要約、詳細）。
- 直近の失敗情報を `status` / `history` で参照可能にする。
- 自動 `process.exit` は行わない。

---

## 5. コンポーネントモデル（既定: 全有効）

起動対象コンポーネント:

- `discord.bot`（Discord Bot プロセス）
- `gateway.api`（Gateway API プロセス）
- `compose.postgres`（Postgres コンテナ）
- `compose.agent`（Agent コンテナ）
- `db.migrate`（起動時マイグレーション）
- `orchestrator.monitor`（監視ループ）
- `orchestrator.cleanup`（定期 cleanup）

補足:

- MCP ツール群は `gateway.api` に内包（別コンポーネントに分離しない）。

### 5.1 依存関係ルール

- `compose.agent=true` は `compose.postgres=true` を前提
- `db.migrate=true` は `compose.postgres=true` を前提
- `discord.bot=true` は `gateway.api=true` を前提
- `discord.bot=true` は `DISCORD_BOT_TOKEN` 必須

---

## 6. Preflight 要件（起動前）

### 6.1 操作順序

1. コンポーネント選択
2. 追加設定編集
3. 差分確認
4. バリデーション
5. `start`

### 6.2 追加設定（最低限）

- 起動制御: `composeBuild`, `stopComposeOnExit`
- 復旧制御: `autoRecoveryEnabled`, `failureThreshold`, `monitorIntervalSec`
- 接続制御: `INTERNAL_CONNECTION_MODE`, `RUNTIME_SOCKET_DIR`, socket path 群
- 実行制御: `commandTimeoutSec`, `cleanupIntervalSec`
- 観測制御: `snapshotOnFailure`, `envDumpOnStart`

### 6.3 Preflight コマンド

- `components`
- `enable <component>` / `disable <component>`
- `preset full|minimal|infra-only|api-only`
- `set <key> <value>` / `unset <key>`
- `diff`
- `validate`
- `save-profile <name>` / `load-profile <name>`
- `start` / `start --yes`
- `reset`

---

## 7. Runtime ツール要件（起動後）

### 7.1 状態確認

- `status`: shell + 各コンポーネント状態 + 最終失敗要約
- `probe`: gateway/agent/db の疎通確認
- `ps`: compose 状態
- `sockets`: UDS 実体（存在/種別/owner/mode/listener）

### 7.2 ログ・履歴

- `logs all|agent|postgres|bot [tail]`
- `history`（コマンド・イベント履歴）
- `snapshot [tag]`（状態一括保存）

### 7.3 コンポーネント操作

- `up`, `down`
- `restart all|agent|postgres|bot`
- `bot status|start|stop|restart`

### 7.4 設定可視化

- `env`
- `env <KEY>`
- `env --all`（秘密値はマスク）
- `config`（有効設定の解決値表示）

表示要件:

- 値の出所を併記（`explicit env` / `default` / `derived`）
- 失敗・未設定を隠さず表示
- トークン/パスワード/DSN/APIキーは常にマスク

---

## 8. エラー処理要件

### 8.1 共通

- すべてのコマンドで `ok/error` を返す
- `error` 時もプロンプトを復帰し、次コマンドを受付可能にする

### 8.2 典型障害の扱い

- `ECONNREFUSED`, `EACCES`, `ENOENT` は種別別に集計
- 最終成功時刻、最終失敗時刻、連続失敗回数を保持
- 自動終了せず、オペレータへ次アクション候補を表示

### 8.3 自動復旧の扱い

- debug 既定は `autoRecoveryEnabled=false`
- 有効化時のみ自動復旧を許可
- 自動復旧実行有無は履歴へ記録

---

## 9. ログ・証跡

保存先:

- `debug/YYYYMMDD-HHMMSS/`

保存対象:

- shell イベントログ（コマンド、結果、エラー）
- preflight 変更履歴（before/after, operator, timestamp）
- compose / gateway / bot のログ断片
- probe / sockets / env / config のスナップショット
- `snapshot` 出力（JSON）

フォーマット:

- 人間可読ログ + JSONL 併用
- timestamp + session id を必須付与

---

## 10. 安全性要件

- destructive 操作（`down` 等）は確認付きまたは明示フラグ必須
- 実行可能コマンドは allowlist 方式
- debug モードであることを起動バナーとログで明示

---

## 11. 受け入れ条件

1. `yarn debug(:local)` で起動できる  
2. いずれのコマンド失敗でもシェルが継続する  
3. コンポーネントクラッシュ後も `status/logs/probe/snapshot` が利用できる  
4. 起動前に「コンポーネント選択 → 追加設定編集」の順で操作できる  
5. `env/config` で調査に必要な設定値を確認できる（秘密値はマスク）  
6. 明示指示なしで `compose down` しない  
7. 通常モードの挙動は不変  

---

## 12. 実装タスク（更新版）

1. shell 継続性の統一実装（例外時も prompt 復帰）
2. Preflight の 2 段階 UI（コンポーネント選択 → 追加設定）
3. 依存関係バリデーションと設定差分表示
4. runtime ツール群（status/probe/sockets/logs/history/snapshot/env/config）
5. コンポーネント操作（up/down/restart/bot control）
6. エラー統計・最終失敗情報の保持と表示
7. 証跡保存基盤（JSONL + snapshot）
