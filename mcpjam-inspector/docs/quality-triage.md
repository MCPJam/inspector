# Weekly quality triage

**30 minutes. Once a week. Same time every week.**

The point is not to fix things during the meeting. The point is that every
item leaves with an **owner** and an explicit **ship or hold** — a bug nobody
owns is a bug nobody fixes, and this list exists because we had error signal
nobody was reading.

Timebox each section. If a discussion runs long, that is a signal to file it
and move on, not to spend the whole slot on one item.

---

## 0. Before you start (2 min)

Open these five tabs:

| What | Where |
| --- | --- |
| Sentry — inspector-client | [issues](https://mcpjam-gh.sentry.io/issues/?project=inspector-client) |
| Sentry — inspector-server | [issues](https://mcpjam-gh.sentry.io/issues/?project=inspector-server) |
| Sentry — inspector-electron | [issues](https://mcpjam-gh.sentry.io/issues/?project=inspector-electron) |
| PostHog — Error Tracking | [issues](https://us.posthog.com/project/212744/error_tracking) |
| PostHog — rageclicks (below) | saved insight |

Sentry also receives events from the Convex backend via the
[Convex→Sentry integration](https://convex.dev/can-do/sentry) — check that
project too when server-side backend errors are in scope.

---

## 1. New Sentry issues (10 min)

Filter each of the three projects to `is:unresolved firstSeen:-7d`, sorted by
**users affected** — not by event count. One user hitting something 4,000
times is a retry loop; 400 users hitting something once is a broken feature,
and the second one matters more.

For each issue, in order, until one applies:

- **Not real** (bot, scanner, a `deployment: self_hosted` misconfiguration we
  can't act on) → resolve, or add to `ignoreErrors` in
  `shared/sentry-config.ts` if it will recur.
- **Real and small** → assign an owner, ship this week.
- **Real and large** → assign an owner, file it, explicitly **hold**. Say out
  loud what would make it urgent.

Use the `deployment` tag. `hosted` means we broke it and we can fix it today.
`self_hosted` means someone's own environment, which changes both the urgency
and the fix.

> **Don't skip inspector-server.** It reported nothing at all until the
> Sentry init was fixed, so anything there is genuinely new information.

---

## 2. PostHog error-tracking issues (5 min)

Same triage, different population: these are the client `$exception` events
from hosted + desktop. Cross-check against Sentry — an issue in both is a
strong signal it's real; an issue in only PostHog is often a surface that
Sentry's `ignoreErrors` filters.

---

## 3. Hosted rageclick trend (5 min)

The number to watch, not a list to read. Is it going up or down week over
week? If a single element dominates, that element is the agenda item.

```sql
SELECT
  properties.$el_text AS element,
  properties.$pathname AS path,
  count() AS clicks,
  count(DISTINCT person_id) AS people
FROM events
WHERE event = '$rageclick'
  AND properties.$host = 'app.mcpjam.com'
  AND timestamp > now() - INTERVAL 7 DAY
GROUP BY element, path
ORDER BY people DESC
LIMIT 20
```

Swap `$rageclick` for `$dead_click` for the quieter version — things that look
clickable and do nothing.

A rageclick hotspot is almost always a missing pending state. The OAuth
Continue button was 211 rageclicks across 67 people, and the fix was showing
"Continuing..." while the request was in flight.

---

## 4. One worst-session replay (5 min)

**Watch exactly one.** Pick the session with the most rageclicks, or one
attached to a top issue. Watch it end to end without narrating.

This is the only item that reliably produces surprises, because it is the only
one that shows you what the user was *trying* to do. It is also the easiest to
skip — don't.

Replay is hosted + packaged desktop only, and credential surfaces are masked
(see `docs/session-replay-masking.md`).

---

## 5. PMF survey verbatims (3 min)

Read the new free-text responses. No action required most weeks; you are
listening for a phrase that repeats.

---

## Leaving the meeting

Every item touched is in one of exactly three states:

- **Shipping this week** — has an owner and an issue.
- **Held** — has an owner, an issue, and a stated reason.
- **Closed** — resolved or ignored, deliberately.

"We looked at it" is not one of the three.

---

## What this is measured on

After two weeks, these should be true:

- The doc has been used in a real review, not just merged.
- Every open Sentry issue in the three projects has an owner.
- Hosted rageclick trend and error-tracking issue count are numbers someone
  can recite.

If none of that is true after a month, the meeting isn't working — change it
or drop it rather than letting it become a ritual.
