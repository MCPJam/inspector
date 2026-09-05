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
  if (matrix.cspConnectDomains) Object.freeze(matrix.cspConnectDomains);
  if (matrix.cspResourceDomains) Object.freeze(matrix.cspResourceDomains);
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
  // The everything-on baseline; MCPJam itself declares them.
  safeAreaInsets: true,
  widgetDisplayModeRequests: "accept",
});

/** Claude web — full bridge surface with probe-captured CSP behavior. */
export const MCP_APPS_CLAUDE: McpAppsCapabilities = frozen({
  ...MCP_APPS_FULL,
  availableDisplayModes: ["inline", "fullscreen"],
  cspFrameDomains: false,
  cspBaseUriDomains: false,
  cspConnectDomains: { fetch: true, xhr: true, websocket: true },
  cspResourceDomains: {
    script: true,
    stylesheet: true,
    image: true,
    font: true,
    media: true,
  },
  requestTeardown: false,
  // Measured 2026-09-02: a uniform 12px inset on every edge.
  safeAreaInsets: true,
});

/**
 * ChatGPT — full bridge surface with probe-captured CSP behavior.
 *
 * `connect-src` is ONE directive, so its three subtypes cannot diverge. The
 * 2026-08-19 probe declared `wss://ws.postman-echo.com` and it connected while
 * the undeclared `wss://echo.websocket.org` took a real connect-src violation
 * — no host baseline carries a Postman echo endpoint, so ChatGPT honors the
 * declared connect list. The fetch/xhr canary that passed (`unpkg.com`) is in
 * ChatGPT's own baseline allowlist, which the catalog row carries as
 * `cspDirectives`; it is not evidence the declaration was ignored.
 *
 * The 2026-08-23 paired probe (captured 2026-08-24Z) declared
 * `fastly.jsdelivr.net`, outside that baseline, and every declared resource
 * subtype loaded in the treatment fixture, so the resource declaration is
 * honored.
 */
export const MCP_APPS_CHATGPT: McpAppsCapabilities = frozen({
  ...MCP_APPS_FULL,
  cspConnectDomains: { fetch: true, xhr: true, websocket: true },
  cspResourceDomains: {
    script: true,
    stylesheet: true,
    image: true,
    font: true,
    media: true,
  },
  downloadFile: false,
  requestTeardown: false,
  // Unmeasured — no capture carries ChatGPT's hostContext, so this
  // preserves the emulator's existing behavior rather than inventing a
  // measurement. Its catalog row is deliberately absent for the same reason.
  safeAreaInsets: true,
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
  // Measured 2026-09-02: the key is absent from hostContext entirely.
  safeAreaInsets: false,
});

/** Cursor 3.14.27 probe — full minus updateModelContext + message. */
export const MCP_APPS_CURSOR: McpAppsCapabilities = frozen({
  ...MCP_APPS_FULL,
  availableDisplayModes: ["inline"],
  updateModelContext: false,
  message: false,
  cspConnectDomains: { fetch: true, xhr: true, websocket: true },
  cspResourceDomains: {
    script: true,
    stylesheet: true,
    image: true,
    font: true,
    media: true,
  },
  // Both explicit false per the catalog row this matrix mirrors. downloadFile
  // was flipped 2026-08-26: it is absent from Cursor's hostCapabilities.
  downloadFile: false,
  requestTeardown: false,
  // Measured 2026-09-02: the key is absent from hostContext entirely.
  safeAreaInsets: false,
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
  cspConnectDomains: { fetch: false, xhr: false, websocket: false },
  cspResourceDomains: {
    script: false,
    stylesheet: false,
    image: false,
    font: false,
    media: false,
  },
  resourcePrefersBorder: true,
  downloadFile: false,
  requestTeardown: false,
  // Unmeasured; preserves the emulator's existing behavior.
  safeAreaInsets: true,
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
  // Unmeasured; preserves the emulator's existing behavior.
  safeAreaInsets: true,
  widgetDisplayModeRequests: "accept",
});

/** Slackbot — probe-captured from Slackbot's `ui/initialize` (2026-06-24). No
 * updateModelContext / message / downloadFile; no pip. Mirrors the slack host
 * template's `mcpAppsOverrides` in `seed-host-template.ts`. */
export const MCP_APPS_SLACK: McpAppsCapabilities = frozen({
  availableDisplayModes: ["inline", "fullscreen"],
  toolInputPartial: false,
  toolCancelled: false,
  hostContextChanged: false,
  resourceTeardown: false,
  toolInfo: true,
  openLinks: true,
  serverTools: true,
  serverResources: true,
  logging: true,
  updateModelContext: false,
  message: false,
  sandboxPermissions: false,
  cspFrameDomains: false,
  cspBaseUriDomains: false,
  resourcePrefersBorder: false,
  downloadFile: false,
  requestTeardown: false,
  // Measured 2026-09-03, both themes: the key is absent entirely.
  safeAreaInsets: false,
  widgetDisplayModeRequests: "accept",
});

/** VS Code 1.130.0 — captured from a live VS Code MCP Apps host probe on
 * 2026-07-23. Advertises inline-only display, typed updateModelContext,
 * downloadFile, and host-context changes. Unexercised behavior deliberately
 * retains the existing emulator defaults. */
export const MCP_APPS_VSCODE: McpAppsCapabilities = frozen({
  availableDisplayModes: ["inline"],
  toolInputPartial: true,
  toolCancelled: true,
  hostContextChanged: true,
  resourceTeardown: true,
  toolInfo: false,
  openLinks: true,
  serverTools: true,
  serverResources: true,
  logging: true,
  updateModelContext: true,
  message: false,
  sandboxPermissions: true,
  cspFrameDomains: true,
  cspBaseUriDomains: true,
  resourcePrefersBorder: true,
  downloadFile: true,
  requestTeardown: true,
  // Measured 2026-09-02: the key is absent from hostContext entirely.
  safeAreaInsets: false,
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
  // No MCP Apps view at all, so no hostContext to carry them.
  safeAreaInsets: false,
  widgetDisplayModeRequests: "accept",
});
