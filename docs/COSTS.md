# Costs

Build-vs-buy pricing, what it costs us to run a client, and where the margin is thin. Numbers from our own code are
exact (`src/engine/costing.ts` `DEFAULTS`, `src/engine/billing.ts` `PLANS`). Third-party prices are **list prices as
published on the linked page at the time of writing (November 2026)** and must be re-checked before they go into a
proposal; anything we could not state from a public price list says **contact sales**. Nothing here is invented.

## 1. Build vs. buy — the task/process-mining layer

| | BridgeBox collector + engine | Microsoft Power Automate Process Mining | UiPath Task Mining | Mimica |
|---|---|---|---|---|
| What it captures | foreground app, coarse document category, salted title hash, durations, counts | event logs from systems (process mining) and desktop recordings via the Process Mining desktop app (task mining) | desktop recordings: screenshots, clicks, keystrokes, app/URL context, processed by its models | desktop recordings of clicks/keystrokes/screen, mapped into process maps |
| Content captured | **none** (schema-enforced) | screenshots / UI context in task recordings | screenshots and keystrokes (with masking options) | screenshots and keystrokes (with privacy controls) |
| Employee controls | pause, withdraw, blocked apps, campaign windows, notice/consent record | recorder start/stop | recorder controls set by admin | recorder controls set by admin |
| Output we can score | native `workflows` rows | import via `mapPowerAutomateProcesses` (manual export; live API needs a license) | import via `mapUiPathTasks` | import via `mapMimicaProcesses` |
| List price | included in BridgeBox plans (below) | Power Automate Premium **$15 per user/month**, which includes process mining with a storage allowance; additional process-mining capacity is a paid add-on — see [Power Automate pricing](https://www.microsoft.com/en-us/power-platform/products/power-automate/pricing) for the current allowance and add-on price | **contact sales** (Task Mining is sold as part of an enterprise Automation Cloud agreement; [UiPath pricing](https://www.uipath.com/pricing)) | **contact sales** ([mimica.ai](https://www.mimica.ai)) |
| Fit for a 10–250-employee SMB client | designed for it | requires M365/Power Platform admin and per-user licensing for recorded users | enterprise procurement | enterprise procurement |
| Our status | built and unit/e2e tested on Linux-simulated collectors; Windows/macOS untested, unsigned | adapter stub (`license_required`) + tested mapper | same | same |

Why we build: the privacy contract (no content, ever) is the product, and none of the vendors sell a metadata-only
agent. The cost of building is on us: desktop packaging, signing, MDM rollout and real-OS testing are still open
(`docs/IMPLEMENTATION_PLAN.md`).

## 2. Build vs. buy — the agent runtime

| | Internal runtime (`src/engine/agents/runner.ts`) | n8n (self-hosted) | n8n Cloud | Vendor RPA (UiPath / Power Automate Desktop) |
|---|---|---|---|---|
| License | ours | free under the [Sustainable Use License](https://docs.n8n.io/sustainable-use-license/) for internal business use; an **Embed** license is required to offer n8n to customers as part of a product — confirm with n8n before white-labelling | paid plans, see [n8n pricing](https://n8n.io/pricing/) (priced per workflow execution, not per step) | per-robot / per-user licensing, **contact sales** |
| Infra | none extra | one container (`docker-compose.yml` profile `n8n`), ~1 vCPU / 1 GB | none | vendor-hosted or on-prem |
| Why | approvals, redaction, compensation and the run ledger under our control; testable offline | 400+ connectors, credential store, UI the client's IT can own | same, no ops | only if the client already owns it |

## 3. Our price list (`PLANS`, `EXTRA_SEAT_MONTHLY`, `EXTRA_AGENT_MONTHLY`)

| Plan | $/month | Monitored-employee seats | Agent slots | $/seat |
|---|---|---|---|---|
| Starter | 499 | 10 | 3 | 49.90 |
| Growth | 1,499 | 50 | 10 | 29.98 |
| Enterprise | 4,999 | 250 | 50 | 20.00 |
| Extra seat | 19 | | | |
| Extra agent slot | 149 | | | |

Implementation consulting (`DEFAULTS.consultingHourly = $175/h`) is billed outside the subscription. The 14-day trial
is free.

## 4. Run-cost model

### Per monitored employee (seat)

What a seat costs us is storage and compute for events plus a share of the platform. From the synthetic demo: 12
people × 20 workdays ≈ 15,000 events ⇒ **≈ 62 events per employee per workday**. An `activity_events` row with its
three indexes is on the order of 300 bytes, so:

| Item | Per employee | Basis |
|---|---|---|
| Events per 180-day retention window (≈ 125 workdays) | ≈ 7,800 rows ≈ 2.5 MB | observed ratio from the demo, assumed row size |
| Ingest requests | one batch every 30 s inside the campaign window, heartbeat every 60 s ⇒ ≈ 1,700 requests per 10-hour day; each is a small Postgres transaction | collector defaults |
| Analysis compute | `runAnalysis` on the demo org (15k events) runs in seconds on one core; cost is linear in events per employee | `tests/unit/analysis.test.ts` "performance" |
| **Marginal cost** | **cents per month** on any managed Postgres tier | — |

A $19 extra seat is therefore almost entirely margin; the seat allowance is what we sell.

### Per deployed agent

`DEFAULTS.perAgentMonthly = $149` is the modelled all-in cost per deployed agent (platform share + model + runtime)
and is the same figure the client's financial model uses as operating cost, so our margin model and their ROI agree.
Decomposition under the assumptions in §6: LLM spend for a typical agent is $5–40/month, n8n/runtime share $5–20,
support/monitoring labour is the remainder. $149 is a conservative ceiling, not a measured cost; replace it with ledger
data once real agents have run for a quarter.

### Per client (list price, all included agent slots deployed)

| Plan | Revenue | Agents | Modelled agent cost (149 × agents) | Margin if every slot deployed | Margin if ⅓ deployed |
|---|---|---|---|---|---|
| Starter | $499 | 3 | $447 | $52 (10%) | $350 (70%) |
| Growth | $1,499 | 10 | $1,490 | $9 (1%) | $1,002 (67%) |
| Enterprise | $4,999 | 50 | $7,450 | **−$2,451** | $2,516 (50%) |

Verbatim from `docs/BILLING.md`: "**Agent slots are the cost driver.** At `perAgentMonthly = 149`, an *extra* agent
slot sold at $149 is break-even — it exists to let clients grow, not to make money. Included slots are only profitable
while the client has deployed fewer agents than the allowance; **Enterprise loses money if a client actually runs 50
agents.** Either raise the Enterprise price, lower the included slots, or treat `perAgentMonthly` as a conservative
ceiling (it bundles model spend that scales with real usage, which most agents never reach)."

Recommendation (default to one): cut Enterprise's included agent slots to 20 and sell the rest at $149. That keeps the
headline price and removes the negative-margin case.

## 5. Infrastructure estimate

Two viable shapes. Prices are the providers' published list prices; links are the source. Usage-based components are
marked as estimates.

### A. Vercel + managed Postgres (Supabase or Neon)

| Component | Tier | List price | Source |
|---|---|---|---|
| Vercel | Pro (needed for cron frequency, team seats, 60 s functions) | $20 per member/month + usage | [vercel.com/pricing](https://vercel.com/pricing) |
| Postgres | Supabase Pro | $25/month (includes 8 GB DB, daily backups) | [supabase.com/pricing](https://supabase.com/pricing) |
| Postgres (alt.) | Neon Launch | $19/month + compute/storage usage | [neon.com/pricing](https://neon.com/pricing) |
| n8n (optional) | n8n Cloud Starter or a small VPS | see [n8n pricing](https://n8n.io/pricing/); VPS below | |
| Object storage (roadmap, PDFs) | Cloudflare R2 / S3 | cents at this volume | |
| **Total, one consultancy with ~10 clients** | | **≈ $45–70/month fixed** + usage | estimate |

Caveats: Vercel function timeout bounds `runAnalysis` for large tenants (run the worker elsewhere); the in-memory rate
limiter is per instance.

### B. Single VPS with Docker Compose

| Component | Size | Typical list price | Source |
|---|---|---|---|
| VPS | 4 vCPU / 8 GB / 80 GB (app + worker + Postgres + optional n8n) | ≈ $20–50/month depending on provider (e.g. Hetzner CX/CPX, DigitalOcean Basic) | [hetzner.com/cloud](https://www.hetzner.com/cloud), [digitalocean.com/pricing](https://www.digitalocean.com/pricing) |
| Backups / snapshots | provider snapshot + `pg_dump` to object storage | ≈ 20% of VPS price | provider |
| TLS / proxy | Caddy or nginx on the same host | $0 | |
| **Total** | | **≈ $25–60/month** | estimate |

Caveat: you own patching, Postgres tuning, backup testing and uptime. Fine for the first clients; move Postgres to a
managed service before the first client that asks for an uptime commitment.

## 6. LLM cost assumptions

All assumptions; the integration is optional and the product works without it (deterministic retrieval mode for the
assistant, `skipped` llm nodes for agents).

| Assumption | Value | Note |
|---|---|---|
| Model | `claude-sonnet-4-5` (`LLM_MODEL` in `runner.ts`, assistant) | |
| Price basis | Anthropic list price per million tokens for the Sonnet tier; see [anthropic.com/pricing](https://www.anthropic.com/pricing) | re-check; prompt caching and batch discounts not assumed |
| Assistant question | ~6k input tokens (evidence pack) + ~400 output | ≈ $0.02–0.03 per question at Sonnet-tier list prices |
| Agent llm node | ~2k input + ~500 output per run | ≈ $0.01–0.02 per run |
| Heavy client (500 assistant questions + 2,000 agent llm runs per month) | ≈ $35–55/month | fits inside `perAgentMonthly` for a 3-agent client |

## 7. Where the margin is thin — summary

1. **Enterprise plan fully utilised** is negative (−$2,451/month at list) — fix the slot allowance before selling it.
2. **Extra agent slot** at $149 is break-even by construction.
3. **Consulting hours** are where early revenue actually comes from; the subscription is 5–10% of the realizable
   savings the model projects for a client (BILLING.md), which is the pitch but also means platform MRR alone will not
   fund the roadmap in `docs/IMPLEMENTATION_PLAN.md` until there are dozens of clients.
4. **Unmodelled costs**: code signing certificates (Windows EV / Apple Developer, roughly a few hundred dollars per
   year each — vendor list prices change, check before budgeting), SOC 2 audit (five figures), pen test, support time.
