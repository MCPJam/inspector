---
"@mcpjam/inspector": minor
---

### `@mcpjam/inspector`
- **Resource-meta interpretation gates (PR D of the foundation series)**: the SEP-1865 MCP Apps matrix now also gates how the renderer interprets resource `_meta.ui.*` fields. Four dimensions wired: (1) `cspFrameDomains: false` strips `widgetCsp.frameDomains` before the sandbox resolver sees it; (2) `cspBaseUriDomains: false` strips `widgetCsp.baseUriDomains`; (3) `sandboxPermissions: false` ignores the widget-declared permissions entirely (Microsoft 365 Copilot doesn't pipe `_meta.ui.permissions` to the iframe); (4) `resourcePrefersBorder: false` ignores `_meta.ui.prefersBorder`, so the iframe chrome falls back to host-default rendering regardless of the widget hint. SDK helpers (`resolveSandboxCsp` / `resolveSandboxPermissions`) are unchanged — the gates post-process the resource declaration on the renderer side (foundation plan's D3 decision: no SDK API change). 4 new renderer tests cover Copilot stripping + Claude pass-through for both CSP sub-fields and permissions; existing iframe-chrome rendering covers `prefersBorder` through the existing `matrixGatedPrefersBorder` derivation.
