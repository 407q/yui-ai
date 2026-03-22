# Agent Runtime

P6 で Agent Runtime を実装し、`createSession/resumeSession + sendAndWait(1回)` の実行モデルを提供しています。  
P8 初回実装として SDK provider は `BOT_MODE` で切り替わります。

フェーズ位置づけ:

- P7: Discord/Bot 経路との統合を実施済み（Gateway API 連携を E2E 接続）
- P8: `BOT_MODE=standard` で copilot provider 実装（初回）

## 実装内容

- `GET /health`
- `GET /ready`
- `POST /v1/tasks/run`
- `POST /v1/tasks/:taskId/attachments/stage`
- `GET /v1/tasks/:taskId`
- `POST /v1/tasks/:taskId/cancel`

`POST /v1/tasks/run` では以下を固定します。

- session bootstrap: `create` or `resume`（`session_id` で判定）
- task body execution: `sendAndWait` 1回
- tool callback: Gateway MCP (`/v1/mcp/tool-call`) へ委譲
- `execution_target != gateway_adapter` は Gateway 側で拒否

`POST /v1/tasks/:taskId/attachments/stage` は、Gateway から渡された添付 URL を
`attachment_mount_path`（既定: `/agent/session/<session_id>`）へ保存します。

- 許可プロトコル: `http` / `https`
- サイズ上限: `AGENT_ATTACHMENT_MAX_BYTES`（既定 25MB）
- 保存先ルート: `AGENT_SESSION_ROOT_DIR`（既定 `/agent/session`）
- `attachment_mount_path` は `<session_root>/<session_id>` のみ許可

## SDK Provider 設定

### mock（既存）

```bash
BOT_MODE=mock
```

### copilot（P8 初回）

```bash
BOT_MODE=standard
COPILOT_GITHUB_TOKEN=<GitHub token>
COPILOT_MODEL=claude-sonnet-4.6
COPILOT_WORKING_DIRECTORY=/app
COPILOT_SEND_TIMEOUT_MS=180000
COPILOT_SDK_LOG_LEVEL=info
```

補足:

- `BOT_MODE=standard` では Node.js 22 以上が必要です（`node:sqlite` を利用）。
- `COPILOT_GITHUB_TOKEN` は必須です（未設定時は起動失敗）。
- `COPILOT_MODEL` は任意（既定: `claude-sonnet-4.6`）。
- `COPILOT_SEND_TIMEOUT_MS` は「最後のツール実行アクティビティから `session.idle` まで」の許容待機時間（ミリ秒）です。
- `COPILOT_WORKING_DIRECTORY` が存在しない場合、Agent は自動で `process.cwd()` にフォールバックします。
- Copilot provider は Runtime callback を維持し、tool callback を常に Gateway MCP に委譲します。
- Gateway API からの `runtime_policy.tool_routing.mode=hybrid_container_builtin_gateway_host` では、
  コンテナ内の built-in file/search tools（`read_file`, `edit_file`, `str_replace_editor`, `grep`, `glob`, `view`）を許可し、
  host 操作・memory 操作は従来どおり Gateway custom tool 経由で実行します。
- Gateway custom tool に `container.file_deliver` を追加し、`/agent/session/<session_id>` 配下ファイルを
  base64 payload として返却できるようにしました（最終的な Discord 送信は Bot 側で実施）。
- Discord 文脈取得ツールとして `discord.channel_history` / `discord.channel_list`
  を Gateway custom tool 経由で利用できます。
- `discord.*` は承認制です。Permission Hook 経由で承認が完了した後にのみ実行されます。
- 境界ガードは `availableTools` allowlist + SDK hooks（`onPreToolUse`）で強制し、System Message は補助的な誘導として扱います。
- host 操作が必要な場合は、LM が口頭確認を先に求めるのではなく `host.*` ツールを呼び、Permission Hook の実行前承認フローに委ねます。
- PR-4 では `system_memory_refs` を run payload に含め、Agent は実行ごとに `memory.get` で `system.*` を先読みしてから推論します（既定: `system.persona/active_profile`, `system.policy/core_rules`, `system.tooling/routing_contract`）。

## Persona / Policy 設定（PR-1）

Persona/Policy は環境変数ではなくコード定義で管理します。

- 定義ファイル: `apps/agent/src/runtime/personaPolicy.ts`
- `PERSONA_REGISTRY` に persona/policy を versioned に保持
- `ACTIVE_PERSONA_ID` で有効な persona を選択
- `buildActiveSystemMessage()` を `sdkProvider.ts` から参照し、Copilot session の `systemMessage` に注入
- `runtime contract` として system memory 参照義務（`system_memory_refs` の mandatory preload）を明示

これにより、実行時の暗黙的な上書きを避けつつ、レビュー可能な形で振る舞いを固定できます。

## 実行

1Password 経由（標準）:

```bash
yarn dev:agent
```

ローカル環境変数（`op run` なし）:

```bash
yarn dev:agent:local
```

## スモーク

```bash
yarn agent:smoke
```

ローカル環境変数（`op run` なし）:

```bash
yarn agent:smoke:local
```

## Docker 実行

`apps/agent/Dockerfile` を利用し、`docker-compose.yml` の `agent` サービスとして起動します。  
ホスト上の Gateway API と接続するため `AGENT_GATEWAY_BASE_URL` を使用します。
