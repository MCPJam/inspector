import { useEffect, useMemo, useState } from "react";
import type { HostedOAuthServerDescriptor } from "@/hooks/hosted/use-hosted-oauth-gate";

export function scenarioIntroDismissedStorageKey(scenarioId: string): string {
  return `scenario-intro-dismissed-${scenarioId}`;
}

export interface PendingOAuthEntry {
  server: { serverId: string };
  state: { status: string };
}

export interface UseScenarioHostIntroGateArgs {
  scenarioId: string;
  servers: Pick<
    HostedOAuthServerDescriptor,
    "useOAuth" | "authorizationRequiredUpfront"
  >[];
  oauthPending: boolean;
  /** True while OAuth is launching, resuming, or verifying — welcome waits behind this. */
  hasBusyOAuth: boolean;
  /** Pending rows from useHostedOAuthGate (for needs_auth-only welcome). */
  pendingOAuthServers: PendingOAuthEntry[];
  /**
   * Whether the creator has host-authored welcome content to show. When false,
   * the welcome overlay is skipped and the gate falls through to either the
   * auth panel (OAuth pending) or the chat composer.
   */
  welcomeAvailable: boolean;
}

/**
 * Welcome overlay: first-time non-OAuth scenarios, or OAuth scenarios that still
 * need consent. When OAuth is already satisfied on load, we persist dismissal
 * so runtime OAuth errors from chat show the auth overlay instead of welcome.
 * Also silent-skipped entirely when the creator has no host-authored content
 * (`welcomeAvailable = false`).
 */
export function useScenarioHostIntroGate({
  scenarioId,
  servers,
  oauthPending,
  hasBusyOAuth,
  pendingOAuthServers,
  welcomeAvailable,
}: UseScenarioHostIntroGateArgs) {
  const storageKey = scenarioIntroDismissedStorageKey(scenarioId);

  // Servers that actually gate this session, not servers that merely COULD use
  // OAuth: `useOAuth` is a compat mirror that is true for discover rows too, so
  // counting it treated a no-auth scenario as an OAuth one and skipped the
  // welcome overlay it should have shown.
  const oauthServerCount = useMemo(
    () =>
      servers.filter(
        (s) => s.useOAuth && s.authorizationRequiredUpfront !== false,
      ).length,
    [servers],
  );

  const nonOAuthFirstVisit = oauthServerCount === 0;

  const [introDismissed, setIntroDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(storageKey) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      setIntroDismissed(sessionStorage.getItem(storageKey) === "1");
    } catch {
      setIntroDismissed(false);
    }
  }, [storageKey]);

  useEffect(() => {
    if (oauthPending) return;
    if (nonOAuthFirstVisit) return;
    try {
      if (sessionStorage.getItem(storageKey) === "1") return;
      sessionStorage.setItem(storageKey, "1");
    } catch {
      return;
    }
    setIntroDismissed(true);
  }, [oauthPending, nonOAuthFirstVisit, servers.length, storageKey]);

  const onlyNeedsAuthIdle =
    oauthPending &&
    pendingOAuthServers.every(({ state }) => state.status === "needs_auth");

  const showWelcome =
    welcomeAvailable &&
    !introDismissed &&
    !hasBusyOAuth &&
    (nonOAuthFirstVisit || (oauthServerCount > 0 && onlyNeedsAuthIdle));

  /**
   * The recipient's way out of an authorization that cannot succeed.
   *
   * Even with the requirement resolved server-side, an authorization can still
   * fail for reasons the recipient cannot fix (a misconfigured authorization
   * server, a revoked client). "Authorize again" is then the only offered
   * action behind a disabled composer, and the session dead-ends. Dismissing
   * releases the composer and lets them talk to whatever the model can already
   * reach.
   *
   * Deliberately NOT persisted, and reset below whenever the pending set
   * changes: a fresh authorization requirement (a different server, or the same
   * one escalating again from a runtime 401) is new information and must be
   * shown, not silently swallowed by an earlier dismissal.
   */
  const [authPanelDismissed, setAuthPanelDismissed] = useState(false);

  const pendingSignature = pendingOAuthServers
    .map(({ server, state }) => `${server.serverId}:${state.status}`)
    .join("|");

  useEffect(() => {
    setAuthPanelDismissed(false);
  }, [pendingSignature]);

  const showAuthPanel = oauthPending && !showWelcome && !authPanelDismissed;

  const composerBlocked = (oauthPending && !authPanelDismissed) || showWelcome;

  const dismissIntro = () => {
    try {
      sessionStorage.setItem(storageKey, "1");
    } catch {
      // ignore
    }
    setIntroDismissed(true);
  };

  const dismissAuthPanel = () => {
    setAuthPanelDismissed(true);
  };

  return {
    showWelcome,
    showAuthPanel,
    composerBlocked,
    dismissIntro,
    dismissAuthPanel,
  };
}
