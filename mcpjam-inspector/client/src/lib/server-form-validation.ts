import { HOSTED_MODE } from "@/lib/config";
import { isPrivateNetworkUrl } from "@/shared/private-address";
import type { ServerFormData } from "@/shared/types.js";
import type { ConfidentialCimdCapabilityStatus } from "@/hooks/use-confidential-cimd-capability";

export function validateOAuthClientId(value: string): string | null {
  if (!value || value.trim() === "") {
    return "Client ID is required when using custom credentials";
  }
  return value.length < 3 ? "Client ID must be at least 3 characters" : null;
}

export function validateOAuthClientSecret(value: string): string | null {
  return value && value.trim() === ""
    ? "Client Secret cannot be only whitespace"
    : null;
}

export function getConfidentialCimdBlockReason(
  wantsConfidentialCimd: boolean,
  status: ConfidentialCimdCapabilityStatus,
): string | null {
  if (!wantsConfidentialCimd || status === "ready") return null;
  if (status === "error") {
    return "Confidential CIMD is selected, but its client identity could not be loaded. Retry, or switch Client authentication to Public.";
  }
  if (status === "unavailable") {
    return "Confidential CIMD requires a signed-in organization member and an enabled deployment. Switch to Public or select an organization.";
  }
  return "Preparing the confidential CIMD client identity. Try again in a moment.";
}

export function validateBearerTargetUrl(url: string): string | null {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    // The general form validator owns malformed and missing URL copy.
    return null;
  }

  if (
    parsedUrl.protocol === "https:" ||
    (parsedUrl.protocol === "http:" && isPrivateNetworkUrl(url))
  ) {
    return null;
  }

  return "Bearer tokens require HTTPS for non-local server URLs.";
}

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
