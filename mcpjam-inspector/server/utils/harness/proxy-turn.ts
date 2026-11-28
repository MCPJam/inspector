import {
  getServiceCredential,
  INSPECTOR_SERVICE_TOKEN_HEADER,
} from "../../services/service-credential.js";
import type { HarnessProxyTurn } from "./harness-proxy-policy-seal.js";
import type {
  HarnessCredentialAlg,
  HarnessMcpProxyClaims,
} from "./harness-proxy-token.js";

/**
 * How a turn check names its caller. An RS256 credential is sent as the
 * bearer and the backend reads the user, project and lane from it; a backend
 * that mints one takes it there. An HS256 credential comes from a backend that
 * may not, so it keeps the service credential with the ids in the body.
 */
function turnCheckCaller(
  credential: { token: string; alg?: HarnessCredentialAlg } | undefined,
  ids: Record<string, string>,
): { headers: Record<string, string>; ids: Record<string, string> } | null {
  if (credential?.alg === "RS256")
    return {
      headers: { authorization: `Bearer ${credential.token}` },
      ids: {},
    };
  const service = getServiceCredential();
  return service
    ? { headers: { [INSPECTOR_SERVICE_TOKEN_HEADER]: service }, ids }
    : null;
}

/** Every Inspector instance observes the same lease, including after Stop. */
export async function authorizeProxyTurn(
  turn: HarnessProxyTurn,
  claims: Pick<HarnessMcpProxyClaims, "userId" | "projectId" | "alg">,
  token?: string,
): Promise<Response | undefined> {
  const unavailable = () =>
    Response.json({ error: "Turn authorization unavailable" }, { status: 503 });
  const base = process.env.CONVEX_HTTP_URL;
  const caller = turnCheckCaller(
    token ? { token, alg: claims.alg } : undefined,
    {
      userId: claims.userId,
      projectId: claims.projectId,
    },
  );
  if (!base || !caller) return unavailable();
  try {
    const response = await fetch(
      new URL("/internal/harness/proxy-turn", base),
      {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", ...caller.headers },
        body: JSON.stringify({ ...turn, ...caller.ids }),
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
  /** The verified session handle, sent as the bearer when it is RS256. */
  handle?: { token: string; alg: HarnessCredentialAlg };
}): Promise<{ turnId: string; policyDigest: string } | Response> {
  const unavailable = () =>
    Response.json({ error: "Turn authorization unavailable" }, { status: 503 });
  const base = process.env.CONVEX_HTTP_URL;
  const { handle, boxGrant, ...ids } = args;
  const caller = turnCheckCaller(handle, ids);
  if (!base || !caller) return unavailable();
  try {
    const response = await fetch(
      new URL("/internal/harness/session-turn", base),
      {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", ...caller.headers },
        body: JSON.stringify({ ...caller.ids, boxGrant }),
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
