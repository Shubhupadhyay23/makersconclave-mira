-- 003_add_last_scraped_at.sql
-- Tracks when each user's Gmail was last scraped, enabling incremental scraping.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_scraped_at timestamptz;
