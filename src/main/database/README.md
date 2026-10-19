`connection.js` opens the SQLite file and sets `PRAGMA foreign_keys = ON` and
`PRAGMA journal_mode = WAL`. `schema.sql` is the verified Phase 3 schema, applied on first run.
