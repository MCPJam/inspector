---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

Move the framework-free `iframe-sandbox-policy` module into the
`@mcpjam/sdk/widget-runtime` subpath (Tier B Phase 2). The deterministic outer
iframe `sandbox=` / `allow=` attribute builders (`DEFAULT_IFRAME_SANDBOX`,
`buildOuterAllowAttribute`, `buildOuterSandboxAttribute`,
`resolveIframeSandboxPolicy`) now live in the SDK so the production renderer and
the eval browser harness share one source of truth. Added
`@modelcontextprotocol/ext-apps` as an `@mcpjam/sdk` dependency for the
`McpUiResourcePermissions` type the module references. The inspector's
`client/src/lib/mcp-ui/iframe-sandbox-policy.ts` is now a thin back-compat
re-export shim, so existing import paths are unchanged. No behavior change.
