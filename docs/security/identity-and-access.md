# Identity, access and online-only operation — specification

Status: **authoritative design** for Phase 1B-2 (2026-10-27); **implemented** in commits `b7632d3` and `fd0a5dc`
(server/), verified as recorded in [`../STATUS.md`](../STATUS.md). §3.2 (multi-factor authentication, decision O-07)
was written before its implementation in slice 1B-2c. Code must match this document; a change to either
needs the other updated in the same commit. Requirement IDs refer to **OWASP ASVS 5.0.0** (verified as the latest
stable release from the OWASP/ASVS repository, `v5.0.0` tag; CSV SHA-256 `98c8fe91…df680`).

No real names, credentials or employee data appear in this repository. Examples use placeholders.

## 1. Ownership (decision O-09, settled)

- **The owner** is the single primary owner of the system, with full administrative control through the admin
  panel. Exactly one account is the owner at any time (database-enforced: a partial unique index; the owner
  account can never be disabled: a `CHECK` constraint).
- The owner account is created **only** by the server-side owner CLI (`npm run owner -- bootstrap`), which must run
  with the separately held **migration credentials** (`wam_owner` database role). There is no setup web page and no
  "first visitor becomes administrator" path (ASVS V6.3.2; review F-6).
- The running server's database role (`wam_app`) has **no privilege on the `is_owner` column** (column-level
  grants). A compromised or buggy web server therefore cannot create an owner or move ownership; only the owner
  CLI can (`bootstrap`, `transfer`).
- **Recovery** (`npm run owner -- recover --yes`): issues a one-time setup code for the owner, clears the owner's
  password, ends all owner sessions and clears login throttling for the owner. Requires operating-system access to
  the server plus the migration credentials. **Break-glass procedure:** those two secrets should be held under a
  two-person control (for example, server access with one trusted person, the credential envelope with another).
  This is an operational control, documented for Phase 1E; the identities of the people involved are recorded
  privately, never here.
- **Ownership transfer** (`npm run owner -- transfer --to <username> --yes`): for continuity when the owner role
  changes hands. Audited.
- The owner's own password is changed through the normal change-password function (current password required).

## 2. Authorization model (ASVS V8.1.1, V8.1.2)

### 2.1 Building blocks

| Concept | What it is | Who manages it |
|---|---|---|
| **Permission** | A named action the server checks, e.g. `asset.retire`. Defined in code **and** in the `permissions` table (a migration adds each one). Two scopes: **system** (administration) and **warehouse** (business data of one warehouse). | Developers, via reviewed migrations |
| **Permission profile** | A reusable, named set of permissions of one scope ("Warehouse clerk", "Regional supervisor"). Configurable in the admin panel. | Warehouse profiles: anyone with `profile.manage`. System profiles: **owner only** |
| **Job title** | A descriptive label ("Warehouse keeper"). **Grants nothing by itself** — it never implies access, so no job title can silently give, say, every manager global access. | `job_title.manage` |
| **Warehouse assignment** | (user, warehouse, warehouse profile). Access to a warehouse exists **only** through an explicit assignment; there is no "all warehouses" grant, so a new warehouse is invisible until someone grants it. | `user.manage` (with the rules in 2.3) |
| **System assignment** | (user, system profile). A user with any system profile is an **administrator**. | **Owner only** |

Effective permissions are read from the database on **every request** (never cached in the session), so a change
takes effect immediately. A deactivated profile grants nothing. The owner implicitly holds every permission in
every warehouse.

### 2.2 Permission catalogue (Phase 1B-2)

System scope: `user.view`, `user.manage`, `profile.manage`, `job_title.manage`, `warehouse.manage`, `audit.view_all`.

Warehouse scope: `asset.view`, `asset.create`, `asset.edit`, `asset.change_status`, `asset.transfer`,
`asset.retire`, `asset.approve`, `asset.import`, `asset.export`, `audit.view`.

The `asset.*` permissions are defined now so profiles can be prepared, but they gate nothing until the asset
features exist (Phase 1B-3 onward). Their exact meaning for approvals and transfers is refined with D-06.

### 2.3 Rules that prevent privilege escalation

For every actor **other than the owner**:

| # | Rule | Enforced by |
|---|---|---|
| A1 | Only the owner may create, edit, delete, assign or revoke **system** profiles — that is, appoint or remove administrators. | service layer |
| A2 | Only the owner may manage an **administrator** (edit, disable, reset, end sessions, change access). Administrators cannot act on each other. | service layer |
| A3 | Nobody but the owner may modify the owner account; the owner can never be disabled; ownership changes only via the CLI. | service layer + `CHECK` + column grants |
| A4 | Nobody may change **their own** access, status or setup code (they change their password through the normal function). | service layer |
| A5 | A holder of `profile.manage` may not edit or delete a profile that is assigned to **themselves**. | service layer |
| A6 | Assigning a warehouse profile requires `user.manage`; the profile must be active and of warehouse scope, and the warehouse must exist. | service layer + composite foreign keys |

Residual risk, accepted and visible: two non-owner administrators could grant each other warehouse access. Every
grant is audited with before/after values; the owner can restrict `user.manage` to themselves.

### 2.4 Outcomes

| Situation | HTTP | Code |
|---|---|---|
| No valid session on a protected route | 401 | `UNAUTHENTICATED` |
| Missing system permission, or rule A1–A5 | 403 | `FORBIDDEN` |
| Missing warehouse permission for the warehouse in the URL — **including warehouses that do not exist** | 404 | `NOT_FOUND` (existence is never revealed) |
| Edit based on an outdated version | 409 | `VERSION_CONFLICT` |

Every denial is written to the audit trail (`authz.denied`, ASVS V16.3.2).

### 2.5 Field-level rules (ASVS V8.2.3, V15.3.3)

Request bodies are validated against schemas that list exactly the writable fields and reject anything else
(`additionalProperties: false`, unknown fields are **rejected**, not silently dropped). Responses declare schemas
so only listed fields are serialized: password hashes, setup-code hashes and session tokens never appear in any
response. `is_owner` is not writable through the API at all.

### 2.6 Every route declares its access

Each route must declare `public`, `authenticated`, a system permission, `owner`, or a warehouse permission. A route
registered without a declaration **stops the server from starting** (fail closed).

## 3. Authentication (ASVS V6)

| Topic | Rule |
|---|---|
| Pathways (V6.1.3, V6.3.4) | Exactly two ways to obtain a session: username + password, followed — whenever §3.2 applies — by a **second factor** (an authenticator-app code or a recovery code). A one-time **setup code** + new password (initial activation and resets) only sets a password; it never creates a session and never bypasses the second factor (V6.4.3). |
| Usernames | 3–64 characters, lower-case `a-z 0-9 . _ -`, unique. Persian full names go in the display name. Reserved: `admin`, `administrator`, `root`, `sa`, `system`, `superuser`, `owner`, `test`, `guest`, `wam` (V6.3.2). |
| Password length | **15–128 characters** (V6.2.1 recommends ≥ 15; NIST SP 800-63B requires 15 when the password is the only factor). Any characters allowed, no composition rules (V6.2.5), checked exactly as typed (V6.2.8), no forced periodic change (V6.2.10). |
| Common passwords (V6.2.4) | Rejected (case-insensitive) if on the bundled list: **11,146** passwords of 15–128 characters from two frequency-ordered public lists (`server/data/README.md`). Works offline. |
| Context words (V6.1.2, V6.2.11) | Rejected if the password contains the username or any of: `warehouse`, `asset`, `anbar`, `farabar`, `zarin`, `sanat`, `password`, `admin`, `owner` (case-insensitive). |
| Breached passwords (V6.2.12) | **Not implemented**: online breach services cannot be relied on from the deployment network. Partially covered by the common-password list. Documented gap. |
| Storage (V11.4.2) | Argon2id, memory 19 MiB, 2 passes, parallelism 1, 16-byte random salt (OWASP Password Storage Cheat Sheet minimum), via Node's built-in `crypto.argon2`. Parameters are stored with each hash so they can be raised later; hashes with old parameters are upgraded at the next successful login. |
| Unknown users | A login for an unknown, disabled or not-yet-activated account does the same Argon2id work and returns the same `INVALID_CREDENTIALS`, so responses do not reveal which usernames exist. |
| Setup codes (V6.4.1) | 160-bit random (32 base32 characters), shown once, stored only as SHA-256, valid **24 hours**, single use, replaced when a new one is issued. Issuing one **clears the password and ends all sessions** (a reset is a reset); it does **not** remove the second factor. They never become the long-term password: the user chooses their own. |
| Password change (V6.2.2, V6.2.3) | Requires the current password; ends all other sessions of that user. |
| No hints or secret questions (V6.4.2) | None exist. |

### 3.1 Throttling and lockout (ASVS V6.1.1, V6.3.1)

Failed logins are recorded per username and source address. A login is refused with `429 TOO_MANY_REQUESTS`, without
checking the password, when in the last **15 minutes** there were:

- 5 failures for this username from this address, or
- 20 failures for this username from any address, or
- 50 failures from this address for any usernames.

Failed setup-code attempts: 20 per address per 15 minutes. The windows slide; nothing needs to be unlocked by hand.
**Malicious lockout:** an attacker can delay one account for up to 15 minutes at a time, but cannot lock it
permanently, and the per-address limit stops one address from blocking many accounts. If the **owner** is targeted,
`npm run owner -- recover` clears the owner's counters. The source address is the TCP peer until a reverse proxy is
configured (Phase 1E; ASVS V15.3.4).

### 3.2 Multi-factor authentication (decision O-07; ASVS V6.3.3, V6.4, V6.5)

Written before the implementation (slice 1B-2c), as the owner required; the code must match it.

#### 3.2.1 Who must use it

| Account | Second factor |
|---|---|
| The owner | **Always required.** |
| Administrators (anyone holding an active system profile) | **Always required.** |
| Anyone who has enrolled an authenticator | Always used at sign-in — enrolling cannot be bypassed later. |
| All other users | Required when the **security policy** says `all_users`; otherwise optional (self-service enrolment). |

The policy is a single setting, changed by the **owner only** in the admin panel and audited. It has exactly two
values: `privileged` (the default and the **minimum**) and `all_users`. There is no value that makes the second factor
optional for the owner or administrators; the database refuses any other value (`CHECK`), and a missing policy row is
treated as `all_users` (fail closed).

**Enforced on every request, not only at sign-in.** Each session records whether it was established with a second
factor. If an account that now requires one (for example, a user who was just appointed administrator, or everybody
after the policy changed to `all_users`) uses a session that was not, that session is ended at once, the event is
audited, and the response is `401 MFA_REQUIRED`: the user signs in again and completes the second step. Administrator
rights are therefore never usable from a password-only session.

#### 3.2.2 The factor: authenticator-app codes (TOTP)

| Topic | Rule |
|---|---|
| Method | Time-based one-time passwords, RFC 6238: any standard authenticator app on a phone (no network needed on the phone). **No SMS and no e-mail codes** (V6.6.1, V6.3.6): no telephone or mail dependency, which also suits sites with unreliable connectivity. |
| Parameters (E-13) | HMAC-SHA-1, 6 digits, 30-second steps — the combination every authenticator app supports. HMAC-SHA-1 with a 160-bit key remains a sound keyed hash; SHA-1 collisions do not affect HMAC. |
| Secret (V6.5.3) | 160 bits from the operating system's CSPRNG (`crypto.randomBytes`), shown once during setup as a QR-code link (`otpauth://`) and as text for manual entry. |
| Time source (V6.5.8) | The server's clock only (kept by NTP on the server); a client-supplied time is never used. |
| Tolerance (V6.5.5) | The current 30-second step plus **one step before and one after**, to absorb small clock differences between phone and server. Taken literally, V6.5.5 allows no tolerance; this is a recorded deviation (E-13), bounded by single use and the failure lock below. |
| Single use (V6.5.1) | The server stores the last step accepted per user and accepts only later steps, inside a row lock: the same code can never be used twice, not even by two simultaneous requests. |
| Storage (V11.3.2, V11.3.3, V13.3.1) | The secret is encrypted with **AES-256-GCM** (authenticated encryption) under a key that is **not in the database**: `WAM_MFA_ENCRYPTION_KEY` (32 random bytes, base64) in the server's environment. The user id is bound in as associated data, so an encrypted secret copied onto another account fails to decrypt. A key fingerprint is stored with each secret, so a wrong key is reported as a server configuration error, never counted against the user. A stolen database backup alone yields no usable secret. The server refuses to start without a valid key. |

#### 3.2.3 Recovery codes (lookup secrets)

10 codes are issued when an authenticator is enrolled (and when the user regenerates them): each 120 bits
(24 base32 characters, shown in groups of four), **shown once**, stored only as SHA-256 (V6.5.2 allows a standard hash
at ≥ 112 bits; V6.5.4), **single use** (marked used atomically). A recovery code replaces the authenticator code at
sign-in when the phone is unavailable. Regenerating invalidates all earlier codes. The user is told how many remain
after each use. Users should keep them somewhere safe away from the phone, such as a password manager or a sealed
envelope; this is personal safekeeping, not a business workflow (D-05).

#### 3.2.4 Sign-in, enrolment and changes

**Sign-in.** A correct password for an account that needs a second factor does **not** create a session. The server
answers `202` with `next: "mfa_verify"` (enrolled) or `next: "mfa_enroll"` (required but not yet enrolled), and sets a
short-lived second-step cookie (`__Host-wam_mfa`, `HttpOnly; Secure; SameSite=Strict`, a random 256-bit reference
stored as SHA-256, valid **5 minutes** for verification and **10 minutes** for enrolment, E-17, one at a time per
user). Only then:

- `POST /api/auth/mfa/verify` with an authenticator code or a recovery code creates the session;
- `POST /api/auth/mfa/enroll/start` and `…/enroll/confirm` let a user who must enrol do so before the first session:
  the secret is held as a pending enrolment for 10 minutes and becomes active only when a code from the app proves the
  app was set up correctly. The confirmation returns the recovery codes and creates the session.

A password-only session is never created for an account that needs a second factor. Accounts that need none sign in
as before (`200`).

**Self-service** (signed-in user; ASVS V7.5.1, full re-authentication before changing MFA settings):

| Action | Requires |
|---|---|
| Enrol an authenticator (when none is enrolled) | current password |
| Replace the authenticator (new phone) | current password **and** a current code (authenticator or recovery code) |
| Regenerate recovery codes | current password and a current code |
| Remove MFA | current password and a current code; **refused** while the account requires MFA (§3.2.1) |

Enrolling, replacing or removing ends the user's **other** sessions (a credential change, V7.4.3).

**Administrator reset** (`POST /api/admin/users/:id/reset-mfa`, `user.manage`, rules A2–A4: nobody resets their own,
only the owner resets an administrator, nobody resets the owner): removes the authenticator and recovery codes **and at
the same time** clears the password, ends all sessions and issues a new setup code. The person proves their identity
to the administrator the same way as at account creation — in person or by a telephone call to a known number — and
receives the setup code that way (V6.4.4). Someone who knows only the old password therefore cannot enrol their own
authenticator after a reset.

**Password reset** (setup code, §3) keeps the authenticator: after setting the new password the user still needs the
second factor (V6.4.3).

#### 3.2.5 Account-lockout safeguards

| Risk | Safeguard |
|---|---|
| Guessing authenticator codes | Only reachable after the correct password. **10 consecutive wrong codes** (authenticator or recovery, at sign-in or in self-service re-authentication) lock second-factor sign-in for the account (E-14); a correct code resets the count. The chance of guessing within 10 tries is about 3 in 100,000. The lock is audited (`auth.mfa.locked`). |
| Malicious lockout of a user | The lock can only be triggered by someone who **already knows the password** — that is, when the password is compromised and must be reset anyway. Password-step throttling keeps its sliding 15-minute windows (§3.1); nothing there locks permanently. |
| Unlocking | A **password reset** clears the lock: an administrator issues a setup code (or performs an MFA reset); for the owner, `npm run owner -- recover`. The attacker loses the password at the same time. |
| User lost the phone | Sign in with a recovery code, then replace the authenticator. Without recovery codes: administrator reset (§3.2.4). |
| Administrator locked out | The owner resets them in the admin panel. Administrators cannot reset each other (A2). |
| **Owner locked out** | The owner can never be locked out of the system as a whole: `npm run owner -- recover --yes` (new password, lock cleared, authenticator kept) or `npm run owner -- recover --reset-mfa --yes` (also removes the authenticator; the owner enrols again at the next sign-in, after setting the new password with the setup code). Both need operating-system access to the server **and** the migration credentials — the two-person break-glass control of §1 — and both are audited. |
| Encryption key lost or wrong | Authenticator codes cannot be checked; the server logs a configuration error and refuses second-factor sign-in rather than skipping it. Recovery: restore the key from its backup. If it is truly lost, every enrolled user must be reset (owner by CLI with `--reset-mfa`, then the owner resets the others). **The key must be backed up, separately from the database backups** (Phase 1D). |
| Server clock wrong | Codes fail for everyone. The server must keep time by NTP (Phase 1E deployment checklist); the ±1-step tolerance absorbs small drift. |
| Half-finished enrolment | A pending enrolment expires after 10 minutes and changes nothing until confirmed with a valid code; an abandoned one leaves the account as it was. |

#### 3.2.6 Residual risks (accepted, visible)

- **First enrolment trusts the password.** Someone who knows a user's password before that user enrols could enrol
  their own authenticator. Safeguards: the owner enrols in the same sitting as the bootstrap; resets always include a
  new password via a setup code; every enrolment is audited and the user list shows who has enrolled. Recommended
  practice: appoint administrators only after they have enrolled.
- Real-time phishing (a fake page relaying codes) is not stopped by TOTP; phishing-resistant authenticators
  (FIDO2/passkeys) are an ASVS Level 3 measure and a possible later addition.
- No automatic notification of suspicious sign-ins (V6.3.5, Level 3); the audit trail records them.

### 3.3 Cryptographic inventory (ASVS V11.1.2)

| Purpose | Algorithm | Key / secret | Where |
|---|---|---|---|
| Password storage | Argon2id (19 MiB, t = 2, p = 1), 16-byte salt | — | `auth/passwords.ts` |
| Session tokens, second-step tokens, setup codes, recovery codes at rest | SHA-256 of ≥ 120-bit random values | — | `auth/secrets.ts` |
| Authenticator codes | HMAC-SHA-1 (RFC 6238) | 160-bit per-user secret | `auth/totp.ts` |
| Authenticator secrets at rest | AES-256-GCM, 96-bit random nonce, user id as associated data | `WAM_MFA_ENCRYPTION_KEY` (environment; vault in Phase 1E) | `auth/secretBox.ts` |
| All random values | Node `crypto.randomBytes` (operating-system CSPRNG) | — | — |
| Transport | TLS 1.2+ at the reverse proxy | certificate | Phase 1E |

Key rotation for `WAM_MFA_ENCRYPTION_KEY` (V11.2.2) is not implemented yet: the stored key fingerprint makes it
possible, and a re-encryption command is planned with the deployment work (Phase 1E; limitation L-8).

## 4. Sessions (ASVS V7)

| Topic | Rule |
|---|---|
| Token (V7.2.1–7.2.3) | 256-bit random reference token; only its SHA-256 is stored; verified by the server on every request. |
| Cookie (V3.3.1–3.3.4) | `__Host-wam_session`; `HttpOnly; Secure; SameSite=Strict; Path=/`; no `Domain`; a browser-session cookie. **Development exception:** over plain `http://` (allowed only when `WAM_ENV` is `development` or `test`) the name is `wam_session` without `Secure`, because browsers reject both otherwise. Production requires an `https://` origin. |
| Lifetime (V7.1.1, V7.3.1, V7.3.2) | Idle timeout **30 minutes**, absolute lifetime **12 hours** (one working day), configurable within 5–240 minutes and 1–24 hours. These equal the AAL2 re-authentication limits of NIST SP 800-63B revision 3 (12 hours; 30 minutes of inactivity) as I recall them; the text of the current revision was not re-read in this session. |
| Concurrent sessions (V7.1.2) | At most **5** per user; a new login ends the oldest. |
| New login (V7.2.4) | Always a new token; a session cookie sent with the login request is ended first. |
| Assurance | Each session records whether a second factor was used. A session that lacks one for an account that requires it (§3.2.1) is ended at its next request (`401 MFA_REQUIRED`). |
| Termination (V7.4.1–7.4.3, V7.4.5, V7.5.2) | Logout ends the session server-side. Disabling a user, issuing a setup code and completing a setup end **all** of that user's sessions; a password change ends all **other** sessions. Administrators can end a user's sessions (rule A2 applies); the owner CLI can end everyone's. Users can list their sessions and end the others after re-entering their password. |

## 5. Request forgery protection (ASVS V3.5.1, V3.5.3)

Every request that is not `GET`/`HEAD`/`OPTIONS` — including login — must:

1. carry the header `X-WAM-CSRF: 1` (not a CORS-safelisted header, so a cross-site page cannot send it without a
   preflight the server never approves — no CORS is configured);
2. carry an `Origin` header equal to `WAM_PUBLIC_ORIGIN`;
3. if a `Sec-Fetch-Site` header is present, have the value `same-origin`.

Otherwise: `403 FORBIDDEN`, audited. State never changes on `GET`. `SameSite=Strict` is a further layer.

Every response also carries `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy:
no-referrer` and, for the JSON API, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`; over
https also `Strict-Transport-Security`. Logout adds `Clear-Site-Data`.

## 6. Online-only operation (decision D-05, settled)

The web application works **online only**. All authoritative reads and writes go through the central server and
database.

**Out of scope, permanently for this design:** offline mode, offline write queues, deferred or automatic
synchronization, conflict resolution for offline edits, service workers or browser storage for business data,
silent acceptance of changes while disconnected, and paper-based workflows as a product feature.

Online-only removes synchronization complexity; it does **not** remove the need for server availability, database
resilience, monitoring, backups and tested recovery (Phase 1D). An outage stops work in the system; the recovery
objectives (decision O-08) define how long that may last.

### 6.1 Server contract (implemented from Phase 1B-2)

| Guarantee | How |
|---|---|
| A change is either saved completely or not at all | One database transaction per operation, including its audit record (ASVS V2.3.3) |
| A retried change never runs twice | Every state-changing admin request carries an `Idempotency-Key` (UUID) header. The key, a fingerprint of the request and the result are stored **in the same transaction** as the change. A retry with the same key returns the original result (`Idempotency-Replayed: true`); the same key with a different request returns `422 IDEMPOTENCY_KEY_REUSED`; concurrent duplicates wait for the first and then replay it. If the change fails, nothing is stored, so a retry runs it once. Keys are kept 24 hours, per user. Exceptions, both safe to repeat by nature: issuing a setup code (its response is a secret and is never stored; each issue replaces the previous code) and ending a user's sessions. |
| Two people cannot silently overwrite each other | Editable records carry a `version`; an edit must name the version it was based on, otherwise `409 VERSION_CONFLICT` |
| Duplicates are impossible at the data level | Database unique constraints (usernames, warehouse codes, profile and job-title names) |
| Clear outcome | Every response is either a success body or the standard error body; a client that receives neither must treat the change as **not confirmed** |

### 6.2 User-interface requirements (Phase 1C; recorded now)

Show connection and operation status. When a save is not confirmed (network error, timeout, 5xx), say clearly
that it was **not confirmed as saved**; keep the unsaved input in the current page so the user can retry, never
present it as saved, and never persist it to browser storage. Do **not** replay unconfirmed changes automatically on
reconnection; a retry is an explicit user action that reuses the same `Idempotency-Key`, so it cannot duplicate the
change if the first attempt did reach the server.

## 7. Audit trail (ASVS V16)

Append-only table `audit_events`: the server's role may only `INSERT` and `SELECT`; a trigger rejects `UPDATE`,
`DELETE` and `TRUNCATE` for every role. Each event records time (UTC), actor (id and username snapshot), action,
outcome (`success`/`denied`/`failure`), target, warehouse (when relevant), request ID, source address and details
(before/after values for changes). **Never recorded:** passwords, setup codes, session tokens or their hashes.

Events in Phase 1B-2: login succeeded/failed/throttled, logout, password changed, setup completed/failed, sessions
ended, user created/updated/disabled/enabled, setup code issued, access changed (one event per affected warehouse,
plus one for system profiles), profile created/updated/deleted, job title created/updated, warehouse
created/updated, owner bootstrapped/recovered/transferred, all sessions ended, authorization denied, request-forgery
check failed. From 1B-2c: password accepted and second step requested, second factor failed, second factor locked,
authenticator enrolled/replaced/removed, recovery codes regenerated, MFA reset by an administrator, session ended
because MFA became required, security policy changed. **Never recorded:** authenticator secrets or codes, recovery
codes.

Who can read it: `audit.view_all` sees everything; `audit.view` in a warehouse sees that warehouse's events only.
Shipping the audit trail to a separate system (V16.4.3) is a Phase 1D/1E task.

## 8. Known limitations and deployment blockers (2026-10-27)

| # | Limitation | Consequence | Resolution |
|---|---|---|---|
| L-1 | **MFA is mandatory only for the owner and administrators by default** (ASVS V6.3.3, Level 2, expects it for every user) | Ordinary users sign in with a password alone while the policy is `privileged` | The owner switches the policy to `all_users` (decision O-11). **Do not expose the server beyond a trusted network before that.** |
| L-2 | **`trustProxy` is off** | Behind a reverse proxy every client would appear as the proxy's address: the per-address throttle would then affect all users together | Configure the proxy's address before deployment (Phase 1E). **Deployment blocker.** |
| L-3 | No breached-password check (V6.2.12) | Only the bundled common-password list protects | Accepted for now: online breach services are unreliable from the deployment network |
| L-4 | No general rate limit (V2.4.1) | A flood of refused requests also fills the audit trail | Proxy rate limits (1E); application limits with the asset APIs |
| L-5 | The setup-code endpoint answers an unknown username slightly faster than a known one | Username probing, limited to 20 attempts per address per 15 minutes | Accepted (V6.3.8 is Level 3); MFA protects accounts even if a username is learned |
| L-6 | Two non-owner administrators could grant each other warehouse access | Collusion, visible in the audit trail | Accepted (§2.3); the owner can keep `user.manage` to themselves |
| L-7 | Audit trail kept only in the application database (V16.4.3) | A database-level compromise could alter history | Ship to a separate store in Phase 1D/1E |
| L-8 | No rotation command for `WAM_MFA_ENCRYPTION_KEY` (V11.2.2) | Changing the key requires resetting every enrolled user | Re-encryption command in Phase 1E; the key fingerprint stored with each secret already allows it |
| L-9 | TOTP is not phishing-resistant | A real-time relay page could capture a code | Accepted for Level 2; FIDO2/passkeys are a possible later addition (§3.2.6) |
