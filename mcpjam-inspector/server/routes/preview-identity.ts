import { createHmac } from "node:crypto";
import type { Hono } from "hono";

/**
 * Lets the preview router (preview-router/, serving *.mcpjam.dev) prove it is
 * talking to one of OUR PR previews before it forwards anything to it,
 * including the sign-in callback, which carries an authorization code.
 *
 * A preview runs at a Railway name like mcp-inspector-pr-123.up.railway.app.
 * Once the preview is deleted, anyone can create a Railway service that gets
 * that same name, so the router never trusts the name alone. It sends a
 * random nonce here and expects
 * HMAC-SHA256(PREVIEW_EDGE_SECRET, `${nonce}:${RAILWAY_PUBLIC_DOMAIN}`).
 * Binding the answer to this process's own Railway domain means one live
 * preview can't answer on behalf of another name.
 *
 * Mounted only when PREVIEW_EDGE_SECRET and RAILWAY_PUBLIC_DOMAIN are both
 * set. CI sets the secret on PR previews only; everywhere else the path 404s
 * like any unknown route. Outside /api on purpose: the router calls it
 * without a session, and sessionAuthMiddleware only guards /api/*.
 */
export const PREVIEW_IDENTITY_PATH = "/__mcpjam/preview-identity";
export const PREVIEW_NONCE_HEADER = "x-mcpjam-preview-nonce";

// The router sends a UUID. Anything else is refused rather than signed.
const NONCE_PATTERN = /^[A-Za-z0-9-]{16,128}$/;

export function previewIdentityProof(
  secret: string,
  nonce: string,
  domain: string,
): string {
  return createHmac("sha256", secret)
    .update(`${nonce}:${domain}`)
    .digest("hex");
}

export function registerPreviewIdentityRoute(
  app: Hono,
  env: NodeJS.ProcessEnv = process.env,
) {
  const secret = env.PREVIEW_EDGE_SECRET;
  const domain = env.RAILWAY_PUBLIC_DOMAIN?.toLowerCase();
  if (!secret || !domain) return;

  app.get(PREVIEW_IDENTITY_PATH, (c) => {
    const nonce = c.req.header(PREVIEW_NONCE_HEADER) ?? "";
    if (!NONCE_PATTERN.test(nonce)) {
      return c.text("missing or malformed nonce", 400, {
        "Cache-Control": "no-store",
      });
    }
    return c.text(previewIdentityProof(secret, nonce, domain), 200, {
      "Cache-Control": "no-store",
    });
  });
}
