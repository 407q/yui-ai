import "dotenv/config";
import { createStatePool } from "./db.js";

const DEFAULT_TASK_EVENTS_RETENTION_DAYS = 90;
const DEFAULT_AUDIT_LOGS_RETENTION_DAYS = 180;

async function main(): Promise<void> {
  const taskEventsRetentionDays = parsePositiveInt(
    process.env.TASK_EVENTS_RETENTION_DAYS,
    DEFAULT_TASK_EVENTS_RETENTION_DAYS,
  );
  const auditLogsRetentionDays = parsePositiveInt(
    process.env.AUDIT_LOGS_RETENTION_DAYS,
    DEFAULT_AUDIT_LOGS_RETENTION_DAYS,
  );

  const pool = createStatePool();
  try {
    const taskEventsResult = await pool.query(
      `
      DELETE FROM task_events
      WHERE "timestamp" < NOW() - ($1::INT * INTERVAL '1 day')
      `,
      [taskEventsRetentionDays],
    );

    const auditLogsResult = await pool.query(
      `
      DELETE FROM audit_logs
      WHERE "timestamp" < NOW() - ($1::INT * INTERVAL '1 day')
      `,
      [auditLogsRetentionDays],
    );

    console.log(
      `[db:cleanup] deleted task_events=${taskEventsResult.rowCount ?? 0}, audit_logs=${auditLogsResult.rowCount ?? 0}`,
    );
  } finally {
    await pool.end();
  }
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

main().catch((error) => {
  console.error("[db:cleanup] failed:", error);
  process.exit(1);
});
