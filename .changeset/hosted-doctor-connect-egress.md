---
"@mcpjam/inspector": patch
---

Check the hosted doctor's target before anything dials it.

The guarded `fetchFn` the doctor route passes covers the probe's requests and nothing else. `runServerDoctor` records a failed probe and connects anyway, and that connection goes out over an MCP transport that takes no fetch — so a target the guard refused was still dialed a moment later by the connection step, on hosted, for whoever holds a bearer token. Pointing a server row at `http://169.254.169.254/mcp` got a refused probe and a connect attempt against the metadata endpoint.

The route now runs `assertAllowedHostedTargetUrl` on the resolved server URL before `runServerDoctor` is called at all — the same check the conformance routes make, with the same split between a blocked address (400, the caller's problem) and a resolver failure (503, ours). Outside hosted mode it is a no-op, so local and LAN doctor runs are unchanged.
