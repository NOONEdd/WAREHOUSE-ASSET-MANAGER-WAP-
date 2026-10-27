# Security acceptance matrix

Baseline: OWASP ASVS **5.0.0**, target Level 2 (see the review, §2.9: its current status was confirmed only from
web-search results, and requirement-level IDs are pending access to the standard's text; rows map to ASVS
chapters for now). A row is **Done** only when its verification has actually run and passed; "tests pass"
alone does not make the application secure.

Status: **Done** (verified, evidence named) · **Partial** · **Planned** (slice named) · **Open** (needs a decision).

| ID | Requirement (WAM) | ASVS chapter | Implementation | Verification | Expected result | Status / evidence |
|---|---|---|---|---|---|---|
| S-01 | Configuration validated at startup; fails closed; never echoes values | V13 Configuration | `server/src/config.ts` | `tests/unit/config.test.ts` | Missing/invalid → process refuses with a full list; password absent from messages | **Done** — 12 tests, 2026-10-27 |
| S-02 | Errors never reveal internals; one response shape | V16 Logging & Error Handling | `server/src/http/errors.ts` | `tests/unit/app.test.ts` | 4xx/5xx bodies are generic; internal text absent | **Done** |
| S-03 | Server-generated request ID on every response and log line; client value ignored | V16 | `server/src/app.ts` | `tests/unit/app.test.ts` | UUID header; forged value not echoed | **Done** |
| S-04 | Runtime DB role is least-privileged; server refuses otherwise | V13, V15 Secure Coding & Architecture | `server/src/db/safety.ts`, `server/sql/` | `tests/integration/safety.test.ts` + mutation check | Superuser, BYPASSRLS, CREATEROLE/DB, schema owner/CREATE, public CREATE all refused | **Done** — 14/14 mutations caught |
| S-05 | Server refuses a schema that does not match its code | V15 | `server/src/db/safety.ts` | `tests/integration/safety.test.ts` | Pending or unknown migrations → refuse | **Done** |
| S-06 | Schema changes only through the migration CLI; transactional; no `down` in production | V15 | `server/src/cli/migrate.ts` | `tests/integration/migrations.test.ts` | Dry run by default; failed run leaves nothing; concurrent runs apply once | **Done** |
| S-07 | Tests cannot reach a real database | (project rule) | `server/tests/support/` | `tests/integration/testSafety.test.ts` + mutation check | No TCP listener; per-run token; PG*/WAM_* scrubbed | **Done** |
| S-08 | Health endpoints disclose nothing | V13 | `server/src/http/health.ts` | unit + integration tests | Only `ok`/`unavailable` | **Done** |
| S-09 | Credentials never logged | V16 | `server/src/server.ts` (redaction), `describeDatabaseTarget` | runbook smoke test grepped the log for all three passwords | Not found | **Partial** — manual smoke test; automate in 1B-2 with session cookies |
| S-10 | Dependencies pinned, audited, registry-verified; no install scripts | V15 | `server/package*.json` | `npm audit`; `npm run verify:deps` | 0 advisories; every package's registry signature verifies | **Partial** — audit 0 and 839/839 signatures verified 2026-10-27; Sigstore provenance (`npm audit signatures`) could not download in the sandbox: run it on your network |
| S-11 | Owner created only by a server CLI; no first-visitor setup | V6 Authentication | — | negative test: no unauthenticated setup route | No route exists | **Planned 1B-2** (D-01) |
| S-12 | Argon2id password hashing; constant-work login | V6, V11 Cryptography | — | unit + timing-shape test | Unknown and wrong-password logins do the same work | **Planned 1B-2** |
| S-13 | Login throttling per account and per address | V6 | — | integration test | Lockout/delay after N failures; audited | **Planned 1B-2** |
| S-14 | Sessions: opaque, hashed at rest, `HttpOnly; Secure; SameSite=Strict`, idle + absolute timeout, revoked on deactivate/role/password change | V7 Session Management | — | integration tests | Revoked/expired sessions get 401 | **Planned 1B-2** |
| S-15 | CSRF defense for state-changing requests | V3 Web Frontend, V4 API | — | integration test | Cross-origin request refused | **Planned 1B-2** |
| S-16 | Every endpoint checks an action permission; deny by default | V8 Authorization | — | route inventory test: every route declares a permission | No unguarded route | **Planned 1B-2/1B-4** |
| S-17 | Warehouse isolation on every path (get, list, search, counts, export, import, transfer, audit, admin) | V8 | — | adversarial suite | Out-of-scope object → 404; counts exclude it | **Planned 1B-4** |
| S-18 | RLS as defense in depth; context transaction-local, never leaks across pooled connections | V8 | — | concurrency test with pooled connections | No cross-request leakage | **Open** — adopt in 1B-4 (review §2.3) |
| S-19 | Append-only audit; runtime role cannot update/delete it | V16 | — | privilege test + trigger test | UPDATE/DELETE rejected | **Planned 1B-2** |
| S-20 | Uploads: size limit, type check, no client paths, safe parser | V5 File Handling | — | integration tests with hostile files | Rejected cleanly | **Planned 1B-3** (D-15) |
| S-21 | Spreadsheet/CSV exports cannot inject formulas | V1 Encoding & Sanitization | — | unit test with `=`, `+`, `-`, `@` values | Exported as text | **Planned 1C** |
| S-22 | Security headers and CSP for the web UI | V3 | partial: `nosniff`, `no-store` | header test | Strict CSP, frame-ancestors none | **Partial / Planned 1C** |
| S-23 | TLS only; HSTS; correct `trustProxy` behind nginx | V12 Secure Communication | — | deployment checklist + scan | No plain-HTTP access | **Planned 1E** |
| S-24 | MFA for administrators | V6 | — | integration test | Admin login requires TOTP | **Open** (O-07) |
| S-25 | Encrypted off-server backups with a measured restore drill | V14 Data Protection | — | drill record | Restore succeeds within RTO | **Planned 1D** (O-08) |
| S-26 | Secrets outside the repository; rotation procedure | V13 | env-only config (no `.env` loading) | review + rotation drill | Rotation without code change | **Partial / Planned 1E** |
