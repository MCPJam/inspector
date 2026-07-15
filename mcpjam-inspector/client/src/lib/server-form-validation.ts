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
      return "Command is required for STDIO connections";
    }
    return null;
  }
  if (!formData.url || formData.url.trim() === "") {
    return "URL is required for HTTP connections";
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(formData.url);
  } catch (err) {
    return `Invalid URL format: ${formData.url} ${err}`;
  }
  if (HOSTED_MODE && parsedUrl.protocol !== "https:") {
    return "Hosted mode requires HTTPS server URLs";
  }
  return null;
}
