# Financial method

How every dollar and hour on the dashboard and in the executive reports is computed. All formulas live in
`src/engine/costing.ts` (pure functions); `src/engine/finance.ts` loads tenant data, applies them and rolls
up. Nothing else re-derives savings math.

Every number carries a **basis**:

| Basis | Meaning | Examples |
|---|---|---|
| `observed` | Measured directly | collector event durations, employee cost from HR record, agent run ledger |
| `estimated` | Derived from observed data through a model | hours recoverable, gross savings, implementation cost |
| `assumed` | A financial-model input the owner can change | adoption rate, realization rate, benefits load |

Every money figure also carries a `CalcTree` (label, value, formula, basis, source, children) so the UI and
PDF can show exactly how it was built.

## 1. Labor cost

```
loaded annual cost  = base annual cost × (1 + benefitsLoadPct)
loaded hourly cost  = loaded annual cost ÷ (hoursPerWeek × workWeeksPerYear)
```

`totalAnnualLaborAnalyzed` sums loaded annual cost over employees that have either collector events or
discovered-workflow links. Employees with no observed activity are excluded so the headline never counts
payroll we did not look at. Basis is `observed` when the employee's `costBasis` is observed, else `assumed`.
If an employee has no `baseAnnualCost`, the stored `loadedHourlyCost × hours × weeks` is used (basis assumed).

## 2. Observed and repetitive hours

```
hoursObservedPerWeek   = Σ workflow.hoursPerWeek                         (basis observed)
repetitiveHoursPerWeek = Σ workflow.hoursPerWeek where repetitionScore ≥ 50
repetitiveSharePct     = repetitive ÷ observed
```

Per employee, the same sums use `workflow_employees.hoursPerWeek`; per department they sum the employees in
that department.

## 3. Opportunity economics (`opportunityEconomics`)

For each opportunity in scope (status ≠ `rejected`, or an explicit `opportunityIds` list):

```
automation share      = opportunity.automationPct × assumptions.automationPct (multiplier, capped at 1)
hoursRecoverable/wk   = workflow hours/wk × automation share × adoptionRate
grossAnnualSavings    = hoursRecoverable/wk × workWeeksPerYear × avg loaded hourly of the performers
realizableAnnual      = grossAnnualSavings × realizationRate
implementationCost    = (base consulting hrs[type] × (1 + complexity) × consultingHourly + tooling[type]) × costMult
annualOperatingCost   = monthlyRun[type] × 12 × costMult      (ai_agent: monthlyRun = perAgentMonthly)
netAnnual (opp)       = realizable − operating
payback (opp)         = implementation ÷ (net ÷ 12)            (null when net ≤ 0)
roi1y (opp)           = (net − implementation) ÷ implementation
```

The average loaded hourly is weighted by each performer's hours on the workflow and is recomputed under
the current `benefitsLoadPct`, so the benefits slider moves savings as well as labor. `complexity` is read
back from the stored opportunity tree ("Complexity multiplier" node) or back-solved from the stored
implementation cost, so re-evaluation with different sliders reproduces the analysis engine's inputs exactly.

Implementation profiles (`IMPLEMENTATION_PROFILES`):

| Type | Consulting hrs | Tooling one-time | Monthly run |
|---|---|---|---|
| ai_agent | 40 | $1,500 | perAgentMonthly ($149) |
| rpa | 60 | $3,000 | $220 |
| conventional_automation | 24 | $500 | $40 |
| process_change | 16 | $0 | $0 |
| role_consolidation | 12 | $0 | $0 |

## 4. Organization roll-up (`computeOrgFinancials`)

```
hoursRecoverablePerWeek = Σ opp hoursRecoverable
grossAnnualSavings      = Σ opp gross
realizableAnnualSavings = Σ opp realizable
implementationCost      = Σ opp implementation      (or implementationCostOverride)
annualOperatingCost     = Σ opp operating           (or annualOpexOverride)
platformBaseAnnual      = platformFeeMonthly × 12
platformAnnual          = platformBaseAnnual + perAgentMonthly × 12 × deployed agents
netAnnualSavings        = realizable − operating − platformBaseAnnual
roi1y                   = (net − implementation) ÷ implementation
paybackMonths           = implementation ÷ (net ÷ 12)          (null when net ≤ 0)
```

`platformAnnual` is the subscription bill (base + per-agent for agents actually deployed). Per-agent fees
for AI-agent opportunities are already inside `annualOperatingCost`, so `netAnnualSavings` subtracts only the
base fee to avoid double counting. Both figures are exposed; the net tree shows the split.

Department rows attribute opportunities by `opportunity.departmentId` (falling back to the workflow's
department). Employee rows attribute an opportunity's recoverable hours and realizable dollars to each
performer in proportion to their share of the workflow's hours. `efficiencyGainPct = recoverable ÷ observed hours`.

## 5. Scenarios

| Scenario | automation × | adoption | realization | cost × |
|---|---|---|---|---|
| conservative | 0.70 | 0.60 | 0.45 | 1.30 |
| expected | 1.00 | 0.75 | 0.60 | 1.00 |
| aggressive | 1.15 | 0.90 | 0.75 | 0.90 |

A scenario replaces only those four inputs. Explicit overrides passed alongside a scenario (sliders) win over
the scenario preset. Observed hours and labor costs are identical across scenarios, which is why the
conservative case is a floor rather than a different dataset. `scenarios.*` in `OrgFinancials` carries the
headline numbers and a 3-year projection for each.

## 6. Three-year projection (`threeYearProjection`)

```
year-1 factor = 1 − rampMonths ÷ 24        (linear ramp to full run-rate over rampMonths)
savings[y]    = realizable × (y = 1 ? year-1 factor : 1)
costs[y]      = operating + platformBaseAnnual + (y = 1 ? implementation : 0)
net[y]        = savings − costs; cumulative; discounted = net ÷ (1 + discountRate)^y
NPV           = Σ discounted; roi3y = cumulative net ÷ implementation
```

## 7. Verified savings — always separate from projected

Projected numbers above are forecasts. Verified numbers come only from `savings_measurements` rows written
after deployment, and are never added to projected figures. The dashboard shows them side by side
(projected = purple, verified = teal).

Annualization for the org roll-up:

```
annualized $ = dollarsSaved × (365.25 ÷ period days)
annualized h = hoursSaved   × (365.25 ÷ period days)
```

Methods:

- **run_ledger** (`recordSavingsFromRunLedger`): for one agent and period, sum `agent_runs` with
  `status = succeeded` whose finish time falls in the period.
  `hoursSaved = Σ minutesSaved ÷ 60`, `hoursAfter = Σ humanMinutes ÷ 60` (review/approval time still spent),
  `hoursBaseline = hoursSaved + hoursAfter`, `dollarsSaved = hoursSaved × avg loaded hourly of the workflow's
  performers` (hours-weighted; falls back to the org average), `costIncurred = agent.monthlyCost × months`.
  Basis `observed`. Idempotent: one row per (agent, period, method); re-running updates it in place.
- **before_after_observation**: collector hours on the workflow before vs after deployment.
- **manual_attestation**: signed statement by the owner; still stored with its own CalcTree.

Completion metrics:

```
automationCompletionPct = verified annualized $ ÷ realizable projected $   (capped at 100%)
deploymentCompletionPct = deployed agents ÷ opportunities in scope          (capped at 100%)
```

## 8. Default assumptions and why

| Assumption | Default | Basis | Justification |
|---|---|---|---|
| benefitsLoadPct | 0.30 | assumed | Employer payroll taxes, health, retirement and PTO typically add 25–40% on top of base pay for US SMBs; 30% is the midpoint. Overridable per org (`settings.benefitsLoadPct`). |
| workHoursPerWeek | 40 | assumed | Standard full-time week; per-employee `hoursPerWeek` overrides it. |
| workWeeksPerYear | 48 | assumed | 52 weeks less ~4 weeks of PTO, holidays and sick leave. Using 52 would overstate hourly capacity. |
| adoptionRate | 0.75 | assumed | Not every eligible run goes through the automation (exceptions, edge cases, habit). 75% is a realistic steady state for a well-supported rollout; conservative 60%, aggressive 90%. |
| realizationRate | 0.60 | assumed | Freed time only becomes money when it avoids a hire, backfills attrition or is redeployed to revenue work. The remainder is slack. 60% expected; 45% conservative; 75% aggressive. |
| automationPct multiplier | 1.0 | assumed | Scales the analysis engine's per-opportunity automatable share so an owner can stress-test it without editing opportunities. |
| consultingHourly | $175 | assumed | Blended automation consulting rate; overridable for in-house implementation. |
| perAgentMonthly | $149 | assumed | Platform + model + runtime cost per deployed AI agent (matches `IMPLEMENTATION_PROFILES.ai_agent.monthlyRun`). |
| platformFeeMonthly | $499 | assumed | Subscription base fee. |
| rampMonths | 3 | assumed | Time from go-live to full run-rate; drives the year-1 factor. |
| discountRate | 0.08 | assumed | Cost of capital for a private SMB; used only for NPV. |

The default `financial_models` row is created by `ensureDefaultFinancialModel(orgId)` from these values
overlaid with `organizations.settings`. Every override on the dashboard is a `Partial<FinancialAssumptions>`
passed to `computeOrgFinancials`; nothing is persisted unless the owner saves a model.

## 9. Why time saved ≠ payroll

Recovering 7.5 hours a week on invoice entry does not remove 7.5 hours of payroll. The employee is still
employed; the hours become capacity. That capacity turns into money only when the business (a) does not make
a hire it otherwise would, (b) does not backfill a departure, or (c) redeploys the time into work that
produces revenue. Everything else is a nicer workday, which is real but not cash.

That is why the engine reports three distinct figures and never collapses them:

1. **Gross annual savings** — the loaded labor value of the time the model expects to remove.
2. **Realizable annual savings** — gross × realization rate; the share a CFO can plan around.
3. **Verified savings** — what the run ledger and post-deployment observation actually measured.

Reports and the dashboard label all three, show the basis of each input, and let the owner move the
realization slider rather than hiding it inside a single "ROI" number.

## 10. Report contents (`generateExecutiveReport`)

Kinds: `executive_roi`, `investment_proposal`, `monthly_performance`. Each PDF contains: branded cover
(`organizations.branding.reportName/primaryColor/footer`; white-label when `reportName` is set), the three
headline numbers, executive summary, department table, top-10 opportunities, scenario comparison, 3-year
table, assumptions page with basis, methodology page, page numbers, and a "SYNTHETIC DEMO DATA" watermark
when `organizations.isDemo`. The report row stores the headline data, departments, top opportunities,
scenarios, 3-year projection and assumptions (never per-employee compensation) plus the PDF as base64.
