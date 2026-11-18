import {
  getServiceCredential,
  INSPECTOR_SERVICE_TOKEN_HEADER,
} from "../../services/service-credential.js";
import type { HarnessProxyTurn } from "./harness-proxy-policy-seal.js";
import type { HarnessMcpProxyClaims } from "./harness-proxy-token.js";

/** Every Inspector instance observes the same lease, including after Stop. */
export async function authorizeProxyTurn(
  turn: HarnessProxyTurn,
  claims: Pick<HarnessMcpProxyClaims, "userId" | "projectId">,
): Promise<Response | undefined> {
  const unavailable = () =>
    Response.json({ error: "Turn authorization unavailable" }, { status: 503 });
  const base = process.env.CONVEX_HTTP_URL;
  const service = getServiceCredential();
  if (!base || !service) return unavailable();
  try {
    const response = await fetch(
      new URL("/internal/harness/proxy-turn", base),
      {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          [INSPECTOR_SERVICE_TOKEN_HEADER]: service,
        },
        body: JSON.stringify({
          ...turn,
          userId: claims.userId,
          projectId: claims.projectId,
        }),
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (response.status === 403)
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    return response.status === 204 ? undefined : unavailable();
  } catch {
    // The caller reports an unavailable authority and never dispatches the request.
    return unavailable();
  }
}

/**
 * The live turn a session handle's request belongs to, with the policy digest
 * that turn bound for the server. A lane without a live, bound turn, or a
 * request without that turn's box grant, answers 401, so a handle copied out
 * of the box or out of a finished session reaches nothing.
 */
export async function authorizeSessionTurn(args: {
  laneId: string;
  userId: string;
  projectId: string;
  serverId: string;
  /** The session grant the request's box egress injected. */
  boxGrant: string;
}): Promise<{ turnId: string; policyDigest: string } | Response> {
  const unavailable = () =>
    Response.json({ error: "Turn authorization unavailable" }, { status: 503 });
  const base = process.env.CONVEX_HTTP_URL;
  const service = getServiceCredential();
  if (!base || !service) return unavailable();
  try {
    const response = await fetch(
      new URL("/internal/harness/session-turn", base),
      {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          [INSPECTOR_SERVICE_TOKEN_HEADER]: service,
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (response.status === 403)
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (response.status !== 200) return unavailable();
    const turn: unknown = await response.json();
    if (
      turn &&
      typeof turn === "object" &&
      "turnId" in turn &&
      typeof turn.turnId === "string" &&
      "policyDigest" in turn &&
      typeof turn.policyDigest === "string"
    )
      return { turnId: turn.turnId, policyDigest: turn.policyDigest };
    return unavailable();
  } catch {
    // The caller reports an unavailable authority and never dispatches the request.
    return unavailable();
  }
}
