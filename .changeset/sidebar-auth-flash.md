---
"@mcpjam/inspector": patch
---

Fix the sidebar flashing a signed-out layout while authentication is still resolving. The sidebar and user section now hold their rendering until auth state settles, avoiding a brief flicker on load.
