import { HOSTED_MODE } from "../config.js";
import {
  getConfiguredInspectorServiceToken,
  INSPECTOR_SERVICE_TOKEN_HEADER,
} from "../middleware/internal-service-auth.js";

/**
 * The tokenizer credential is runtime server configuration, never a VITE_ env
 * value. All tokenizer callers use this fixed backend destination; neither a
 * request URL nor incoming headers can select the credential's recipient.
 * Local/self-hosted and Electron callers keep the anonymous lane.
 */
export function fetchTokenizerCount(
  text: string,
  model: string,
): Promise<Response> {
  const configuredUrl = process.env.CONVEX_HTTP_URL;
  if (!configuredUrl) throw new Error("CONVEX_HTTP_URL is not set");
  const url = new URL(configuredUrl);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("CONVEX_HTTP_URL must be a backend origin");
  }
  url.pathname = "/tokenizer/count";

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (HOSTED_MODE && !process.versions.electron && url.protocol === "https:") {
    const token = getConfiguredInspectorServiceToken();
    if (token) headers[INSPECTOR_SERVICE_TOKEN_HEADER] = token;
  }

  return fetch(url.href, {
    method: "POST",
    headers,
    body: JSON.stringify({ text, model }),
    // Custom service headers can survive cross-origin redirects. Never follow
    // one, even for a tokenless caller; existing callers fall back without retry.
    redirect: "error",
  });
}
