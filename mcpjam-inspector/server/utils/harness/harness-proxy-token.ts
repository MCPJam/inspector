/**
 * Harness MCP proxy token — VERIFY side (inspector / data plane).
 *
 * The token is MINTED by Convex (`/web/harness/mcp-proxy-token`, bearer-authed —
 * Convex knows the user, so the identity is authoritative and baked in), exactly
 * like computers mint terminal tokens. The inspector only VERIFIES it here,
 * REUSING the existing shared `COMPUTERS_TERMINAL_TOKEN_SECRET` (the distinct
 * `purpose` claim isolates it from terminal tokens — no new deployment secret).
 * HS256, fail-closed.
 *
 * HAND-MIRRORED CONTRACT: this verifier must agree byte-for-byte with the Convex
 * signer (`mcpjam-backend/convex/lib/harnessMcpProxyToken.ts`) — same claim
 * shape, issuer, purpose, and base64url(JWT) encoding — or it will reject
 * legitimate tokens. (Node `createHmac` and Convex `crypto.subtle` produce the
 * identical HMAC-SHA256 bytes for the same secret + signing input.)
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const ISSUER = "https://api.mcpjam.com/harness-mcp-proxy";
const PURPOSE = "harness-mcp-proxy";
const MIN_SECRET_LENGTH = 16;

/** Claims a route gets back from a verified token. `externalId` + `orgId` drive
 *  the hosted route's acting-as authorize; the local route ignores them. */
export interface HarnessMcpProxyClaims {
  userId: string;
  externalId: string;
  orgId: string;
  projectId: string;
  serverId: string;
}

function getSecret(): string {
  // Reuse the computer-terminal token secret (already on both sides); the
  // purpose claim isolates harness-mcp tokens from terminal tokens.
  const secret = process.env.COMPUTERS_TERMINAL_TOKEN_SECRET?.trim();
  if (!secret) {
    throw new Error(
      "harness-proxy-token: COMPUTERS_TERMINAL_TOKEN_SECRET is not set on this deployment",
    );
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `harness-proxy-token: COMPUTERS_TERMINAL_TOKEN_SECRET must be at least ${MIN_SECRET_LENGTH} characters`,
    );
  }
  return secret;
}

/**
 * Verify a Convex-minted token and that it was minted for exactly `serverId`.
 * Returns the claims, or `null` for anything wrong (missing/weak secret,
 * malformed, tampered signature, wrong issuer/purpose, wrong serverId, expired).
 * Never throws.
 */
export function verifyHarnessProxyToken(
  token: string | undefined | null,
  serverId: string,
  opts: { nowMs?: number } = {},
): HarnessMcpProxyClaims | null {
  if (!token) return null;
  let secret: string;
  try {
    secret = getSecret();
  } catch {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  if (!h || !p || !s) return null;

  const expected = createHmac("sha256", secret).update(`${h}.${p}`).digest();
  let given: Buffer;
  try {
    given = Buffer.from(s, "base64url");
  } catch {
    return null;
  }
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return null;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (payload.iss !== ISSUER || payload.purpose !== PURPOSE) return null;
  for (const k of ["sub", "ext", "org", "projectId", "serverId"] as const) {
    if (typeof payload[k] !== "string" || (payload[k] as string).length === 0) {
      return null;
    }
  }
  if (payload.serverId !== serverId) return null;
  if (typeof payload.exp !== "number") return null;
  if (Math.floor((opts.nowMs ?? Date.now()) / 1000) > payload.exp) return null;

  return {
    userId: payload.sub as string,
    externalId: payload.ext as string,
    orgId: payload.org as string,
    projectId: payload.projectId as string,
    serverId: payload.serverId as string,
  };
}
