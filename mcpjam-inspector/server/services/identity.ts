import { ConvexHttpClient } from "convex/browser";

/**
 * Resolve an MCPJam user from a WorkOS user id (the user's `externalId`
 * in Convex).
 *
 * Used by the bearer middleware when an `sk_` WorkOS API key is presented:
 * after `WorkOS.apiKeys.createValidation` returns the owning WorkOS user,
 * we map it to an MCPJam user id so Inspector can call Convex as that user
 * via the service-token + acting-as exchange.
 *
 * Returns `null` when no matching user is found — the caller is
 * responsible for translating that into a 401.
 */
export interface ResolvedMcpjamUser {
  /** MCPJam user document id (Convex). */
  _id: string;
}

export async function resolveUserByExternalId(
  externalId: string
): Promise<ResolvedMcpjamUser | null> {
  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    throw new Error("CONVEX_URL is not set");
  }

  const client = new ConvexHttpClient(convexUrl);

  // TODO: remove `as any` cast after the backend PR `claude/workos-api-keys-backend`
  // adds `api.users.getByExternalId`. Inspector calls Convex via string
  // function paths (matches `local-server-resolver.ts:935` and
  // `servers.ts:80`) — no codegen step pins the API surface here, so the
  // cast is the documented escape hatch until the reader query lands.
  const result = (await client.query(
    "users:getByExternalId" as any,
    { externalId }
  )) as { _id: string } | null | undefined;

  if (!result || typeof result._id !== "string") return null;
  return { _id: result._id };
}
