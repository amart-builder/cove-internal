CREATE TABLE IF NOT EXISTS forge_commitments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('follow_up', 'promise', 'waiting_on', 'open_decision', 'overnight_request', 'idea')),
  title text NOT NULL,
  details text,
  counterparty text,
  contact_id uuid,
  source_kind text NOT NULL CHECK (source_kind IN ('brain_dump', 'manual', 'chat', 'detector', 'brief')),
  source_quote text,
  source_ref text,
  due_at timestamptz,
  review_at timestamptz,
  confidence text NOT NULL DEFAULT 'high' CHECK (confidence IN ('high', 'medium', 'low')),
  confirmed boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dropped', 'expired')),
  evidence text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS forge_commitments_status_due_at_idx
  ON forge_commitments (status, due_at);

CREATE INDEX IF NOT EXISTS forge_commitments_status_review_at_idx
  ON forge_commitments (status, review_at);
