---
"@mcpjam/inspector": patch
---

`/api/v1` accepts a judge model written as `mcpjam/<vendor>/<model>`, the spelling the SDK and CLI document for MCPJam-hosted models, and stores it as the catalog id `<vendor>/<model>`. A suite file, suite settings edit or per-run judge override that used it was refused with "is not in MCPJam's hosted model catalog".
