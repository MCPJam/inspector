---
"@mcpjam/sdk": minor
---

Mock servers are available through `PlatformApiClient` and five operations: `create_mock_server` (from a saved server or from nothing), `update_mock_server` (a whole definition or a merge patch against `expectedVersion`; an identical retry returns the same version, a stale one reports the head), `get_mock_server` (a small read: version, base, forwarding policy, counts and changed paths), `get_mock_forwarding_policy` and `set_mock_forwarding_policy` (workspace admins only). All of them answer to the `mock-servers-enabled` flag.
