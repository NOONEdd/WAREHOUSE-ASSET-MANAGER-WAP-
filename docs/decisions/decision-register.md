# Decision register (living document)

Last updated: 2026-10-27 (second session). **This file is the single place for the current status of every
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
| **O-05** | Proceed with Phase 1B-2 (identity, permissions, warehouses, sessions, audit) | 2026-10-27 | Authorized by the owner's continuation instructions, within their safety rules (no push, merge or tag without separate approval). |
| P-1…P-3 | Base-data deletion contract | 2026-10-26 | Unchanged |

## 2. Needed from you

| ID | Decision | Recommended default | Blocks |
|---|---|---|---|
| **O-07** | **Multi-factor authentication.** ASVS 5.0.0 Level 2 requires it (V6.3.3) unless a documented rationale with compensating controls is accepted. | Mandatory authenticator-app codes (TOTP) for the owner and every administrator; strongly recommended — and before any internet exposure required — for all users. Please confirm whether all staff must use it. | Slice 1B-2c; any network exposure |
| **O-02** | Publish the tag `desktop-baseline-efbd65a` (this session cannot push tags). | You run the commands in [`../STATUS.md`](../STATUS.md#owner-actions); also protect `main` in GitHub settings. | Nothing technical; baseline protection |
| **O-03** | Fix the desktop import data-loss defect (review F-3) as a separate desktop task. **Until then staff should choose "skip", never "update", for duplicates.** | Approve | Desktop data integrity now |
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

## 4. Can wait until pilot or deployment

| ID | Decision | Recommended default |
|---|---|---|
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

E-01…E-07: review §3. E-08…E-12: section 3 above.
