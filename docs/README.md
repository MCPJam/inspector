# MCPJam docs

The public documentation at [docs.mcpjam.com](https://docs.mcpjam.com), built
with [Mintlify](https://mintlify.com). Pages are `.mdx`; navigation lives in
`docs.json`.

> **Everything in this directory is published.** Mintlify serves every
> `.md`/`.mdx` here at its path unless `.mintignore` excludes it; `docs.json`
> controls navigation and search, not reachability. A file with no nav entry
> still has a working URL. Do not write anything here you would not put on the
> marketing site: no unreleased product names, no feature-flag keys, no
> customer names, no internal hostnames, no references to the backend repo.
>
> Notes for MCPJam engineers (design docs, plans, runbooks, architecture) go in
> [`internal-docs/`](../internal-docs) at the repo root, which Mintlify never
> reads. The GitHub repo is public, so that folder is off the docs site, not
> private.

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

So a beta whose availability is decided per organization gets no page until
that decision goes away. Its API routes are correspondingly kept out of
`reference/openapi.json` and listed in the Inspector's `KNOWN_UNDOCUMENTED`
baseline, where the reason is written down. Look there — not here — for which
surfaces are currently in that state: the baseline is version-controlled next
to the routes, whereas naming them in this file would publish the answer.

The same applies to a feature behind a feature flag that is on only for
MCPJam staff or a few accounts. Document it when it is on for everyone the
page is for.

Pages describe what a user can do and observe. How MCPJam is built (module
paths, storage, design rationale, contributor steps) belongs in
`internal-docs/`.

### Every page needs a nav entry

A page that no `docs.json` entry points at is absent from navigation and
search, so only someone who already has the URL will reach it. Add the nav
entry in the same change as the page.

## The API reference is generated from a checked-in spec

`reference/openapi.json` is hand-authored and guarded by
`mcpjam-inspector/server/routes/v1/__tests__/openapi-drift.test.ts`, which
fails when the Inspector serves a route the spec does not describe (or
describes one it does not serve). Edit the spec in the same change as the
route; the test is what stops the two drifting.

Each endpoint page's URL is `/api-reference/{tag}/{summary}`, slugged from the
operation's first tag and its summary — so renaming either moves the page.
`reference/published-api-pages.json` lists every URL the spec has ever
produced, and `mcpjam-inspector/server/routes/v1/__tests__/api-reference-urls.test.ts`
fails until a new page is added to it, or until a URL the spec no longer
produces has a redirect in `docs.json` to the page that replaced it.

Treat a red run as blocking even though CI will not: the test runs in the
`Inspector Tests` shards, and the checks `main` requires are `Build and Test`
and `Run Tests`. A rename that breaks URLs goes red but can still be merged.

The ledger is append-only. Never drop a row, including when resolving a merge
conflict in it — a URL that was ever published must keep resolving.
