---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

### `@mcpjam/sdk`
- Gate `window.openai` injection on host config (#2165) — the OpenAI-compatible runtime now reads host capability/profile to decide whether to inject the `window.openai` bridge.
- Consolidate widget renderers into a single MCP-Apps path (#2157) — removes parallel renderer code paths.

### `@mcpjam/inspector`
- **Playground**: MultiHostPicker UI (#2187), multi-host render path + `hostSnapshot` consolidation (#2196), polymorphic compare card + provider lift (#2194), MultiHostPicker chrome alignment (#2197), guard stale history loads (#2189), PostHog launch instrumentation (#2206), removed empty-state subtitle (#2193), fix auto-connect.
- **Apps / widgets**: stabilize widget iframe across first render and history reloads (#2199), correct Copilot template `containerDimensions` + flag guesses (#2191), Permissive toolbar toggle no longer bypasses host-config CSP hardening (#2190), CSP workbench replaces sandbox debug panel with 3-tab UI (#2202), hosted sandbox proxy now served from a distinct origin (#2164).
- **Servers / OAuth**: silently refresh OAuth servers after local-mode page reload (#2208), reset auto-connect attempts on project toggle (#2205), gate Codex MCP primitive loading on connection status (#2207), gate project server queries on user readiness (#2182), route context switches to servers (#2184).
- **Chat / sharing**: per-message sender avatars in shared sessions (#2203), BYOK vault hotfix (#2201).
- **Reliability**: inspector orphan process cleanup (#2195), error on fullscreen (#2181), test OOM fix.
