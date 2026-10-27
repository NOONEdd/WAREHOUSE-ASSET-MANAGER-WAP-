# Decision register (living document)

Last updated: 2026-10-27. **This file is the single place for the current status of every open decision.**
Detailed analysis stays where it was written — this register links to it instead of copying it:

- D-01…D-09, T-1…T-7: [`phase-1b-readiness-decision-sheet.md`](phase-1b-readiness-decision-sheet.md) (2026-10-26 analysis)
- P-1…P-3 (approved): [`phase-1a-owner-decisions.md`](phase-1a-owner-decisions.md)
- F-1…F-12, E-01…E-07: [`../architecture/web-architecture-and-security-review.md`](../architecture/web-architecture-and-security-review.md)

New owner decisions use the prefix **O-** so they cannot collide with the Phase 0 register's D-numbers.

## 1. Needed from you now (they block the next step)

| ID | Decision | Recommended default | Why it matters now |
|---|---|---|---|
| **O-01** | Authorize pushing this session's work: branch `ccr-1860034b-yp0csr` with the Phase 1B-1 server foundation and these documents (2 commits, not yet on GitHub). | Authorize. | It exists only in a temporary cloud container that is deleted when idle. A Git bundle has been sent to you as a backup. |
| **O-02** | Publish the tag `desktop-baseline-efbd65a` (this session's GitHub permission refused tag pushes). | You run the two commands in [`../STATUS.md`](../STATUS.md#owner-actions); also protect `main` in GitHub settings. | Until then, the baseline is protected only by `main` not moving. |
| **O-05** | Authorize Phase 1B-2 (users, roles, warehouses, sessions, audit) — needs D-01 and D-05 answered. D-02 can be answered later: 1B-2 can be built and tested with made-up warehouse names. | Authorize after answering D-01 and D-05. | It is the next slice on the critical path. |
| D-01 | Owner and two break-glass custodians — **names in a private note, never in this repository**. | Owner created only by a server CLI; recovery needs both custodians. | Blocks the bootstrap CLI in 1B-2. |
| D-05 | Online-only release 1 with a paper fallback, and an operation ID on every write request so retries cannot duplicate records. | Yes to both. | Shapes the API conventions of the first 1B-2 endpoints. |

## 2. Needed soon (they block a later slice)

| ID | Decision | Recommended default | Blocks |
|---|---|---|---|
| **O-03** | Fix the desktop import data-loss defect (F-3) as a separate, approved desktop task. **Until then, staff should choose "skip", never "update", for duplicates.** | Approve; regression tests first, then the fix. | Desktop data integrity now |
| **O-04** | Update the desktop app's Electron 43.2.0 → latest 43.x (≥ 43.8.1) as a separate desktop task, verified on Windows (F-4). | Approve, together with the Vite/Vitest developer-tool updates (T-6). | Desktop security now |
| **O-06** | Run a read-only data-quality report on a **copy** of the real desktop database on your PC (placeholder serials, missing fields, `integrity_check`). I will provide the script; nothing leaves your PC. | Approve. | 1B-3 schema design |
| D-02 | Official warehouse list (names, codes) and its maintainer — supplied privately, never committed. | You supply it, plus a system warehouse `UNASSIGNED`. | 1B-2 production seed; pilot |
| D-03 | Source of truth and reviewer for asset → warehouse mapping. | Everything starts `UNASSIGNED`; audited bulk assignment from a reviewed workbook; never inferred. | 1B-3 real data, pilot |
| D-06 | Which actions need approval (registration, retirement, transfer). | Registration approved by a same-warehouse manager (never self); retirement and transfer by Manager+ with a reason. | 1B-5 |
| D-08 | Local PostgreSQL on your PC. **1B-1 no longer waits for this** (it was built and tested in the cloud sandbox), but you need it to run the tests yourself and for the real-data rehearsal. | WSL2 with Debian or Ubuntu; run the read-only checks in sheet T-5 first. | Your own verification; 1B-3 rehearsal |
| D-15 | Spreadsheet parsing on the server (F-5). Phase 0 register item; its text is not in this repository. | Server never uses `xlsx@0.18.5`; read `.xlsx` with ExcelJS (already a desktop dependency) or accept CSV; `.xls` files converted by the user. | 1B-3 import |
| O-07 | MFA for Administrator accounts in release 1. | Yes (TOTP) before the server is reachable from the internet. | 1C/1D |
| T-2 | Server Node line: 24 (maintenance since 2026-10-20, EOL 2028-04-30) or 26 (LTS from 2026-10-28, EOL 2029-04-30). | 24 now; re-test on 26 and decide before the pilot. | Pilot |

## 3. Can wait until pilot or deployment

| ID | Decision | Recommended default |
|---|---|---|
| D-04 | Concurrent users and sites with unreliable internet | Size and load-test for 100 concurrent sessions; please confirm the real number |
| D-07 | Trial VPS | **Not authorized.** Re-raise before Phase 1E with a test script, cost ceiling and deletion date |
| D-09 | Domain and DNS ownership | Tell me what exists; nothing to buy now |
| O-08 | Recovery objectives (RPO: how much data loss is tolerable; RTO: how long an outage) | Proposal in Phase 1D, e.g. RPO 24 h / RTO 4 h for R1 |
| T-1 | Root `.nvmrc` 22 → 24 | Low priority; only affects developer tooling |
| T-6 | Root developer-tool advisories | Bundle with O-04 |

## 4. Unknown — please clarify

The readiness sheet refers to Phase 0 register items **D-10, D-11, D-12, D-13, D-14, D-24, D-25** (and D-15) by
number only; their text is not in this repository, so I have not guessed their content. Please provide the
Phase 0 decision register, or tell me they are superseded by this file.

## 5. Settled

| ID | Decision | Basis |
|---|---|---|
| P-1…P-3 | Base-data deletion contract | Approved by the owner 2026-10-26 |
| Phase 1A | Repository safety net | Verified and published 2026-10-27 (see `../STATUS.md`) |
| 1B-1 | Server foundation scope | Authorized conditionally in the owner's continuation prompt; preconditions met; built and verified (see `../STATUS.md`) |
| T-3 | Keep TypeScript 6.0.3 | typescript-eslint 8.72.0 still requires `<6.1.0` (re-verified 2026-10-27) |
| E-01…E-07 | Engineering decisions | Review §3; reversible, within engineering authority |
