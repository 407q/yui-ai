# Copilot CLI 承認ブートストラップ実行指示書（エージェント向け）

この文書は、**Copilot エージェント自身が読む実行指示書**です。  
ユーザーから「このドキュメントを参照して実行して」と指示された場合、以下の契約に従って動作してください。

> 前提:
> - リポジトリルートおよびその配下のファイルアクセス許可は付与済み
> - 本書の目的は「コマンド実行許可のブートストラップ」
> - `INTERNAL_CONNECTION_MODE`（`tcp`/`uds`）は事前に設定済み

---

## 1. 実行契約（必須）

1. コマンドは**順番通りに逐次実行**する（並列実行しない）。
2. 失敗したらその時点で停止し、失敗コマンド・終了コード・stderr 要約を報告する。
3. ユーザーへの事前許可依頼を文章で出さず、実行して承認 UI を発火させる。
4. `standard` が失敗し、原因が `op run` / 1Password 由来なら `:local` フォールバックを提案する。
5. 実行結果は「成功/失敗」「主要ログ」「次アクション」を短く要約する。
6. 完了時は `copilot-bootstrap-log` ディレクトリへ日時付きログを保存する。

---

## 2. 実行シーケンス（standard）

以下を順に実行する。

```bash
git --no-pager status
yarn build
yarn compose:up
yarn db:migrate
yarn api:smoke
yarn agent:smoke
yarn orchestrator:smoke
yarn db:smoke
yarn db:cleanup
yarn compose:ps
yarn compose:down
git --no-pager status
```

---

## 3. フォールバックシーケンス（local）

`op run` / 1Password 失敗時のみ、次へ切り替える。

```bash
git --no-pager status
yarn build
yarn compose:up:local
yarn db:migrate:local
yarn api:smoke:local
yarn agent:smoke:local
yarn orchestrator:smoke:local
yarn db:smoke:local
yarn db:cleanup:local
yarn compose:ps:local
yarn compose:down:local
git --no-pager status
```

---

## 4. 失敗時ハンドリング

### A. `policy_denied_command`

- 原因: ホストコマンドが許可リスト外
- 報告内容:
  - 拒否されたコマンド名
  - 推奨 `HOST_CLI_ALLOWLIST`（例: `git,node,npm,yarn,curl,docker`）

### B. `approval_timeout`

- 原因: 承認 UI の応答待ちタイムアウト
- 対応: 同じコマンドを再実行（1回）

### C. `op run` / 1Password 失敗

- 原因: 未ログイン or 参照失敗
- 対応: local シーケンスへ切替提案

### D. Docker 未起動

- 原因: `docker compose ...` 実行失敗
- 報告: Docker daemon 未起動の可能性を明記して停止

---

## 5. 完了条件

以下をすべて満たしたら完了:

- `yarn build` 成功
- `yarn compose:up` と `yarn compose:down` 成功
- smoke 系が少なくとも 1 本成功（推奨: 全本成功）
- 最終 `git --no-pager status` を報告
- `copilot-bootstrap-log/bootstrap-YYYYMMDD-HHMMSS.log` を保存

---

## 6. 実行結果ログ保存（必須）

最終 `git --no-pager status` 取得後、以下を実行してログを保存する。

```bash
mkdir -p copilot-bootstrap-log
BOOTSTRAP_LOG_PATH="copilot-bootstrap-log/bootstrap-$(date +%Y%m%d-%H%M%S).log"
cat > "$BOOTSTRAP_LOG_PATH" <<'EOF'
承認ブートストラップを完了しました。
- 実行モード: <standard|local>
- 成功: <コマンド一覧>
- 失敗/スキップ: <あれば>
- 最終git状態: <clean or changed files>
EOF
echo "$BOOTSTRAP_LOG_PATH"
```

---

## 7. ユーザーへの最終報告フォーマット

```text
承認ブートストラップを完了しました。
- 実行モード: standard | local
- 成功: <コマンド一覧>
- 失敗/スキップ: <あれば>
- 最終git状態: <clean or changed files>
- ログ保存先: copilot-bootstrap-log/bootstrap-YYYYMMDD-HHMMSS.log
```

---

## 8. 根拠（このリポジトリ）

- `package.json` scripts
- `apps/gateway/api/src/orchestration/supervisor.ts`（compose/migrate/cleanup 実行）
- `docs/development/copilot-cli-permissions.md`
