---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Hosted mode can reach the private MCP servers and model endpoints an operator lists in `MCPJAM_PRIVATE_EGRESS_ALLOWLIST`, a comma-separated list of CIDRs and host suffixes. Cloud metadata, link-local and unspecified addresses stay refused whatever the list says, and a list with an invalid entry admits nothing. The pinned streaming transport takes an `admitPrivateDestination` option that every redirect hop is checked against.
