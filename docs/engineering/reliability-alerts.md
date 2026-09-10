# Reliability alerts and release verification

Incident #4932 showed why a healthy HTTP endpoint and no Sentry exceptions are
insufficient: an npm client rejected saved credentials before connecting. A 403
can be a product regression even when its generic classification is user error.

This implementation checks saved bearer and saved OAuth connections through the
hosted public API and an installed npm Inspector. It exercises discovery, a
read-only health tool with an exact expected result, and fresh connections. The
npm check additionally exercises the local UI's connect/reconnect routes. It does
not pass MCP target credentials into requests: they must come from persisted
backend rows. A 200 with an error result or empty discovery fails.

## Activation status

**Provisioning is required before merging/enabling these gates.** The repository
currently has no verified canary fixtures, incoming Slack webhook or Sentry Cron
monitor. This PR does not create accounts, mint credentials, or send test Slack
messages. Missing configuration deliberately fails; it is never a skipped green
check. Normal Inspector releases will be blocked until fixtures are configured.

The npm path needs a **user session JWT**, not a WorkOS `sk_` API key. A static
access token expires and is not a durable scheduled-monitor setup. The synthetic
account's session refresh/rotation mechanism must be supplied before continuous
npm coverage can be called operational. Do not use a personal engineer's session,
put production service credentials in the packaged app, or bypass authorization
in the probe. `CANARY_LOCAL_BEARER` is the injection point for a freshly rotated
synthetic-account session; this PR does not implement its issuer/rotation.

## Required configuration

Use a dedicated synthetic organization/project with no customer data. Create two
owned test servers through normal product flows: one saved bearer connection and
one saved OAuth connection with refresh support. Both must expose a read-only
health tool that returns deterministic text. Keep older persisted rows across
releases to exercise migrations. Never repair the fixtures automatically after a
failure; that could hide the exact regression being monitored.

Set repository Actions secrets:

| Secret                     | Purpose                                                                      |
| -------------------------- | ---------------------------------------------------------------------------- |
| `CANARY_API_KEY`           | Synthetic account MCPJam API key for hosted public operations                |
| `CANARY_LOCAL_BEARER`      | Fresh synthetic user session JWT for npm/local operations; requires rotation |
| `CANARY_FIXTURES_JSON`     | Two persisted fixtures in the format below; no MCP target tokens             |
| `SLACK_ALERTS_WEBHOOK_URL` | Incoming webhook bound to existing `#mcpjam-alerts`                          |
| `CANARY_SENTRY_DSN`        | Sentry `inspector-hono` DSN used only for Cron check-ins                     |

```json
[
  {
    "kind": "bearer",
    "projectId": "PROJECT_ID",
    "serverId": "BEARER_SERVER_ID",
    "toolName": "health",
    "expectedText": "healthy"
  },
  {
    "kind": "oauth",
    "projectId": "PROJECT_ID",
    "serverId": "OAUTH_SERVER_ID",
    "toolName": "health",
    "expectedText": "healthy"
  }
]
```

No arbitrary request bodies or target credentials are accepted. The canary calls
only the configured read-only tool with empty arguments. Fixture names, URLs,
response bodies, tool output and credentials are excluded from reports and Slack.

Preview the Sentry changes with the authenticated existing CLI:

```sh
node scripts/reliability/configure-sentry.mjs
```

After fixture setup, apply the reviewed configuration:

```sh
node scripts/reliability/configure-sentry.mjs --apply
```

The script appends the existing Slack integration (`329687`, channel
`C09HW2XRVUK`) to active, unsnoozed issue rules in inspector-hono, inspector-client,
inspector-electron, convex and mcpjam-sdk. It preserves existing conditions,
thresholds, environment filters and recipients. Re-running is idempotent. The
September 10 audit identified six active rules lacking this Slack destination.
It also provisions the Cron monitor and a specific failed/missing-check-in Slack
rule. No quota upgrades or incident.io configuration are required by the script;
Sentry monitor availability must still be verified in the account.

## Coverage and delivery

- `Prod canary` runs every five minutes. It checks edge health, hosted saved auth,
  installs `@mcpjam/inspector@latest` in a clean directory, and checks the npm app.
  Install failure is reported as `npm.install`, not a claim that the hosted app
  is down. Failed controls/configuration do not silently pass.
- Failure changes alert immediately. Unchanged failures repeat after 30 minutes.
  A transition to healthy sends one recovery message. Cache eviction can produce
  another notification; cache is deduplication state, never health evidence.
- Sentry observes executions independently: a five-minute schedule plus a
  ten-minute margin detects a missing check-in roughly fifteen minutes after the
  last expected successful tick. GitHub schedules can be delayed; this is not a
  guaranteed five-minute detection SLA. Cron delivery also needs the Sentry rule
  configured; sending a DSN check-in alone does not configure Slack.
- Release, desktop release and deployment failures on main post the run link and
  SHA to Slack. A following successful run sends recovery. No automatic rollback.
- A missing webhook fails even a healthy run. A rejected Slack response fails the
  delivery step and does not advance notification state. Missing reports are
  coverage failures. Reports are uploaded for 30 days.

## Release gates

Build and clean-install smoke the package archives, record their SHA-512 integrity
and candidate git SHA, and upload those exact archives. After any optional backend
production deployment, install the same archives and exercise persisted credentials
against the backend currently live. Only `skip_verify` bypasses this new credential
gate, alongside the existing CI/staging gates. Archive integrity validation is
always required. SDK/CLI-only releases retain their existing package smoke checks.

Publish the tested `.tgz` files with lifecycle scripts disabled, so SDK/CLI
`prepublishOnly` cannot rebuild them after verification. Verify npm registry
integrity against the manifest. Partial-release retries skip identical published
versions, and reject a version whose published bytes differ. SDK sourcemap IDs are
injected before packing. Existing Inspector release tagging remains unchanged;
this publisher does not create per-package Changesets tags.

The new tests run inside `npm run test:checks` and therefore the required Tests
workflow. No production secrets are available to ordinary PR tests.

## Acceptance drill before calling this live

1. Run both healthy fixtures on hosted and npm, and verify all operation results.
2. In an isolated test deployment, restore the missing-origin-binding rejection
   with an older persisted row. Verify health/identity still pass while saved
   connections fail. The unit regression test simulates this response; it is not
   evidence of a completed live backend/client compatibility drill.
3. Verify empty tool discovery and MCP `isError: true` fail despite HTTP 200.
4. Reject a synthetic credential: verify a coverage/journey failure in Slack,
   never a claim of measured customer impact. Restore it and verify recovery.
5. Pause the scheduled monitor and confirm Sentry's missing check-in reaches
   `#mcpjam-alerts`. Restore the schedule. Test Slack rejection in an isolated
   test, not by altering the shared production channel.
6. Verify the packed release candidate against the live backend before publish;
   inspect the registry integrity result afterwards.

This covers this incident's saved-credential/install gap. It does **not** yet
measure affected customer counts, add cross-issue PostHog failure-rate alerts,
verify every chat/eval/billing/UI journey, implement backend capability/migration
readiness, cover the companion backend repository's deploy workflow, or prove
Windows/macOS authenticated runtime parity. Existing tests and alerts for those
surfaces remain separate. Synthetic failures must not be automatically labeled P0
without impact assessment.
