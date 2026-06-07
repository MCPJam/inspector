---
"@mcpjam/sdk": minor
---

eval reporter: send {hostConfig, hostConfigHash} on /sdk/v1/evals/* when backend advertises `evalsHostConfig` (Stage 5 Step 3).

Reporter probes `GET /sdk/v1/info` lazily (cached per baseUrl, fail-safe to "no capability"). When backend supports it AND iteration host snapshots are homogeneous, sends a normalized + content-hashed host config alongside results. Source order: `iteration.hostSnapshot` → `executor.getHostSnapshot?.()` → `MCPJamReportingConfig.host`. Heterogeneous per-iteration snapshots omit the run-level field (per-iteration wire support is a later stage). Old backends are unaffected.
