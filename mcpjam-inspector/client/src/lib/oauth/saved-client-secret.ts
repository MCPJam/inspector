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
  server: ServerWithName,
  targetUrl: string
): Promise<SavedClientSecret | undefined> {
  if (!server.hasClientSecret) return undefined;
  // The run tests the OAuth profile's URL, which can differ from the server's
  // own URL. The secret was saved for the server's site, so never fetch it
  // for a run aimed at another one.
  const serverUrl = "url" in server.config ? server.config.url : undefined;
  if (!serverUrl || !isSameOrigin(String(serverUrl), targetUrl)) {
    throw new Error(
      "The OAuth test URL is on a different site than the server URL, so the saved client secret wasn't sent. Match the URLs, then run the checks again."
    );
  }
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
