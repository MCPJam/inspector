---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

Move the framework-free `iframe-sandbox-policy` module into the
`@mcpjam/sdk/widget-runtime` subpath (Tier B Phase 2). The deterministic outer
iframe `sandbox=` / `allow=` attribute builders (`DEFAULT_IFRAME_SANDBOX`,
`buildOuterAllowAttribute`, `buildOuterSandboxAttribute`,
`resolveIframeSandboxPolicy`) now live in the SDK so the production renderer and
the eval browser harness share one source of truth. The permissions input uses a
local structural `IframeSandboxPermissions` type (the real
`McpUiResourcePermissions` is structurally assignable), so the module stays
dependency-free and the published `.d.ts` resolves cleanly for NodeNext
consumers. The inspector's `client/src/lib/mcp-ui/iframe-sandbox-policy.ts` is
now a thin back-compat re-export shim, so existing import paths are unchanged. No
behavior change.
