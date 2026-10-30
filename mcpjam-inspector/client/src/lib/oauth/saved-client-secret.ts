import type { ServerWithName } from "@/hooks/use-app-state";
import { tryResolveProjectServer } from "@/lib/apis/web/context";
import { fetchOAuthClientSecret } from "@/lib/apis/hosted-oauth-client-secret-api";

/** A saved secret, with the project and server it was fetched for. */
export interface SavedClientSecret {
  clientSecret: string;
  projectId: string;
  serverId: string;
}

const SAVED_CLIENT_SECRET_TIMEOUT_MS = 10_000;

/**
 * A hosted server's saved client secret lives in Convex, flagged only by
 * `hasClientSecret`, so `deriveOAuthProfileFromServer` never sees it. Load it
 * the way the OAuth debugger does (`createHostedClientSecretResolver`) — held
 * in memory for one run, never written to storage. Any failure throws —
 * an unresolvable server, an error, or a fetch that outlasts the deadline:
 * running on without the secret would fail the token step with
 * `invalid_client` and blame the client's registration instead of the load,
 * and a hung fetch would leave the suite running with Run disabled.
 */
export async function loadSavedClientSecret(
  server: ServerWithName
): Promise<SavedClientSecret | undefined> {
  if (!server.hasClientSecret) return undefined;
  const loadFailed = new Error(
    "Couldn't load the saved client secret. Run the checks again."
  );
  // Project serialization keeps `hasClientSecret` while blanking the secret,
  // so a flagged server with no project mapping has no secret to send.
  const resolved = tryResolveProjectServer(server.name);
  if (!resolved) throw loadFailed;
  try {
    const { clientSecret } = await fetchOAuthClientSecret(resolved, {
      signal: AbortSignal.timeout(SAVED_CLIENT_SECRET_TIMEOUT_MS),
    });
    return { clientSecret, ...resolved };
  } catch {
    throw loadFailed;
  }
}

/**
 * The URL the OAuth suite should test. Connect's URL is the source of truth;
 * the OAuth profile keeps its own copy, which can fall out of sync. A copy on
 * another site would send the saved secret there, so use Connect's URL
 * instead. The same site keeps the profile's path (it may name a versioned
 * endpoint).
 */
export function oauthTargetUrl(
  server: ServerWithName,
  profileUrl: string
): string {
  const serverUrl = "url" in server.config ? String(server.config.url) : "";
  if (!serverUrl || !profileUrl) return profileUrl || serverUrl;
  return isSameOrigin(serverUrl, profileUrl) ? profileUrl : serverUrl;
}

function isSameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * The start request resolves the server by name against the CURRENT project.
 * If the project changed during the fetch, a same-named server there would
 * receive this secret — so stop the run unless the name still points at the
 * project and server the secret belongs to.
 */
export function assertSavedSecretTargets(
  serverName: string,
  saved: SavedClientSecret
): void {
  const current = tryResolveProjectServer(serverName);
  if (
    current?.projectId !== saved.projectId ||
    current.serverId !== saved.serverId
  ) {
    throw new Error(
      "The project changed while loading the saved client secret. Run the checks again."
    );
  }
}
