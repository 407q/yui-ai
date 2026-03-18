# Memory Service

`apps/gateway/memory` は `memory.*` ツールの永続記憶ロジックを配置します。

## 実装内容（P2）

- `src/memoryStore.ts`
  - `upsert`
  - `get`
  - `search`
  - `delete`

`MEMORY_STORE_DSN` が未設定の場合は `STATE_STORE_DSN` をフォールバック利用できる設計です。
