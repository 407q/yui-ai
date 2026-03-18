# 実行環境定義

実装ドキュメントとの整合確認に使う、実行環境の記録用ドキュメントです。

---

## 1. 開発実行環境（MacBook）

| 項目 | 値 |
|---|---|
| 端末名 | keitodama Air (MacBookAir10,1) |
| macOS バージョン | Tahoe 26.3.1 |
| CPU / アーキテクチャ | Apple M1 SoC / arm64 |
| Node.js バージョン | 25.6.1 |
| Yarn (Classic) バージョン | 1.22.22 |
| コンテナランタイム（OrbStack/Docker Desktop） | OrbStack 2.0.5 |
| Docker Compose v2 バージョン | 2.40.3 |
| 1Password CLI (`op`) バージョン | 2.32.1 |

---

## 2. 実働実行環境（Linux サーバー）

| 項目 | 値 |
|---|---|
| ホスト名 | shiona-srv |
| Linux ディストリビューション / バージョン | Ubuntu 22.04.5 |
| CPU / メモリ | Core i5-7400 / DDR4-2400 8GiB |
| Node.js バージョン | 20.16.0 |
| Yarn (Classic) バージョン | 1.22.22 |
| Docker Engine バージョン | 29.1.3 |
| Docker Compose v2 バージョン | 5.0.1 |
| 1Password CLI (`op`) バージョン | 2.33.0 |

---

## 3. 共通前提（確認用）

| 項目 | 値 |
|---|---|
| Gateway 系（`apps/gateway/*`）はホスト実行 | OK |
| Compose 対象は `agent` / `postgres` のみ | OK |
| シークレット注入は `op run` を使用 | OK |
| 平文シークレットをリポジトリに保存しない | OK |
