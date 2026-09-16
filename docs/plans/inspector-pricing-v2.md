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
  contain hardcoded legacy copy. Credit balance normalization does not explicitly recognize flat plans; the backend currently provides a per-seat compatibility discriminator to older clients.
- Saved refill quotes exist; draft quotes, detailed pause reasons, a distinct
  enrollment-enabled field, and month-reset wakeups do not. Do not fabricate them.
- The backend handoff has no browser publishable-key contract. Supply the matching
  Stripe environment key explicitly; keep activation unavailable if it is absent.

## Simple user stories

- [x] As a customer, I see only plans offered to my organization by the pricing flag.
- [x] As a customer, I can choose Pro or Team and monthly or annual billing.
- [x] As a customer, I see correct flat or per-seat prices and included credits.
- [x] As a customer, I keep my chosen plan and interval through sign-in and checkout returns.
- [x] As a customer, I see my current plan and remaining credits without incorrect renewal promises.
- [x] As an admin, I can save a refill threshold, credit amount, and monthly dollar limit.
- [x] As an admin, I review the server price and explicitly authorize automatic purchases.
- [x] As an admin, I securely save a card and see enrollment only after backend confirmation.
- [x] As a member, I can see refill status, card summary, and charged/reserved monthly spend.
- [x] As an admin, I can turn refills off while preserving my settings and pending payments.
- [x] As a customer, I see the correct price for manual Team credit purchases.
- [x] As a signed-out visitor, I get a sign-in prompt for Evals, Swarm, and User testing when the separate restriction flag is enabled.
- [ ] As a customer, I get a relevant prompt when credits or starter iterations run out.
- [x] As a hosted visitor, I can find the local Inspector install option.
- [x] As a customer, I can estimate costs from the finalized rate card in Billing.
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

## Implemented behavior and rollout configuration

- PR: https://github.com/MCPJam/inspector/pull/5104
- `PRICING_V2_MODE` stays backend-owned. The client renders the returned catalog,
  checks checkout interval eligibility, and recognizes Pro in stored intent.
- `pricing-feature-signin-required` is a separate PostHog UI flag, default off.
  It gates Evals, Evaluate, Swarm, and User testing without changing pricing offers.
- `AUTO_TOPUP_MODE` remains a separate backend kill switch. The client checks
  `activationAllowed`; no production configuration was changed.
- Set `VITE_STRIPE_PUBLISHABLE_KEY` to the publishable key for the same Stripe
  account/environment as the selected backend before building hosted/local/desktop.
  Missing/invalid configuration hides enrollment. Never put a secret key here.
- Card input uses Stripe Elements and [confirmCardSetup](https://docs.stripe.com/js/setup_intents/confirm_card_setup).
  Only successful Stripe confirmation calls backend finish; only the reactive
  backend query supplies enrollment/payment status. Secrets stay in memory.
- Consent resets on preference revision and price changes. Org switching discards
  stale setup responses. Disable confirmation survives backend revision updates.
- Manual package prices use matching purchased-catalog terms. If those cannot be
  verified (including rollback/catalog mismatch), the dialog says price at checkout.
- Calculator is a scenario estimator using catalog rates, model cost per call,
  and product unit counts. It does not promise an exact run quote or reserve credits.
- Current subscription price copy is withheld when the offered catalog describes
  a different bundle. Existing subscription terms continue to apply.

## Remaining work

1. **Deployed acceptance:** configure the matching publishable key in a test build;
   exercise hosted, local-browser, and packaged desktop auth/card/3DS flows against
   the deployed backend. Verify disable during pending payment, failed payments,
   renewal, webhook/cron recovery, and rollback before enabling automatic charges.
2. **Run estimate/reservation:** no public pre-run credit quote/reservation contract
   was identified in the handoff. Define model/harness cost inputs, maximum spend,
   admission/reservation, cancellation and settlement semantics with the backend.
   A scenario calculator is not a run authorization guarantee.
3. **Feature-specific limits:** Pro/flat upgrade copy and one-time starter balance
   are implemented. Final exhausted-allowance behavior still depends on backend
   accounting. `getEvalIterationQuota` returns an allowance but does not expose the
   separate `EVAL_ITERATION_LIMIT_ENFORCED` switch; clients cannot reliably infer
   whether a non-null allowance is currently enforced. Resolve that contract before
   removing/replacing frontend iteration gates.
4. **Manual quotes:** expose numeric package credits and organization-specific
   quotes so all price displays remain exact when current/offer catalogs differ.
5. **Automatic-refill gaps:** explicit enabled state, automatic eligibility distinct
   from manual eligibility, specific pause/limit reasons, and month-reset wakeup.
6. **Outside Inspector:** finalized website calculator/pricing, accounting/backfills,
   work-org auto-creation/invites, Slack setup, payment observability/alerts, and the
   enterprise-invoice launch decision remain backend/marketing launch work.

## TDD and validation

Observed failing contract tests before replacing placeholder refill APIs; failing
form tests before the dollar/consent UI; failing Stripe adapter test before card
setup; failing v2/flat-balance/quote/estimate tests before their implementations;
failing disable-revision test before retaining confirmation across query updates.
Existing guest-route and meter tests caught regressions and were rerun after fixes.

- Focused npm test run (including pretest bundle freshness): 263 tests passed.
- Additional catalog integration and consent/org-switch tests: 56 passed.
- Final disable confirmation/sidebar regression run: 15 passed.
- Final consolidated pricing regression run: 247 tests passed; card-finish retry regression also passed.
- Client typecheck passed.
- Design drift check passed; pinned design lint reports zero errors and 109 existing warnings.
- Broad client run: 15,387 passed, 34 skipped, 42 initially failed. All failing
  pricing/meter/route files were subsequently rerun green. The other 20 failures
  were loopback sandbox restrictions; both OAuth files passed with local server
  access (40 tests). This was not a deployed payment end-to-end test.


## Test readiness — September 15 conflict update

The frontend sign-in flag does **not** enable V2 checkout. Offers come from
`billing:getPlanCatalog` on the selected Convex deployment.

- Use a Stripe **test-mode** backend and the matching frontend publishable key.
- For an isolated shared-deployment test, use backend `PRICING_V2_MODE=targeted`
  and enroll the test user through `userOps/pricing:setUserPricingV2Enrollment`.
  Targeting checks the server-owned `users.pricingV2EnrolledAt`, not PostHog.
  Existing V2 organizations also receive V2 offers in targeted mode.
- `PRICING_V2_MODE=on` offers V2 to everyone on that deployment. Keep `off` for
  legacy offers; toggling only `pricing-feature-signin-required` changes sign-in
  gating, not plan prices or Stripe checkout authorization.
- Verify the test catalog with `npm run stripe:catalog:dry-run:test` in the backend.
  Required V2 lookup keys: `pro_monthly` ($29/month), `pro_annual` ($288/year),
  `team_v2_monthly` ($249/month), `team_v2_annual` ($2,388/year). Legacy
  `team_monthly` / `team_annual` retain their existing terms.
- Test each V2 plan/cadence from a disposable Free organization, confirm hosted
  checkout uses quantity 1 and the intended price, then verify webhook-driven
  plan and allowance updates. Test cancellation and a failed payment as well.
- Automatic refill has separate `AUTO_TOPUP_MODE` and eligibility requirements;
  a pricing flag does not activate it.

Current blocker: the configured local backend Stripe test API key is expired.
The read-only catalog dry run failed authentication, so current Stripe catalog
readiness is **not verified**. Replace the key locally and rerun before checkout
acceptance. No Stripe products, subscriptions, flags, or deployments were changed.
