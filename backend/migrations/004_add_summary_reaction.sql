-- 004_add_summary_reaction.sql
-- Allow 'summary' as a valid reaction type for session recap records.

ALTER TABLE session_outfits DROP CONSTRAINT session_outfits_reaction_check;
ALTER TABLE session_outfits ADD CONSTRAINT session_outfits_reaction_check
  CHECK (reaction IN ('liked', 'disliked', 'skipped', 'summary'));
