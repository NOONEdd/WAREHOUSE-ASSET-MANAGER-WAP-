-- Migration 001: repair English asset_statuses seeded before the
-- Phase 9 fix to schema.sql.
--
-- schema.sql only runs on a brand-new database (see connection.js) — an
-- already-created database keeps whatever it was seeded with at creation
-- time, in whatever language that was. This repairs those existing
-- databases instead of requiring anyone to delete their data.
--
-- Matched by id AND by "does this name still look English" (the GLOB
-- below — Persian text uses Arabic-script codepoints, never plain ASCII
-- letters, so a name containing [A-Za-z] anywhere is unambiguously
-- still-unfixed old English data, regardless of what the exact original
-- English wording was, which isn't known exactly). The GLOB condition
-- was added after a real bug: the original version of this migration
-- matched by id alone (id 1..6 reliably identified which status was
-- which back when the schema always seeded exactly six, in that fixed
-- order) — matching by id 4 = "تعمیر" specifically. Once schema.sql was
-- later changed (Manual Status Management phase) to seed only FOUR
-- statuses with id 4 = "آسیب‌دیده", this same statement fired on every
-- single launch of a brand-new database, silently overwriting id 4's
-- correct "آسیب‌دیده" with "تعمیر" — or, if an administrator had
-- separately created a custom status actually named "تعمیر" (a
-- realistic, even expected scenario per that phase), crashing the
-- entire app on startup with a UNIQUE constraint violation instead.
-- Matching on an already-Persian name is now structurally impossible:
-- GLOB '*[A-Za-z]*' cannot match Persian text no matter which Persian
-- name is currently stored, so this migration is now a true no-op for
-- every database schema.sql has ever produced, and still correctly
-- fixes a genuinely old English-named database exactly as before.
--
-- Each statement is a no-op if that row doesn't currently look English,
-- so this remains safe to run on every launch.

UPDATE asset_statuses SET name = 'در انبار' WHERE id = 1 AND name GLOB '*[A-Za-z]*';
UPDATE asset_statuses SET name = 'صادر شده' WHERE id = 2 AND name GLOB '*[A-Za-z]*';
UPDATE asset_statuses SET name = 'مرجوع شده' WHERE id = 3 AND name GLOB '*[A-Za-z]*';
UPDATE asset_statuses SET name = 'تعمیر' WHERE id = 4 AND name GLOB '*[A-Za-z]*';
UPDATE asset_statuses SET name = 'آسیب‌دیده' WHERE id = 5 AND name GLOB '*[A-Za-z]*';
UPDATE asset_statuses SET name = 'مفقود' WHERE id = 6 AND name GLOB '*[A-Za-z]*';
