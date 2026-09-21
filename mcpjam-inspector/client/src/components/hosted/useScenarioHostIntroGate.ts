import { useEffect, useState } from "react";

export function scenarioIntroDismissedStorageKey(scenarioId: string): string {
  return `scenario-intro-dismissed-${scenarioId}`;
}

interface ScopedConsent {
  /** The storage key this answer belongs to. An answer is never read apart
   * from its scenario — see the render-phase adjustment in the hook. */
  key: string;
  accepted: boolean;
  declined: boolean;
}

function readScopedConsent(key: string): ScopedConsent {
  try {
    return {
      key,
      accepted: sessionStorage.getItem(key) === "1",
      declined: false,
    };
  } catch {
    return { key, accepted: false, declined: false };
  }
}

export interface PendingOAuthEntry {
  server: { serverId: string };
  state: { status: string };
}

export interface UseScenarioHostIntroGateArgs {
  scenarioId: string;
  oauthPending: boolean;
  /** Pending rows from useHostedOAuthGate, to reset the auth panel's dismissal. */
  pendingOAuthServers: PendingOAuthEntry[];
}

/**
 * What a tester has to get past before they can send a message: the recording
 * notice, then any authorization the session needs.
 *
 * **Consent is UNCONDITIONAL and comes FIRST (BB-176).** It used to be a
 * creator-authored "welcome" overlay, shown only when the creator had written
 * a body — so whether a tester was told their session would be read came down
 * to whether someone remembered to type it, and the notice competed with
 * whatever else that copy said. Recording is a product statement, so the
 * dialog is product-owned, always shown once per session, and asked before
 * authorization: consenting to being read is a precondition for the session,
 * not one step among several.
 *
 * A consequence worth naming: an OAuth scenario whose authorization is already
 * satisfied on load still shows consent. The version this replaces persisted a
 * dismissal in exactly that case, so runtime OAuth errors from chat would show
 * the auth overlay rather than a stale welcome — and that shortcut is not
 * available to a notice that must not be skippable. Consent is separately
 * latched from the auth panel, so a runtime 401 after consent still surfaces
 * the auth overlay.
 *
 * Dismissal is per scenario, in `sessionStorage`: it survives a reload and the
 * OAuth redirect round trip (same tab, same origin), and a new tab asks again.
 */
export function useScenarioHostIntroGate({
  scenarioId,
  oauthPending,
  pendingOAuthServers,
}: UseScenarioHostIntroGateArgs) {
  const storageKey = scenarioIntroDismissedStorageKey(scenarioId);

  /**
   * Both answers, carrying the key they were given for.
   *
   * `declined` rides along because it is the same fact about the same
   * scenario: leaving is a decision about this page view, not persisted, and
   * cleared when the scenario changes — someone who reloads is asking again
   * rather than being permanently locked out of a link they hold.
   */
  const [consent, setConsent] = useState<ScopedConsent>(() =>
    readScopedConsent(storageKey),
  );

  /**
   * Re-read DURING render when the scenario changes, not in an effect.
   *
   * An effect corrects a render that has already committed. This page is not
   * remounted per scenario — `ScenarioChatPage` takes the token as a prop —
   * so a tester who accepted A and then opened B in the same tab got one
   * committed render of B still holding A's acceptance: the notice skipped,
   * and chat (or, with OAuth outstanding, the authorization panel) mounted
   * behind the one question this gate exists to ask first. React re-renders
   * immediately on a render-phase set, so nothing carrying A's latch paints.
   */
  if (consent.key !== storageKey) {
    setConsent(readScopedConsent(storageKey));
  }

  // A mismatch reads as UNACCEPTED rather than as the stale answer, so the
  // discarded pass above also fails in the ask-again direction.
  const consentAccepted = consent.key === storageKey && consent.accepted;
  const consentDeclined = consent.key === storageKey && consent.declined;

  /**
   * NOT held back by a busy OAuth flow.
   *
   * An earlier version suppressed the notice while OAuth was mid-flight,
   * reasoning that a tester returning from an authorization redirect had
   * already consented in the same tab. That reasoning had a hole: the resume
   * marker lives in `localStorage` (`hosted-oauth-resume`), which is shared
   * across tabs, while the consent latch is per-tab `sessionStorage`. So a
   * tester opening the link in a NEW tab while a marker was still around got
   * `hasBusyOAuth` with no latch — the notice was skipped and authorization
   * proceeded first, which is the one thing this gate exists to prevent.
   *
   * The case that motivated the guard is already covered without it: a
   * same-tab redirect return has `consentAccepted === true`, so no dialog is
   * shown anyway. Nothing is lost by dropping it.
   */
  const showConsent = !consentAccepted && !consentDeclined;

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

  // Consent outranks authorization: one dialog at a time, and the recording
  // notice is the one that has to come first.
  const showAuthPanel = oauthPending && !showConsent && !authPanelDismissed;

  const composerBlocked =
    (oauthPending && !authPanelDismissed) || showConsent || consentDeclined;

  const acceptConsent = () => {
    try {
      sessionStorage.setItem(storageKey, "1");
    } catch {
      // A tester who cannot persist re-consents on the next reload, which is
      // the safe direction to fail in.
    }
    setConsent({ key: storageKey, accepted: true, declined: false });
  };

  const declineConsent = () => {
    setConsent({ key: storageKey, accepted: consentAccepted, declined: true });
  };

  /**
   * Back from the declined panel. Clears the refusal WITHOUT accepting, so the
   * dialog is asked again — rejoining is a change of mind about answering, not
   * an answer.
   */
  const rejoinAfterDecline = () => {
    setConsent({ key: storageKey, accepted: consentAccepted, declined: false });
  };

  const dismissAuthPanel = () => {
    setAuthPanelDismissed(true);
  };

  return {
    showConsent,
    consentDeclined,
    showAuthPanel,
    composerBlocked,
    acceptConsent,
    declineConsent,
    rejoinAfterDecline,
    dismissAuthPanel,
  };
}
