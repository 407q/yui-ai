# Copilot SDK で利用可能なモデルを確認する手順

`COPILOT_GITHUB_TOKEN` で実際にアクセスできるモデル ID 一覧は、`@github/copilot-sdk` の `CopilotClient.listModels()` を Agent コンテナ内で叩いて取得する。

`COPILOT_MODEL` を変更する前にこの一覧と突き合わせること。CLI の `--model` フラグは未対応モデルでも文字列を受け取るが、推論時に `400 The requested model is not supported` あるいは「assistant response is empty」になって失敗する。

## 前提

- `compose` が起動済み (`docker compose -f docker-compose.${INTERNAL_CONNECTION_MODE}.yml ps` で `agent` が healthy)
- `.env` の `COPILOT_GITHUB_TOKEN` が **fine-grained PAT** で **Account permissions → Copilot Requests** が有効
- classic PAT (`ghp_...`) は不可。`github_pat_...` を使う

## 手順

1. スクリプトを用意（このドキュメント内の内容をそのままコピーで可）

   ```ts
   // /tmp/list-models.ts
   import { CopilotClient } from "@github/copilot-sdk";

   const c = new CopilotClient({ githubToken: process.env.COPILOT_SDK_AUTH_TOKEN });
   await c.start();
   const models = await c.listModels();
   for (const m of models) {
     const premium = m.billing?.is_premium ? "★" : " ";
     const mult = m.billing?.multiplier;
     const ctx = m.capabilities?.limits?.max_context_window_tokens;
     console.log(`${premium} ${m.id.padEnd(28)} ${String(m.name).padEnd(28)} ctx=${ctx ?? "?"}  premium-mult=${mult ?? "?"}`);
   }
   console.log(`\ntotal: ${models.length}`);
   await c.stop();
   ```

2. Agent コンテナへコピー

   ```bash
   docker cp /tmp/list-models.ts yui-ai-agent:/app/list-models.ts
   ```

3. コンテナ内で tsx 実行（`.env` を読み込んでから）

   ```bash
   set -a; source .env; set +a
   docker compose -f docker-compose.tcp.yml exec -T \
     -e COPILOT_SDK_AUTH_TOKEN="$COPILOT_GITHUB_TOKEN" \
     agent yarn tsx /app/list-models.ts
   ```

   `INTERNAL_CONNECTION_MODE=uds` のときは compose ファイル名を `docker-compose.uds.yml` に置き換える。

## 出力例

```
★ claude-sonnet-4.5            Claude Sonnet 4.5            ctx=144000  premium-mult=1
★ claude-haiku-4.5             Claude Haiku 4.5             ctx=144000  premium-mult=0.33
★ claude-opus-4.5              Claude Opus 4.5              ctx=160000  premium-mult=3
★ claude-sonnet-4              Claude Sonnet 4              ctx=216000  premium-mult=1
★ gpt-5.3-codex                GPT-5.3-Codex                ctx=400000  premium-mult=1
★ gpt-5.2-codex                GPT-5.2-Codex                ctx=400000  premium-mult=1
★ gpt-5.2                      GPT-5.2                      ctx=264000  premium-mult=1
★ gpt-5.4-mini                 GPT-5.4 mini                 ctx=400000  premium-mult=0.33
  gpt-5-mini                   GPT-5 mini                   ctx=264000  premium-mult=0
  gpt-4.1                      GPT-4.1                      ctx=128000  premium-mult=0
```

- **★** = Premium Requests 対象（プラン課金カウント）
- **premium-mult** = Premium Request の消費倍率（`0` は無料枠、`0.33` は 1/3 カウント、`3` は 3 倍カウント）
- アカウントのプラン (`pro` / `pro_plus` / `business` / `enterprise` 等) によって `restricted_to` で弾かれているモデルは戻り値から除外される

## なぜコンテナ内で実行するのか

- SDK は内部で `@github/copilot` の CLI バイナリを spawn する。その依存はコンテナの image 内 `node_modules/` にだけ揃っている
- ホスト側の素の Node から呼ぶと `vscode-jsonrpc/node` の ESM 解決でこける。`tsx` 経由なら解決規則が緩いので動くが、本番と同じ環境で確認したいので Agent コンテナでの実行を推奨

## 落とし穴

- `--model` のドキュメントにある `gpt-5.2` のような表記をそのまま使うと、契約プランで使えないケースがある（`Model "X" from --model flag is not available.` で落ちる）
- `claude-sonnet-4.5` は `listModels()` には出るが、CLI の `--model` 経由だと `400 The requested model is not supported` になることがある（CLI 側の対応モデルセットと一致しない）。`COPILOT_MODEL` 変更時はこのスクリプトで一覧を取り、続けて `node /app/node_modules/@github/copilot/index.js -p "hi" --model <id> --allow-all-tools` で実行確認まで行うのが安全
- 本番運用に乗せるモデルは「listModels に出る」かつ「CLI で `-p` 実行が成功する」両方を満たすものに限る

## 関連

- `apps/agent/src/runtime/sdkProvider.ts` — SDK 呼び出し本体
- `docs/reference/environment-variables.md` — `COPILOT_MODEL` の項
- `docs/development/copilot-cli-permissions.md` — CLI 権限再設定
