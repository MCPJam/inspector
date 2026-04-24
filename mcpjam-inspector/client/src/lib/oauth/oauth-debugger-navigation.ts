export const OAUTH_DEBUGGER_HASH = "#oauth-flow";

const OPEN_OAUTH_DEBUGGER_EVENT = "mcpjam:open-oauth-debugger";

export interface OAuthDebuggerOpenRequest {
  serverName: string;
}

export function requestOpenOAuthDebugger(serverName: string): void {
  if (typeof window === "undefined") {
    return;
  }

  const trimmedServerName = serverName.trim();
  if (!trimmedServerName) {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<OAuthDebuggerOpenRequest>(OPEN_OAUTH_DEBUGGER_EVENT, {
      detail: { serverName: trimmedServerName },
    }),
  );
}

export function subscribeToOAuthDebuggerRequests(
  onRequest: (request: OAuthDebuggerOpenRequest) => void,
): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  const handleEvent = (event: Event) => {
    const detail = (event as CustomEvent<Partial<OAuthDebuggerOpenRequest>>)
      .detail;
    if (!detail || typeof detail.serverName !== "string") {
      return;
    }

    const trimmedServerName = detail.serverName.trim();
    if (!trimmedServerName) {
      return;
    }

    onRequest({ serverName: trimmedServerName });
  };

  window.addEventListener(
    OPEN_OAUTH_DEBUGGER_EVENT,
    handleEvent as EventListener,
  );

  return () => {
    window.removeEventListener(
      OPEN_OAUTH_DEBUGGER_EVENT,
      handleEvent as EventListener,
    );
  };
}
