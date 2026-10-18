---
"@mcpjam/sdk": major
"@mcpjam/cli": major
"@mcpjam/vitest": minor
"@mcpjam/inspector": patch
---

Require an online MCPJam login or organization `sk_` API key before every official eval, including BYOK and uploads-off runs. The SDK reads the saved CLI login after explicit credentials and `MCPJAM_API_KEY`; explicit failures never fall back. CI never opens a login browser.

Record one idempotent start per logical run. Only identity, project selection, client version/surface, run-start ID, planned iteration count, provider names, and client-profile usage leave the machine when results remain local. Planned iterations are not completed work or a charge. Analytics opt-out does not disable this request. Bounded retries stop execution on an outage; there is no offline validation cache.

Deploy the backend start-run endpoint before publishing SDK 10, CLI 6, and Vitest 0.3. Earlier package versions retain their existing behavior.
