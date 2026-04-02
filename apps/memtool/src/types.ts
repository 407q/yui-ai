export interface MemoryNamespaceSummary {
  namespace: string;
  count: number;
  system_count: number;
  latest_updated_at: string | null;
}

export interface MemoryEntrySummary {
  memory_id: string;
  user_id: string;
  namespace: string;
  key: string;
  value_json: unknown;
  tags_json: string[];
  is_system: boolean;
  updated_at: string;
  inbound_links: number;
  outbound_links: number;
}

export interface MemoryEntryLinkInbound {
  relation: string;
  created_at: string;
  source_memory_id: string;
  source_user_id: string;
  source_namespace: string;
  source_key: string;
}

export interface MemoryEntryLinkOutbound {
  relation: string;
  created_at: string;
  target_user_id: string;
  target_namespace: string;
  target_key: string;
  target_memory_id: string | null;
}

export interface MemoryEntryDetailResponse {
  entry: MemoryEntrySummary;
  inbound_links: MemoryEntryLinkInbound[];
  outbound_links: MemoryEntryLinkOutbound[];
}

export interface MemoryListResponse {
  total: number;
  limit: number;
  offset: number;
  entries: MemoryEntrySummary[];
}

export interface MemoryNamespacesResponse {
  namespaces: MemoryNamespaceSummary[];
}

export interface MemoryUpsertRequest {
  user_id: string;
  namespace: string;
  key: string;
  value_json: unknown;
  tags_json: string[];
  is_system: boolean;
}

export interface MemoryUpsertResponse {
  entry: MemoryEntrySummary;
}

export interface MemoryDeleteResponse {
  deleted: boolean;
  memory_id: string;
  user_id: string;
  namespace: string;
  key: string;
  is_system: boolean;
}
