-- 002_enrich_purchases.sql
-- Adds richer purchase data for AI agent consumption and prevents duplicate imports.

ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS merchant text,
  ADD COLUMN IF NOT EXISTS order_status text,
  ADD COLUMN IF NOT EXISTS tracking_number text,
  ADD COLUMN IF NOT EXISTS receipt_text text;

-- Prevent duplicate imports from the same email + item combination.
-- Uses COALESCE so rows with NULL source_email_id don't collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_purchases_email_item
  ON purchases(user_id, COALESCE(source_email_id, ''), item_name);
