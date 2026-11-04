import type {
  EnsureServerConnectionResult,
  EnsureServersReadyResult,
} from "@/hooks/use-server-state";

/** What a background connect from Run came back with. */
export type ConformanceConnectOutcome = "ready" | "reauth" | "failed";

/**
 * Connects a server in the background. `signIn` lets the connect open the
 * server's sign-in, for a server whose last connect needed one.
 */
export type ConformanceConnectServer = (
  name: string,
  options?: { signIn?: boolean },
) => Promise<ConformanceConnectOutcome>;

export function createConformanceConnector({
  ensureServersReady,
  reconnectServerWithResult,
}: {
  ensureServersReady: (names: string[]) => Promise<EnsureServersReadyResult>;
  reconnectServerWithResult: (
    name: string,
    options: { forceOAuthFlow: true },
  ) => Promise<EnsureServerConnectionResult>;
}): ConformanceConnectServer {
  return async (name, options) => {
    if (options?.signIn) {
      // The forced attempt owns the OAuth flow. A redirect or failure must
      // not fall through to another attempt that can open sign-in again.
      const result = await reconnectServerWithResult(name, {
        forceOAuthFlow: true,
      });
      if (result.status === "connected") return "ready";
      return result.status === "reauth" ? "reauth" : "failed";
    }
    const result = await ensureServersReady([name]);
    if (result.readyServerNames.includes(name)) return "ready";
    return result.reauthServerNames.includes(name) ? "reauth" : "failed";
  };
}
