# Credential leak monitor

A daily check that no credential URL reached PostHog or Sentry in the clear.

Some of our URLs are credentials: the token in `/results/<token>`, a tester
link, an OAuth callback's `?code=`. Every telemetry exit scrubs them with the
registry in `mcpjam-inspector/shared/credential-urls.ts`, so a stored event
should only ever show the secret as `[redacted]`. This monitor counts the
events from the last 24 hours that still carry one, grouped by registry route
id, and alerts on any. It checks what the vendors **stored**, so it also
catches a scrubbing gap on the vendor side or in an old installed build.

`mcpjam-inspector/docs/session-replay-masking.md` ("Credential URLs")
describes the scrubbing it checks.

## Files

| File                                                                | What it is                                                                                         |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `patterns.mts`                                                      | Generates the patterns, the HogQL query and the Sentry searches from the registry. Pure.           |
| `samples.mts`                                                       | Sample URLs built from the registry: one unredacted URL per route, and values that must not match. |
| `run.mts`                                                           | Runs the queries, prints the report, sets the exit code.                                           |
| `mcpjam-inspector/shared/__tests__/credential-leak-monitor.test.ts` | Holds the patterns to the registry (see [Drift](#drift)).                                          |
| `.github/workflows/credential-leak-monitor.yml`                     | Daily schedule and the Slack alert.                                                                |

## Run it

From the repository root, with Node 22.18 or later (Node runs `.mts` directly):

```sh
# Print the patterns, the HogQL and the Sentry searches. No network, no secrets.
node ops/credential-leak-monitor/run.mts --dry-run

# Run against the vendors. Credentials come from the environment only.
POSTHOG_PERSONAL_API_KEY=… POSTHOG_PROJECT_ID=… \
SENTRY_AUTH_TOKEN=… SENTRY_ORG=… \
  node ops/credential-leak-monitor/run.mts [--hours=24] [--only=posthog|sentry]

# Check that ClickHouse reads the patterns the way JavaScript does: runs the
# classifier over the literal sample URLs in samples.mts. Reads no event data.
POSTHOG_PERSONAL_API_KEY=… POSTHOG_PROJECT_ID=… \
  node ops/credential-leak-monitor/run.mts --self-test
```

Exit codes: `0` clean, `1` a leak was found, `2` the monitor could not check
a sink (missing configuration or an API error). A monitor that cannot look
reports `NOT CHECKED`, never clean.

The report never contains a matched URL or property value, because a hit is a
credential and the report goes to a chat channel. It has route ids, counts,
the platform and version of the build that sent the event (PostHog), and up to
ten event ids per route (Sentry): enough to find and delete the events.

## What it queries

### PostHog (HogQL)

One query over `events` in the window. For each event it reads every URL
property (`$current_url`, `$referrer`, `$pathname`, `$external_click_url`,
`$session_entry_url`, `$session_entry_pathname`, `$session_entry_referrer`,
`$initial_*`, `$prev_pageview_*`) and the `elements_chain` column, classifies
each value with the generated patterns, and returns
`route_id, property, platform, version, events`. Platform and version come
from the client's super properties, so an old installed desktop build is told
apart from a current one.

### Sentry (Discover)

Sentry search has wildcards, not regular expressions, so the monitor narrows
with coarse wildcard searches generated from the registry (one per route
prefix, callback path and secret key) on the `url` field (the request URL Sentry
records), and on `transaction` for path routes, skipping transaction names
that are already templates (they contain `:`). It reads up to 20 pages of 100
events per search, de-duplicates by event id, and classifies `url` and
`transaction` with the same patterns as PostHog. Hitting the page cap is
reported, and the count is then a lower bound.

### The patterns

For each registry route, a pattern that matches the route with its secret
**still in the clear**:

- Path routes (`/results/:runToken`): the path at the start of a value or
  after a delimiter (`href="…"` in an element chain), with or without scheme
  and host, and after `#` (the legacy hash router). The secret segment must
  not start with `[`, `%`, `:`, `<`, `{` or `*`, which rules out `[redacted]`,
  `[name]`, their percent-encoded spelling, and route templates. Reserved
  values (`/user-testing/<id>/edit`, `/connect/server/request`) are excluded
  after the match.
- Query and fragment routes (`/oauth/callback?code=`, `#token=`): the route's
  key (any secret key, for callback pages) with a value that does not start
  with those characters.
- `secret-param`: any key in `SECRET_PARAM_KEYS` or the key families
  (`X-Amz-*`, `X-Goog-*`, `…token`, `…secret`, …) on any URL.
- `userinfo`: `scheme://user:pass@host`.

A value is attributed to the first pattern it matches: path routes, then
query and fragment routes with a concrete path, then `/*` routes, then the
two catch-alls. The patterns use syntax that JavaScript and RE2 (ClickHouse)
both accept: no lookaround, no backreferences, exactly one capturing group
(the secret).

Not covered: a credential URL percent-encoded inside another URL's query
(`?redirect=%2Fresults%2F…`), properties other than the URL properties above,
Sentry Replay's URL list, and server log lines (Axiom). Those are scrubbed
at the source; this monitor does not re-check them.

## Drift

The monitor reads the registry at run time, so there is no list to keep in
step. `credential-leak-monitor.test.ts` (run by the inspector's `shared`
Vitest project) fails when:

- a registered route has no pattern, or no unredacted sample the pattern
  attributes to it;
- a pattern matches the scrubbed (`[redacted]`) form of any sample, a
  reserved word, a route template, or a clean URL;
- the secret-key alternation disagrees with `isSecretParamKey` (the key
  families are mirrored here because the registry does not export them);
- a pattern uses syntax RE2 rejects, or has other than one capturing group.

```sh
cd mcpjam-inspector && npx vitest run --project shared shared/__tests__/credential-leak-monitor.test.ts
```

After changing `patterns.mts`, also run `--self-test` against PostHog: the
unit test proves JavaScript's reading, the self-test proves ClickHouse's.

## Setup (GitHub Actions)

The workflow runs daily at 07:23 UTC and on demand (`workflow_dispatch`, with
`hours` and `dry_run` inputs). It runs only in `MCPJam/inspector`.

Secrets (Settings → Secrets and variables → Actions):

| Secret                         | What it needs                                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `POSTHOG_LEAK_MONITOR_API_KEY` | A PostHog **personal** API key scoped to the project with `query:read` only.                         |
| `SENTRY_LEAK_MONITOR_TOKEN`    | A Sentry token with `event:read` and `org:read` only (an internal integration or a user auth token). |
| `SLACK_ALERTS_WEBHOOK_URL`     | Already used by the prod canary. The alert goes to the same channel.                                 |

Use dedicated read-only credentials, not the source-map upload tokens: those
carry write scopes this job does not need.

Variables (optional; the defaults are the production values already public in
this repository):

| Variable             | Default                  |
| -------------------- | ------------------------ |
| `POSTHOG_PROJECT_ID` | `212744`                 |
| `POSTHOG_HOST`       | `https://us.posthog.com` |
| `SENTRY_ORG`         | `mcpjam-gh`              |

Until the two secrets are set, every run alerts as `NOT CHECKED`. That is
intended: a monitor that is not configured must not look healthy.

## When it alerts

- **Leak (exit 1).** The report names the route and the property (PostHog) or
  event ids (Sentry). Delete the events in the vendor UI. Then find the
  sink that let the value through: the platform and version say whether it is
  a current build (a scrubber bug: fix it and add the URL to the scrubber's
  tests) or an old installed desktop build (out of our reach in the build
  itself; tighten the vendor-side scrubbing rules instead). If the secret is a
  long-lived link (a share link, a tester link), rotate it.
- **Not checked (exit 2).** A secret is missing or expired, or a vendor API
  failed. Nothing is known to have leaked; restore the credential.
