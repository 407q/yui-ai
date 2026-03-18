import http from "node:http";

const bindHost = process.env.AGENT_BIND_HOST ?? "0.0.0.0";
const port = parsePort(process.env.AGENT_PORT, 3801);
const startedAt = new Date();

const server = http.createServer((req, res) => {
  if (!req.url) {
    respondJson(res, 400, { error: "invalid_request" });
    return;
  }

  if (req.url === "/health") {
    respondJson(res, 200, {
      status: "ok",
      service: "agent-runtime",
      uptime_sec: getUptimeSeconds(),
    });
    return;
  }

  if (req.url === "/ready") {
    respondJson(res, 200, {
      status: "ready",
      service: "agent-runtime",
      started_at: startedAt.toISOString(),
    });
    return;
  }

  respondJson(res, 404, { error: "not_found" });
});

server.listen(port, bindHost, () => {
  console.log(`[agent] listening on ${bindHost}:${port}`);
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});

process.on("SIGINT", () => {
  shutdown("SIGINT");
});

function shutdown(signal: string): void {
  console.log(`[agent] received ${signal}, shutting down...`);
  server.close((error) => {
    if (error) {
      console.error("[agent] shutdown error:", error);
      process.exit(1);
      return;
    }

    process.exit(0);
  });
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function getUptimeSeconds(): number {
  return Math.floor((Date.now() - startedAt.getTime()) / 1000);
}

function respondJson(
  res: http.ServerResponse,
  statusCode: number,
  payload: Record<string, number | string>,
): void {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(payload));
}
