---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

Report the saved environment targets when creating an eval suite with a client. The public create response now returns `hosts: []` for environment-backed suites; read `environmentIds` for their saved execution targets.
