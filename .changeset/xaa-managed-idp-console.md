---
"@mcpjam/inspector": minor
---

XAA managed-IdP console: setup center, managed debugger mode, and per-subject policy testing.

- **Setup center:** manage the org's test people, resource-app connections, and access policy from one place. Resource apps can be registered by picking an existing server from the workspace instead of re-entering its details.
- **Debugger managed mode:** the XAA debugger can run against the managed issuer with the org roster, showing stage-aware outcomes (granted / downscoped / denied with the issuer's reason) at each step of the flow.
- **"Run as" people:** pick a test identity and run the full flow as that subject to verify per-person policy decisions. Projects can set a default test identity in settings, with an atomic per-server override; the debugger resolves server override → project default.
- The separate `xaa-registration` feature flag is retired — registration now rides the main `xaa` flag.
