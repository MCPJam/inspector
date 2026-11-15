# Internal docs

Notes for people changing MCPJam: architecture (`contributing/`), plans,
decisions, runbooks (`ops/`), design notes, and PR or QA screenshots.

Mintlify publishes only `docs/`, so nothing here reaches docs.mcpjam.com. The
GitHub repo is public, though, so this folder is not private. Keep secrets out
of it.

If a note becomes useful to users, rewrite it for them and add it to `docs/`
with a `docs.json` nav entry. Don't copy it over unchanged.

`unreleased/` holds finished docs pages for features that are not yet on for
everyone. When one launches, move its page back into `docs/`, add it to
`docs.json`, and remove the redirect that points its URL elsewhere.
