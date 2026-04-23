# デバッグ対話モード仕様（`yarn debug` / `yarn debug:local`）

本書は、今回の UDS 障害調査だけでなく、今後の本番相当トラブルシュート全般を対象にした
「デバッグ運用モード」の要件定義です。

---

## 1. 背景

通常モードは「安全に自動復旧してサービス継続する」ことを優先しており、障害調査では次の問題がある。

- Orchestrator の復旧/終了シーケンスで `compose down` が走り、障害時の socket・コンテナ状態が消える
- `gracefulTerminate...` / `uncaughtException` で Bot プロセスが終了し、現場観測が途切れる
- 障害再現時に「実際に渡った環境変数・解決済み設定値」を即時に確認しづらい

---

## 2. 目的

- 障害発生後も **観測可能な状態を保持** し、原因分析に必要な情報を失わない
- 復旧を自動化ではなく **オペレータ主導** に切り替える
- 「渡った環境変数」と「有効設定」を **その場で可視化** できる
- 通常モードと切り離し、運用安全性を保ったまま検証できる

---

## 3. スコープ

### 3.1 対象

- `yarn debug:local`
- `yarn debug`（`op run --env-file=.env.op -- yarn debug:local`）
- Bot 本体とは別プロセスの debug 専用スクリプト
- Gateway / Orchestrator / compose の起動・監視・終了・障害処理
- debug 専用の対話コマンド、ログ、証跡保存

### 3.2 非対象

- 通常モード（`yarn dev`, `yarn start`）の既定挙動変更
- 障害原因そのものの修正

---

## 4. モード定義

### 4.1 起動コマンド

- `yarn debug:local`: デバッグ用対話スクリプトを起動
- `yarn debug`: 1Password 経由で同上

### 4.2 モードフラグ

- debug スクリプト側で `BOT_DEBUG_INTERACTIVE=true` を必須付与
- Bot 本体（`yarn dev(:local)`）には組み込まない

### 4.3 前提

- `INTERNAL_CONNECTION_MODE=tcp|uds` の両方をサポート（UDS 固定にしない）
- Agent は既存方針どおり現在ユーザー UID/GID で起動

### 4.4 起動前設定（Preflight）要件

debug モードでは、システム起動前に設定を確認・編集できることを必須とする。

- 起動シーケンスに入る前に preflight フェーズへ入る
- まず「起動するコンポーネント」を選択する（既定は全選択）
- コンポーネント選択後に必要な追加設定を編集する
- 現在値・既定値・値の出所（env/default/derived）を一覧表示する
- 変更内容を確認後、明示操作（`start`）までインフラ起動を開始しない
- 変更内容を破棄して既定値に戻せる（`reset`）

### 4.5 起動コンポーネント選択（既定: 全て）

Preflight の最初のステップとして、以下の起動対象を選択できること。

- `compose.agent`（Agent コンテナ）
- `compose.postgres`（PostgreSQL コンテナ）
- `db.migrate`（起動時マイグレーション）
- `gateway.api`（Gateway API サーバー）
- `orchestrator.monitor`（監視ループ）
- `orchestrator.cleanup`（定期 cleanup）

仕様:

- 既定は **全コンポーネント有効**
- 依存関係違反は `validate` で検出する  
  例: `db.migrate=true` かつ `compose.postgres=false` は不正
- `start` 実行時は選択コンポーネントのみ起動/実行

### 4.6 Preflight で編集可能な追加設定項目

最低限、以下のカテゴリを編集対象に含める。

1. **起動シーケンス制御**
   - `composeBuild`（compose up 時に build を行うか）
   - `composeUpEnabled`（compose up を実行するか）
   - `dbMigrateEnabled`（起動時に migrate を実行するか）
   - `gatewayStartEnabled`（Gateway API 起動を行うか）
2. **復旧・終了制御**
   - `autoRecoveryEnabled`（自動 restart/down/up 実行可否）
   - `stopComposeOnExit`（終了時に compose down するか）
   - `failureThreshold` / `monitorIntervalSec`
3. **接続経路**
   - `INTERNAL_CONNECTION_MODE`（tcp/uds）
   - `RUNTIME_SOCKET_DIR`
   - `GATEWAY_API_SOCKET_PATH` / `AGENT_RUNTIME_SOCKET_PATH` / `AGENT_SOCKET_PATH`
   - DB 接続関連（`POSTGRES_SOCKET_PATH`, `DB_SOCKET_MOUNT_PATH`, `POSTGRES_PORT` など）
4. **観測・診断**
   - `LOG_LEVEL`, `COPILOT_SDK_LOG_LEVEL`
   - `snapshotOnFailure`（障害時に自動証跡採取）
   - `envDumpOnStart`（起動時の環境変数スナップショット採取）
5. **安全制御**
   - `commandTimeoutSec`
   - `allowDestructiveCommands`（`down` 等の許可方針）

---

## 5. 起動・終了・復旧シーケンス要件

### 5.1 自動停止抑止

`BOT_DEBUG_INTERACTIVE=true` では以下を抑止する。

- 障害時の `shutdownInfrastructure({ stopCompose: true })`
- `gracefulTerminateFromInfrastructureFailure` からの `process.exit(1)`
- `uncaughtException` での即時終了

期待挙動:

- Bot プロセスは継続
- `runtimeInfrastructureStatus` を `failed` に遷移
- 「debug mode により継続中」を明示ログ/alert出力

### 5.2 compose down の明示化

- debug モードでは `compose down` は明示操作時のみ実行
- `/exit` `/reboot` の既定は `stopCompose=false`
- `--with-compose-down` 明示時のみ down を許可

### 5.3 Orchestrator 自動復旧の抑止

debug モードでは監視は継続するが、自動 `restart/down/up` は実行しない。

- 健全性は継続観測する
- 復旧は対話コマンドで実施
- 復旧判断材料（失敗回数、最終成功時刻）を保持

---

## 6. 対話コマンド要件（拡張版）

Bot プロセス標準入力（TTY）で受け付ける。Discord コマンドとは分離する。

### 6.0 起動前設定操作（Preflight）

- `preflight`: 現在の preflight 設定一覧表示
- `components`: 起動対象コンポーネント一覧と有効/無効状態を表示
- `enable <component>` / `disable <component>`: コンポーネント選択の変更
- `preset full|minimal|infra-only|api-only`: コンポーネント選択のプリセット適用
- `set <key> <value>`: 設定値変更
- `unset <key>`: 明示設定解除（既定値へ戻す）
- `diff`: 既定値との差分表示
- `validate`: 起動前バリデーション実行（必須値・整合性・path）
- `save-profile <name>` / `load-profile <name>`: 設定プロファイル保存/読込
- `start`: 現在設定で起動シーケンス開始
- `reset`: preflight 変更を破棄

要件:

- `start` 前に「有効コンポーネント一覧 + 追加設定差分」を最終確認表示する
- `start --yes` 以外では確認プロンプトを出す

### 6.1 基本操作

- `help`: コマンド一覧
- `status`: 全体状態（infra/gateway/agent/compose）
- `ps`: compose 状態
- `up`, `down`, `restart agent|postgres|all`
- `logs agent|postgres|all [--tail N] [--follow]`

### 6.2 接続・socket診断

- `probe`: gateway/agent/db の health probe 一括実行
- `probe gateway|agent|db`: 個別 probe
- `sockets`: UDS ファイル一覧・owner/mode/type・listener 有無

### 6.3 環境変数・有効設定の可視化（必須）

- `env`: デバッグ対象の主要環境変数を表示
- `env <KEY>`: 単一キー表示
- `env --all`: 全環境変数表示（秘密値はマスク）
- `config`: 実際の解決済み設定値（socket path、mode、compose file など）を表示

表示要件:

- 値の出所を併記（`explicit env` / `fallback default` / `derived`）
- 秘密値はマスク（トークン・パスワード・APIキー類）
- 取得失敗時はエラーを握りつぶさず表示

### 6.4 証跡採取

- `snapshot`: 現在状態を bundle 保存
- `snapshot --name <tag>`: 任意タグ付き保存
- `history`: 直近コマンド履歴・重要イベント表示

### 6.5 終了操作

- `exit`: Bot プロセスのみ終了（compose維持）
- `exit --with-compose-down`: Bot終了 + compose down

---

## 7. 例外・障害時の挙動

### 7.1 uncaught / unhandled

- 構造化ログ出力
- system alert 送信
- debug モードではプロセス継続
- 直近 N 件の致命エラーをメモリ保持し `status` で参照可能

### 7.2 接続断続系（`ECONNREFUSED` / `EACCES` / `ENOENT`）

- イベントを時系列で記録
  - 最終 200 応答時刻
  - 最終失敗時刻
  - 失敗回数（連続/累積）
  - エラー種別別カウント
- `status` / `probe` / `history` から参照可能

### 7.3 非TTY実行時

- 対話入力は無効化
- 代替として定期 `status` 出力を有効化

---

## 8. ログ・証跡要件

### 8.1 保存先

- `debug/YYYYMMDD-HHMMSS/`

### 8.2 保存内容

- Bot stdout/stderr
- orchestrator イベント（boot/monitor/recovery decision）
- preflight 設定変更イベント（before/after, operator, timestamp）
- 手動コマンド履歴（実行者/時刻付き）
- health probe 結果
- socket 状態スナップショット
- 環境変数スナップショット（マスク済み）
- 解決済み設定スナップショット

### 8.3 フォーマット

- 人間可読ログ + JSONL（機械解析用）を併用
- すべてのレコードに timestamp と debug session id を付与

---

## 9. セキュリティ・安全要件

- 環境変数表示は秘密値を必ずマスク
- debug コマンドで実行可能な操作は allowlist 化
- destructive 操作（down, prune 等）は確認付きまたは明示フラグ必須
- debug モードであることをログと起動バナーで明確化

---

## 10. 受け入れ条件

- `yarn debug(:local)` で起動できる
- 起動前に preflight 設定を確認・編集し、`start` まで起動を保留できる
- 起動前にコンポーネント選択ができ、既定は全コンポーネント有効である
- `enable/disable/preset` で起動対象を変更し、`start` 結果に反映される
- `set/unset/diff/validate` で設定差分と妥当性を確認できる
- `save-profile/load-profile` で検証条件を再利用できる
- Agent/Gateway 障害後も Bot が終了しない
- 障害後に `ps` / `logs` / `probe` / `sockets` / `snapshot` が継続利用できる
- `env` / `config` で調査に必要な設定値を即時確認できる
- 秘密値が平文出力されない
- 明示操作なしで `compose down` されない
- 通常モードの挙動が変わらない

---

## 11. 実装タスク（高レベル）

1. package scripts に `debug:local` / `debug` を追加
2. debug フラグ解決ロジックを Bot 起動時に追加
3. preflight 設定スキーマ（コンポーネント選択/既定値/型/バリデーション/由来情報）を実装
4. preflight 対話コマンド（components/enable/disable/preset/set/unset/diff/validate/save-profile/load-profile/start/reset）を実装
5. 選択コンポーネントに応じた起動シーケンス分岐（compose/migrate/gateway/monitor/cleanup）を実装
6. 終了/障害経路（`gracefulTerminate...`, `uncaughtException`, `/exit` `/reboot`）を debug 分岐
7. Orchestrator auto-recovery の debug 抑止
8. stdin 対話コマンドループ（help/status/ps/logs/probe/sockets/env/config/snapshot/exit）追加
9. 環境変数表示とマスキング実装
10. 設定解決値（effective config）の可視化実装
11. debug セッション証跡の保存基盤実装

---

## 12. 互換性・リスク

- `process.exit` 抑止により不健康状態が残留するリスク
  - debug モード限定 + 明示終了コマンドを提供
- 収集ログ増加によるディスク使用量増加
  - ローテーション/保存上限を別途設定
- 環境変数可視化は秘密漏えいリスク
  - マスクルールを必須化し、`--all` でも平文禁止
