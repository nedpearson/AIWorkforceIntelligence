# Billing — plans, economics, Stripe integration, seat enforcement

Code: `src/engine/billing.ts` (engine), `src/app/api/billing/webhook/route.ts` (Stripe webhook), `src/app/admin/clients/[id]/actions.ts` (checkout / portal / sync / local plan actions), `src/app/admin/billing/*` (portfolio view). Tests: `tests/unit/billing.test.ts` (mocked Stripe, real Postgres).

Honesty rule (docs/CONVENTIONS.md): nothing here fakes a payment. Without Stripe credentials every Stripe call returns `{ ok: false, reason, missing: [...] }` and the UI prints the exact environment variables that are missing. Plans can still be set *locally* for trials and manually invoiced clients; those rows carry no `stripe_subscription_id` and the audit log records `billing.plan_set_locally` with `note: "not billed through Stripe"`.

## Price list (ours)

| Plan | Monthly | Monitored-employee seats | Agent slots | Effective $/seat |
|---|---|---|---|---|
| Starter | $499 | 10 | 3 | $49.90 |
| Growth | $1,499 | 50 | 10 | $29.98 |
| Enterprise | $4,999 | 250 | 50 | $20.00 |

Add-ons: extra seat **$19/mo**, extra agent slot **$149/mo**. `planMonthly(plan, seats, agentSlots)` = base + (seats − allowance) × 19 + (agentSlots − allowance) × 149, never below base. The 14-day trial is created by `createClientOrg` (`subscriptions.status = trialing`, `trial_ends_at = now + 14d`).

A *seat* is an employee with a non-revoked collector (`pending | active | paused | offline`). An *agent slot* is an agent whose status is `configured | deployed | paused | error` (drafts and retired agents are free).

## Unit economics vs. modelled cost

Cost inputs are the `DEFAULTS` in `src/engine/costing.ts` — the same numbers the finance engine shows clients, so our margin model and the client's ROI model agree:

| DEFAULTS key | Value | Used for |
|---|---|---|
| `perAgentMonthly` | $149 | platform + model + runtime cost per **deployed** agent |
| `platformFeeMonthly` | $499 | the subscription base fee the client's financial model assumes (= Starter) |
| `consultingHourly` | $175 | implementation labor (billed separately, outside the subscription) |

Per client per month (list price, all included slots used):

| Plan | Revenue | Agents included | Modelled agent cost (149 × agents) | Gross margin if every slot is deployed | Margin if 1/3 of slots are deployed |
|---|---|---|---|---|---|
| Starter | $499 | 3 | $447 | $52 (10%) | $350 (70%) |
| Growth | $1,499 | 10 | $1,490 | $9 (1%) | $1,002 (67%) |
| Enterprise | $4,999 | 50 | $7,450 | **−$2,451** | $2,516 (50%) |

Reading this honestly:

- **Seats are nearly pure margin.** Collection and analysis cost is storage + compute per event (not modelled in `DEFAULTS`; it is small — the demo client's 20 workdays × 12 people is ~15k rows). An extra seat at $19 is therefore ~100% margin; the plan's seat allowance is what we *sell*, the agent slots are what *costs* us.
- **Agent slots are the cost driver.** At `perAgentMonthly = 149`, an *extra* agent slot sold at $149 is break-even — it exists to let clients grow, not to make money. Included slots are only profitable while the client has deployed fewer agents than the allowance; Enterprise loses money if a client actually runs 50 agents. Either raise the Enterprise price, lower the included slots, or treat `perAgentMonthly` as a conservative ceiling (it bundles model spend that scales with real usage, which most agents never reach).
- **Per monitored employee:** Starter earns $49.90/seat/mo, Growth $29.98, Enterprise $20.00; against the client's typical realizable savings of several hundred dollars per monitored employee per month (see `docs/FINANCIAL_METHOD.md`), the subscription is 5–10% of what we project for them, which is the pitch.
- **Consulting** (`consultingHourly`) is not in MRR. The portfolio Billing page reports MRR (active + past_due subscriptions at list price) and the modelled agent cost across every client's deployed agents; everything else is cash outside the platform.

`costToServe(agentsDeployed)` in the engine exposes the same arithmetic for the UI.

## Stripe

Environment (all optional; the UI says what is missing):

| Variable | Purpose |
|---|---|
| `STRIPE_SECRET_KEY` | API key (`sk_test_…` / `sk_live_…`) |
| `STRIPE_WEBHOOK_SECRET` | signing secret for `/api/billing/webhook` (`whsec_…`) |
| `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_GROWTH`, `STRIPE_PRICE_ENTERPRISE` | recurring Price ids for the three plans |
| `STRIPE_PRICE_EXTRA_SEAT`, `STRIPE_PRICE_EXTRA_AGENT` | optional per-unit recurring Prices for add-ons; without them a checkout with extra seats/slots refuses and names the variable |

Engine functions (`src/engine/billing.ts`):

- `stripeConfig(env?)` → `{ ok, stripe, prices, webhookSecret }` or `{ ok:false, missing, reason }`.
- `createCheckoutSession(orgId, plan, { successUrl, cancelUrl, seats?, agentSlots?, actorUserId?, customerEmail? })` → Checkout Session in `subscription` mode with one line item per plan price plus quantity line items for add-ons. `client_reference_id`, `metadata` and `subscription_data.metadata` all carry `{ orgId, plan, seats, agentSlots }` so the webhook can find the tenant. Audited `billing.checkout_started`.
- `createPortalSession(orgId, returnUrl)` → Billing Portal session for the org's `stripe_customer_id` (requires a prior checkout).
- `syncSubscriptionFromStripe(orgId)` → `subscriptions.retrieve` + `invoices.list({ subscription })`, mapped with `subscriptionPatchFromStripe` / `invoiceRowFromStripe`. Audited `billing.synced`.
- `verifyWebhook(rawBody, signature)` → `stripe.webhooks.constructEvent` with `STRIPE_WEBHOOK_SECRET`; 503 when unconfigured, 400 on a bad signature.
- `handleStripeEvent(event)` — idempotent: the event id is written to `jobs` (`kind = 'stripe_event'`, `payload.eventId`, `status = done`) and a redelivery returns `{ duplicate: true }` without touching anything. Handled events:

| Event | Effect |
|---|---|
| `checkout.session.completed` | link `stripe_customer_id` + `stripe_subscription_id`, status `active`, plan/seats/agentSlots from metadata |
| `customer.subscription.created/updated` | plan from the line item's price id (metadata fallback), seats = allowance + extra-seat quantity, `current_period_end` = max item period end, `trial_ends_at`, status mapped (`incomplete_expired/paused → canceled`, `incomplete → unpaid`) |
| `customer.subscription.deleted` | status `canceled` |
| `invoice.paid` | upsert `invoices` by `stripe_invoice_id` (amount, period, line items, PDF url); a `past_due/unpaid` subscription returns to `active` |
| `invoice.payment_failed` | upsert the open invoice, subscription → `past_due` |
| anything else | recorded as ignored |

The org is resolved from `metadata.orgId` / `client_reference_id`, else by `stripe_subscription_id`, else by `stripe_customer_id` (admin handle, cross-tenant by nature — the same sanctioned pattern as collector-token lookup). All writes to `subscriptions` / `invoices` go through `withTenant(orgId)`. Every webhook is audited as `billing.webhook` with `actorType: system`.

Local development: `stripe listen --forward-to localhost:3000/api/billing/webhook` and put the printed `whsec_…` in `.env`. Test cards: `4242 4242 4242 4242`; `4000 0000 0000 0341` to exercise `invoice.payment_failed`.

What is **not** covered: proration previews, taxes, coupons beyond `allow_promotion_codes`, metered usage, and multi-currency. Live Stripe calls are not exercised in CI — request shapes are asserted against a mocked client, signature verification uses `stripe.webhooks.generateTestHeaderString`.

## Seat enforcement

`seatUsage(orgId)` returns `{ seats, used, remaining, agentSlots, agentsUsed, overSeats, overAgents, … }`.
`assertSeatAvailable(orgId, employeeId?)` throws `SeatLimitError` (message names the plan, the counts and the add-on price) when enrolling one more employee would exceed the plan. An employee who already holds a seat (re-enrollment, second device) does not consume another one. An org without a `subscriptions` row is not blocked (returns `null`).

Where it must be called (owned by the collection team — not wired by this module):

1. `src/app/app/collection/actions.ts` → `createEnrollmentCode`, before inserting the collector: `await assertSeatAvailable(ctx.orgId, p.data.employeeId)` and return `fail(e.message)` on `SeatLimitError`.
2. `src/app/api/collect/enroll/route.ts`, before activating a pending collector that is bound to an employee without a seat (defensive — codes are normally issued through step 1).

Already enforced here: the consultant bulk action (`bulkEnrollmentCodes` in `src/app/admin/clients/[id]/actions.ts`) issues codes only up to the remaining seats and reports how many employees were skipped. Warnings are shown on the portfolio cards (`seats full`), the client Collectors tab, the client Billing tab and the portfolio Billing page whenever `used ≥ seats` or `agentsUsed > agentSlots`.

## Admin UI

- `/admin/clients/[id]?tab=billing` — current subscription (plan, status, seats used/allowed, agent slots, monthly list price, period / trial end, Stripe ids), invoices, **Start Stripe checkout**, **Manage in Stripe** (portal), **Sync with Stripe**, and **Set locally (no Stripe)** for unlinked subscriptions (owner/admin of the consultancy only). A Stripe-linked subscription cannot be changed locally; the action says to use the portal so billing stays in sync.
- `/admin/billing` — every client's subscription, MRR, trial pipeline, modelled agent cost, gross margin, price list, recent invoices, **Sync with Stripe** for all linked clients (lists the skipped ones with the reason).
