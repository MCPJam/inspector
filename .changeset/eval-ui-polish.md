---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Inspector updates:

- Polish the Evaluate surface: refreshed empty hero, suite list sidebar, suite header, dashboard, executions overview, run insights and metrics charts
- Gate the Evaluate tab and flask buttons behind the `evaluate-ui` flag, and gate suite creation
- Improve test generation, with safer empty server/client handling and a clearer tooltip on the create-suite dialog
- New tool-calls diff view and the Excalidraw quickstart cases for the eval surface
