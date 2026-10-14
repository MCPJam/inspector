---
name: investigate-production
description: Find what happened in production using the Sentry, Axiom and PostHog MCP servers, and map it back to inspector code. Use for alert triage, a Sentry issue, an Axiom monitor, a spend or usage question, or "which user/org was this".
---

# Investigate production

The Sentry, Axiom and PostHog MCP servers are installed org-wide on a shared
account. Use them read-only. Never paste tokens, access links or request bodies
from them into Slack, PRs or commits.

## Where each signal comes from

| Question                                 | Tool                    | Where it is defined in code                                                       |
| ---------------------------------------- | ----------------------- | --------------------------------------------------------------------------------- |
| Exceptions, stack traces, affected users | Sentry, org `mcpjam-gh` | `server/sentry.ts`, `client/src/lib/sentry.ts`, `shared/sentry-config.ts`         |
| Server logs and typed events             | Axiom                   | `server/utils/logger.ts`, `server/utils/log-events.ts`, `server/utils/LOGGING.md` |
| Product usage, funnels, person records   | PostHog (US cloud)      | `shared/analytics-events.ts`, `client/src/lib/PosthogUtils.ts`                    |

Paths are relative to `mcpjam-inspector/`.

### Sentry

- Inspector projects: `inspector-server`, `inspector-client`, `inspector-electron`.
  Issue IDs look like `INSPECTOR-CLIENT-2KJ`.
- `CONVEX-*` issues come from the backend in `MCPJam/mcpjam-backend`, not this repo.
- Only `logger.error` and the error-origin policy create Sentry issues.
  Warnings never do, so a missing Sentry issue does not mean nothing failed;
  check Axiom.

### Axiom

- List datasets first; the server uses nonempty `AXIOM_CLEAN_DATASET`, then `AXIOM_DATASET`, falling back to `inspector-logs`.
- Every row has `level`, `message` and `environment`, plus the context fields
  the call site passed.
- Typed events have an `event` field. The catalog with payload fields is in
  `server/utils/LOGGING.md`; filter on `event` instead of grepping `message`.
- Route failures carry `source` and `hop` (`user_server_hop` or
  `mcpjam_internal`). `user_server_hop` failures are usually the user's own MCP
  server, not an MCPJam bug.
- Monitors and dashboards live in `MCPJam/mcpjam-backend` under
  `ops/axiom-monitors/`. Some monitors were created through the Axiom API and
  exist in neither repo.

### PostHog

- Event names and properties: `shared/analytics-events.ts`.
- `organization_id` is a super property on client events. PostHog does not
  record organization names, and neither does Axiom.

## Identifying users and orgs

- Convex IDs (`jx7...`, `nx7...`) and WorkOS IDs (`user_01...`) both appear.
  Join them through Axiom identity events and the PostHog person record.
- Org names are not available from these tools. Report the org ID and say the
  name needs a Convex lookup; do not guess.

## Procedure

1. Start from the alert, issue or question and write down the time window.
2. Query the narrowest source first: the Sentry issue, or the Axiom monitor's
   own query. Keep queries to the window.
3. Find the code path: search for the `event` name, `source` value or error text.
4. Decide whose fault it is: MCPJam code, the user's MCP server, or user
   configuration.
5. Report impact (users, orgs, events, money), cause with a confidence level,
   and the next action with an owner. Lead with impact.
6. If a code fix is clear, open a PR, or say why not. Do not leave a patch only
   in a Slack thread.
