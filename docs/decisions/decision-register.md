# Decision register (living document)

Last updated: 2026-10-27 (third session). **This file is the single place for the current status of every
decision.** Detailed analysis stays where it was written; this register links to it instead of copying it:

- D-01…D-09, T-1…T-7: [`phase-1b-readiness-decision-sheet.md`](phase-1b-readiness-decision-sheet.md) (2026-10-26 analysis; its D-05 text is superseded below)
- P-1…P-3 (approved): [`phase-1a-owner-decisions.md`](phase-1a-owner-decisions.md)
- F-1…F-12, E-01…E-07: [`../architecture/web-architecture-and-security-review.md`](../architecture/web-architecture-and-security-review.md)
- Identity, authorization and online-only rules: [`../security/identity-and-access.md`](../security/identity-and-access.md)

New owner decisions use the prefix **O-** so they cannot collide with the Phase 0 register's D-numbers.

## 1. Settled by the owner

| ID | Decision | Recorded | Consequence |
|---|---|---|---|
| **D-05** | **Online-only web application.** All authoritative reads and writes go through the central server and database. No offline mode, offline write queues, deferred or automatic synchronization, offline conflict resolution, service workers or browser storage for business operations, and no paper-based workflow as a product feature. Changes are never silently accepted while disconnected; an unconfirmed save is shown as not saved, input may be kept in the page for an explicit retry, and nothing is replayed automatically on reconnection. Retried changes must not execute twice. | 2026-10-27 | Supersedes the earlier "paper fallback" recommendation. Server contract and UI requirements: identity-and-access §6. Online-only does not remove the need for availability, backups and tested recovery (O-08). |
| **O-09** | **Owner-controlled administration.** The owner is the primary owner with full control through the admin panel: user accounts, job titles, reusable permission profiles, warehouse scope, granular asset permissions, other administrators (with ownership safeguards), audit review. Job titles and permissions are configured in the application, never hard-coded per employee; no assumption that managers have global access. The owner account is protected against takeover and lockout; no public first-user setup, no hard-coded owner credentials, ownership not decided by a client-side field. No personal names or credentials in the repository. | 2026-10-27 | Model and safeguards: identity-and-access §1–§2. |
| **D-01** | Owner bootstrap and recovery — **settled at design level by O-09**: owner created and recovered only by the server-side owner CLI using the separately held migration credentials; break-glass is an operational two-person control over those credentials (identity-and-access §1). The identities of the owner and any custodians stay in a private record, never in this repository. | 2026-10-27 | No longer blocks 1B-2. |
| **O-01** | Push of the Phase 1B-1 work | 2026-10-27 | Pushed: `ccr-1860034b-yp0csr` = `eeb25fe` on GitHub (verified). |
| **O-05** | Proceed with Phase 1B-2 (identity, permissions, warehouses, sessions, audit) | 2026-10-27 | Authorized by the owner's continuation instructions, within their safety rules (no push, merge or tag without separate approval). **Delivered:** 1B-2a (`b7632d3`), 1B-2b (`fd0a5dc`), 1B-2c MFA (`742d273`, local). |
| **O-10** | Push of this session's commits to the session branch | 2026-10-27 | Conditional approval, conditions checked before pushing: exactly the five commits `28c9fcd`, `b7632d3`, `fd0a5dc`, `fc53b1a`, `1463f63`; remote head `eeb25fe` an ancestor (fast-forward, nothing on GitHub overwritten); only `server/` and `docs/` changed; normal push, no force. **Pushed and verified:** GitHub branch `ccr-1860034b-yp0csr` = `1463f63`; `main` and `phase-1a/repo-safety-net` unchanged. The bundle backup is kept. Further pushes need a new approval. |
| **O-07** | **Multi-factor authentication:** required for the owner and every administrator, never optional for privileged accounts. The design must also let all staff be required to use it through a configurable security policy. Recovery and account-lockout safeguards are documented before implementation. | 2026-10-27 | Design: identity-and-access §3.2 (written before the code, `0c65acf`). **Implemented and verified:** `742d273` (local; results in [`../STATUS.md`](../STATUS.md)). Policy values are `privileged` (the minimum, enforced by the database) and `all_users`; see O-11 for when to switch. |
| **O-02** | Baseline tag publication stays a **separate task you run locally**. I perform no tag operation, local or remote, without your explicit approval. | 2026-10-27 | Still pending on your side: commands in [`../STATUS.md`](../STATUS.md#owner-actions). |
| **O-03 (interim rule)** | Until the desktop import defect is fixed **and verified**, users choose **Skip**, never **Update**, for duplicate records. | 2026-10-27 | Applies to staff now. The fix itself is still awaiting approval (section 2). |
| P-1…P-3 | Base-data deletion contract | 2026-10-26 | Unchanged |

## 2. Needed from you

| ID | Decision | Recommended default | Blocks |
|---|---|---|---|
| **O-03** | Fix the desktop import data-loss defect (review F-3) as a separate desktop task. Interim rule settled above (Skip, never Update). | Approve | Desktop data integrity now |
| **O-04** | Update the desktop app's Electron 43.2.0 → latest 43.x (≥ 43.8.1), verified on Windows (review F-4). | Approve, together with developer-tool updates (T-6) | Desktop security now |
| **O-06** | Read-only data-quality report on a **copy** of the real desktop database on your PC. | Approve | 1B-3 schema design |
| D-02 | Official warehouse list (names, codes) and its maintainer — supplied privately, never committed. | You supply it; a system warehouse `UNASSIGNED` exists from 1B-2 | Production data, pilot |
| D-03 | Source of truth and reviewer for asset → warehouse mapping | Everything starts `UNASSIGNED`; audited bulk assignment; never inferred | 1B-3 real data, pilot |
| D-06 | Which actions need approval (registration, retirement, transfer) | Registration approved by a same-warehouse holder of `asset.approve` (never self); retirement and transfer likewise, with a reason | 1B-5 |
| D-08 | Local PostgreSQL on your PC (WSL2) — for running the tests yourself and for the real-data rehearsal | WSL2 with Debian or Ubuntu; read-only checks in sheet T-5 first | Your own verification; 1B-3 rehearsal |
| D-15 | Spreadsheet parsing on the server (review F-5) | Never `xlsx@0.18.5` on the server; ExcelJS for `.xlsx` or CSV | 1B-3 import |
| T-2 | Server Node line 24 (maintenance, EOL 2028-04-30) or 26 (LTS from 2026-10-28, EOL 2029-04-30) | 24 now; re-test on 26 and decide before the pilot | Pilot |

## 3. Engineering defaults (you may override; each is an ASVS-based choice)

| ID | Default | Basis |
|---|---|---|
| E-08 | Minimum password length 15, maximum 128 | ASVS V6.2.1 ("15 strongly recommended"), V6.2.9 |
| E-09 | Sessions: 30 min idle, 12 h absolute, max 5 per user | ASVS V7.1.1, V7.1.2, V7.3 |
| E-10 | Throttling thresholds (5 / 20 / 50 failures per 15 min) | ASVS V6.1.1, V6.3.1; identity-and-access §3.1 |
| E-11 | Usernames lower-case ASCII; Persian names in the display name | Avoids look-alike Unicode usernames |
| E-12 | Row-level security not used in 1B-2; decided with the asset tables in 1B-4 | Application authorization is the primary control; RLS is defense in depth where warehouse data lives |
| E-13 | TOTP per RFC 6238: HMAC-SHA-1, 6 digits, 30-second steps (the parameters every authenticator app supports); the server also accepts the step before and after its own to absorb clock differences, each code at most once | ASVS V6.5.1, V6.5.5, V6.5.8. Accepting the neighbouring steps is a **recorded deviation** from the literal 30-second maximum of V6.5.5; identity-and-access §3.2.2 |
| E-14 | 10 consecutive wrong second-factor codes lock second-factor sign-in for that account until a password reset | Only someone who already knows the password can reach this step, so the lock cannot be used against an unaffected user (ASVS V6.1.1, V6.3.1); §3.2.5 |
| E-15 | 10 recovery codes per user, 120 bits each, shown once, stored as SHA-256 | ASVS V6.5.2 (≥ 112 bits allows a standard hash), V6.5.4 |
| E-16 | Authenticator secrets encrypted at rest with AES-256-GCM under a key held outside the database (`WAM_MFA_ENCRYPTION_KEY`) | ASVS V11.3.2, V11.3.3, V13.3.1; a stolen database backup alone yields no usable secret |
| E-17 | Second-step lifetimes: 5 minutes to enter a code after the password, 10 minutes to finish setting up an authenticator | Bounded half-finished sign-ins |

## 4. Can wait until pilot or deployment

| ID | Decision | Recommended default |
|---|---|---|
| **O-11** | When to set the MFA policy to **all staff** | Before any exposure beyond the trusted network (ASVS V6.3.3 Level 2 expects every user to have MFA); the owner switches it in the admin panel |
| D-04 | Concurrent users and sites with unreliable internet | Size and load-test for 100 concurrent sessions; please confirm the real number |
| D-07 | Trial VPS | **Not authorized** |
| D-09 | Domain and DNS ownership | Tell me what exists; nothing to buy now |
| O-08 | Recovery objectives (RPO / RTO) | Proposal in Phase 1D, e.g. RPO 24 h / RTO 4 h. Under D-05 these define how long work stops during an outage. |
| T-1 | Root `.nvmrc` 22 → 24 | Low priority |
| T-6 | Root developer-tool advisories | Bundle with O-04 |

## 5. Unknown — please clarify

The readiness sheet refers to Phase 0 register items **D-10, D-11, D-12, D-13, D-14, D-24, D-25** (and D-15) by
number only; their text is not in this repository, so I have not guessed their content. Please provide the
Phase 0 decision register, or tell me they are superseded by this file.

## 6. Engineering decisions (reversible)

E-01…E-07: review §3. E-08…E-17: section 3 above.
