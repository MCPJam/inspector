---
"@mcpjam/sdk": patch
---

Host configs can declare `safeAreaInsets` support.

`McpAppsCapabilities` and `mcpAppsCapabilitiesSchema` gain the optional field,
the nine bundled `MCP_APPS_*` capability presets declare it, and the host-config
canonicalizer accepts the key so it survives hashing.

Stored host-config hashes are unaffected: the previous canonicalizer THREW on
this key, so no stored configuration can contain one. Six bundled host templates
that now set it are content-addressed afresh. An SDK at 8.6.0 or earlier still
rejects a host config carrying the field, so upgrade readers before writers.
