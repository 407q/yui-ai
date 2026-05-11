UPDATE memory_entries
SET
  value_json = jsonb_set(
    value_json,
    '{approval}',
    to_jsonb(
      ARRAY[
        '承認は事前申請ではなく、必要なツール呼び出し時に Gateway が approval_required を返して開始される',
        '承認要求はスレッドのボタンで処理し、原則としてセッション作成者が操作する',
        'system.* 書き込みの承認では、管理者ロール要件を満たすユーザーのみ承認できる'
      ]::text[]
    ),
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
    '{approval_flow}',
    '"ツールを直接呼び出した時点で必要な承認が判定され、approval_required とボタン承認フローが起動する"'::jsonb,
    true
  ),
  updated_at = NOW()
WHERE user_id = '__system__'
  AND namespace = 'system.tooling'
  AND "key" = 'routing_contract';
