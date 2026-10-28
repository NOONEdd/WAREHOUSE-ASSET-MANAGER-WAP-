# 30-day plan (from 2026-10-27)

**Estimates are engineering effort, not measurements.** Calendar time depends mostly on how quickly owner
decisions arrive; each slice still needs your authorization before it starts.

## Critical path

```
D-01 + D-05 ──► 1B-2 identity ──► 1B-4 isolation suite ──► 1C frontend ──► 1D acceptance ──► 1E deploy
                     │                                         ▲
D-02 (warehouses) ───┘                                         │
1B-3 authorization ──► schema design ──► synthetic-data build ─┘
O-14 stages + D-03 (mapping source + reviewer) ───────────────► real pilot data   ◄── the longest, business-side path
```

The longest path is **not code**: about 10,000 assets have no warehouse, and only a named reviewer working from
an approved source can assign them (D-03). Starting that business work now is the single most effective way to
shorten the project.

## Plan

| Week | Slice | Effort (est.) | Needs | Acceptance criteria |
|---|---|---|---|---|
| 1 | **Owner:** push approval (O-01), tag (O-02), D-01, D-05; WSL2 checks (sheet T-5); start D-02/D-03 | owner time | — | Branch on GitHub; tag published; answers recorded in the register |
| 1–2 | **1B-2** users, configurable permission profiles and job titles, warehouses (synthetic names), owner CLI, login, sessions, audit events, idempotent admin API; then **1B-2c** MFA | 5–7 days + 2–3 days | settled (O-05, O-09, D-01, D-05, O-07) | Negative tests: no unauthenticated setup; revoked/expired sessions refused; user of warehouse A cannot read B; throttling works; audit append-only |
| 2 | **Desktop maintenance** (only if O-03/O-04 approved): import fix + Electron update | 2–3 days | O-03, O-04, Windows check by you | 533+ tests pass; new regression tests for blank-cell and status-history cases; `verify` passes on Windows |
| 2–3 | **1B-3** (only after your explicit authorization): an asset-schema design proposal for your review, then the schema, status history, provenance and staged import with preview, implemented and tested on **synthetic** data only. No desktop data migration and no SQLite → PostgreSQL rehearsal (O-06: the desktop database holds test data only). The real spreadsheet stays outside 1B-3 until the Excel Source Admission Gate (O-14, proposed) admits it; a preview-only test (its stage 2) and operational import (stage 3) each need their own approval | 5–7 days | **Gate (STATUS):** O-06 resolved; your explicit authorization of 1B-3 (not yet given); O-13 (licence) before ExcelJS; D-15 (server) decided | Row counts reconcile; blank cells never erase; duplicates reported, not merged; re-running an import changes nothing |
| 3–4 | **1B-4** isolation and API security suite across every endpoint; RLS decision | 3–4 days | 1B-2, 1B-3 | Every route declares a permission; adversarial cross-warehouse tests on get/list/search/count/export/import/audit pass |
| 4 | **1C start**: login screen, session expiry, read-only warehouse-scoped asset list and details using the existing React pages | 4–5 days of ~10 | 1B-4 | End-to-end test: log in, see only own warehouse, session expiry returns to login |

## Minimum safe first release (R1)

Login and sessions; user and role administration; warehouses; warehouse-scoped asset list, search, view, create,
edit and status change with full history; transfers (as decided in D-06); audit-log view; staged import with
preview and reconciliation; export; encrypted backups with a **tested** restore; online-only operation with
idempotent retries and clear "not saved" feedback (D-05); MFA for at least the owner and administrators (O-07).

## Deferrable without weakening security or data integrity

Approval workflows beyond the D-06 minimum, attachments, PDF report parity, QR printing, dashboards beyond basic
counts, e-mail notifications, self-service password reset.

**Out of scope (not deferred):** offline operation, offline synchronization and paper-based workflows (D-05).

## Unlikely to fit in the first month

The rest of Phase 1C (editing, transfers, import and audit screens: ~6 more days), 1B-5 approvals (4–6 days),
Phase 1D acceptance (security review, restore drill, load test: 5–8 days), Phase 1E deployment (3–5 days plus
provider, network and DNS dependencies), and **real pilot data**, which depends on the Excel Source Admission Gate
(O-14, proposed) and the D-03 mapping work.
A realistic pilot is 6–8 weeks out if decisions arrive within days; that is an estimate, not a commitment.

## Highest-risk unknowns

1. How long warehouse mapping (D-03) takes, and who does it.
2. Reachability of a VPS from every site in Iran, and TLS issuance under disruption (D-07, D-09; Phase 0 IB-1…IB-3).
3. The real data's quality: placeholder serials, duplicates, contradictory rows — now a question about the
   spreadsheet source (O-14, proposed); the desktop database holds test data only (O-06).
4. Whether your PC can run WSL2 (D-08); nothing has been verified on Windows yet.
5. PostgreSQL 17 behavior: everything so far was tested on 16.15 only.
