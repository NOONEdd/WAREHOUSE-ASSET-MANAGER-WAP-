# Project status

Snapshot: **2026-10-27, third session** (after the second push). Replace this file's contents at the end of each work session; history
stays in Git.

## Where things are

| Reference | Commit | On GitHub? | Content |
|---|---|---|---|
| `main` | `efbd65a9ca123c1ac03d464087628097671a0290` | yes (unchanged) | Desktop baseline |
| tag `desktop-baseline-efbd65a` | tag object `6dd8a5dd58b3d43e78abdfe2113128b9947bf6b5` → `efbd65a9…` | **no** — a separate task you run locally (O-02); see [owner actions](#owner-actions) | Protects the baseline |
| `phase-1a/repo-safety-net` | `c819994e80cfdc0262677b0e359eb14a5b9765cc` | yes | Phase 1A |
| `ccr-1860034b-yp0csr` (session branch) | GitHub: `568846b` (second push under O-10, verified). **Locally ahead by the commits below** | up to `568846b` | Phase 1B-1, 1B-2 including MFA (1B-2c) |

Pushed under O-10 (second approval; fast-forward from `1463f63`, no force, verified on GitHub): `0c65acf` (decisions
and MFA design), `742d273` (MFA), `568846b` (verified result).

**Local only** — pushing them needs a new approval:

| Commit | Content |
|---|---|
| `1724a7a` | Fix: the owner account can no longer be reset over HTTP, not even by an owner session (found while checking your requirement that owner recovery is server-side only) |
| the commit containing this file | Decisions O-10 (second push), O-11, the O-07 follow-up requirements and O-12 recorded; this status |

Nothing was merged into `main`, tagged, released or deployed. No desktop file changed (verified with `git diff`).

## Current phase

**Phase 1B-2 (identity and access) is complete on the server side, including MFA.** Next would be **1B-3** (asset
schema, status history, staged import, SQLite → PostgreSQL rehearsal). **Not started, by your instruction:** it waits
for decisions O-06 and D-15 (reported with options and recommendations; D-15's original scope also needs your
confirmation).

What 1B-2c delivers (decision O-07; `security/identity-and-access.md` §3.2):

- Authenticator-app codes (TOTP) and 10 single-use recovery codes. No SMS or e-mail codes.
- **Always required for the owner and administrators**, for every user once the owner sets the security policy to
  `all_users` (O-11). Enforced on every request: a password-only session ends as soon as its account needs a
  second factor (for example right after the user is appointed administrator).
- A correct password alone never creates a session for such an account; there is a short-lived second step.
- Lockout safeguards: 10 consecutive wrong codes lock second-factor sign-in until a password reset; an administrator
  MFA reset always resets the password too (identity proven again, as at account creation); the owner is recovered
  with `npm run owner -- recover [--reset-mfa] --yes`.
- Authenticator secrets are encrypted at rest (AES-256-GCM) under `WAM_MFA_ENCRYPTION_KEY`, which lives outside the
  database. **Back that key up separately from the database backups.**

## Verification of this session (Linux sandbox; **nothing run on Windows**)

| Check | Result |
|---|---|
| Fresh clone of `742d273`, `npm ci --ignore-scripts`, `npm run verify` (typecheck, lint `strictTypeChecked`, tests, build), Node 24.22.1, PostgreSQL 16.15, non-root user | **exit 0**; **312/312** tests (unit 145 in 7 files, integration 167 in 10 files); lockfile unchanged |
| Owner recovery is server-side only (O-07 follow-up) | Owner CLI not reachable from web code; ownership not writable by the server's database role; CLI refuses the server's credentials. **Gap found and closed (`1724a7a`):** an owner session could reset the owner's own password and authenticator over HTTP (probe: `200` with a new setup code). Now `403` for everyone; test added; removing either check is caught. Fresh clone of `1724a7a`: `verify` exit 0, **313/313** |
| Enrolment and appointment safeguards (O-07 follow-up) | Every enforced safeguard has a test (no session without the second step; administrator rights never usable from a password-only session; activation only with a code from the app; enrolment audited and visible; resets always include a new password; sign-in enrolment never overwrites). Not enforced: "appoint only after enrolment" — decision O-12 |
| RFC conformance | HOTP (RFC 4226 Appendix D) and TOTP (RFC 6238 Appendix B) published test vectors reproduced |
| Deliberate-defect check: 70 safeguards removed one at a time — the 30 from 1B-2 and 40 MFA safeguards (enforcement on every request, owner/administrator rule, fail-closed policy, single use of codes, lock and its recovery paths, challenge expiry and single use, re-authentication, reset rules, owner-only policy, database grants and `CHECK`, encryption binding, audit guard, …) | **70/70 caught** in one run against the fresh clone of `742d273`; source restored byte-identical. (An earlier run during development left 3 survivors; each led to a new test, and one to a code fix: a second-step challenge now completes at most one sign-in even under concurrent requests.) |
| End-to-end runbook with the **built** server as real processes: refuses to start without the MFA key → migrate → owner bootstrap → setup code → password step (no session, second-step cookie only) → enrol (wrong code refused, right code → session + 10 recovery codes) → `/api/me` → create warehouse → sign in again with a recovery code → same code refused → owner `status` shows MFA | all as expected; **no password, setup code, session or second-step token, authenticator secret, recovery code or encryption key in the server log** |
| `npm audit` (server) | 0 vulnerabilities; no dependency added |
| Desktop app | unchanged; its tests were not re-run (no desktop file changed) |

### Performance (synthetic data; targets fixed before the first measurement)

Volume: 2,000 users, 50 warehouses, 30 profiles, 6,000 warehouse assignments, 5,000 sessions, 200,000 audit events,
10,000 recent failed logins, about 600 enrolled authenticators. Sandbox: 4 vCPU Xeon 2.1 GHz, 16 GB RAM;
PostgreSQL with `fsync=off` (writes faster than production). Real HTTP on loopback. Two runs (run 2 from the fresh
clone); p95 shown as run 2 / run 1, other columns from run 2.

| Measurement | Target | p95 (run 2 / run 1) | p50 | Throughput |
|---|---|---|---|---|
| Login password step (Argon2id), 10 concurrent, 100 requests | ≤ 1,000 ms | **175 / 205 ms** | 83.7 ms | 103 /s |
| Second sign-in step (authenticator code), 10 concurrent, 100 requests — new | ≤ 100 ms | **40 / 40 ms** | 35.5 ms | 277 /s |
| `GET /api/me`, 20 concurrent, 2,000 requests | ≤ 100 ms | **46 / 41 ms** | 29.7 ms | 634 /s |
| Admin user search, 20 concurrent, 1,000 requests | ≤ 100 ms | **41 / 41 ms** | 29.1 ms | 663 /s |
| Warehouse audit page (of 200,000 events), 20 concurrent, 1,000 requests | ≤ 100 ms | **41 / 43 ms** | 30.0 ms | 644 /s |

The per-request session check now also decides whether the account needs a second factor; `/api/me` p95 moved from
38–46 ms (before MFA) to 41–46 ms, within run-to-run variation. `EXPLAIN`: the session lookup uses the token index and
the `user_mfa` primary key; no sequential scan on any growing table. **Not yet measured:** production hardware,
asset queries (do not exist yet), the D-04 concurrency figure (unconfirmed).

## Known limitations (details: `security/identity-and-access.md` §3.2.6 and §8)

1. **Trusted network only (decision O-11).** MFA for all staff is required before any public internet exposure;
   until the policy is switched to `all_users`, verified and recovery-tested, the server stays on a trusted network.
2. **Deployment blocker:** behind a reverse proxy, `trustProxy` must be set to the proxy's address, or all users
   share one address for throttling.
3. A user's **first** enrolment trusts the password at that moment; appoint administrators after they have enrolled.
   TOTP is not phishing-resistant (L-9).
4. No rotation command for `WAM_MFA_ENCRYPTION_KEY` yet (L-8). **Your requirement:** a key-rotation and recovery
   procedure is documented and tested before production deployment. Keep the key separate from the database and
   backed up securely; losing it means resetting every enrolled user.
5. No breached-password check (offline list only); no general rate limit yet; audit trail not yet shipped off the
   server.

## Owner actions

1. **Push approval** for `1724a7a` and the docs commit above, if you want them on GitHub (a bundle backup is
   provided).
2. **Publish the baseline tag (O-02)** — a separate task you run locally; I perform no tag operation. On your PC, in
   the repository folder, with `WAM_Phase1A_closure.bundle` (changes your local Git and adds one tag on GitHub;
   nothing else):
   ```
   git fetch "PATH\TO\WAM_Phase1A_closure.bundle" refs/tags/desktop-baseline-efbd65a:refs/tags/desktop-baseline-efbd65a
   git rev-parse "desktop-baseline-efbd65a^{commit}"     # must print efbd65a9ca123c1ac03d464087628097671a0290
   git push origin refs/tags/desktop-baseline-efbd65a
   git ls-remote origin refs/tags/desktop-baseline-efbd65a   # must print 6dd8a5dd58b3d43e78abdfe2113128b9947bf6b5
   ```
   Then in GitHub → Settings → Rules, protect `main` (require a pull request) and protect tags `desktop-baseline-*`.
3. **Staff rule until O-03 is fixed and verified:** in the desktop import screen choose **Skip**, never **Update**,
   for duplicate records.
4. For 1B-3: **O-06** (read-only data-quality report on a copy of the desktop database, on your PC) and **D-15**
   (spreadsheet handling — please also confirm its scope). **O-12** (enrol first, then appoint).
5. When you can: O-03 and O-04 (desktop fixes), D-02 (warehouse list,
   privately), D-03 (mapping source and reviewer), D-06 (approvals), and the WSL2 readiness checks in the readiness
   sheet, T-5 (read-only).
