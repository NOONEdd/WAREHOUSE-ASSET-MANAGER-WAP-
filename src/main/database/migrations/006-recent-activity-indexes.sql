-- Migration 006: indexes for Dashboard's new "recently added" /
-- "recently modified" sections (assetService.getRecentlyAdded /
-- getRecentlyModified), which query
--   ORDER BY created_at DESC LIMIT N   and   ORDER BY updated_at DESC LIMIT N
-- respectively. Without an index, each of those is a full table scan +
-- sort even though only 5-10 rows are ever returned — cheap today at a
-- few thousand assets, but exactly the kind of thing that's worth
-- indexing when a feature is actually introducing the query pattern,
-- rather than waiting for it to become "demonstrably problematic" first
-- (Phase 6 performance review's own bar for anything more invasive than
-- this, like FTS5 or keyset pagination — a plain single-column index is
-- not that).
--
-- CREATE INDEX IF NOT EXISTS is naturally idempotent — unlike migrations
-- 002-005 (ALTER TABLE / table rebuilds), this needs no "has it already
-- run" guard in connection.js; it's safe to execute unconditionally on
-- every launch, the same way migration 001's plain UPDATEs already are.

CREATE INDEX IF NOT EXISTS idx_assets_created_at ON assets(created_at);
CREATE INDEX IF NOT EXISTS idx_assets_updated_at ON assets(updated_at);
