# Copilot E2E テスト手順書（Discord -> Gateway -> Agent）

この手順書は、`AGENT_SDK_PROVIDER=copilot` で実 Copilot SDK を利用した  
Discord 経路の E2E テスト（run/status/cancel/approval）を行うための運用手順です。

---

## 1. 目的

- Discord メンションから Agent 実行が開始されること
- Agent Runtime が Copilot SDK provider で `create/resume + sendAndWait` を完走できること
- Gateway MCP ツール呼び出しが機能すること
- Host 承認フロー（approval required -> approve -> 再実行）が機能すること
- `/status` `/cancel` `/close` が期待どおり動作すること

---

## 2. 前提条件

以下が設定済みであること。

- Node.js 22 以上で Agent コンテナをビルドできること
- `DISCORD_BOT_TOKEN`
- `DISCORD_CLIENT_ID`
- `DISCORD_GUILD_ID`
- `MOCK_SYSTEM_ALERT_CHANNEL_ID`
- `STATE_STORE_DSN`
- `MEMORY_STORE_DSN`
- `POSTGRES_*`
- `COPILOT_GITHUB_TOKEN`

また、`.env.op` で次を設定すること。

```env
AGENT_SDK_PROVIDER=copilot
COPILOT_MODEL=claude-haiku-4.5
COPILOT_WORKING_DIRECTORY=/app
COPILOT_SEND_TIMEOUT_MS=180000
COPILOT_SDK_LOG_LEVEL=info
```

---

## 3. 事前準備

### 3.1 依存とビルド

```bash
yarn install
yarn build
```

### 3.2 コマンド登録

```bash
yarn register:commands
```

### 3.3 起動

Bot 起動時に Orchestrator が `compose up` / `db:migrate` / `gateway-api` 起動を行います。

```bash
yarn dev
```

起動ログで以下を確認してください。

- Orchestrator boot 成功
- `agent` / `postgres` / `gateway-api` が healthy
- Discord Bot ready

---

## 4. E2E テストシナリオ

同一スレッド内で順に実施します。

### 4.1 Run（create）+ Tool call 確認

Bot へのメンションで新規タスクを開始します。  
例:

```text
@Bot #tool: memory.upsert {"namespace":"e2e","key":"k1","value":{"content":"hello-from-e2e"}}
```

確認ポイント:

- スレッドが作成される
- タスクが `running -> completed` へ遷移
- 返信にエラーがなく完了する

### 4.2 Resume 確認

同じスレッドで追加メッセージを送信します。  
例:

```text
@Bot さっき保存した内容を確認して
```

確認ポイント:

- 同一 session で再実行される（resume）
- `running -> completed`

### 4.3 Host approval 確認

承認が必要な host read を要求します。  
例:

```text
@Bot #host-read: /Volumes/nekodisk/github/yui-ai/README.md
```

確認ポイント:

- 承認 Embed が表示される（approval required）
- Approve 後に再実行され、完了に到達する
- 同一 path / operation で承認ループしない

### 4.4 `/status` 確認

```text
/status
```

確認ポイント:

- Gateway 側状態と Agent 側状態が整合している
- 表示が terminal state を反映する

### 4.5 `/cancel` 確認

時間がかかる処理を投げた直後にキャンセルします。

```text
@Bot #tool: memory.search {"namespace":"e2e","query":"k","limit":50}
/cancel
```

確認ポイント:

- cancel が受理される
- タスクが `canceled` に遷移する

### 4.6 `/close` 確認

```text
/close
```

確認ポイント:

- セッションが close される
- 後続メッセージは新規セッション開始として扱われる

---

## 5. 成功判定

以下を満たせば E2E 合格とします。

- run(create/resume) が完走
- approval required -> approve -> 再実行が成立
- `/status` `/cancel` `/close` が機能
- system alert に重大エラー通知が出ていない

---

## 6. 失敗時の切り分け

### 6.1 Agent が failed になる

- `AGENT_SDK_PROVIDER=copilot` になっているか
- `COPILOT_GITHUB_TOKEN` の値が有効か
- `COPILOT_MODEL` が利用可能モデルか

### 6.2 tool call で 400 が出る

- Copilot custom tool 名制約（英数字/`_`/`-`）に抵触していないか  
  実装側では SDK 登録時に `.` を `_` へ正規化済み

### 6.3 approval が進まない

- `MOCK_SYSTEM_ALERT_CHANNEL_ID` と対象チャンネルの権限
- approval response が送信されているか
- `apps/gateway/api` のログで `approval_required` / `approved` の遷移を確認

### 6.4 API/DB 接続エラー

- `STATE_STORE_DSN` / `MEMORY_STORE_DSN` / `POSTGRES_*`
- `yarn compose:ps` で `postgres` / `agent` 健全性確認

### 6.5 `ERR_STREAM_DESTROYED` が run 直後に発生する

- `COPILOT_WORKING_DIRECTORY` をコンテナ内パス（`/app`）に設定
- `docker compose up --build -d` で agent を再作成
- `docker compose logs -f agent` で再発有無を確認

### 6.6 `spawn /usr/local/bin/node ENOENT` が出る

- `COPILOT_WORKING_DIRECTORY` が無効なパスだと CLI 起動時に失敗することがあります
- `.env.op` の `COPILOT_WORKING_DIRECTORY` を `/app` に修正
- Agent は無効パス検出時に `process.cwd()` へフォールバックするが、設定値自体も修正する

### 6.7 `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite` が出る

- Copilot provider は Node.js 22 以上が必要です
- `apps/agent/Dockerfile` のベースイメージを Node 22 系にする
- `docker compose up --build -d` で Agent イメージを再ビルドする

---

## 7. 補助コマンド

```bash
yarn build
yarn orchestrator:smoke
yarn api:smoke
yarn agent:smoke
yarn compose:ps
yarn compose:logs
```

---

## 8. テスト後の停止

```bash
yarn compose:down
```

必要に応じて作業ブランチで結果をコミットしてください。
