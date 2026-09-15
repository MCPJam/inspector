# Inspector pricing v2: audit and implementation checklist

## Audit (2026-09-15)

Inspected Inspector at c655a08e3 and backend auto-refill branch at 3b56b610
([backend PR 1360](https://github.com/MCPJam/mcpjam-backend/pull/1360)).
The handoff and launch plan are reference material; this work implements the
requested Inspector changes, not unrelated launch outreach or production rollout.

- Auto-reload UI currently calls placeholder endpoints that do not exist in the
  handoff backend. It treats preferences as enrollment and converts monthly dollar
  limits to credits. Replace it with the preferences, consent, and setup contract.
- Backend getPlanCatalog already selects v1/v2 using PRICING_V2_MODE and actor/org
  eligibility. Inspector currently omits Pro and assumes Team per-seat pricing.
  The backend flag is authoritative; a local flag must not expose unauthorized offers.
- Existing billing/settings reorganization and usage dashboard are present.
- Checkout intent storage exists but recognizes Team only. Comparison allowances
  contain hardcoded legacy copy. Credit balance normalization drops flat plans.
- Saved refill quotes exist; draft quotes, detailed pause reasons, a distinct
  enrollment-enabled field, and month-reset wakeups do not. Do not fabricate them.
- The backend handoff has no browser publishable-key contract. Supply the matching
  Stripe environment key explicitly; keep activation unavailable if it is absent.

## Simple user stories

- [ ] As a customer, I see only plans offered to my organization by the pricing flag.
- [ ] As a customer, I can choose Pro or Team and monthly or annual billing.
- [ ] As a customer, I see correct flat or per-seat prices and included credits.
- [ ] As a customer, I keep my chosen plan and interval through sign-in and checkout returns.
- [ ] As a customer, I see my current plan and remaining credits without incorrect renewal promises.
- [ ] As an admin, I can save a refill threshold, credit amount, and monthly dollar limit.
- [ ] As an admin, I review the server price and explicitly authorize automatic purchases.
- [ ] As an admin, I securely save a card and see enrollment only after backend confirmation.
- [ ] As a member, I can see refill status, card summary, and charged/reserved monthly spend.
- [ ] As an admin, I can turn refills off while preserving my settings and pending payments.
- [ ] As a customer, I see the correct price for manual Team credit purchases.
- [ ] As a signed-out visitor, I get a sign-in prompt for Evals, Swarm, and User testing when the separate restriction flag is enabled.
- [ ] As a customer, I get a relevant prompt when credits or starter iterations run out.
- [ ] As a hosted visitor, I can find the local Inspector install option.
- [ ] As a customer, I can estimate costs from the finalized rate card in Billing.
- [ ] As a customer, I can see estimated run credits before starting a run.

## Dependencies and acceptance boundaries

- Backend accounting, starter allowance/backfill, reservation estimates, organization
  creation/invite policy, and enterprise invoicing belong to backend work. Marketing
  pages, demo form, and outreach belong outside this PR.
- Do not remove consumption controls until the corresponding backend policy is ready.
- Calculator must use confirmed catalog/rate-card data, not an invented model estimate.
- Auto-refill activation follows activationAllowed (separate AUTO_TOPUP_MODE switch)
  plus explicit customer consent. Saving preferences never authorizes a charge.
- New v2 offers follow backend catalog eligibility. Rollback must preserve purchased
  v2 subscriptions and existing credit grants. No production flags change in this PR.
- Hosted, browser-local, and packaged desktop Stripe/card/auth journeys need deployed
  validation. Backend isolated Stripe smoke tests do not establish this.
- Launch still requires webhook/cron, renewals, failed payments, and canary verification.

## TDD log

Record failing behavior tests before each implementation slice, then the passing
focused suite. Keep unfinished stories unchecked in this document and draft PR.
