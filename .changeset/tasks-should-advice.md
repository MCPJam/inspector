---
"@mcpjam/sdk": patch
"@mcpjam/cli": patch
---

Tasks conformance: two of the extension's SHOULDs now show as advice instead of check warnings — a failed task with no `statusMessage`, and `tasks/update` or `tasks/cancel` answering an unknown task id with something other than -32602. They are labeled SHOULD and cost no points for now.
