# Backend server-side capture plan (signup + billing + chatbox)

Completes the analytics-capture-resilience project: the events that fire in
the **Convex backend** (mcpjam-backend), not the inspector. These are the
highest-value gap — signup and revenue events currently only fire client-side
and are ad-blockable. This lives in the other repo, so it's a separate PR
there. It needs a connected Convex deployment (`npx convex codegen` + typecheck
+ deploy) — it can't be verified from the inspector repo.

## What's already there (reuse, don't reinvent)

- `posthog-node@^5.10.2` is a backend dependency.
- **A working capture pattern exists**: `convex/usage/telemetry.ts` — a
  `'use node'` module with a warm module-level `PostHog` singleton
  (`new PostHog(process.env.POSTHOG_API_KEY, { host: 'https://us.i.posthog.com' })`),
  an `internalAction captureLlmUsagePostHog` that does `posthog.capture(...)`
  then `await posthog.flush()` (never `shutdown()` — reused workers), and
  `$insert_id` for idempotency. The scheduling side is
  `scheduleLlmUsagePostHogCapture` (`convex/usage/create.ts:57`) via
  `ctx.scheduler.runAfter(0, internal.usage.telemetry.captureLlmUsagePostHog, …)`.
- `POSTHOG_API_KEY` already holds the public `phc_` token (`.env.local`;
  add it to `.env.example` and set it as a prod Convex env var).

## Step 1 — generalize into `convex/usage/serverAnalytics.ts` (`'use node'`)

Mirror `telemetry.ts` but generic:

```ts
'use node';
import { v } from 'convex/values';
import { internalAction } from '../_generated/server';
import { PostHog } from 'posthog-node';
import { emitOperationalEvent } from '../lib/operationalEvents';

const posthog = process.env.POSTHOG_API_KEY
  ? new PostHog(process.env.POSTHOG_API_KEY, { host: 'https://us.i.posthog.com' })
  : null;

export const captureServerEvent = internalAction({
  args: {
    distinctId: v.string(),          // MUST be users.externalId (WorkOS id) — see below
    event: v.string(),
    insertId: v.string(),            // dedupe key
    properties: v.optional(v.any()),
    orgId: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    if (!posthog) { emitOperationalEvent('warn', 'server_event_capture_failed', { event: args.event, reason: 'missing_posthog_api_key' }); return; }
    posthog.capture({
      distinctId: args.distinctId,
      event: args.event,
      properties: { $insert_id: args.insertId, source: 'server', ...(args.orgId ? { organization_id: args.orgId } : {}), ...(args.properties ?? {}) },
    });
    await posthog.flush();
  },
});
```

## Step 2 — identity rule (critical)

**`distinctId` MUST be `users.externalId`** (the WorkOS user id / guest JWT
subject) — the SAME id the inspector client sends. Do **not** use the Convex
`users._id`. The existing `captureLlmUsagePostHog` uses `_id` for signed-in
users, which does NOT match the client and splits the person — don't copy that
choice. Where you only hold a Convex `userId` (billing), resolve externalId
with a `ctx.runQuery` (add an internal `getUserExternalId(userId)` in
`convex/users.ts`).

## Step 3 — wire the events

| Event | Site | How | distinctId |
|-------|------|-----|-----------|
| `signup_server` | `runWorkOsFirstLoginSideEffects` (`convex/users.ts:339`), next to the `emitDomainEvent('signup.completed')` at `:364` | mutation → `ctx.scheduler.runAfter`. Thread `externalId` into the helper args (caller `upsertUserFromIdentity:221` has it) | `externalId` (already in scope upstream) |
| `credit_purchased_server` | after the `[billing.credit_purchased]` log, `convex/billingNode.ts:1658` | already a `'use node'` action → capture **inline** (`ctx.runAction(internal.usage.serverAnalytics.captureServerEvent, …)` or import the client). Resolve externalId from `log.purchasedByUserId` via runQuery; if `unknown`, fall back to org-keyed | resolved externalId; else org id + `orgId` |
| `subscription_created_server` | `checkout.session.completed` (subscription) convergence `convex/billingNode.ts:2394` | inline (Node action). Org-level — key on the purchasing user's externalId if available, else org | externalId or org |
| `chatbox_published_server` | `createHost` (`convex/hosts.ts:274`), also `duplicateHost:502` | userMutation → schedule. `requireAdminAccess` returns `user` Doc with `user.externalId` | `user.externalId` |

`insertId` suggestions: `signup:<userId>`, `credit_purchased:<stripeSessionId>`,
`subscription:<stripeSubscriptionId>`, `chatbox_published:<chatboxId>` — stable
so retries dedupe.

Naming: `_server` suffix matches the inspector's parallel-run policy (the
client/server pair ratio is the block-rate metric). Mirror these names by hand
into the inspector's `shared/analytics-events.ts` (the two repos mirror by
hand) and into the block-rate dashboard.

⚠️ `chatbox_published_server` touches `convex/hosts.ts`, which had uncommitted
parallel edits as of 2026-07-10 — coordinate to avoid a conflict, or land it
in a follow-up.

## Step 4 — verify (needs Convex env)

`npx convex codegen` (registers the new action) → `npx tsc --noEmit` → deploy to
staging → trigger a real signup + a test credit purchase → confirm
`signup_server` / `credit_purchased_server` land in PostHog with a `distinctId`
that **matches the same person's client events**.
