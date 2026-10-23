BEGIN;

ALTER TABLE products
  DROP CONSTRAINT IF EXISTS products_slot_check;

ALTER TABLE products
  ALTER COLUMN slot TYPE INTEGER;

ALTER TABLE products
  ADD CONSTRAINT products_slot_check CHECK (slot >= 1);

COMMIT;
