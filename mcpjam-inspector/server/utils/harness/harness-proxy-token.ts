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
  /**
   * The eval scope this token was authorized for, when it carries one.
   *
   * The evidence write path requires it: a proxied `tools/call` is recorded
   * against an iteration only because the CONTROL PLANE put that iteration on
   * the token, having checked the run is this caller's, running, on a
   * proxy-delivering harness. Absent means playground traffic — nothing to
   * record, and nothing claiming otherwise.
   *
   * The pair is surfaced only when BOTH claims are well-formed. A half-present
   * pair is dropped rather than partly returned: a caller seeing an iteration
   * id treats it as authorized scope, so handing one back without the run it
   * was checked against is the single shape that could turn a malformed token
   * into a trusted claim.
   */
  runId?: string;
  iterationId?: string;
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

/** The HS256 payload of a Convex-minted token, or `null` when the signature fails. */
function verifiedPayload(
  token: string | undefined | null,
): Record<string, unknown> | null {
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

  try {
    const payload: unknown = JSON.parse(
      Buffer.from(p, "base64url").toString("utf8"),
    );
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
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
  const payload = verifiedPayload(token);
  if (!payload) return null;
  if (payload.iss !== ISSUER || payload.purpose !== PURPOSE) return null;
  for (const k of ["sub", "ext", "org", "projectId", "serverId"] as const) {
    if (typeof payload[k] !== "string" || (payload[k] as string).length === 0) {
      return null;
    }
  }
  if (payload.serverId !== serverId) return null;
  if (typeof payload.exp !== "number") return null;
  // JWT NumericDate semantics: the token is expired AT `exp`, not after it.
  if (Math.floor((opts.nowMs ?? Date.now()) / 1000) >= payload.exp) return null;

  const runId = payload.runId;
  const iterationId = payload.iterationId;
  const evalScope =
    typeof runId === "string" &&
    runId.length > 0 &&
    typeof iterationId === "string" &&
    iterationId.length > 0
      ? { runId, iterationId }
      : {};

  return {
    userId: payload.sub as string,
    externalId: payload.ext as string,
    orgId: payload.org as string,
    projectId: payload.projectId as string,
    serverId: payload.serverId as string,
    ...evalScope,
  };
}

const SESSION_PURPOSE = "harness-mcp-session";

/** A lane's session handle for one server: identity only, no turn authority. */
export interface HarnessMcpSessionClaims {
  userId: string;
  externalId: string;
  orgId: string;
  projectId: string;
  serverId: string;
  laneId: string;
  connectionId?: string;
}

/**
 * Verify a lane's session handle (`/web/harness/session-state/bind-turn`).
 *
 * It carries no expiry on purpose: a runtime that fingerprints its MCP
 * configuration must see the same handle on every turn. So it proves identity
 * only, and every request it rides on must also find the lane's live turn.
 */
export function verifyHarnessSessionHandle(
  token: string | undefined | null,
  serverId: string,
): HarnessMcpSessionClaims | null {
  const payload = verifiedPayload(token);
  if (
    !payload ||
    payload.iss !== ISSUER ||
    payload.purpose !== SESSION_PURPOSE ||
    payload.serverId !== serverId
  )
    return null;
  const field = (key: string) => {
    const value = payload[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  };
  const [userId, externalId, orgId, projectId, laneId] = [
    "sub",
    "ext",
    "org",
    "projectId",
    "lane",
  ].map(field);
  if (!userId || !externalId || !orgId || !projectId || !laneId) return null;
  const connectionId = payload.acct === undefined ? undefined : field("acct");
  if (connectionId === null) return null;
  return {
    userId,
    externalId,
    orgId,
    projectId,
    serverId,
    laneId,
    ...(connectionId ? { connectionId } : {}),
  };
}
