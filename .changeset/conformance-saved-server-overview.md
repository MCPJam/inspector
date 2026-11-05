---
"@mcpjam/inspector": patch
---

Fix CQT-92 and CQT-105: show saved Conformance results for every project server after refresh, navigation, or OAuth return, including disconnected servers. Use the same saved server list when editing connection settings.

Keep Conformance links open while the feature flag loads, so refreshing no longer sends enabled users to Home.

Show a loading screen on private Conformance pages until the flag resolves, preventing checks from starting before access is known. Shared result links stay available.

Keep connected runtime-only servers available in the local setup picker and connection settings, including when there is no active project.
