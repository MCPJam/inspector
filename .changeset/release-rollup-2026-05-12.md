---
"@mcpjam/inspector": patch
"@mcpjam/sdk": minor
---

Inspector + SDK rollup since the last release.

**@mcpjam/sdk (new matchers + eval reporting types)**

- Add `matchers` exports for the new SDK matchers used by evals (M1 phase 1).
- Add layered match options and run-level validator override types (M1 evals).

**@mcpjam/inspector**

- Hot fix: resolves "unknown IP" guest-session bug.
- Evals: layered match options + run-level validator overrides.
- Evals M1: SDK matchers + diff rendering + p50/p95 percentiles.
- Evals M1 phase 2: N-iterations picker and save-from-chat into tests.
- MCP apps: profile-driven `hostCapabilities` with user-saved overrides; advertise MCP app message capabilities.
- Electron: redirect OAuth flows to the system browser; include `@ngrok/ngrok` in the packaged app so tunnels work; guard `autoUpdater` renderer messaging against destroyed windows.
- Billing: compare-plans table now reads "Unlimited" for servers-per-project on free; cleaner member/invite copy on the billing UI.
- TypeScript hygiene: cleared all production `tsc` errors, enforce typecheck in CI, and added a `typecheck:client` script.
