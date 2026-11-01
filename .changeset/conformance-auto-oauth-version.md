---
"@mcpjam/inspector": patch
---

Conformance: with Protocol set to Auto, the OAuth suite now runs at the protocol version your server picked when it connected, instead of always 2025-11-25. Servers that only speak 2026-07-28 no longer fail OAuth with "Unsupported protocol version".
