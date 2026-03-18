# Agent Runtime

P1 では、Compose 起動と疎通確認のための最小ランタイムを配置しています。  
将来的に Copilot SDK セッション実行本体へ置き換えます。

## 現在の実装

- `src/server.ts`
  - `GET /health` と `GET /ready` を提供
  - `SIGTERM` / `SIGINT` で graceful shutdown

## Docker 実行

`apps/agent/Dockerfile` を利用し、`docker-compose.yml` の `agent` サービスとして起動します。
