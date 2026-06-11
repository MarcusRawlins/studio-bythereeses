WITH ranked_primary_contacts AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY project_id
      ORDER BY created_at, id
    ) AS primary_rank
  FROM project_participants
  WHERE is_primary_contact = 1
)
UPDATE project_participants
SET is_primary_contact = 0
WHERE id IN (
  SELECT id
  FROM ranked_primary_contacts
  WHERE primary_rank > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_participants_unique_primary
  ON project_participants(project_id)
  WHERE is_primary_contact = 1;
