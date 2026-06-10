import { ConvexHttpClient } from "convex/browser";
import { getInspectorClientRuntimeConfig } from "../env.js";

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
  // ConvexHttpClient needs the deployment (`.convex.cloud`) URL. Inspector
  // boot only *requires* CONVEX_HTTP_URL (the `.convex.site` HTTP-actions
  // origin), and `getInspectorClientRuntimeConfig()` derives the `.convex.cloud`
  // query URL from it — so a deployment that sets only CONVEX_HTTP_URL still
  // resolves identity here (previously this threw "CONVEX_URL is not set",
  // 500-ing all sk_ auth and API-key minting). Fall back to an explicit
  // CONVEX_URL if the derivation can't produce one.
  const convexUrl =
    getInspectorClientRuntimeConfig().convexUrl ?? process.env.CONVEX_URL;
  if (!convexUrl) {
    throw new Error(
      "Convex deployment URL is not configured (set CONVEX_HTTP_URL or CONVEX_URL)",
    );
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

  if (!result || typeof result !== "object" || typeof result._id !== "string")
    return null;
  return { _id: result._id };
}
