-- Add approval_type column to distinguish System Memory approvals
ALTER TABLE approvals
  ADD COLUMN IF NOT EXISTS approval_type TEXT NOT NULL DEFAULT 'operation';

-- Add approver_role_id to track which role was required for approval
ALTER TABLE approvals
  ADD COLUMN IF NOT EXISTS approver_role_id TEXT;

-- Add index for querying System Memory approvals
CREATE INDEX IF NOT EXISTS idx_approvals_type_status
  ON approvals (approval_type, status, requested_at DESC);
