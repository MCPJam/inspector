---
"@mcpjam/cli": minor
"@mcpjam/sdk": minor
---

A composed eval run now has to say which servers it is testing

`--compose-host chatgpt` recorded only the CLIENT. The server half was resolved at run
time from that host's current list, so pointing the shared ChatGPT host at a different
server silently repointed every eval composed against it — a suite written for Vercel
would connect to Sentry, run its cases there, and report a real score for a server it
was never meant to test. Nothing errored, because nothing was wrong as far as the run
could tell.

Composed runs now require `--compose-server <name>` (or `--compose-server-group <id>`).
Following the host's live list is still available as `--compose-host-servers`, which is
the same behaviour as before — the difference is that it is now something you ask for
rather than what you get by saying nothing.

Existing scripts that pass `--compose-host` alone will fail with a message naming both
flags. Saved environments, journeys and user-testing scenarios are unaffected.
