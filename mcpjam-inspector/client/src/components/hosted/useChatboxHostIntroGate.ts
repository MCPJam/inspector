import { useEffect, useMemo, useState } from "react";
import type { HostedOAuthServerDescriptor } from "@/hooks/hosted/use-hosted-oauth-gate";

export function chatboxIntroDismissedStorageKey(chatboxId: string): string {
  return `chatbox-intro-dismissed-${chatboxId}`;
}

export interface PendingOAuthEntry {
  state: { status: string };
}

export interface UseChatboxHostIntroGateArgs {
  chatboxId: string;
  servers: Pick<HostedOAuthServerDescriptor, "useOAuth">[];
  oauthPending: boolean;
  /** True while OAuth is launching, resuming, or verifying — welcome waits behind this. */
  hasBusyOAuth: boolean;
  /** Pending rows from useHostedOAuthGate (for needs_auth-only welcome). */
  pendingOAuthServers: PendingOAuthEntry[];
}

/**
 * Welcome overlay: first-time non-OAuth chatboxes, or OAuth chatboxes that still
 * need consent. When OAuth is already satisfied on load, we persist dismissal
 * so runtime OAuth errors from chat show the auth overlay instead of welcome.
 */
export function useChatboxHostIntroGate({
  chatboxId,
  servers,
  oauthPending,
  hasBusyOAuth,
  pendingOAuthServers,
}: UseChatboxHostIntroGateArgs) {
  const storageKey = chatboxIntroDismissedStorageKey(chatboxId);

  const oauthServerCount = useMemo(
    () => servers.filter((s) => s.useOAuth).length,
    [servers],
  );

  const nonOAuthFirstVisit = servers.length > 0 && oauthServerCount === 0;

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
    if (servers.length === 0) return;
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
    !introDismissed &&
    !hasBusyOAuth &&
    (nonOAuthFirstVisit || (oauthServerCount > 0 && onlyNeedsAuthIdle));

  const showAuthPanel = oauthPending && !showWelcome;

  const composerBlocked = oauthPending || showWelcome;

  const dismissIntro = () => {
    try {
      sessionStorage.setItem(storageKey, "1");
    } catch {
      // ignore
    }
    setIntroDismissed(true);
  };

  return {
    showWelcome,
    showAuthPanel,
    composerBlocked,
    dismissIntro,
  };
}
