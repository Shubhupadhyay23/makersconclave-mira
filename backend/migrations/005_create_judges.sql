-- Create judges/organizers directory table
CREATE TABLE judges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  role          text NOT NULL DEFAULT 'judge'
                  CHECK (role IN ('judge', 'organizer')),
  title         text,
  organization  text,
  bio           text,
  photo_url     text,
  linkedin_url  text,
  twitter_url   text,
  website_url   text,
  source_urls   jsonb DEFAULT '[]',
  scrape_status text NOT NULL DEFAULT 'pending'
                  CHECK (scrape_status IN ('pending', 'scraped', 'failed', 'manual')),
  scrape_error  text,
  scraped_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_judges_name_role ON judges(lower(name), role);
CREATE INDEX idx_judges_role ON judges(role);
CREATE INDEX idx_judges_scrape_status ON judges(scrape_status);
