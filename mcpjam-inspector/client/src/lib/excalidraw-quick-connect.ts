import type { ServerFormData } from "@/shared/types.js";

/**
 * Hardcoded Excalidraw server config for the App Builder first-run quick-connect flow.
 * This fallback ensures auto-connect works even when registry metadata is unavailable.
 *
 * Name follows the `getRegistryServerName()` convention: "${displayName} (App)".
 */
export const EXCALIDRAW_SERVER_CONFIG: ServerFormData = {
  name: "Excalidraw (App)",
  type: "http",
  url: "https://mcp.excalidraw.com/mcp",
  useOAuth: false,
};

export const EXCALIDRAW_SERVER_NAME = "Excalidraw (App)";
