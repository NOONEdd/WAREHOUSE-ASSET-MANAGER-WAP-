# Security acceptance matrix

Baseline: **OWASP ASVS 5.0.0**, target **Level 2**. Version verified 2026-10-27 from the OWASP/ASVS repository
(README: "Latest Stable Version - 5.0.0"; next target 5.0.1, unreleased). Requirement text read from the official
`v5.0.0` CSV (345 requirements; SHA-256 `98c8fe911b9edb403af8ee05d3ce8201ecac2659e313b053890a62847cdcf680`).
IDs below are `v5.0.0` IDs.

A row is **Done** only when its verification ran and passed in this repository; tests passing do not by themselves
make the application secure. Status: **Done** · **Partial** · **Planned** (slice) · **Gap** (known, documented).

Evidence abbreviations: *unit/…*, *int/…* = test files under `server/tests/`; *mutation* = the deliberate-defect check
(2026-10-27, after slice 1B-2c: 70/70 safeguards removed one at a time, each caught by the suite); *smoke* = end-to-end
run of the built server as real processes.

## Authentication (V6)

| ASVS | Requirement (short) | Implementation | Status / evidence |
|---|---|---|---|
| 6.1.1 | Documented anti-automation, no malicious lockout | identity-and-access §3.1; `auth/throttle.ts` | **Done** — int/auth "throttling", mutation |
| 6.1.2, 6.2.11 | Context-specific words documented and refused | `CONTEXT_WORDS` in `auth/passwordPolicy.ts`; spec §3 | **Done** — unit/passwordPolicy |
| 6.1.3, 6.3.4 | All authentication pathways documented, consistent | spec §3, §3.2: a session only via password + (where required) second factor; the setup code only sets a password | **Done** — int/mfa (no session without the second step), review |
| 6.2.1, 6.2.9 | ≥ 8 (15 recommended); ≥ 64 allowed | 15–128 code points | **Done** — unit/passwordPolicy |
| 6.2.2, 6.2.3 | Users can change password; current + new required | `POST /api/auth/change-password` | **Done** — int/auth |
| 6.2.4 | Checked against ≥ 3,000 common passwords meeting policy | 11,146 bundled (SecLists; checksum tested) | **Done** — unit/passwordPolicy, mutation |
| 6.2.5, 6.2.8, 6.2.10 | Any composition; verified exactly as typed; no forced rotation | `auth/passwords.ts` | **Done** — unit/passwords |
| 6.2.6, 6.2.7 | Masked input; paste and password managers allowed | user interface | **Planned 1C** |
| 6.2.12 | Checked against breached passwords | — | **Gap**: online breach services are not reliable from the deployment network; partly covered by 6.2.4 |
| 6.3.1 | Brute-force controls implemented | password throttling; second-factor lock after 10 consecutive wrong codes (E-14) | **Done** — int/auth, int/mfa, mutation |
| 6.3.2 | No default accounts | no seeded users; reserved names refused | **Done** — unit/passwordPolicy, int/ownerCli |
| 6.3.3 | **MFA** (L2) | TOTP authenticator apps + recovery codes (spec §3.2); enforced at sign-in **and on every request** | **Partial** — always required for the owner and administrators (int/mfa, mutation); for **all** users only when the owner sets the policy to `all_users` (decision O-11). Until then: no exposure beyond a trusted network |
| 6.4.1 | Activation codes random, expire, single use, never the long-term password | `auth/setupCodes.ts` (160-bit, 24 h, one use) | **Done** — int/auth, int/ownerCli, mutation |
| 6.4.2 | No hints or secret questions | none exist | **Done** (review) |
| 6.4.3 | Secure reset, not bypassing MFA | administrator- or CLI-issued setup code; the authenticator is kept, so the second step is still required | **Done** — int/mfa |
| 6.4.4 | Lost factor: identity proofing as at enrolment | administrator MFA reset always also resets the password and issues a setup code handed over in person; owner via CLI `recover --reset-mfa` | **Done** — int/mfa, int/ownerCli, mutation |
| 6.5.1 | Lookup secrets and TOTP usable only once | last accepted step stored under a row lock; recovery codes marked used atomically | **Done** — unit/mfa, int/mfa (incl. simultaneous submission), mutation |
| 6.5.2, 6.5.3 | ≥ 112-bit secrets hashed; CSPRNG | SHA-256 of 120/160/256-bit `crypto.randomBytes` values (recovery codes, setup codes, tokens); TOTP seeds from the CSPRNG | **Done** — unit/secretsAndCookies, unit/mfa, int/schema, int/mfa |
| 6.5.4 | Lookup secrets ≥ 20 bits | recovery codes 120 bits | **Done** — unit/mfa |
| 6.5.5 | TOTP lifetime ≤ 30 s | 30-second steps; one step tolerance either side | **Partial** — recorded deviation E-13 (clock tolerance), bounded by single use and the lock; unit/mfa |
| 6.5.6, 6.5.8 (L3) | Factor revocable; TOTP checked against server time | administrator reset, self-service replace/remove; server clock only | **Done** (beyond L2) — int/mfa, unit/mfa |
| 6.6.1 | SMS/phone codes only with safeguards | not offered | **Done** (not applicable by design) |

## Sessions (V7) and cookies (V3.3)

| ASVS | Requirement (short) | Implementation | Status / evidence |
|---|---|---|---|
| 7.1.1, 7.1.2 | Timeouts and concurrent-session policy documented | spec §4: 30 min / 12 h / 5 sessions | **Done** |
| 7.2.1–7.2.3 | Server-side verification; reference token ≥ 128 bits | 256-bit token, SHA-256 at rest, checked per request | **Done** — int/auth, int/schema |
| 7.2.4 | New token at login; old one ended | `/api/auth/login` | **Done** — int/auth, mutation |
| 7.3.1, 7.3.2 | Idle and absolute timeouts | `auth/sessions.ts` | **Done** — int/auth, mutation |
| 7.4.1 | Logout invalidates server-side | `/api/auth/logout` | **Done** — int/auth, smoke |
| 7.4.2 | Disabling a user ends all sessions | `admin/users.ts` | **Done** — int/adminApi, mutation |
| 7.4.3 | End other sessions after a credential change | change password, setup completion | **Done** — int/auth, mutation |
| 7.4.4 | Visible logout on every page | user interface | **Planned 1C** |
| 7.4.5 | Administrators end a user's or everyone's sessions | `POST /api/admin/users/:id/end-sessions`; owner CLI `end-all-sessions` | **Done** — int/adminApi, int/ownerCli |
| 7.5.1 | Re-authentication before changing authentication attributes | current password; plus a current code to replace or remove an authenticator or regenerate recovery codes | **Done** — int/auth, int/mfa, mutation |
| 7.5.2 | Users view and end their sessions (after re-authentication) | `/api/me/sessions`, `/api/me/sessions/end-others` | **Done** — int/auth |
| 3.3.1–3.3.4 | `Secure`, `__Host-`, `SameSite`, `HttpOnly` | `http/cookies.ts`; dev-only http exception | **Done** — unit/secretsAndCookies |

## Authorization (V8)

| ASVS | Requirement (short) | Implementation | Status / evidence |
|---|---|---|---|
| 8.1.1, 8.1.2 | Function-, data- and field-level rules documented | spec §2 (catalogue, profiles, rules A1–A6, outcomes, field rules) | **Done** |
| 8.2.1 | Function-level access only with explicit permission | route access declarations; server refuses undeclared routes | **Done** — int/adminApi, unit/app, mutation |
| 8.2.2, 8.4.1 | Data-level access (IDOR/BOLA); cross-tenant (warehouse) control | warehouse permission per URL warehouse; 404 otherwise | **Done for access data and audit** — int/adminApi, mutation. **Assets: Planned 1B-3/1B-4** |
| 8.2.3 | Field-level access (BOPLA) | strict request/response schemas; `is_owner` not writable via API or by `wam_app` | **Done** — int/adminApi (mass assignment), int/schema |
| 8.3.1 | Enforced at a trusted service layer | server only; UI visibility is never a control | **Done** |
| — | Privilege escalation rules A1–A7 (A7: enrol first, then appoint — O-12) | `admin/rules.ts`, services; A7 also in the database (migration 0004) | **Done** — int/adminApi (each rule paired with an owner success), int/mfa (A7: API, sessions, concurrency, database), int/migrations, mutation |
| — | Row-level security as defense in depth | — | **Planned 1B-4** (decision E-12) |

## Request forgery, headers, data protection (V3.4, V3.5, V14)

| ASVS | Requirement (short) | Implementation | Status / evidence |
|---|---|---|---|
| 3.5.1, 3.5.3 | Cross-origin forgery prevented; no state change on GET | `X-WAM-CSRF` + `Origin` + `Sec-Fetch-Site` | **Done** — unit/app, smoke, mutation |
| 3.4.1 | HSTS | sent when the public origin is https | **Done** — unit/app (proxy configuration Phase 1E) |
| 3.4.3, 3.4.6 | CSP; `frame-ancestors` | API responses: `default-src 'none'; frame-ancestors 'none'` | **Done for the API** — unit/app. **UI pages: Planned 1C** |
| 3.4.4, 3.4.5 | `nosniff`; referrer policy | every response | **Done** — unit/app |
| 14.2.1 | No secrets in URLs | tokens only in cookies; codes only in bodies | **Done** (review) |
| 14.3.1 | Clear client data at logout | `Clear-Site-Data` on logout | **Done** — int/auth |
| 14.3.2 | Anti-caching headers | `Cache-Control: no-store` everywhere | **Done** — unit/app |

## Input, business logic, coding (V1, V2, V15)

| ASVS | Requirement (short) | Implementation | Status / evidence |
|---|---|---|---|
| 1.2.4 | Parameterized queries | Kysely query builder and `sql` tags only; no string-built SQL with input | **Done** (review) |
| 2.2.1, 2.2.2 | Server-side positive validation | JSON schemas on every route | **Done** — unit/app |
| 2.3.3 | Transactions: all or nothing | one transaction per change, audit included | **Done** — int/idempotency |
| — | Retried changes never run twice (D-05) | `Idempotency-Key` stored with the change | **Done** — int/idempotency, int/adminApi, mutation |
| 2.4.1 | Anti-automation beyond login | — | **Gap**: no general rate limit yet (a flood of refused requests also writes audit rows). Reverse-proxy limits in Phase 1E; application limits with the asset APIs |
| 15.3.1, 15.3.3 | Only required fields returned; mass assignment blocked | response schemas; unknown body fields rejected | **Done** — int/adminApi |
| 15.3.4 | Real client address through proxies | `trustProxy: false` until a proxy exists | **Planned 1E — deployment blocker**: behind nginx all clients would share one address and the per-address throttle would affect everyone |
| 15.3.6 | Prototype pollution defenses | Fastify rejects `__proto__`/`constructor` keys; Maps/Sets in access code | **Done** (framework default, review) |

## Logging, errors, configuration, cryptography (V16, V13, V11)

| ASVS | Requirement (short) | Implementation | Status / evidence |
|---|---|---|---|
| 16.2.1, 16.2.2 | Who/what/when/where; UTC | `audit_events` (timestamptz), request IDs | **Done** — int/auth, int/adminApi |
| 16.2.5 | Sensitive data never logged | secret-name guard in `audit.ts` (incl. recovery codes, otpauth links); log redaction | **Done** — unit (guard), int/auth and int/mfa (scans), smoke (log scan), mutation |
| 16.3.1, 16.3.2 | Authentication events and authorization failures logged | login/setup/password events, second-step and MFA events, lock, `authz.denied`, `session.ended_mfa_required` | **Done** — int/auth, int/adminApi, int/mfa |
| 16.4.1 | Log injection prevented | JSON logs (pino); parameterized audit inserts | **Done** (review) |
| 16.4.2 | Logs protected from modification | audit append-only by privileges and trigger | **Done** — int/schema, mutation |
| 16.4.3 | Logs shipped to a separate system | — | **Planned 1D/1E** |
| 16.5.1, 16.5.3 | Generic errors; fail closed | `http/errors.ts`; startup gate | **Done** — unit/app, int/safety |
| 11.4.2 | Approved password hashing with current parameters | Argon2id 19 MiB / t=2 / p=1, rehash on login | **Done** — unit/passwords, int/auth |
| 11.1.2 | Cryptographic inventory | spec §3.3 | **Done** (review) |
| 11.2.2 | Crypto agility, key replacement | key fingerprint stored with every sealed secret; Argon2 parameters stored per hash | **Partial** — no re-encryption command for the MFA key yet (L-8, Phase 1E) |
| 11.3.2, 11.3.3 | Approved authenticated encryption | AES-256-GCM, random 96-bit nonce, user id as associated data | **Done** — unit/mfa (tamper, wrong key, moved value), mutation |
| 13.2.3 | No default service credentials | database roles have no passwords until set interactively | **Done** (runbook) |
| 13.3.1, 13.3.2 | Secrets management; least privilege | environment variables (database credentials, `WAM_MFA_ENCRYPTION_KEY`); separate migration and runtime credentials; `wam_app` cannot rewrite a stored authenticator secret | **Partial** — vault/systemd credentials in Phase 1E; int/mfa (grants) |
| 13.4.4, 13.4.5 | No TRACE; no exposed internal endpoints | only declared routes exist (no TRACE route); health reveals nothing | **Done** — health: unit/app; TRACE: review only |

## Operations (V5, V12, V14) — later phases

| ASVS | Requirement | Status |
|---|---|---|
| 5.1.1, 5.2.1–5.2.3, 5.3.2, 5.3.3 | File types, size and unpacked size documented and enforced; archive checks before unpacking; no user-supplied paths | **Evaluated, not in the server yet (1B-3)** — E-18 ceilings approved by the owner (2026-10-28); each exact boundary and the first value above it tested on synthetic files with the pre-check (import-evaluation §3–§4); enforcement in `server/` comes with 1B-3, after O-06 |
| 15.1.1, 15.1.2, 15.2.1 | Remediation time frames; component inventory; components within time frames | **Partial** — server dependencies pinned with a lockfile, `npm audit` 0; time frames proposed (E-18); no SBOM file yet. Selected parser dependencies (O-13) verified against their published artifacts (SHA-512 and contents, `verify_artifacts.py`); `npm audit signatures` not verified in the sandbox. Desktop dependencies outside this scope (T-6, D-15 desktop scope) |
| 15.1.3, 15.2.2, 15.1.4, 15.2.5 | Resource-demanding functionality and risky components documented and contained | **Evaluated, not in the server yet (1B-3)** — ExcelJS selected (O-13) as a risky component, not approved for operational use; confined child process with kernel, heap, watchdog and time limits, no writes, no network, measured memory limits; at most 2 parses at once, 1 until measured on the target host (import-evaluation §3, §5); a worker thread was shown to be insufficient |
| 12.x | TLS 1.2+/1.3, trusted certificates | **Planned 1E** |
| 14.x | Encrypted backups, restore drill | **Planned 1D** (decision O-08) |
| — | Spreadsheet/CSV formula injection on export | **Planned 1C** |
