# Financial reconciliation

The rule (docs/CONVENTIONS.md, docs/FINANCIAL_METHOD.md): every money figure comes from `src/engine/costing.ts` /
`src/engine/finance.ts`, carries a basis and a `CalcTree`, and the same scenario shows the same dollars on every
surface. Projected and verified savings are never mixed; time saved is not payroll cut.

## What proves it

| Layer | Test | What it asserts |
|---|---|---|
| e2e, cross-surface | `tests/e2e/reconciliation.spec.ts` (3 tests) | `/app` (Command Center) = `/app/finance` (Financial Model) = `/app/savings` (ROI & Savings Center) to the whole dollar for (1) the saved model, (2) the Conservative preset, (3) a temporarily saved custom model; each compact KPI card matches its whole-dollar drill-down; the `/app` Excel export equals the UI and its sheets add up (regression: the export once applied the Expected preset) |
| e2e | `tests/e2e/finance-reports.spec.ts` | adoption slider and scenario presets move net savings; Executive ROI PDF |
| e2e | `tests/e2e/agents.spec.ts`, `acceptance-ai-workforce.spec.ts` | a measured, succeeded agent run moves "Verified so far" above $0; sandbox runs contribute $0 |
| unit | `tests/unit/costing.test.ts` (10) | loaded cost, opportunity economics, adoption/realization, CalcTree sums |
| unit | `tests/unit/finance.test.ts` (7) | org roll-up, scenarios, three-year projection, report generation |
| unit | `tests/unit/savings.test.ts` (8) | savings ledger tiers (approved / cost avoidance / realized hard), verified vs projected |
| unit | `tests/unit/exports.test.ts` (9) | Excel/Markdown exports reproduce engine numbers |
| unit | `tests/unit/business-intel.test.ts` (5), `capacity.test.ts` (2) | BI and capacity roll-ups from the same engine |

Counts are `it(`/`test(` occurrences in each file (grep), cross-checked by the runner totals in §Runs.

## Runs

Recorded in `docs/LAUNCH_CERTIFICATION.md` §2 (command, commit, timestamp, result). All runs are on the **synthetic**
demo org (Gulf Coast Supply Co., seed 42) in the local-ci-equivalent environment. No real client's books have been
reconciled; the `financial_reconciliation` gate is recorded for `local-ci-equivalent` only.

## Not covered

- Reconciliation against a client's accounting system (QuickBooks/ERP connectors are not built).
- Currency other than USD in the UI (orgs carry a `currency` column; reports are USD-tested only).
- Verified savings on real data (gate `evidence_savings`).
