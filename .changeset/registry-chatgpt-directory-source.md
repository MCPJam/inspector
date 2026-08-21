---
"@mcpjam/inspector": minor
---

Add the ChatGPT app directory beside the Claude one in the Registry tab, behind
a source facet.

Ships DARK, behind the same two gates as the Claude half: the
`registry-enabled` PostHog flag and the `REGISTRY_FEATURE_ENABLED` constant. It
also needs the matching backend (`chatgpt-directory` rows, the `authPosture`
search filter, `getCatalogSourceStatus`, and `connectCatalogServer`'s new
`outcome` field); until that deploys the facet has nothing to show.

**One directory at a time, Claude by default.** The backend's browse and search
are source-scoped index reads, so a merged "both" mode would be a second query
and a merge with no defensible ordering. The facet is also how a person says
which catalog they are looking at, which the cards cannot state as clearly.

**"Listed in ChatGPT" is provenance, not endorsement.** OpenAI accepting a
submission is not a verification tier of ours, so ChatGPT rows carry no tier and
the tier filter is hidden entirely for that source — an always-empty filter
reads as "this directory has no partners", which would be a claim we invented.

**Rows with no endpoint are shown, disabled, with a reason.** About 37% of the
ChatGPT directory is a hosted server OpenAI proxies and never publishes a URL
for. Those are ingested — the census is the point — and rendered as
non-connectable cards. The copy keys on the row's `unavailableReason`, not on
`endpointKind === 'none'`, because that kind used to mean exactly one thing:
"a local desktop extension". Telling someone their SaaS connector is a desktop
extension sends them looking for an installer that does not exist.

**Connecting the same server from both directories collapses.** The backend
dedupes by canonical endpoint across sources and hands back the existing
connection; the UI says "Already connected via the Claude directory" rather
than silently doing nothing. Listing overlap still shows both cards — dual
listing is a signal — and only connect collapses.

A **Connectable only** toggle hides the rows that cannot be installed. It is
off by default — hiding a third of a catalog before anyone asked would make the
directory look smaller than it is — and it filters in the QUERY rather than on
the page, because filtering a page after it arrives returns short pages and
eventually blank ones.

Each source shows its own "as of" date, taken from the upstream scrape time
rather than our ingest time: uploading a Tuesday sweep on Friday makes the
catalog Tuesday-fresh, and saying Friday would overstate it by three days. The
Claude feed syncs daily; the ChatGPT one is a manual weekly upload, so
staleness there is an expected condition and worth surfacing.

Agent surface: `ui_search_registry_directory` gains an optional `source`
(omitted leaves the user's current view alone, so a model that does not know
there are two cannot silently switch it), and `ui_snapshot_app`'s `directory`
block reports the source, the as-of date, and `connectable: false` with the
reason for rows that cannot be installed. Still no endpoint URLs in the
snapshot.

`useClaudeDirectory` is now `useServerDirectory`; it was never going to stay
Claude-only.
