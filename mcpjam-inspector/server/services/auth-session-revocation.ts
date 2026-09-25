import { ConvexHttpClient } from "convex/browser";
import { getInspectorClientRuntimeConfig } from "../env.js";

export type SessionRevocationResult =
  | { revoked: true }
  | {
      revoked: false;
      reason:
        "no_identity" | "no_session" | "not_configured" | "timeout" | "failed";
    };

export const SESSION_REVOCATION_TIMEOUT_MS = 3_000;

export interface SessionRevocationDeps {
  convexUrl?: string;
  /** Calls the mutation as the bearer of `token`. Injectable for tests. */
  revoke?: (convexUrl: string, token: string) => Promise<unknown>;
}

async function revokeViaConvex(
  convexUrl: string,
  token: string,
): Promise<unknown> {
  const client = new ConvexHttpClient(convexUrl);
  client.setAuth(token);
  return await client.mutation("authSessions:revokeCurrentSession" as any, {});
}

function isRevocationResponse(
  value: unknown,
): value is { revoked: boolean; reason?: string } {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { revoked?: unknown }).revoked === "boolean"
  );
}

/**
 * Revoke the WorkOS AuthKit session an access token belongs to, in Convex.
 *
 * WorkOS's logout ends a session — no more refreshes — but cannot recall the
 * access tokens it already issued, and Convex accepts those on signature and
 * expiry alone. The backend's `authSessions:revokeCurrentSession` records the
 * token's session id (`sid`) so every later request carrying a token from that
 * session is treated as signed out (see the backend's
 * `lib/sessionRevocation.ts`).
 *
 * The mutation only ever revokes the session of the token that calls it, so
 * this is safe to call with any bearer: a token without a session id, or one
 * Convex does not accept, simply revokes nothing.
 *
 * BEST EFFORT by contract. Callers are sign-out paths, and a sign-out must
 * never wait on, or fail because of, this call. It resolves — never rejects —
 * within `timeoutMs`.
 */
export async function revokeAuthKitSession(
  token: string,
  options: SessionRevocationDeps & { timeoutMs?: number } = {},
): Promise<SessionRevocationResult> {
  const convexUrl =
    options.convexUrl ?? getInspectorClientRuntimeConfig().convexUrl;
  if (!convexUrl || !token) {
    return { revoked: false, reason: "not_configured" };
  }
  const revoke = options.revoke ?? revokeViaConvex;
  const timeoutMs = options.timeoutMs ?? SESSION_REVOCATION_TIMEOUT_MS;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const outcome = await Promise.race([revoke(convexUrl, token), timedOut]);
    if (outcome === "timeout") return { revoked: false, reason: "timeout" };
    if (!isRevocationResponse(outcome)) {
      return { revoked: false, reason: "failed" };
    }
    if (outcome.revoked) return { revoked: true };
    return {
      revoked: false,
      reason: outcome.reason === "no_identity" ? "no_identity" : "no_session",
    };
  } catch {
    return { revoked: false, reason: "failed" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
