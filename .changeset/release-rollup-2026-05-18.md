---
"@mcpjam/inspector": patch
"@mcpjam/sdk": minor
---

Inspector + SDK rollup since the last release.

**@mcpjam/sdk**

- New `normalizeWidgetCspMeta` export and hardening of CSP/runtime-head helpers used by the ChatGPT widget surface (#2149, #2153).

**@mcpjam/inspector**

- Clients (formerly Hosts) tab: canvas redesign as a single host matrix with diagram color tokens, snappier Servers→Host transition, host routes, and Rename Hosts→Clients in UI (#2126, #2128, #2132, #2133, #2136).
- Playground / Chat: new IDE-style Playground tab, renamed to Chat with NEW announcement, refactored Chat UX, chatbox surface, playground routing, evals host config override, and copilot/cursor animation with thread-color abstraction (#2121, #2129, #2130, #2131, #2135, #2138, #2144).
- React Router v7 shell + path-based navigation adapter (#2115).
- Sandbox: model real-host iframe attributes via 3 new sandbox config fields; stop pre-populating `restrictTo` and hide safe-default sandbox rows (#2142, #2143).
- ChatGPT client: patches CSP and addresses follow-up CSP review feedback; fix auto-create client (#2147, #2149, #2153, #2154).
- Tool approvals: default Require tool approval off in client templates; fix tool approvals (#2146, #2150).
- Host previews and theming: read global theme on host creation + icons, fix system-prompt race, align previewed-host scope across surfaces, hide per-server OAuth errors in playground Tools tab, revert per-client primary color (#2134, #2139, #2140, #2141).
- Servers spinner held across sign-out gap with snap-to-Servers on project switch; don't send org id from inspector; don't error on invite when guest/UI changes on org modal (#2123, #2125, #2127).
- Electron: Squirrel + update detector (#2114).
- PostHog instrumentation for Clients feature launch (#2137).
