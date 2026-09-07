---
"@mcpjam/inspector": patch
---

Settings you cannot use now say why instead of vanishing

**Three different problems looked identical: an empty space.** The suite
settings sheet gated Computer environment on a PostHog flag, the Schedule on
another, and GitHub Checks on a backend availability read — and every refusal
produced the same result, a row that simply was not on the page. A missing
permission, a feature the organization does not have, and a flag service that
could not be reached need three different next steps, and a person told to
configure a setting they cannot find has no way to tell which one they are
looking at.

Those rows now render disabled with the reason underneath, read from the
backend's per-suite capabilities: "Not enabled for this organization", "Not
available for this account", "Not available on this deployment", "You don't
have permission to change this". A flag service that could not answer says
"Could not check availability right now", deliberately not the same sentence as
a flag that said no — collapsing the two is how a temporary outage teaches
somebody their organization lacks a feature it has.

**The GitHub Checks row used to disappear when its own read failed.** That read
refuses rather than answers for a caller the backend will not confirm an
organization to, and the error boundary around it rendered nothing. It now
renders the row, disabled, saying it could not be loaded — and still reports
the caught error, because silence was always the UI choice and never the
telemetry one.

**Nothing gets worse on an older backend.** The capabilities query fails soft:
a deployment that predates it, or a suite this person cannot see, produces
`unavailable`, and every row falls back to exactly the gate it had before.
Capabilities make the page more honest; they never make it less usable than the
page that had none.
