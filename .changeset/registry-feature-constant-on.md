---
"@mcpjam/inspector": patch
---

Let the Registry tab load data: `REGISTRY_FEATURE_ENABLED` is now `true`.

The tab has two independent gates. The PostHog `registry-enabled` flag decides
who can reach the route; a build-time constant in `useRegistryServers` decided
whether the data layer did anything at all. With the constant `false` the hooks
were fully inert — empty arrays, no fetches, no-op mutations — so a user who had
the flag turned on reached `/registry` and was told "No servers available" by a
screen that had never asked.

The constant existed for a real reason: the flag gates the route, not the data,
so an internal user with the flag on mounted the tab and fired requests at a
backend that wasn't ready, producing visible errors. Its comment named the exit
condition — flip once the registry backend is ready for real use — and that
condition is now met. The curated registry is seeded, and the Claude connectors
directory carries ~2,000 rows synced daily, with search over names, descriptions
and tool names.

Nothing else changes. The PostHog flag is untouched and still decides the
audience, which today is internal users only. Both halves of the tab share this
one constant, so they light up together rather than leaving a directory querying
beside a dark curated catalog.

The constant should not survive long. It duplicates a control that is better at
the job — `registry-enabled` is per-user and needs no deploy, while this needs a
build to move, so a real emergency reaches for the flag every time — and it is
what currently forces two `useRegistryServers` suites to `describe.skip`.
Removing it means deleting the `enabled` plumbing in both hooks and un-skipping
those suites, which is a small refactor deliberately kept out of this change so
that reverting "turn it on" never means reverting the refactor too.
