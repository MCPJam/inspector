import type { McpAppsCapabilities } from "../host-config/types.js";

/**
 * SEP-1865 MCP Apps capability matrices per host, relocated from the inspector
 * (`client/src/lib/client-styles/built-ins.ts`) so the SDK owns the
 * compatibility facts. These are the SAME presets the playground uses to
 * emulate each host, so the verdict never drifts from the emulation.
 *
 * Best-effort: probe-captured or vendor-published where noted in the inspector;
 * treat as starting points. The compat engine reads only the boolean capability
 * dimensions (serverTools, message, …); display-mode / behavior keys are carried
 * for fidelity but don't affect verdicts.
 *
 * Exported deeply frozen: `buildMarketHostProfiles` reads these module-level
 * constants, so a consumer mutating one (they're shared) would otherwise poison
 * verdicts process-wide. Callers needing to edit one should copy it first.
 */
function frozen(matrix: McpAppsCapabilities): McpAppsCapabilities {
  if (Array.isArray(matrix.availableDisplayModes)) {
    Object.freeze(matrix.availableDisplayModes);
  }
  return Object.freeze(matrix);
}

/** Full surface — every dimension on. Claude's baseline. */
export const MCP_APPS_FULL: McpAppsCapabilities = frozen({
  availableDisplayModes: ["inline", "fullscreen", "pip"],
  toolInputPartial: true,
  toolCancelled: true,
  hostContextChanged: true,
  resourceTeardown: true,
  toolInfo: true,
  openLinks: true,
  serverTools: true,
  serverResources: true,
  logging: true,
  updateModelContext: true,
  message: true,
  sandboxPermissions: true,
  cspFrameDomains: true,
  cspBaseUriDomains: true,
  resourcePrefersBorder: true,
  downloadFile: true,
  requestTeardown: true,
  widgetDisplayModeRequests: "accept",
});

/** ChatGPT — full minus serverResources + logging. */
export const MCP_APPS_CHATGPT: McpAppsCapabilities = frozen({
  ...MCP_APPS_FULL,
  serverResources: false,
  logging: false,
});

/** Mistral Le Chat — Apps-side `ui/initialize` evidence (no pip / download / teardown). */
export const MCP_APPS_MISTRAL: McpAppsCapabilities = frozen({
  ...MCP_APPS_FULL,
  availableDisplayModes: ["inline", "fullscreen"],
  toolCancelled: false,
  resourceTeardown: false,
  toolInfo: false,
  cspFrameDomains: false,
  cspBaseUriDomains: false,
  resourcePrefersBorder: false,
  downloadFile: false,
  requestTeardown: false,
});

/** Cursor 3.4.17 probe — full minus updateModelContext + message. */
export const MCP_APPS_CURSOR: McpAppsCapabilities = frozen({
  ...MCP_APPS_FULL,
  updateModelContext: false,
  message: false,
});

/** Goose Desktop 1.38.0 capture — only openLinks (+ toolInfo) advertised. */
export const MCP_APPS_GOOSE: McpAppsCapabilities = frozen({
  availableDisplayModes: ["inline", "fullscreen", "pip"],
  toolInputPartial: false,
  toolCancelled: false,
  hostContextChanged: false,
  resourceTeardown: false,
  toolInfo: true,
  openLinks: true,
  serverTools: false,
  serverResources: false,
  logging: false,
  updateModelContext: false,
  message: false,
  sandboxPermissions: false,
  cspFrameDomains: false,
  cspBaseUriDomains: false,
  resourcePrefersBorder: false,
  downloadFile: false,
  requestTeardown: false,
  widgetDisplayModeRequests: "accept",
});

/** Microsoft 365 Copilot — published component-bridge table. */
export const MCP_APPS_COPILOT: McpAppsCapabilities = frozen({
  availableDisplayModes: ["inline", "fullscreen"],
  toolInputPartial: false,
  toolCancelled: false,
  hostContextChanged: false,
  resourceTeardown: false,
  toolInfo: false,
  openLinks: true,
  serverTools: true,
  serverResources: false,
  logging: false,
  updateModelContext: true,
  message: true,
  sandboxPermissions: false,
  cspFrameDomains: false,
  cspBaseUriDomains: false,
  resourcePrefersBorder: false,
  downloadFile: false,
  requestTeardown: false,
  widgetDisplayModeRequests: "accept",
});

/** Spec-default "no claims" — every advertise key off. Fallback baseline. */
export const MCP_APPS_NO_CLAIMS: McpAppsCapabilities = frozen({
  availableDisplayModes: ["inline"],
  toolInputPartial: false,
  toolCancelled: false,
  hostContextChanged: false,
  resourceTeardown: false,
  toolInfo: false,
  openLinks: false,
  serverTools: false,
  serverResources: false,
  logging: false,
  updateModelContext: false,
  message: false,
  sandboxPermissions: false,
  cspFrameDomains: false,
  cspBaseUriDomains: false,
  resourcePrefersBorder: false,
  downloadFile: false,
  requestTeardown: false,
  widgetDisplayModeRequests: "accept",
});
