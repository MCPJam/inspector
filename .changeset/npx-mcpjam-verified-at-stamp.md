---
"@mcpjam/inspector": patch
---

The MCPJam client's "Verified" date now moves in `npx` releases too.

That date is special-cased for the MCPJam row: because the profile describes
this app, `resolveVerifiedAt` prefers a build-time stamp over the host
catalog's hand-stamped date. Only the webapp deploy wrote that stamp, so
app.mcpjam.com showed the date of its last deploy while `npx @mcpjam/inspector`
fell back to the catalog date — 2026-07-23 at the time of writing — and stayed
there until someone re-stamped the catalog by hand.

The release workflow now writes the same stamp before building the inspector
tarball, so a fresh `npx` run reports the release it is actually running.
Both workflows call one shared script rather than each inlining its own.

Local, desktop, and non-production builds are unchanged: they still show the
catalog's date.
