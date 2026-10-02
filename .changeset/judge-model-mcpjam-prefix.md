---
"@mcpjam/inspector": patch
---

`/api/v1` accepts a judge model written as `mcpjam/<vendor>/<model>`, the spelling the SDK and CLI document for MCPJam-hosted models, and stores it as the hosted catalog id `<vendor>/<model>`. A suite file, suite settings edit or per-run judge override that used it was refused with "is not in MCPJam's hosted model catalog". Only an exact catalog id is rewritten; any other value is sent as typed. Judge model ids are now trimmed, and a blank one is refused instead of stored. Changing the judge model over `PATCH` no longer fails on a suite whose judge was picked in the app.
