---
"@mcpjam/inspector": patch
---

Ask for a GitHub check's outage policy when a repository is connected, and
connect through the server-verified action.

Connecting now goes to `github/checkRepoConfigsNode:connectVerifiedRepo`, which
proves the pinned installation can actually reach the repository before any
config row is written and stamps the installation id server-side. Both connect
surfaces — Settings → Integrations → GitHub and the suite's own "run this on
every pull request" section — use it, so nothing in Inspector calls the
unverified `github/checkRepoConfigs:connectRepo` mutation any more and it can be
removed in the follow-up backend deploy. The client never names an installation
id: which installation can reach a repository is a server-side fact, and a
client that could name one is a client that could name the wrong one.

The outage policy is now an explicit onboarding choice rather than an assumed
default. Neither value is preselected and Connect stays disabled until
repository, suite and policy are all chosen, because a preselected policy
records a decision nobody made. Both options are described before the choice:
fail open reports the check as neutral during an MCPJam outage or pause, fail
closed reports it as failed. Neither description promises a merge outcome —
MCPJam decides the check's conclusion, and whether a failed or neutral check
blocks merging is the repository's branch-protection setting, which MCPJam can
neither read nor set.

Connected rows gain a policy control and keep the distinction visible. A row
connected before the policy existed shows "Policy not chosen" and says that it
effectively fails open, rather than rendering `fail_open` as though it had been
selected — those two rows behave identically today and are not the same thing.
Choosing a value on such a row records it. The control is disabled while its
write is in flight and a duplicate change is dropped until it settles, tracked
separately from the enable toggle so one control never freezes the other.

Rows also show live repository visibility, joined case-insensitively to the
installation listing. Only an explicit `private` boolean produces a badge:
a repository GitHub returned without the flag, one absent from the current
listing, a listing still loading and a listing that failed all render no badge
at all, because none of them is evidence that a repository is public.
Visibility is never persisted — it can change under a connected repository at
any time — and a connected repository missing from the listing keeps its row.
