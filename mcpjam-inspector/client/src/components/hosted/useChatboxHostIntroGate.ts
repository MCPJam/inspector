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
  /**
   * Whether the creator has host-authored welcome content to show. When false,
   * the welcome overlay is skipped and the gate falls through to either the
   * auth panel (OAuth pending) or the chat composer.
   */
  welcomeAvailable: boolean;
}

/**
 * Welcome overlay: first-time non-OAuth chatboxes, or OAuth chatboxes that still
 * need consent. When OAuth is already satisfied on load, we persist dismissal
 * so runtime OAuth errors from chat show the auth overlay instead of welcome.
 * Also silent-skipped entirely when the creator has no host-authored content
 * (`welcomeAvailable = false`).
 */
export function useChatboxHostIntroGate({
  chatboxId,
  servers,
  oauthPending,
  hasBusyOAuth,
  pendingOAuthServers,
  welcomeAvailable,
}: UseChatboxHostIntroGateArgs) {
  const storageKey = chatboxIntroDismissedStorageKey(chatboxId);

  const oauthServerCount = useMemo(
    () => servers.filter((s) => s.useOAuth).length,
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
