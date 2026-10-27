# Project status

Snapshot: **2026-10-27, third session** (in progress: slice 1B-2c). Replace this file's contents at the end of each work session; history
stays in Git.

## Where things are

| Reference | Commit | On GitHub? | Content |
|---|---|---|---|
| `main` | `efbd65a9ca123c1ac03d464087628097671a0290` | yes (unchanged) | Desktop baseline |
| tag `desktop-baseline-efbd65a` | tag object `6dd8a5dd58b3d43e78abdfe2113128b9947bf6b5` → `efbd65a9…` | **no** — this session cannot push tags; see [owner actions](#owner-actions) | Protects the baseline |
| `phase-1a/repo-safety-net` | `c819994e80cfdc0262677b0e359eb14a5b9765cc` | yes | Phase 1A |
| `ccr-1860034b-yp0csr` (session branch) | GitHub: `1463f63` (pushed with approval O-10, verified). Newer commits are local only | yes, up to `1463f63` | Phase 1B-1 + 1B-2 (+ 1B-2c locally) |

Commits pushed under O-10 (fast-forward from `eeb25fe`, no force, verified on GitHub):

| Commit | Content |
|---|---|
| `28c9fcd` | Decisions D-05 (online-only) and O-09 (owner-controlled administration) recorded; `security/identity-and-access.md` specification |
| `b7632d3` | Phase 1B-2a: identity schema, Argon2id, sessions, throttling, request-forgery protection, idempotency, owner CLI, audit trail |
| `fd0a5dc` | Phase 1B-2b: admin API (users, access, profiles, job titles, warehouses, audit), escalation rules A1–A6, performance check |
| `fc53b1a` | Security response headers (CSP, `nosniff`, referrer policy, HSTS on https, `Clear-Site-Data` at logout) |
| the commit containing this file | Documentation of the verified result |

Nothing was merged into `main`, tagged, released or deployed. No desktop file changed (verified with `git diff`).
Commits made after `1463f63` (slice 1B-2c) are local and need a new push approval.

## Current phase

**Phase 1B-2c — multi-factor authentication** (decision O-07: mandatory for the owner and administrators,
policy-configurable for all staff). Design, recovery and lockout safeguards written first:
`security/identity-and-access.md` §3.2. Then **1B-3** (asset schema and SQLite migration rehearsal).

## Verification of this session (Linux sandbox; **nothing run on Windows**)

| Check | Result |
|---|---|
| `server`: typecheck, lint (`strictTypeChecked`), build | exit 0 |
| `server`: tests, Node 24.22.1, PostgreSQL 16.15, non-root user | **222/222** pass (unit 97 in 6 files, integration 125 in 9 files) |
| Deliberate-defect check: 30 safeguards removed one at a time (escalation rules A1–A6, 404 isolation, session expiry and revocation, throttling, setup-code single use and expiry, CSRF checks, cookie tossing, idempotency fingerprint, `is_owner` grant, audit trigger, secret guard, …) | **30/30 caught** by the suite; source restored byte-identical |
| End-to-end runbook with the **built** server as real processes: migrate → owner bootstrap → setup code → login → `/api/me` → create warehouse → forged POST refused → logout | all as expected; **no password, setup code or session token in the server log** |
| `npm audit` (server) | 0 vulnerabilities |
| Desktop app | unchanged; its tests were not re-run this session (no desktop file changed) |
| ASVS version | 5.0.0 confirmed from OWASP's own repository; requirement text read from the official CSV |

### Performance (synthetic data; targets fixed before the first measurement)

Volume: 2,000 users, 50 warehouses, 30 profiles, 6,000 warehouse assignments, 5,000 sessions, 200,000 audit events,
10,000 recent failed logins. Sandbox: 4 vCPU Xeon 2.1 GHz, 16 GB RAM; PostgreSQL with `fsync=off` (writes faster
than production). Real HTTP on loopback. Two runs; p95 shown as run 2 / run 1, other columns from run 2.

| Measurement | Target | p95 (run 2 / run 1) | p50 | Throughput |
|---|---|---|---|---|
| Login (Argon2id), 10 concurrent, 100 requests | ≤ 1,000 ms | **148 / 156 ms** | 80.7 ms | 109 /s |
| `GET /api/me`, 20 concurrent, 2,000 requests | ≤ 100 ms | **38 / 46 ms** | 27.5 ms | 703 /s |
| Admin user search, 20 concurrent, 1,000 requests | ≤ 100 ms | **38 / 46 ms** | 23.1 ms | 776 /s |
| Warehouse audit page (of 200,000 events), 20 concurrent, 1,000 requests | ≤ 100 ms | **38 / 33 ms** | 24.5 ms | 756 /s |

`EXPLAIN` of the exact per-request queries: session lookup and the audit page use their indexes; no sequential scan
on any growing table. **Not yet measured:** production hardware, asset queries (do not exist yet), the D-04
concurrency figure (unconfirmed).

## Known limitations (details: `security/identity-and-access.md` §8)

1. **MFA** — being implemented (1B-2c). Even then it is mandatory only for the owner and administrators until the
   policy is set to all staff (O-11). Do not expose the server beyond a trusted network before that.
2. **Deployment blocker:** behind a reverse proxy, `trustProxy` must be set to the proxy's address, or all users
   share one address for throttling.
3. No breached-password check (offline list only); no general rate limit yet; audit trail not yet shipped off the
   server.

## Owner actions

1. **Publish the baseline tag (O-02)** — a separate task you run locally; I perform no tag operation. On your PC, in
   the repository folder, with `WAM_Phase1A_closure.bundle` (changes your local Git and adds one tag on GitHub;
   nothing else):
   ```
   git fetch "PATH\TO\WAM_Phase1A_closure.bundle" refs/tags/desktop-baseline-efbd65a:refs/tags/desktop-baseline-efbd65a
   git rev-parse "desktop-baseline-efbd65a^{commit}"     # must print efbd65a9ca123c1ac03d464087628097671a0290
   git push origin refs/tags/desktop-baseline-efbd65a
   git ls-remote origin refs/tags/desktop-baseline-efbd65a   # must print 6dd8a5dd58b3d43e78abdfe2113128b9947bf6b5
   ```
   Then in GitHub → Settings → Rules, protect `main` (require a pull request) and protect tags `desktop-baseline-*`.
2. **Staff rule until O-03 is fixed and verified:** in the desktop import screen choose **Skip**, never **Update**,
   for duplicate records.
3. When you can: O-03 and O-04 (desktop fixes), D-02 (warehouse list, privately), D-03 (mapping source and
   reviewer), D-06 (approvals), O-11 (when to require MFA for all staff), and the WSL2 readiness checks in the
   readiness sheet, T-5 (read-only).
