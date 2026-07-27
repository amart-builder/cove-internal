ALTER TABLE forge_tasks
  ADD COLUMN IF NOT EXISTS project text;

UPDATE forge_tasks
SET project = 'Atlas'
WHERE project IS NULL;

ALTER TABLE forge_tasks
  ALTER COLUMN project SET DEFAULT 'Atlas';

ALTER TABLE forge_tasks
  ALTER COLUMN project SET NOT NULL;

CREATE INDEX IF NOT EXISTS forge_tasks_project_status_idx
  ON forge_tasks (project, status);
