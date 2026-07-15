import type { Hono } from "hono";
import type { Context } from "hono";
import {
  decodeConfidentialCimdKey,
  getConfidentialCimdReflectorMetadata,
  XAA_CONFIDENTIAL_CIMD_PATH_PREFIX,
} from "@mcpjam/sdk";
import { getClientIp } from "../utils/client-ip.js";

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
 *
 * IMPORTANT — the reflected identity is EXPLICITLY UNTRUSTED and UNBRANDED.
 * Anyone can publish an arbitrary public key here, so the document must not
 * carry MCPJam branding (name/logo/uri): possession proves control of the
 * client_id, never that MCPJam issued or endorses the client. The decoder also
 * strictly validates an exact public P-256 JWK and strips any private/unknown
 * members, so the reflector can only ever serve a clean public key.
 */
export const XAA_CONFIDENTIAL_CIMD_ROUTE = `${XAA_CONFIDENTIAL_CIMD_PATH_PREFIX}:key`;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

// A base64url EC P-256 JWK is well under 1 KB; cap the segment to reject abuse.
const MAX_KEY_SEGMENT = 2048;

// The reflector's key space is unbounded and anonymous. A per-IP sliding window
// caps single-IP enumeration (cache-fill / amplification). The limit is
// deliberately generous: a legitimate shared authorization server behind one
// egress IP may fetch many DISTINCT client documents in a burst, so 600/min
// (10/s) leaves ample headroom while still bounding a lone abuser. In-memory is
// sufficient — the response is a pure function of the URL, so a multi-instance
// deployment just gets a proportionally higher aggregate limit.
const RATE_LIMIT = 600;
const RATE_WINDOW_MS = 60_000;
// Hard cap on tracked IPs so IP churn (spoofed/rotated sources) can't grow the
// map without bound; at the cap, a brand-new IP fails closed (429).
const MAX_TRACKED_IPS = 10_000;
const ipWindows = new Map<string, { count: number; windowStart: number }>();

const rateCleanup = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of ipWindows) {
    if (now - entry.windowStart > RATE_WINDOW_MS * 2) ipWindows.delete(ip);
  }
}, 5 * 60_000);
rateCleanup.unref?.();

export function resetXaaConfidentialCimdRateLimitForTests(): void {
  ipWindows.clear();
}

/** Returns true when the caller is over budget for the current window. Uses the
 * trusted client-IP resolution (cf-connecting-ip / x-real-ip before the
 * client-mutable x-forwarded-for) so the key can't be trivially spoofed. */
function isRateLimited(c: Context): boolean {
  const ip = getClientIp(c) ?? "unknown";
  const now = Date.now();
  const entry = ipWindows.get(ip);
  if (entry && now - entry.windowStart < RATE_WINDOW_MS) {
    if (entry.count >= RATE_LIMIT) return true;
    entry.count++;
    return false;
  }
  // New window for this IP. Bound the map: if it's full and this is a genuinely
  // new key, fail closed rather than admit unbounded growth under IP churn.
  if (!entry && ipWindows.size >= MAX_TRACKED_IPS) return true;
  ipWindows.set(ip, { count: 1, windowStart: now });
  return false;
}

/**
 * The public origin this request was served at (Cloudflare/Vercel-forwarded).
 * Exported so the endpoint that MINTS a confidential client_id URL uses the same
 * origin derivation the reflector uses when it ECHOES client_id — otherwise the
 * minted URL and the reflected `client_id` wouldn't byte-match.
 */
export function confidentialCimdPublicOrigin(c: Context): string {
  const url = new URL(c.req.url);
  const proto =
    c.req.header("x-forwarded-proto") ?? url.protocol.replace(/:$/, "");
  const host =
    c.req.header("x-forwarded-host") ?? c.req.header("host") ?? url.host;
  return `${proto}://${host}`;
}

/** The public URL this request was served at (Cloudflare/Vercel-forwarded). */
function requestClientId(c: Context): string {
  return `${confidentialCimdPublicOrigin(c)}${new URL(c.req.url).pathname}`;
}

export function registerXaaConfidentialCimdRoute(app: Hono) {
  app.get(XAA_CONFIDENTIAL_CIMD_ROUTE, (c) => {
    if (isRateLimited(c)) {
      return c.json({ error: "rate_limited" }, 429, CORS_HEADERS);
    }
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
        ...getConfidentialCimdReflectorMetadata({ keys: [jwk] }),
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
