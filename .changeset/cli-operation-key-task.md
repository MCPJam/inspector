---
"@mcpjam/cli": patch
---

`tools call` refuses `--operation-key` together with `--task`: the task call path does not carry the key, so a retried write would not apply once.
