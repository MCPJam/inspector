// The SandboxedIframe double-iframe component relocated to @mcpjam/widget-react
// (Tier B Phase 3d-ii-c). Re-exported here so existing
// `@/components/ui/sandboxed-iframe` import sites are unchanged. The component
// no longer reads `@/lib/config` directly — `hostedMode` / `sandboxOrigin` are
// props the widget host supplies (`host.surface.hostedMode` / `.sandboxOrigin`).
export {
  SandboxedIframe,
  type SandboxedIframeHandle,
} from "@mcpjam/widget-react";
