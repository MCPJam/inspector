import type { Hono } from "hono";
import {
  getXaaDebugClientMetadata,
  XAA_DEBUG_CLIENT_ID_METADATA_URL,
} from "@mcpjam/sdk";

/** Exact public path of the XAA debugger's Client ID Metadata Document.
 * Outside /api on purpose: sessionAuthMiddleware only guards /api/* paths,
 * and the target authorization server must fetch this anonymously. */
export const XAA_CLIENT_METADATA_PATH =
  "/.well-known/oauth/xaa-client-metadata.json";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

/**
 * Registers GET + OPTIONS for the XAA Client ID Metadata Document
 * (draft-ietf-oauth-client-id-metadata-document-02). Requirements the
 * contract tests pin:
 *  - a DIRECT 200 (never a redirect — the AS must not follow one),
 *  - Content-Type application/json,
 *  - client_id exactly equal to the FIXED production URL, even when a local
 *    dev server serves the handler — the URL IS the client identity, and a
 *    localhost variant would be a different (unreachable) client.
 *
 * This is a separate client identity from the login document served by
 * mcpjam-webapp at www.mcpjam.com — changing that one's grants would change
 * the authorization-code login client.
 */
export function registerXaaClientMetadataRoute(app: Hono) {
  app.get(XAA_CLIENT_METADATA_PATH, (c) =>
    c.json(
      {
        client_id: XAA_DEBUG_CLIENT_ID_METADATA_URL,
        ...getXaaDebugClientMetadata({ tokenEndpointAuthMethod: "none" }),
      },
      200,
      {
        ...CORS_HEADERS,
        "Cache-Control": "public, max-age=3600",
      },
    ),
  );

  app.options(XAA_CLIENT_METADATA_PATH, (c) => c.body(null, 204, CORS_HEADERS));
}
