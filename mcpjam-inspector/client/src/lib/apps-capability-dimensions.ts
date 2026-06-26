/**
 * Shared display tables for the SEP-1865 Apps capability surface.
 *
 * Single source of truth for the per-dimension keys, labels, and
 * descriptions used by BOTH the host-config editor (`AppsExtensionTab`)
 * and the host comparison matrix (`host-config-field-schema`). Keeping
 * them here keeps the editor's matrix and the comparison rows in lockstep.
 */

import type {
  McpAppsCapabilities,
  OpenAiAppsCapabilities,
} from "@/lib/client-styles";

/** Boolean MCP Apps spec-bridge dimensions (excludes the two non-boolean fields). */
export type McpAppsDimensionKey = Exclude<
  keyof McpAppsCapabilities,
  "availableDisplayModes" | "widgetDisplayModeRequests"
>;

/** Per-dimension matrix metadata. Description is shown on row hover. */
export type McpAppsDimensionMeta = {
  key: McpAppsDimensionKey;
  description: string;
};

/** All boolean MCP Apps matrix dimensions in display order. */
export const MCP_APPS_DIMENSIONS: McpAppsDimensionMeta[] = [
  {
    key: "toolInputPartial",
    description:
      "Send ui/notifications/tool-input-partial while the agent streams arguments",
  },
  {
    key: "toolCancelled",
    description:
      "Notify the app when tool execution is cancelled (ui/notifications/tool-cancelled)",
  },
  {
    key: "hostContextChanged",
    description:
      "Notify the app when theme, display mode, or other host context changes",
  },
  {
    key: "resourceTeardown",
    description: "Send ui/resource-teardown before destroying the app view",
  },
  {
    key: "serverResources",
    description: "Advertise resources/read proxy capability in ui/initialize",
  },
  {
    key: "logging",
    description: "Accept notifications/message log calls from the app",
  },
  {
    key: "toolInfo",
    description: "Include calling-tool metadata in HostContext.toolInfo",
  },
  {
    key: "openLinks",
    description: "Advertise ui/open-link capability",
  },
  {
    key: "serverTools",
    description: "Advertise tools/call proxy capability",
  },
  {
    key: "updateModelContext",
    description: "Accept ui/update-model-context requests from the app",
  },
  {
    key: "message",
    description:
      "Accept ui/message requests that add content to the conversation",
  },
  {
    key: "downloadFile",
    description: "Accept ui/download-file requests from the app",
  },
  {
    key: "requestTeardown",
    description:
      "Honor ui/notifications/request-teardown by unmounting the app",
  },
  {
    key: "sandboxPermissions",
    description: "Honor _meta.ui.permissions when configuring the iframe",
  },
  {
    key: "cspFrameDomains",
    description: "Honor _meta.ui.csp.frameDomains for nested iframes",
  },
  {
    key: "cspBaseUriDomains",
    description: "Honor _meta.ui.csp.baseUriDomains in CSP",
  },
  {
    key: "resourcePrefersBorder",
    description: "Honor _meta.ui.prefersBorder when rendering app chrome",
  },
];

/** `window.openai.*` shim methods. Order matches Copilot's published table. */
export const OPENAI_APPS_METHOD_LABELS: Array<{
  key: keyof OpenAiAppsCapabilities;
  label: string;
}> = [
  { key: "callTool", label: "callTool" },
  { key: "sendFollowUpMessage", label: "sendFollowUpMessage" },
  { key: "setWidgetState", label: "setWidgetState" },
  { key: "requestDisplayMode", label: "requestDisplayMode" },
  { key: "notifyIntrinsicHeight", label: "notifyIntrinsicHeight" },
  { key: "openExternal", label: "openExternal" },
  { key: "setOpenInAppUrl", label: "setOpenInAppUrl" },
  { key: "requestModal", label: "requestModal" },
  { key: "uploadFile", label: "uploadFile" },
  { key: "selectFiles", label: "selectFiles" },
  { key: "getFileDownloadUrl", label: "getFileDownloadUrl" },
  { key: "requestCheckout", label: "requestCheckout" },
  { key: "requestClose", label: "requestClose" },
];

export const ALL_DISPLAY_MODES = ["inline", "fullscreen", "pip"] as const;
export type DisplayMode = (typeof ALL_DISPLAY_MODES)[number];
