# MCP ツールリファレンス

Agent が Gateway 経由で使用できる MCP ツールの一覧です。

## 目次

1. [コンテナツール](#コンテナツール-container)
2. [ホストツール](#ホストツール-host)
3. [メモリツール](#メモリツール-memory)
4. [Discord ツール](#discord-ツール-discord)
5. [承認が必要なツール](#承認が必要なツール)

---

## コンテナツール (`container.*`)

Agent コンテナ内のファイル操作を行います。  
**スコープ**: セッション作業ディレクトリ内のみ  
**承認**: 不要

### `container.file_read`

ファイルを読み取ります。

**引数:**
| 名前 | 型 | 必須 | 説明 |
|-----|---|------|------|
| `path` | string | ✅ | ファイルパス（セッションルートからの相対パス） |

**レスポンス:**
```json
{
  "path": "workspace/file.txt",
  "content": "ファイル内容..."
}
```

---

### `container.file_write`

ファイルを書き込みます。

**引数:**
| 名前 | 型 | 必須 | 説明 |
|-----|---|------|------|
| `path` | string | ✅ | ファイルパス |
| `content` | string | ✅ | 書き込む内容 |

**レスポンス:**
```json
{
  "path": "workspace/file.txt",
  "bytes": 1234,
  "action": "created"
}
```

---

### `container.file_delete`

ファイルを削除します。

**引数:**
| 名前 | 型 | 必須 | 説明 |
|-----|---|------|------|
| `path` | string | ✅ | ファイルパス |

**レスポンス:**
```json
{
  "deleted": true,
  "path": "workspace/file.txt"
}
```

---

### `container.file_list`

ディレクトリ内のファイル一覧を取得します。

**引数:**
| 名前 | 型 | 必須 | 説明 |
|-----|---|------|------|
| `path` | string | - | ディレクトリパス（デフォルト: `.`） |

**レスポンス:**
```json
{
  "path": "workspace",
  "entries": [
    { "name": "file.txt", "type": "file", "size": 1234 },
    { "name": "subdir", "type": "directory" }
  ]
}
```

---

### `container.file_deliver`

ファイルを Base64 エンコードして返します（Discord 添付用）。

**引数:**
| 名前 | 型 | 必須 | 説明 |
|-----|---|------|------|
| `path` | string | ✅ | ファイルパス |
| `maxBytes` | number | - | 最大バイト数（デフォルト: 2MB、最大: 8MB） |

**レスポンス:**
```json
{
  "path": "workspace/report.pdf",
  "bytes": 12345,
  "content_base64": "JVBERi0xLjQ...",
  "mime_type": "application/pdf",
  "file_name": "report.pdf"
}
```

---

### `container.cli_exec`

コンテナ内でコマンドを実行します。

**引数:**
| 名前 | 型 | 必須 | 説明 |
|-----|---|------|------|
| `command` | string | ✅ | コマンド |
| `args` | string[] | - | 引数 |
| `cwd` | string | - | 作業ディレクトリ |
| `timeoutSec` | number | - | タイムアウト（秒） |

**レスポンス:**
```json
{
  "exit_code": 0,
  "stdout": "...",
  "stderr": "",
  "timed_out": false
}
```

---

## ホストツール (`host.*`)

ホストマシン上でファイル操作やコマンド実行を行います。  
**承認**: **必要**

### `host.file_read`

ホストのファイルを読み取ります。

**引数:**
| 名前 | 型 | 必須 | 説明 |
|-----|---|------|------|
| `path` | string | ✅ | ファイルパス（絶対パス） |

---

### `host.file_write`

ホストにファイルを書き込みます。

**引数:**
| 名前 | 型 | 必須 | 説明 |
|-----|---|------|------|
| `path` | string | ✅ | ファイルパス |
| `content` | string | ✅ | 書き込む内容 |

---

### `host.file_delete`

ホストのファイルを削除します。

**引数:**
| 名前 | 型 | 必須 | 説明 |
|-----|---|------|------|
| `path` | string | ✅ | ファイルパス |

---

### `host.file_list`

ホストのディレクトリ一覧を取得します。

**引数:**
| 名前 | 型 | 必須 | 説明 |
|-----|---|------|------|
| `path` | string | - | ディレクトリパス（デフォルト: `.`） |

---

### `host.cli_exec`

ホストでコマンドを実行します。

**引数:**
| 名前 | 型 | 必須 | 説明 |
|-----|---|------|------|
| `command` | string | ✅ | コマンド（allowlist に含まれる必要あり） |
| `args` | string[] | - | 引数 |
| `cwd` | string | - | 作業ディレクトリ |
| `timeoutSec` | number | - | タイムアウト（秒） |

**許可コマンド（デフォルト）:**
- `git`, `node`, `npm`, `yarn`, `curl`

環境変数 `HOST_CLI_ALLOWLIST` で変更可能。

---

### `host.http_request`

ホストから HTTP リクエストを送信します。

**引数:**
| 名前 | 型 | 必須 | 説明 |
|-----|---|------|------|
| `url` | string | ✅ | URL |
| `method` | string | - | メソッド（デフォルト: `GET`） |
| `headers` | object | - | ヘッダー |
| `body` | string | - | リクエストボディ |
| `timeoutSec` | number | - | タイムアウト（秒） |

---

## メモリツール (`memory.*`)

永続メモリの読み書きを行います。  
**承認**: 不要  
**スコープ**: ユーザー所有エントリのみ（system.* は読み取り専用）

### `memory.upsert`

メモリエントリを作成/更新します。

**引数:**
| 名前 | 型 | 必須 | 説明 |
|-----|---|------|------|
| `namespace` | string | ✅ | 名前空間 |
| `key` | string | ✅ | キー |
| `value` | object | ✅ | 値（JSON オブジェクト） |
| `tags` | string[] | - | タグ |
| `backlinks` | object[] | - | バックリンク |

**推奨名前空間:**
- `user.profile` — ユーザー情報
- `user.preference` — 設定・好み
- `knowledge.fact` — 知識・事実
- `knowledge.context` — 文脈情報
- `task.history` — タスク履歴

---

### `memory.get`

メモリエントリを取得します。

**引数:**
| 名前 | 型 | 必須 | 説明 |
|-----|---|------|------|
| `namespace` | string | ✅ | 名前空間 |
| `key` | string | ✅ | キー |

**レスポンス:**
```json
{
  "found": true,
  "entry": {
    "memoryId": "mem-xxx",
    "namespace": "user.profile",
    "key": "name",
    "value": { "name": "ユーザー名" },
    "tags": [],
    "is_system": false,
    "backlinks": [],
    "updatedAt": "2024-01-01T00:00:00.000Z"
  }
}
```

---

### `memory.search`

メモリを検索します。

**引数:**
| 名前 | 型 | 必須 | 説明 |
|-----|---|------|------|
| `namespace` | string | ✅ | 名前空間 |
| `query` | string | - | 検索クエリ |
| `limit` | number | - | 最大件数（デフォルト: 20） |

---

### `memory.delete`

メモリエントリを削除します。

**引数:**
| 名前 | 型 | 必須 | 説明 |
|-----|---|------|------|
| `namespace` | string | ✅ | 名前空間 |
| `key` | string | ✅ | キー |

---

## Discord ツール (`discord.*`)

Discord API を呼び出します。  
**承認**: **必要**

### `discord.channel_history`

チャンネルのメッセージ履歴を取得します。

**引数:**
| 名前 | 型 | 必須 | 説明 |
|-----|---|------|------|
| `channelId` | string | - | チャンネル ID（デフォルト: セッションのチャンネル） |
| `limit` | number | - | 最大件数 |
| `role` | string | - | フィルタ（`all`/`user`/`assistant`） |
| `from` | string | - | 開始日時（ISO 8601） |
| `to` | string | - | 終了日時（ISO 8601） |

---

### `discord.channel_list`

ギルドのチャンネル一覧を取得します。

**引数:**
| 名前 | 型 | 必須 | 説明 |
|-----|---|------|------|
| `limit` | number | - | 最大件数（デフォルト: 50） |

---

## 承認が必要なツール

以下のツールは実行前にユーザーの承認が必要です:

| カテゴリ | ツール | 承認スコープ |
|---------|-------|-------------|
| `host.*` | 全て | パス / コマンド / URL origin |
| `discord.*` | 全て | チャンネル ID / ギルド ID |

### 承認の付与

一度承認すると、同一セッション内で同じスコープ（パス・操作）の承認は自動付与されます。

例: `/path/to/file` への `read` を承認 → 同じファイルへの `read` は再承認不要

---

## エラーコード

| コード | 説明 |
|-------|------|
| `container_path_out_of_scope` | コンテナパスがセッションスコープ外 |
| `host_command_not_allowed` | ホストコマンドが allowlist にない |
| `policy_denied_command` | ポリシーでコマンドが拒否された |
| `host_scope_not_allowed` | ホスト操作が未承認 |
| `discord_scope_not_allowed` | Discord 操作が未承認 |
| `memory_system_entry_read_only` | system.* 名前空間への書き込み |
| `invalid_tool_arguments` | 引数が不正 |
| `external_mcp_disabled` | 外部 MCP が無効 |

---

## 次のステップ

- [API エンドポイント](api-endpoints.md) — API 仕様
- [Discord Bot 操作ガイド](../guide/discord-usage.md) — 使い方
