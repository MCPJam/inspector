import type { ServerWithName } from "@/hooks/use-app-state";
import { tryResolveProjectServer } from "@/lib/apis/web/context";
import { fetchOAuthClientSecret } from "@/lib/apis/hosted-oauth-client-secret-api";

/** A saved secret, with the project and server it was fetched for. */
export interface SavedClientSecret {
  clientSecret: string;
  projectId: string;
  serverId: string;
}

/**
 * A hosted server's saved client secret lives in Convex, flagged only by
 * `hasClientSecret`, so `deriveOAuthProfileFromServer` never sees it. Load it
 * the way the OAuth debugger does (`createHostedClientSecretResolver`) — held
 * in memory for one run, never written to storage. A failed fetch throws:
 * running on without the secret would fail the token step with
 * `invalid_client` and blame the client's registration instead of the load.
 */
export async function loadSavedClientSecret(
  server: ServerWithName
): Promise<SavedClientSecret | undefined> {
  if (!server.hasClientSecret) return undefined;
  const resolved = tryResolveProjectServer(server.name);
  if (!resolved) return undefined;
  try {
    const { clientSecret } = await fetchOAuthClientSecret(resolved);
    return { clientSecret, ...resolved };
  } catch {
    throw new Error(
      "Couldn't load the saved client secret. Run the checks again."
    );
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
