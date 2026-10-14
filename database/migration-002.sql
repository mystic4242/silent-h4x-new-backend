BEGIN;

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_status_check;

ALTER TABLE orders
  ADD CONSTRAINT orders_status_check
  CHECK (status IN (
    'pending_fulfillment',
    'completed',
    'cancelled',
    'refunded'
  ));

ALTER TABLE generated_keys
  ADD COLUMN IF NOT EXISTS encrypted_key TEXT;

ALTER TABLE generated_keys
  ADD COLUMN IF NOT EXISTS revealed_at TIMESTAMPTZ;

ALTER TABLE generated_keys
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_orders_fulfillment
  ON orders(status, created_at DESC);

COMMIT;
