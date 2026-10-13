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

const RUN_LOCALLY =
  "run npx @mcpjam/inspector@latest on your computer or use the MCPJam desktop app.";

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
    if (parsedUrl.protocol !== "http:") {
      return "Enter a complete HTTPS server URL, such as https://example.com/mcp.";
    }
    return `MCPJam’s hosted web app requires an HTTPS server URL. To connect over HTTP, ${RUN_LOCALLY}`;
  }
  return null;
}

export const HOSTED_STDIO_ERROR =
  "Connect your STDIO server in MCPJam’s local app. The web app connects to HTTPS servers.";

/**
 * First-run onboarding adds only a server the user typed, never a plugin
 * component, so hosted mode has no runtime that can start its STDIO command.
 * Refuse it here, where the user can still edit the input, instead of letting
 * the connect fail. The shared validator stays permissive because plugin
 * STDIO components do have a hosted runtime.
 */
export function validateFirstRunServerFormData(
  formData: ServerFormData,
): string | null {
  if (HOSTED_MODE && formData.type === "stdio") return HOSTED_STDIO_ERROR;
  return validateServerFormData(formData);
}

export type FirstRunValidationKind = "input" | "hosted-stdio";

export function inferFirstRunTransport(
  input: string,
  current?: "http" | "stdio",
): "http" | "stdio" {
  if (!HOSTED_MODE && current) return current;
  if (/^https?:\/\//i.test(input)) return "http";
  if (!HOSTED_MODE || /\s/.test(input)) return "stdio";
  // Bare hosts need URL guidance; executable paths still belong to STDIO.
  return /^[a-z][a-z\d+.-]*:\/\//i.test(input) ||
    /^(?:localhost|(?:[a-z\d-]+\.)+[a-z\d-]+)(?::\d+)?(?:[/?#]|$)/i.test(input)
    ? "http"
    : "stdio";
}
