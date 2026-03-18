import type { Pool } from "pg";

export interface MemoryEntry {
  memoryId: string;
  userId: string;
  namespace: string;
  key: string;
  valueJson: Record<string, unknown>;
  tagsJson: string[];
  updatedAt: Date;
}

export interface UpsertMemoryInput {
  memoryId: string;
  userId: string;
  namespace: string;
  key: string;
  valueJson: Record<string, unknown>;
  tagsJson?: string[];
}

export interface SearchMemoryInput {
  userId: string;
  namespace: string;
  keyPrefix?: string;
  limit?: number;
}

export class MemoryStore {
  constructor(private readonly pool: Pool) {}

  async upsert(input: UpsertMemoryInput): Promise<MemoryEntry> {
    const tags = input.tagsJson ?? [];
    const valueJson = JSON.stringify(input.valueJson);
    const tagsJson = JSON.stringify(tags);
    const { rows } = await this.pool.query<MemoryRow>(
      `
      INSERT INTO memory_entries (
        memory_id,
        user_id,
        namespace,
        "key",
        value_json,
        tags_json,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (user_id, namespace, "key")
      DO UPDATE SET
        value_json = EXCLUDED.value_json,
        tags_json = EXCLUDED.tags_json,
        updated_at = NOW()
      RETURNING *
      `,
      [
        input.memoryId,
        input.userId,
        input.namespace,
        input.key,
        valueJson,
        tagsJson,
      ],
    );

    return toMemoryEntry(rows[0]);
  }

  async get(
    userId: string,
    namespace: string,
    key: string,
  ): Promise<MemoryEntry | null> {
    const { rows } = await this.pool.query<MemoryRow>(
      `
      SELECT *
      FROM memory_entries
      WHERE user_id = $1
        AND namespace = $2
        AND "key" = $3
      `,
      [userId, namespace, key],
    );

    return rows.length > 0 ? toMemoryEntry(rows[0]) : null;
  }

  async search(input: SearchMemoryInput): Promise<MemoryEntry[]> {
    const limit = input.limit ?? 20;
    const params: Array<number | string> = [input.userId, input.namespace];
    let whereClause = `
      user_id = $1
      AND namespace = $2
    `;

    if (input.keyPrefix) {
      params.push(`${input.keyPrefix}%`);
      whereClause += ` AND "key" LIKE $${params.length}`;
    }

    params.push(limit);
    const query = `
      SELECT *
      FROM memory_entries
      WHERE ${whereClause}
      ORDER BY updated_at DESC
      LIMIT $${params.length}
    `;

    const { rows } = await this.pool.query<MemoryRow>(query, params);
    return rows.map(toMemoryEntry);
  }

  async delete(userId: string, namespace: string, key: string): Promise<void> {
    await this.pool.query(
      `
      DELETE FROM memory_entries
      WHERE user_id = $1
        AND namespace = $2
        AND "key" = $3
      `,
      [userId, namespace, key],
    );
  }
}

interface MemoryRow {
  memory_id: string;
  user_id: string;
  namespace: string;
  key: string;
  value_json: Record<string, unknown>;
  tags_json: string[];
  updated_at: Date;
}

function toMemoryEntry(row: MemoryRow): MemoryEntry {
  return {
    memoryId: row.memory_id,
    userId: row.user_id,
    namespace: row.namespace,
    key: row.key,
    valueJson: row.value_json,
    tagsJson: row.tags_json,
    updatedAt: row.updated_at,
  };
}
