CREATE TABLE IF NOT EXISTS cove_inbound_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  source_id text NOT NULL,
  raw_text text NOT NULL,
  machine text,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'triaged', 'failed', 'dismissed')),
  task_id uuid,
  error text,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_id)
);

CREATE INDEX IF NOT EXISTS cove_inbound_events_state_created_at_idx
  ON cove_inbound_events (state, created_at);

CREATE OR REPLACE FUNCTION cove_resolve_inbound_event(
  p_id uuid,
  p_state text,
  p_task_id uuid,
  p_error text,
  p_updated_at timestamptz
)
RETURNS SETOF cove_inbound_events
LANGUAGE sql
AS $$
  UPDATE cove_inbound_events
  SET
    state = p_state,
    task_id = p_task_id,
    error = p_error,
    attempts = attempts + 1,
    updated_at = p_updated_at
  WHERE id = p_id
  RETURNING *;
$$;
