# WAM server operations runbook (pre-deployment draft)

Status: **draft for the first deployment; not yet exercised on the target host.** It describes what the code in
`server/` does today (2026-10-30) and the steps an operator follows. Commands assume `npm run build` has been run in
`server/` and the environment variables in `server/README.md` are set. Sections marked *target host* need the
deployment design (Phase 1D/1E) before they can be completed.

## 1. Database outage and recovery
**What the server does.**
- It keeps running when the database is unreachable or drops connections. A broken pooled connection is
  discarded, never reused (finding ST-1).
- `GET /health/live` stays `200`; `GET /health/ready` answers `503` until the database answers again.
- API requests answer `503 SERVICE_UNAVAILABLE` with `Retry-After: 5` (decision O-21). A request whose statement
  runs out of time answers `503 DATABASE_TIMEOUT` with `Retry-After: 2`.
- Sign-in and session checks answer `503` too, never `401`: an outage does not sign anyone out.
- Each failure is logged once as `request failed: database`, with the error's code and SQLSTATE only.

**Operator steps.**
1. Confirm: `/health/ready` is `503`, and the log shows `request failed: database` lines.
2. Restore the database service (*target host*: service manager, disk, network).
3. Confirm recovery: `/health/ready` is `200` and a read (`GET /api/me` with a session) answers `200`. No server
   restart is needed. Restart only if readiness stays `503` after the database is reachable again.
4. Writes that were in flight have one of two outcomes, and both are settled by the client repeating the request
   with the **same Idempotency-Key** (§2).

## 2. Unknown commit outcome and idempotent retry
- Every change is one transaction, and its Idempotency-Key row commits **in the same transaction**.
- `503` with `details.outcome = "not_applied"`: PostgreSQL rolled the change back.
- `503 OUTCOME_UNKNOWN` (`details.outcome = "unknown"`): the connection broke while COMMIT was in flight, so the
  change may have been applied.
- In both cases the client repeats the request **with the same key** within one day (keys expire after 24 hours,
  `maintenance.ts`):
  - if the first attempt committed, the stored response is returned with `Idempotency-Replayed: true`;
  - if it did not, the change is applied once.
- A different body with the same key answers `422 IDEMPOTENCY_KEY_REUSED`.
- Never retry an uncertain change with a new key.
- **Support question "did my change go through?"** Look up the request id from the error body in the audit trail.
  A committed change has an audit event with that request id; an uncommitted one has none.

## 3. Retention jobs
| Job | When | What it changes | Evidence it ran |
|---|---|---|---|
| Maintenance | at start-up, then every 15 minutes (`MAINTENANCE_INTERVAL_MS`) | removes sessions 7 days after they ended or expired, throttling records and idempotency keys after 1 day, setup codes and sign-in challenges once expired; never audit events or business data | log `maintenance completed` with counts |
| Import retention (PD-09) | at start-up, then daily | expires abandoned batches (7 days), clears staged cells and file names (7 / 7 / 90 days), in inactive warehouses too | one `import.retention_applied` audit event per run, and log `import retention completed` |

- **Alert** (*target host*, Phase 1D monitoring) when no `import.retention_applied` event appears for 48 hours.
- A missed run is caught up by the next one, because the periods are compared with timestamps.
- Restarting the server runs both jobs at once; there is no separate retention command yet (known gap).
- A failed run logs `maintenance failed` or `import retention failed`, with an error summary; the next run retries.

## 4. Migrations and downgrades
1. **Back up the database and verify the backup restores** (*target host*, Phase 1D) before any production
   migration.
2. Stop the server. It refuses to start while migrations are pending, so nothing serves a half-migrated schema.
3. `npm run db:migrate -- status`, then `npm run db:migrate -- up` (dry run), then `npm run db:migrate -- up --apply`.
   - All pending migrations apply in one transaction; a failure applies nothing.
   - Each table lock is awaited at most `WAM_MIGRATION_LOCK_TIMEOUT_MS` (10 s; finding NF-6). On
     `Another session holds a lock…`, find the long transaction (`pg_stat_activity`), end it or wait, and run the
     command again.
4. Start the server; check `/health/ready`.
5. **Never `down` in production** (the CLI refuses it). Recovery is a forward migration or a restore (§7).
6. Never run `docs/architecture/asset-schema-draft-down.sql` against production. It is design evidence; if it is
   ever needed elsewhere, use `psql --single-transaction -v ON_ERROR_STOP=1 -f …`.

## 5. Log privacy (application and database)
**Application log** (`server/README.md`, "Log privacy"):
- errors appear as allowlisted summaries only;
- request lines carry no query string and no `Host` header;
- bodies, cookies and tokens are never logged;
- erasures write one id-only `person.erased` line (§7).

**PostgreSQL's log** must use the policy in `server/README.md`:
- `log_error_verbosity = terse`;
- `log_parameter_max_length_on_error = 0` and `log_parameter_max_length = 0`;
- `log_statement = none` or `ddl`;
- `log_min_duration_statement = -1` or at least 250 ms;
- `auto_explain` not loaded.

After any configuration change, as `wam_app`:

```
psql -v ON_ERROR_STOP=1 -d wam -f server/sql/check-logging-settings.sql
```

It must print `logging settings follow the WAM policy`. Never raise `log_error_verbosity` or log parameters on
production, even temporarily: the lines would hold personal data that erasure cannot reach.

**Retention and access** (recommendation R-3; the periods are owner decisions):

| Log | Contains | Recommended retention | Access |
|---|---|---|---|
| Application log | user ids, request ids, remote addresses, paths, error summaries, erasure journal | **at least as long as the longest backup retention** (the erasure journal must outlive every backup), and no longer than needed: 90 days if backups are kept 30 days | operators only; shipped off the server host; append-only store |
| PostgreSQL log | errors with statement text (placeholders), possibly an invalid input value (README, residual) | 30 days | database administrators only |
| Reverse-proxy and infrastructure logs | client addresses, paths, user agents | 30 days | operators only |

Rotate daily. Delete at the end of the period, including copies in backups of the log store. Keep a copy beyond
the period only under a recorded incident, for that incident.

## 6. Import feature flag
- `WAM_IMPORT_ENABLED` must stay `false` (the default) in every real environment until O-14, G-2…G-9, ExcelJS
  approval and the confirmation UI are done.
- Verify after each deployment:
  - the start-up log line `server started` shows `"importEnabled":false`;
  - `GET /api/warehouses/<id>/imports/<any>` answers `404`.
- Only the owner may authorize changing it, in writing, naming the environment.

## 7. Backup restore and re-erasure (recommendation R-2)
A restored backup brings back the names of persons erased after it was taken.

1. Keep the server stopped after the restore, so nothing serves the restored names.
2. From the application log, collect the `personId` of every `person.erased` line newer than the backup's
   timestamp, one per line. For example, with JSON lines:
   `jq -r 'select(.event == "person.erased" and .time > <backup-epoch-ms>) | .personId' wam.log > erased-ids.txt`.
3. Run `npm run owner -- reapply-erasures --ids-file erased-ids.txt --yes`. It reports how many it erased again,
   how many were already erased, and how many are not in the restored database (created after the backup).
4. Start the server.
5. Record the restore and the counts in the incident record.

Running the command twice changes nothing. If the application log for the period is missing, the erasures since
the backup cannot be replayed: record this as a privacy incident.

## 8. Not yet covered (Phase 1D/1E)
Target-host specifics:
- service manager units;
- TLS certificates and the reverse proxy (`trustProxy`, real client addresses for audit and throttling);
- backup schedule and storage;
- monitoring and alerting;
- MFA key rotation (L-8);
- disaster-recovery drill.
