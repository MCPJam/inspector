# MCPJam docs

The public documentation at [docs.mcpjam.com](https://docs.mcpjam.com), built
with [Mintlify](https://mintlify.com). Pages are `.mdx`; navigation lives in
`docs.json`.

## Local preview

```sh
npm i -g mint
mint dev        # run from this directory (the one with docs.json)
```

`mint update` refreshes the CLI if a page renders differently here than in
production.

## What belongs here — and what does not

### Public docs are the one surface a feature flag cannot gate

A Mintlify page is visible to everyone the moment it merges. There is no
per-organization view of it, so **a feature that is enforced per organization
must not be documented until the flag comes off.** Documenting it early means
telling most readers about something they will get an error from.

That is why Swarms and user-testing scenarios have no pages yet even though
their API routes exist: `sandboxes-enabled` gates them server-side. The routes
are correspondingly absent from `reference/openapi.json` and listed in the
Inspector's `KNOWN_UNDOCUMENTED` baseline with that reason.

For a feature that IS live but only enabled for some accounts, use an
availability `<Note>` at the top of the page — `inspector/plugins.mdx`,
`inspector/computer.mdx` and `inspector/skills.mdx` all carry one. Say what is
gated and what the reader would see if it is not on for them.

### `contributing/` is deliberately not in the nav

Those nine pages are internal architecture notes — how the eval pipeline is
put together, how the MCP client manager works, how OAuth flows through the
app. They are written for someone changing MCPJam, not someone using it, and
publishing them would put implementation detail in a customer's search results
and commit us to keeping it accurate for an audience that will never read it.

They stay in this repo because they render nicely and are easy to link from a
PR. If one becomes genuinely useful to a user, the fix is to rewrite it for
that audience and add it to the nav — not to add it as-is.

**Everything else with no nav entry is a bug**, not a policy. An `.mdx` file
outside `contributing/` that no `docs.json` entry points at is unreachable: it
does not appear in navigation or in search, and only someone who already knows
the URL will find it. Four pages sat in that state — multi-server connections,
tracing & debugging, the docs MCP server, and contributing a host preset — all
current, all effectively invisible.

## The API reference is generated from a checked-in spec

`reference/openapi.json` is hand-authored and guarded by
`mcpjam-inspector/server/routes/v1/__tests__/openapi-drift.test.ts`, which
fails when the Inspector serves a route the spec does not describe (or
describes one it does not serve). Edit the spec in the same change as the
route; the test is what stops the two drifting.
