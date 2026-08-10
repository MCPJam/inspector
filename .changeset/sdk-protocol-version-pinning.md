---
"@mcpjam/sdk": minor
---

Propose the pinned protocol version on `initialize`, and say which versions a client advertises.

A host config could pin a protocol version, but the client still opened with the head of its accept-list and let negotiation land wherever it landed — so a pin was a preference the handshake didn't state. `MCPClientManager` now hoists the pinned version to the front of the proposal while keeping the rest as fallbacks, so the server sees what was asked for and a mismatch still degrades instead of failing. A pin outside the accept-list is left untouched rather than silently rewritten.

Seed host templates and the generated host-compat catalog now declare `supportedProtocolVersions` for the clients that really do ship a single version (`2025-11-25` for Claude, ChatGPT, Cursor and Copilot); MCPJam's own host stays list-free, meaning unrestricted. The canonicalizer no longer derives that list from a pin — an absent list stays absent, which keeps canonical host hashes stable across the default paths.
