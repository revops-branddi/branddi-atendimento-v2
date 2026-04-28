-- Migration 006: remember which phone variant (com/sem 9) was confirmed
-- delivered=1 by WhatsApp for each lead. Eliminates the "ghost chat" guess
-- on subsequent sends — startNewChat reads this and goes straight to the
-- variant the WhatsApp side actually has registered.
--
-- Values:
--   'with_9'    — the 11-digit mobile (DDD + 9 + 8 digits) was the one delivered
--   'without_9' — the 10-digit legacy mobile (DDD + 8 digits) was the one delivered
--   NULL        — never confirmed yet (use heuristic / try both)

ALTER TABLE leads
    ADD COLUMN IF NOT EXISTS working_phone_variant text
    CHECK (working_phone_variant IN ('with_9', 'without_9'));
