/**
 * Harness MCP proxy token — VERIFY side (inspector / data plane).
 *
 * The token is MINTED by Convex (`/web/harness/mcp-proxy-token`, bearer-authed —
 * Convex knows the user, so the identity is authoritative and baked in), exactly
 * like computers mint terminal tokens. The inspector only VERIFIES it here, by
 * the algorithm its header names, chosen before any key is:
 *
 *   RS256  against the backend-published JWKS (`/harness/mcp-proxy-jwks`), so
 *          this process holds nothing that can sign one.
 *   HS256  with the shared `COMPUTERS_TERMINAL_TOKEN_SECRET`, only while
 *          `HARNESS_PROXY_ACCEPT_HS256` is not `false`. Each acceptance is
 *          logged (`harness.hs256_credential_accepted`), so the lanes still on
 *          it can be counted before it is turned off.
 *
 * Anything else, `none` included, is refused. Fail-closed.
 *
 * HAND-MIRRORED CONTRACT: this verifier must agree byte-for-byte with the Convex
 * signer (`mcpjam-backend/convex/lib/harnessMcpProxyToken.ts`) — same claim
 * shape, issuer, purpose, and base64url(JWT) encoding — or it will reject
 * legitimate tokens. (Node `createHmac` and Convex `crypto.subtle` produce the
 * identical HMAC-SHA256 bytes for the same secret + signing input.)
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { createJwksPayloadVerifier } from "../computers/jwks-verifier.js";
import { getSystemLogger } from "../request-logger.js";

const ISSUER = "https://api.mcpjam.com/harness-mcp-proxy";
const PURPOSE = "harness-mcp-proxy";
const MIN_SECRET_LENGTH = 16;

const jwks = createJwksPayloadVerifier({
  jwksPath: "/harness/mcp-proxy-jwks",
  label: "harness proxy",
});

export function resetHarnessProxyJwksCacheForTests(): void {
  jwks.resetCacheForTests();
}

/** The algorithm a verified harness credential was signed with. */
export type HarnessCredentialAlg = "HS256" | "RS256";

/** Claims a route gets back from a verified token. `externalId` + `orgId` drive
 *  the hosted route's acting-as authorize; the local route ignores them. */
export interface HarnessMcpProxyClaims {
  userId: string;
  externalId: string;
  orgId: string;
  projectId: string;
  serverId: string;
  /**
   * How the token was signed. An RS256 token is presented to the backend as
   * the caller itself; an HS256 one keeps the synthesized acting-as caller,
   * because the backends that mint it don't take it as a bearer.
   */
  alg?: HarnessCredentialAlg;
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

/** `HARNESS_PROXY_ACCEPT_HS256`; only `false` refuses HS256 credentials. */
export function acceptsHs256HarnessCredentials(): boolean {
  return (
    process.env.HARNESS_PROXY_ACCEPT_HS256?.trim().toLowerCase() !== "false"
  );
}

/** The `alg` a compact JWT's header names, or null when it has none. */
export function harnessCredentialAlg(
  token: string | undefined | null,
): string | null {
  const header = token?.split(".")[0];
  if (!header) return null;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(header, "base64url").toString("utf8"),
    );
    return parsed &&
      typeof parsed === "object" &&
      "alg" in parsed &&
      typeof parsed.alg === "string"
      ? parsed.alg
      : null;
  } catch {
    return null;
  }
}

function getSecret(): string | null {
  const secret = process.env.COMPUTERS_TERMINAL_TOKEN_SECRET?.trim();
  return secret && secret.length >= MIN_SECRET_LENGTH ? secret : null;
}

/** The payload of an HS256 token whose signature checks out, or `null`. */
function hs256Payload(token: string): Record<string, unknown> | null {
  const secret = getSecret();
  if (!secret) return null;
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
 * The verified payload and the algorithm that verified it, or `null`. Only
 * the signature and issuer are checked here; each population checks its own
 * purpose and claims.
 */
async function verifiedPayload(token: string | undefined | null): Promise<{
  payload: Record<string, unknown>;
  alg: HarnessCredentialAlg;
} | null> {
  if (!token) return null;
  const alg = harnessCredentialAlg(token);
  if (alg === "RS256") {
    // No claim is required here: a session handle carries no `exp` on
    // purpose, and the per-turn check below requires its own.
    const payload = await jwks.verifyPayload(token, {
      issuer: ISSUER,
      requiredClaims: [],
    });
    return payload ? { payload, alg } : null;
  }
  if (alg === "HS256" && acceptsHs256HarnessCredentials()) {
    const payload = hs256Payload(token);
    return payload && payload.iss === ISSUER ? { payload, alg } : null;
  }
  return null;
}

/** Counts what still arrives on HS256, so its end can be scheduled. */
function logHs256Accepted(
  credential: "proxy_token" | "session_handle",
  laneId?: string,
): void {
  getSystemLogger("harness").event("harness.hs256_credential_accepted", {
    credential,
    ...(laneId ? { laneId } : {}),
  });
}

/**
 * Verify a Convex-minted token and that it was minted for exactly `serverId`.
 * Returns the claims, or `null` for anything wrong (an algorithm this
 * deployment doesn't accept, no key to check it with, malformed, tampered
 * signature, wrong issuer/purpose, wrong serverId, expired). Never throws.
 */
export async function verifyHarnessProxyToken(
  token: string | undefined | null,
  serverId: string,
  opts: { nowMs?: number } = {},
): Promise<HarnessMcpProxyClaims | null> {
  const verified = await verifiedPayload(token);
  if (!verified) return null;
  const { payload, alg } = verified;
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

  if (alg === "HS256") logHs256Accepted("proxy_token");
  return {
    userId: payload.sub as string,
    externalId: payload.ext as string,
    orgId: payload.org as string,
    projectId: payload.projectId as string,
    serverId: payload.serverId as string,
    alg,
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
  alg: HarnessCredentialAlg;
}

/**
 * Verify a lane's session handle (`/web/harness/session-state/bind-turn`).
 *
 * It carries no expiry on purpose: a runtime that fingerprints its MCP
 * configuration must see the same handle on every turn. So it proves identity
 * only, and every request it rides on must also find the lane's live turn.
 */
export async function verifyHarnessSessionHandle(
  token: string | undefined | null,
  serverId: string,
): Promise<HarnessMcpSessionClaims | null> {
  const verified = await verifiedPayload(token);
  if (!verified) return null;
  const { payload, alg } = verified;
  if (
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
  if (alg === "HS256") logHs256Accepted("session_handle", laneId);
  return {
    userId,
    externalId,
    orgId,
    projectId,
    serverId,
    laneId,
    ...(connectionId ? { connectionId } : {}),
    alg,
  };
}
