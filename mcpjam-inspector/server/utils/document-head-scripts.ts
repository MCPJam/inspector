import type { Context } from "hono";
import { getInspectorClientRuntimeConfigScript } from "../env.js";
import { withScriptNonce } from "../middleware/security-headers.js";
import { buildAnalyticsConsentScript } from "./analytics-consent.js";

/** The config scripts every app document carries, written before `</head>`. */
export function injectDocumentConfigScripts(
  html: string,
  c: Context,
  nonce: string,
): string {
  const scripts = [
    getInspectorClientRuntimeConfigScript(),
    buildAnalyticsConsentScript(c),
  ]
    .flatMap((script) => (script ? [withScriptNonce(script, nonce)] : []))
    .join("");
  return html.replace("</head>", `${scripts}</head>`);
}
