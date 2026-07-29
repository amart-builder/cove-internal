ALTER TABLE cove_tasks
  ADD COLUMN IF NOT EXISTS project text;

UPDATE cove_tasks
SET project = 'Atlas'
WHERE project IS NULL;

ALTER TABLE cove_tasks
  ALTER COLUMN project SET DEFAULT 'Atlas';

ALTER TABLE cove_tasks
  ALTER COLUMN project SET NOT NULL;

CREATE INDEX IF NOT EXISTS cove_tasks_project_status_idx
  ON cove_tasks (project, status);
