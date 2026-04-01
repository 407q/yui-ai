# Copilot CLI 再起動後の権限再設定ガイド

Copilot CLI を再起動すると、ファイル編集やコマンド実行の許可が再度必要になる場合があります。

このドキュメントは、Yui AI リポジトリで日常的に必要な操作を「毎回確認なしで進められる」状態に戻すための手順です。

## 目次

1. [前提](#前提)
2. [初回に許可するディレクトリ](#初回に許可するディレクトリ)
3. [推奨: 先に実行しておくコマンド](#推奨-先に実行しておくコマンド)
4. [このリポジトリで必要な許可対象一覧](#このリポジトリで必要な許可対象一覧)
5. [運用チェックリスト](#運用チェックリスト)

---

## 前提

- リポジトリルート: `/Volumes/nekodisk/github/yui-ai`
- このプロジェクトは以下を日常的に実行します:
  - TypeScript ビルド (`yarn build`)
  - Docker Compose 起動・停止 (`yarn compose:up`, `yarn compose:down`)
  - 各種 smoke テスト (`yarn api:smoke`, `yarn agent:smoke`, `yarn orchestrator:smoke`, `yarn db:smoke`)
  - Git 操作 (`git status`, `git add`, `git commit`)

---

## 初回に許可するディレクトリ

CLI 再起動後、まず次を実行してアクセス許可を付与します。

```text
/add-dir /Volumes/nekodisk/github/yui-ai
/add-dir /Volumes/nekodisk/github/yui-ai/.tmp
```

確認:

```text
/list-dirs
```

> 備考: ユーザー要件の `tmp/` は、実際のコードベースでは `.tmp/` を利用しています。

---

## 推奨: 先に実行しておくコマンド

以下は「先に一度実行して許可しておく」と、以降の開発が止まりにくくなります。

### ビルド・テスト系

```bash
yarn build
yarn api:smoke
yarn agent:smoke
yarn orchestrator:smoke
yarn db:smoke
```

### Docker / DB 系

```bash
yarn compose:up
yarn db:migrate
yarn db:cleanup
yarn compose:down
```

### 日常運用系

```bash
yarn register:commands
yarn dev
yarn dev:mock
yarn compose:ps
yarn compose:logs
```

### Git 系

```bash
git --no-pager status
git add -A
git commit -m "[Change]変更内容"
```

---

## このリポジトリで必要な許可対象一覧

`package.json` と Orchestrator 実装（`apps/gateway/api/src/orchestration/supervisor.ts`）を基に整理しています。

### 1) ファイル編集

- リポジトリ配下の編集全般
- 特に頻出:
  - `README.md`
  - `docs/**`
  - `apps/**`
  - `.env.example`, `.env.op.example`
  - `.tmp/**`（テスト・一時ファイル）

### 2) Yarn スクリプト

| カテゴリ | コマンド |
|---------|---------|
| ビルド | `yarn build` |
| 開発起動 | `yarn dev`, `yarn dev:mock`, `yarn dev:api`, `yarn dev:agent` |
| 本番起動 | `yarn start`, `yarn start:mock`, `yarn start:api`, `yarn start:agent` |
| Discord登録 | `yarn register:commands` |
| DB | `yarn db:migrate`, `yarn db:cleanup`, `yarn db:smoke` |
| テスト | `yarn api:smoke`, `yarn agent:smoke`, `yarn orchestrator:smoke` |
| Docker補助 | `yarn compose:up`, `yarn compose:down`, `yarn compose:ps`, `yarn compose:logs` |

> `:local` 系スクリプトも同等に許可しておくと、`op run` が使えない場面で復旧しやすくなります。

### 3) Git 操作

- `git --no-pager status`
- `git --no-pager diff`
- `git add ...`
- `git commit ...`
- 必要に応じて `git --no-pager log`, `git --no-pager show`

### 4) 補助コマンド（実運用で発生）

- `find`（`yarn clean:appledouble` で利用）
- `node`, `tsx`（スクリプト実行）
- `curl`（ヘルスチェック）

---

## 運用チェックリスト

CLI 再起動後は、以下を上から順に実施してください。

1. `/cwd` で作業ディレクトリが `yui-ai` か確認
2. `/add-dir` で `yui-ai` と `.tmp` を許可
3. `git --no-pager status` を実行して Git 操作許可を通す
4. `yarn build` を実行して基本コマンド許可を通す
5. `yarn compose:up && yarn compose:down` を実行して Docker 許可を通す
6. `yarn api:smoke` など最低1つの smoke を通して検証

これで、通常の編集・検証・コミット作業はほぼ中断なく進められます。

