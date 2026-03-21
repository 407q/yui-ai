export const SYSTEM_MEMORY_USER_ID = "__system__";
export const SYSTEM_MEMORY_NAMESPACE_PREFIX = "system.";

export const SYSTEM_MEMORY_NAMESPACES = [
  "system.persona",
  "system.policy",
  "system.tooling",
] as const;

export const RECOMMENDED_MEMORY_NAMESPACES = [
  "profile.person",
  "conversation.fact",
  "knowledge.note",
  "task.preference",
  ...SYSTEM_MEMORY_NAMESPACES,
] as const;

export const SYSTEM_MEMORY_REFERENCE_ENTRIES = [
  {
    namespace: "system.persona",
    key: "active_profile",
    reason: "load active persona profile",
  },
  {
    namespace: "system.policy",
    key: "core_rules",
    reason: "load core behavior and safety rules",
  },
  {
    namespace: "system.tooling",
    key: "routing_contract",
    reason: "load tool routing contract",
  },
] as const;

export function isSystemMemoryNamespace(namespace: string): boolean {
  return namespace.trim().startsWith(SYSTEM_MEMORY_NAMESPACE_PREFIX);
}
