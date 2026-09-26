import { HOSTED_MODE } from "@/lib/config";
import type { ServerFormData } from "@/shared/types.js";

/**
 * Single source of truth for server-config validation, shared by the save
 * path (`use-server-state`) and every form that feeds it (XAAServerModal,
 * the header Active Server selector, ...).
 *
 * Returns a human-readable error message, or null when the config is valid.
 *
 * Keeping ONE implementation is the point: a form must reject exactly what the
 * save path rejects. If a form kept its own copy of these rules and the save
 * path later gained a new one, the form would let the user submit, the dialog
 * would close, and the save would fail downstream — silently discarding
 * everything they typed. Both sides calling this means that can't happen.
 */
export function validateServerFormData(
  formData: ServerFormData,
): string | null {
  if (formData.type === "stdio") {
    if (!formData.command || formData.command.trim() === "") {
      return "Enter the command that starts your STDIO server.";
    }
    return null;
  }
  if (!formData.url || formData.url.trim() === "") {
    return "Enter your server’s URL.";
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(formData.url);
  } catch {
    return "Enter a complete server URL, such as https://example.com/mcp.";
  }
  if (HOSTED_MODE && parsedUrl.protocol !== "https:") {
    return "MCPJam’s hosted web app requires an HTTPS server URL. To connect over HTTP, run npx @mcpjam/inspector@latest on your computer or use the MCPJam desktop app.";
  }
  return null;
}
