---
"@mcpjam/sdk": patch
"@mcpjam/cli": patch
---

`update_eval_suite` forwards `expectedRevisionNumber`

**The compare-and-set was accepted and then dropped.** `update_eval_suite`
took an `expectedRevisionNumber`, and the SDK, the CLI and MCP all documented it
as the way to refuse an edit against a suite that had moved on. The PATCH body
was built from a fixed list of settings keys that did not include it, so the
number never left the process and every edit was last-write-wins — with no
error to say so. The body now carries `expectedRevisionNumber` whenever it is
given, so a stale revision is refused with a 409 having written nothing, as the
description always said.
