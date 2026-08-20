---
"@mcpjam/inspector": minor
---

Add the Claude connectors directory to the Registry tab — ~2,000 mirrored
entries, searchable, alongside MCPJam's curated catalog.

Ships DARK. The whole section is behind the two gates the Registry tab already
has: the `registry-enabled` PostHog flag and the `REGISTRY_FEATURE_ENABLED`
constant. Flipping them is a separate decision. It also needs the matching
backend deployment (`searchCatalogServers`, `getProjectCatalogConnections`, and
`connectCatalogServer`'s `{serverId, serverName}` return) plus its column
backfill; until those land the queries do not resolve.

The curated registry is ~21 cards MCPJam stands behind. The directory is a
daily mirror of Anthropic's public one — two orders of magnitude larger, and
nothing we vouch for. So it is a SEPARATE section with its own search box and
tier filter, not a longer grid: a catalog that size is not browsable, and
folding it into the curated one would quietly restate 2,000 upstream listings
as recommendations.

About a dozen connectors are in both. The curated card wins: the directory row
is hidden, and the agent's connect resolves curated-first for the same reason —
installing the mirrored copy of a server we curate would drop the transport
config we maintain for it.

**Connecting is mutation-first.** The backend validates the endpoint, refuses a
withdrawn listing, dedupes against an existing connection, writes the audit
event and creates the server row — all before anything can redirect the
browser. The curated flow does the reverse and writes its provenance from a
later effect keyed on React state, which an OAuth redirect destroys; this
ordering cannot lose it. Success means INSTALLED, not connected: the live
connection is client-initiated as always, and the card reads `added` from the
connection rows but `connecting` / `connected` / `error` from the live servers
map.

Auth is probed, never assumed. The connect runs `authMethod: "auto"` —
unauthenticated first, OAuth escalation on a 401, with a confirmation before
the redirect — rather than deriving OAuth from the directory's `is_authless`
flag, which is upstream metadata that can be stale. A stale `true` would
otherwise produce a server that silently never authorizes.

Some entries cannot be connected from a card alone, and each says so in its own
words: a multi-region connector opens a picker of its published endpoints, and
one that runs on your own instance asks for that URL and shows the pattern it
has to match. The client checks the pattern to save you a round trip; the
server re-checks it and its refusal is what you see. If the listing has moved
on since the page loaded, the retry re-seeds from the server's answer rather
than the stale card.

Icons come from third-party CDNs, so they load lazily, send no referrer, and
fall back to a placeholder rather than leaving a hole.

For the agent: `ui_connect_registry_server` now resolves directory entries too,
and reports `endpoint_choice_required` or `authorization_required` instead of
starting anything that would redirect the browser mid-turn — a URL only the
person can choose is never guessed. One new read-only tool,
`ui_search_registry_directory`, types into the screen's own search box so the
model and the person are looking at the same results. The snapshot gains a
bounded `directory` block carrying names, tiers and statuses — never an
endpoint URL, same redaction rule as the curated half.

The verified check mark is now shared between both halves, and its fill moved
from a hardcoded light-theme hex to `fill-primary`, so it tracks the palette
and is legible in dark mode.
