---
"@mcpjam/inspector": minor
---

XAA debugger: the client registration strategy (Pre-registered / CIMD / DCR) is now chosen in the "Configure Server to Test" modal and persisted per-server, instead of a session-only band on the flow.

- The modal gains a **Registration** selector (Pre-registered → CIMD → DCR, per MCP authorization guidance) and collapses its Advanced (issuer + simulated identity) section by default, matching the OAuth debugger's layout. Client ID is required only for the pre-registered strategy; DCR mints a client and CIMD addresses it by metadata URL, so both leave it optional.
- The chosen strategy is saved on the server config (`xaaRegistrationStrategy`) and rehydrated when editing. Non-debugger (Connect-page) saves preserve it rather than erasing it, and unknown persisted values fall back to pre-registered.
- An explicit DCR/CIMD choice is now honored even when the server has a stored client secret: the run ignores the stored pre-registered credentials and establishes its own dynamic client identity.
- The on-flow strategy band is removed. DCR's mid-run "Register another client" recovery (the only action that clears the duplicate-registration risk gate) remains, shown contextually.

Requires the matching `xaaRegistrationStrategy` column + mutation validators in the backend (deploy first).
