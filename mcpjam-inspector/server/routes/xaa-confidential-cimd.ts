import type { Hono } from "hono";
import type { Context } from "hono";
import {
  decodeConfidentialCimdKey,
  getXaaDebugClientMetadata,
  XAA_CONFIDENTIAL_CIMD_PATH_PREFIX,
} from "@mcpjam/sdk";

/**
 * Stateless confidential-CIMD reflector. The client encodes its PUBLIC key in
 * the URL; this route decodes it and echoes it into a `private_key_jwt` Client
 * ID Metadata Document. Each key → a unique HTTPS URL, with no server storage.
 * The client proves ownership by signing a `client_assertion` with the matching
 * private key (which never leaves the client). Public/anonymous (outside /api),
 * DIRECT 200, no redirects — the authorization server fetches it itself.
 *
 * `client_id` is the exact URL this document was fetched from (proxy-forwarded
 * headers honored), so it byte-matches the URL the client presented — CIMD
 * requires `doc.client_id === fetched URL`. Deriving it from the request is safe
 * here (unlike the sibling public doc's fixed identity): the URL contains the
 * key, so a spoofed host just produces a non-matching client_id and fails; only
 * the private-key holder can authenticate.
 */
export const XAA_CONFIDENTIAL_CIMD_ROUTE = `${XAA_CONFIDENTIAL_CIMD_PATH_PREFIX}:key`;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

// A base64url EC P-256 JWK is well under 1 KB; cap the segment to reject abuse.
const MAX_KEY_SEGMENT = 2048;

/** The public URL this request was served at (Cloudflare/Vercel-forwarded). */
function requestClientId(c: Context): string {
  const url = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto") ?? url.protocol.replace(/:$/, "");
  const host =
    c.req.header("x-forwarded-host") ?? c.req.header("host") ?? url.host;
  return `${proto}://${host}${url.pathname}`;
}

export function registerXaaConfidentialCimdRoute(app: Hono) {
  app.get(XAA_CONFIDENTIAL_CIMD_ROUTE, (c) => {
    const key = c.req.param("key");
    if (!key || key.length > MAX_KEY_SEGMENT) {
      return c.json({ error: "invalid_client_metadata_key" }, 400, CORS_HEADERS);
    }
    const jwk = decodeConfidentialCimdKey(key);
    if (!jwk) {
      return c.json({ error: "invalid_client_metadata_key" }, 400, CORS_HEADERS);
    }
    return c.json(
      {
        client_id: requestClientId(c),
        ...getXaaDebugClientMetadata({
          tokenEndpointAuthMethod: "private_key_jwt",
          jwks: { keys: [jwk] },
        }),
      },
      200,
      {
        ...CORS_HEADERS,
        "Cache-Control": "public, max-age=3600",
        // client_id is derived from the forwarded host/proto, so the cached
        // body varies by them: without Vary a shared/CDN cache could serve one
        // request's client_id to a different host and fail the RAS's
        // `doc.client_id === fetched URL` equality check.
        Vary: "X-Forwarded-Host, X-Forwarded-Proto",
      },
    );
  });

  app.options(XAA_CONFIDENTIAL_CIMD_ROUTE, (c) =>
    c.body(null, 204, CORS_HEADERS),
  );
}
