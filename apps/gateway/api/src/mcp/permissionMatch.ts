import path from "node:path";

export const DEFAULT_OLLAMA_WEB_SEARCH_API_URL = "https://ollama.com/api/web_search";

export function normalizeHostPath(rawPath: string): string {
  return path.resolve(rawPath);
}

export function resolveWebSearchOrigin(configuredApiUrl?: string): string | null {
  const base = configuredApiUrl?.trim() || DEFAULT_OLLAMA_WEB_SEARCH_API_URL;
  return safeParseUrlOrigin(base);
}

export function isPermissionMatch(
  operation: string,
  grantedValue: string,
  scopeValue: string,
  options?: { webSearchOrigin?: string | null },
): boolean {
  if (operation === "web_search") {
    if (grantedValue === scopeValue) {
      return true;
    }
    if (grantedValue === "web_search:__configured_origin__") {
      const configuredOrigin = options?.webSearchOrigin ?? null;
      return configuredOrigin !== null && configuredOrigin === scopeValue;
    }
    return false;
  }
  if (
    operation === "discord_channel_history" &&
    grantedValue === "discord_channel:__session_channel__"
  ) {
    return scopeValue.startsWith("discord_channel:");
  }
  if (
    operation === "discord_channel_list" &&
    grantedValue === "discord_guild:__session_guild__"
  ) {
    return scopeValue.startsWith("discord_guild:");
  }
  if (
    operation === "read" ||
    operation === "write" ||
    operation === "delete" ||
    operation === "list"
  ) {
    const grantedPath = normalizeHostPath(grantedValue);
    const targetPath = normalizeHostPath(scopeValue);
    if (targetPath === grantedPath) {
      return true;
    }
    return targetPath.startsWith(`${grantedPath}${path.sep}`);
  }

  return grantedValue === scopeValue;
}

function safeParseUrlOrigin(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return null;
  }
}
