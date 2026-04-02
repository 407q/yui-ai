import type {
  MemoryDeleteResponse,
  MemoryEntryDetailResponse,
  MemoryListResponse,
  MemoryNamespacesResponse,
  MemoryUpsertRequest,
  MemoryUpsertResponse,
} from "./types";

interface MemoryQueryInput {
  search?: string;
  namespace?: string;
  userId?: string;
  includeSystem?: boolean;
  limit?: number;
  offset?: number;
}

export async function fetchHealth(): Promise<{ status: string; database: string }> {
  return await fetchJson<{ status: string; database: string }>("/api/health");
}

export async function fetchNamespaces(): Promise<MemoryNamespacesResponse> {
  return await fetchJson<MemoryNamespacesResponse>("/api/memory/namespaces");
}

export async function fetchMemoryList(input: MemoryQueryInput): Promise<MemoryListResponse> {
  const params = new URLSearchParams();
  if (input.search && input.search.trim().length > 0) {
    params.set("search", input.search.trim());
  }
  if (input.namespace && input.namespace.trim().length > 0) {
    params.set("namespace", input.namespace.trim());
  }
  if (input.userId && input.userId.trim().length > 0) {
    params.set("userId", input.userId.trim());
  }
  if (input.includeSystem !== undefined) {
    params.set("includeSystem", input.includeSystem ? "true" : "false");
  }
  if (input.limit !== undefined) {
    params.set("limit", String(input.limit));
  }
  if (input.offset !== undefined) {
    params.set("offset", String(input.offset));
  }

  const query = params.toString();
  return await fetchJson<MemoryListResponse>(
    `/api/memory${query.length > 0 ? `?${query}` : ""}`,
  );
}

export async function fetchMemoryDetail(
  memoryId: string,
): Promise<MemoryEntryDetailResponse> {
  return await fetchJson<MemoryEntryDetailResponse>(
    `/api/memory/${encodeURIComponent(memoryId)}`,
  );
}

export async function upsertMemory(
  payload: MemoryUpsertRequest,
): Promise<MemoryUpsertResponse> {
  return await fetchJson<MemoryUpsertResponse>("/api/memory/upsert", {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  });
}

export async function deleteMemory(
  memoryId: string,
  force: boolean,
): Promise<MemoryDeleteResponse> {
  const query = force ? "?force=true" : "";
  return await fetchJson<MemoryDeleteResponse>(
    `/api/memory/${encodeURIComponent(memoryId)}${query}`,
    {
      method: "DELETE",
    },
  );
}

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = (await response.json().catch(() => null)) as
    | Record<string, unknown>
    | null;
  if (!response.ok) {
    const message =
      (payload?.message as string | undefined) ??
      `Request failed with ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}
