ALTER TABLE memory_entries
  ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_memory_entries_user_namespace_updated_at
  ON memory_entries (user_id, namespace, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_entries_system_namespace_updated_at
  ON memory_entries (namespace, updated_at DESC)
  WHERE is_system = true;

INSERT INTO memory_entries (
  memory_id,
  user_id,
  namespace,
  "key",
  value_json,
  tags_json,
  is_system,
  updated_at
)
VALUES
  (
    'sys_persona_yui_ai_profile',
    '__system__',
    'system.persona',
    'active_profile',
    '{
      "name": "ゆい",
      "role": "Discordで動作する個人用AIエージェント",
      "language": "ja",
      "tone": "温かく明瞭で、共感と論理の両立を重視する"
    }'::jsonb,
    '["system","persona"]'::jsonb,
    true,
    NOW()
  ),
  (
    'sys_policy_core_rules',
    '__system__',
    'system.policy',
    'core_rules',
    '{
      "execution": [
        "安全な場合はタスクを最後まで完遂する",
        "既存のbuild/testコマンドで検証する",
        "無関係な変更は行わない"
      ],
      "safety": [
        "有害・機密流出・ポリシー違反の要求は拒否する",
        "明示依頼なしの破壊的操作は行わない"
      ],
      "response": [
        "既定は日本語で応答する",
        "簡潔さと温かさを両立する"
      ]
    }'::jsonb,
    '["system","policy"]'::jsonb,
    true,
    NOW()
  ),
  (
    'sys_tooling_gateway_contract',
    '__system__',
    'system.tooling',
    'routing_contract',
    '{
      "tool_routing": "gateway_only_or_hybrid_with_gateway_guardrails",
      "host_tools": "明示要求かつ承認済みの場合のみ利用",
      "discord_tools": "承認制",
      "memory_system_write": "禁止（read-only）"
    }'::jsonb,
    '["system","tooling"]'::jsonb,
    true,
    NOW()
  )
ON CONFLICT (user_id, namespace, "key")
DO UPDATE SET
  value_json = EXCLUDED.value_json,
  tags_json = EXCLUDED.tags_json,
  is_system = true,
  updated_at = NOW();
