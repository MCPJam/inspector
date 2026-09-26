---
"@mcpjam/inspector": patch
---

Benchmark cells run through project environments. When the claim pins an environment to a cell, the bench worker launches that environment ephemerally instead of the cell's legacy client pin. A claim from an older backend still launches the pinned client.
