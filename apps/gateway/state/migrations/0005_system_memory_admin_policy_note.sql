UPDATE memory_entries
SET
  value_json = jsonb_set(
    value_json,
    '{execution}',
    CASE
      WHEN jsonb_typeof(value_json -> 'execution') = 'array' THEN
        CASE
          WHEN (value_json -> 'execution') @> '["system.* の書き込みは管理者承認が明示的に付与された場合のみ実行する"]'::jsonb
            THEN value_json -> 'execution'
          ELSE (value_json -> 'execution') || to_jsonb('system.* の書き込みは管理者承認が明示的に付与された場合のみ実行する'::text)
        END
      ELSE to_jsonb(ARRAY['system.* の書き込みは管理者承認が明示的に付与された場合のみ実行する']::text[])
    END,
    true
  ),
  updated_at = NOW()
WHERE user_id = '__system__'
  AND namespace = 'system.policy'
  AND "key" = 'core_rules';

UPDATE memory_entries
SET
  value_json = jsonb_set(
    value_json,
    '{memory_system_write}',
    '"管理者承認済みの場合のみ許可（通常は保護）"'::jsonb,
    true
  ),
  updated_at = NOW()
WHERE user_id = '__system__'
  AND namespace = 'system.tooling'
  AND "key" = 'routing_contract';
