import type { ResolvedOpenAiAppsCapabilities } from "./types";

/**
 * Full `window.openai.*` method surface — every method on, every display
 * mode allowed. This is what ChatGPT (the original Apps SDK host) and the
 * MCPJam dev shim advertise.
 *
 * `selectFiles` is `true` here for type completeness and forward
 * compatibility, but the SDK runtime in
 * `sdk/src/McpAppsOpenAICompatibleRuntime.ts` does NOT install it yet —
 * widgets that feature-detect on it must see `typeof
 * window.openai.selectFiles === "undefined"` to take their fallback path.
 * `setOpenInAppUrl` is implemented by the runtime and host fullscreen
 * chrome.
 */
export const OPENAI_APPS_FULL_SURFACE: ResolvedOpenAiAppsCapabilities = {
  callTool: true,
  sendFollowUpMessage: true,
  setWidgetState: true,
  requestDisplayMode: "all",
  notifyIntrinsicHeight: true,
  openExternal: true,
  setOpenInAppUrl: true,
  requestModal: true,
  uploadFile: true,
  selectFiles: true,
  getFileDownloadUrl: true,
  requestCheckout: true,
  requestClose: true,
};

/**
 * Microsoft 365 Copilot's published per-method surface, verbatim from
 * the "Supported MCP Apps capabilities in Copilot" → "Component bridge"
 * table at
 * https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-mcp-apps
 *
 * Diffs from FULL: `requestDisplayMode` is fullscreen-only;
 * `requestModal`, `uploadFile`, `getFileDownloadUrl`, `requestCheckout`,
 * `selectFiles` are off. Everything else is on.
 */
export const OPENAI_APPS_COPILOT_SURFACE: ResolvedOpenAiAppsCapabilities = {
  callTool: true,
  sendFollowUpMessage: true,
  setWidgetState: true,
  requestDisplayMode: "fullscreen-only",
  notifyIntrinsicHeight: true,
  openExternal: true,
  setOpenInAppUrl: true,
  requestModal: false,
  uploadFile: false,
  selectFiles: false,
  getFileDownloadUrl: false,
  requestCheckout: false,
  requestClose: true,
};

/**
 * The `window.openai` surface of OpenAI's desktop app, shared by ChatGPT
 * Desktop, its work mode and the Codex app: no file upload, file selection,
 * download URLs, checkout, open-in-app URL or height notifications.
 */
export const OPENAI_APPS_DESKTOP_SURFACE: ResolvedOpenAiAppsCapabilities = {
  ...OPENAI_APPS_FULL_SURFACE,
  notifyIntrinsicHeight: false,
  setOpenInAppUrl: false,
  uploadFile: false,
  selectFiles: false,
  getFileDownloadUrl: false,
  requestCheckout: false,
};
