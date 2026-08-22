---
"@mcpjam/mcp": patch
---

Partition the three share operations, unbreaking the platform catalog check.

`get_share_settings`, `set_share_mode` and `rotate_share_link` reached the SDK
operation list without being placed on either side of the MCP catalog
partition, so `platformTools.ts` threw "Platform MCP catalog partition drift"
at module load and took three `@mcpjam/mcp` suites down with it.

They are split the way the surrounding entries already split: the read
(`get_share_settings`) joins the catalog, and both writes are excluded.
`set_share_mode` is `risk: 'exposure'` — `anyone_with_link` widens a resource
to every holder of the URL, guests included — and `rotate_share_link` is
`risk: 'destructive'`, immediately locking out everyone holding the old link.
Neither is something an unattended caller should decide. Reading the current
setting tells a caller nothing it could not learn by opening the UI.
