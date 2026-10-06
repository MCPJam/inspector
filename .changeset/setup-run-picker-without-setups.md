---
"@mcpjam/inspector": patch
---

Setup Run now shows the "Where it runs" picker (servers, clients and models) for suites that have no environments yet: suites made before environments, and suites your CI reports through the SDK. Before, these showed a placeholder "Suite configuration" row, or, for SDK suites, needed a saved project environment. The run uses a one-run setup and does not change the suite. The picker pre-fills the suite's own server group, its clients (or the project's default client) and the models its cases use. This partly reverses the rule that the run dialog never builds setups from a suite's old fields: those fields only pre-fill pickers you can see and change. SDK suites can still run in a saved environment. In the local inspector, a run of a suite with environments now connects their servers first.
