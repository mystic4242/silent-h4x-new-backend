BEGIN;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS email VARCHAR(254),
  ADD COLUMN IF NOT EXISTS password_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS customers_email_lower_unique
  ON customers (LOWER(email))
  WHERE email IS NOT NULL;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS is_free BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS price NUMERIC(14,2) NOT NULL DEFAULT 0;

UPDATE products p
SET price = COALESCE((
  SELECT MIN(d.price)
  FROM product_durations d
  WHERE d.product_id = p.id AND d.active = TRUE
), 0)
WHERE p.price = 0 AND p.is_free = FALSE;

ALTER TABLE orders
  ALTER COLUMN duration_hours DROP NOT NULL;

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_duration_hours_check;

CREATE TABLE IF NOT EXISTS product_ownerships (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  order_id BIGINT REFERENCES orders(id),
  amount_paid NUMERIC(14,2) NOT NULL DEFAULT 0
    CHECK (amount_paid >= 0),
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (customer_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_product_ownerships_customer
  ON product_ownerships (customer_id, acquired_at DESC);

CREATE INDEX IF NOT EXISTS idx_product_ownerships_product
  ON product_ownerships (product_id);

COMMIT;
