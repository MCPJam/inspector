/**
 * The page a connection handoff link opens.
 *
 * It renders in its own tree, without AuthKit or Convex, because its visitor
 * may be signed out or a guest and mounting the authenticated shell around
 * them would be both pointless and slow. Everything it can do, it does through
 * `/api/web/server-connections/*` with an HttpOnly cookie it never sees.
 *
 * THE PAGE HOLDS NO CREDENTIAL. The handoff token in the URL is traded for
 * that cookie on first load and then removed from the address bar; after that
 * the only identifier in view is a `scr_…` request id, which is printable by
 * design. Nothing here reads `document.cookie`, and nothing here stores a
 * token — the one thing kept across the OAuth redirect is a request id, so the
 * callback can find its way home.
 *
 * WHAT IT DELIBERATELY DOES NOT SHOW. The server's operational URL never
 * arrives: the backend sends `displayUrl`, with query values redacted, because
 * a keyed-endpoint URL's query can be the credential itself. When the original
 * carried parameters the page says so without showing them, so a user can tell
 * "this link had a key in it" from "this link did not" without the key being
 * on screen.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  callbackMatchesPending,
  clearPendingAuthorization,
  HANDOFF_SIGN_IN_STATE_KEY,
  handoffRefusedPath,
  handoffRequestPath,
  isTerminalHandoffStatus,
  isWaitingHandoffStatus,
  matchHandoffRoute,
  readCallbackParams,
  readClaimedHandoff,
  readPendingAuthorization,
  rememberClaimedHandoff,
  rememberHandoffSignInReturn,
  rememberPendingAuthorization,
  type CallbackParams,
  type PendingAuthorization,
} from "@/lib/server-connection-handoff";
import {
  consumeOAuthCallbackParams,
  readOAuthCallbackParams,
} from "@/lib/oauth-callback-inbox";
import { ErrorCard } from "@/components/ui/error-card";
import { markSignOutInProgress } from "@/lib/auth/sign-out-latch";
import { pauseQueriesBeforeAuthClear } from "@/lib/auth/pause-queries-before-auth-clear";
import { startSessionRevocation } from "@/lib/auth/revoke-session";
import {
  readClaimRefusal,
  type ClaimRefusalDetails,
} from "@/shared/server-connection-claim-refusal";
import { useAuth } from "@workos-inc/authkit-react";
import { ClaimRefusal } from "./ClaimRefusal";
import {
  bestEffortAccessToken,
  call,
  HandoffCallError,
  isTransientCallFailure,
  isUsedLinkError,
  type HandoffState,
} from "./handoff-api";
import { Shell, Spinner } from "./HandoffShell";

/** Slow enough to be polite to a shared backend, fast enough that a discovery
 * finishing feels immediate. Only ever runs while a step belongs to someone
 * else — the page stops on every status the user must act on. */
const POLL_INTERVAL_MS = 2_000;

export function ServerConnectionHandoff() {
  const {
    getAccessToken,
    isLoading: isAuthLoading,
    signIn,
    signOut,
    user,
  } = useAuth();
  const [state, setState] = useState<HandoffState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usedLink, setUsedLink] = useState(false);
  const [refusal, setRefusal] = useState<ClaimRefusalDetails | null>(null);
  const [busy, setBusy] = useState(false);
  // A completion that failed, kept for an in-page retry. The authorization
  // answer lives in memory only (`oauth-callback-inbox.ts`), so a reload
  // cannot retry it; this button can.
  const [retryableCompletion, setRetryableCompletion] = useState<{
    callback: CallbackParams;
    pending: PendingAuthorization;
  } | null>(null);
  // A claim that failed without an answer about the link (see
  // `isTransientCallFailure`), kept for an in-page retry from `claimLinkRef`.
  const [retryableClaim, setRetryableClaim] = useState(false);
  const claimed = useRef(false);
  // The link as it was opened, held in memory only. A claim that does not
  // succeed takes the token out of the address bar (below), but the two
  // recoveries for a refusal about WHO is asking — sign in, switch account —
  // must come back to this exact link, and the token is the link.
  const claimLinkRef = useRef<string | null>(
    matchHandoffRoute(window.location.pathname)?.kind === "claim"
      ? `${window.location.pathname}${window.location.search}`
      : null,
  );

  const refresh = useCallback(async () => {
    try {
      setState(await call<HandoffState>("/state"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  /** Trade the token for the cookie, then take it out of the URL. Throws. */
  const claimHandoff = useCallback(
    async (handoffToken: string) => {
      const result = await call<{ requestId: string }>(
        "/claim",
        { handoffToken },
        // Only the claim carries identity. Every later step authenticates
        // with the continuation cookie, which is scoped to this request.
        await bestEffortAccessToken(getAccessToken),
      );
      // Record what this token became, so a later reopen of THIS link can
      // tell the continuation cookie is describing the same request rather
      // than whichever one this browser claimed most recently.
      rememberClaimedHandoff(handoffToken, result.requestId);
      // `replaceState`, not push: the token URL must not be somewhere the
      // back button can return to, and it is single-use anyway.
      window.history.replaceState({}, "", handoffRequestPath(result.requestId));
    },
    [getAccessToken],
  );

  /** What a claim that did not succeed leaves on screen. */
  const settleFailedClaim = useCallback(
    async (handoffToken: string, cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      // No answer about the link: keep it, in the address bar as well as in
      // `claimLinkRef`, so both Retry and a reload try the claim again.
      if (isTransientCallFailure(cause)) {
        setRetryableClaim(true);
        setError(message);
        return;
      }
      setRetryableClaim(false);
      // A refused claim must not leave its token in the address bar for as
      // long as the error screen stays up: every telemetry sink and every
      // `Referer` sees the URL. The success path trades it for the request
      // page; this is the same rule for a refusal. The resume below may still
      // move on to the request page, and the recoveries use `claimLinkRef`,
      // not the URL.
      window.history.replaceState({}, "", handoffRefusedPath());
      // A refusal about WHO is asking is recoverable, and gets its own screen
      // with the action that recovers it. Everything else is the existing
      // dead-end report.
      const claimRefusal =
        cause instanceof HandoffCallError
          ? readClaimRefusal(cause.details)
          : null;
      if (claimRefusal) {
        setRefusal(claimRefusal);
        return;
      }
      // A SPENT TOKEN IS NOT AUTOMATICALLY A DEAD END, and treating it as one
      // is what turned a re-opened link into a burned retry. The first claim
      // cleared the handoff digest, but it also set the continuation cookie —
      // the credential every later step of the flow already authenticates
      // with. If that cookie still resolves to a request, this is the same
      // browser coming back to its own link, and the honest answer is to put
      // the user back in the flow rather than tell them it is gone.
      //
      // A browser that never claimed has no cookie and gets the used-link
      // screen exactly as before.
      //
      // MATCHED, NOT MERELY PRESENT. The cookie has one name and always
      // describes the last link this browser claimed, so a browser that
      // claimed A and then B would answer a reopened A with B — a different
      // server quietly swapped in behind the URL the user opened. The claim
      // recorded which request each token became; only that request may be
      // resumed here. When they disagree, the session behind this link really
      // is gone, and the used-link screen is the honest answer.
      if (isUsedLinkError(cause)) {
        const claimedRequestId = readClaimedHandoff(handoffToken);
        const resumed = claimedRequestId
          ? await call<HandoffState>("/state").catch(() => null)
          : null;
        if (resumed && resumed.requestId === claimedRequestId) {
          window.history.replaceState(
            {},
            "",
            handoffRequestPath(resumed.requestId),
          );
          setState(resumed);
          return;
        }
        setUsedLink(true);
      }
      setError(message);
    },
    [],
  );

  // First load: trade the token for the cookie, then take it out of the URL.
  //
  // WAITS FOR AUTHKIT, and that wait is the difference between this page
  // working and looping forever for a correctly signed-in user.
  //
  // `AuthKitProvider` swaps its `getAccessToken` when the client finishes
  // initializing: before that it is literally
  // `() => Promise.reject(new LoginRequiredError())`. `bestEffortAccessToken`
  // cannot tell that rejection from a genuinely signed-out visitor — the two
  // are the same error — so a claim issued during hydration went out with no
  // bearer, the backend saw an anonymous caller, and refused with
  // SIGN_IN_REQUIRED.
  //
  // Which then LOOPED, because signing in "succeeds" instantly for someone who
  // already has a session: AuthKit returns to this same URL (the token is only
  // stripped after a claim succeeds), the page cold-mounts, hydration races the
  // claim again, and the same screen comes back. Every cold load of a handoff
  // link is exactly the case that loses this race.
  useEffect(() => {
    if (isAuthLoading) return;
    if (claimed.current) return;
    claimed.current = true;

    void (async () => {
      const route = matchHandoffRoute(window.location.pathname);
      // The callback's answer from the inbox `main.tsx` moved it into before
      // telemetry started; the address bar holds only `?oauth_pending=1`.
      const callback = readCallbackParams(readOAuthCallbackParams() ?? "");
      const pending = readPendingAuthorization();

      try {
        if (route?.kind === "claim") {
          await claimHandoff(route.handoffToken);
        } else if (callbackMatchesPending(pending, callback)) {
          // Returned from the authorization server. The cookie travelled with
          // the top-level navigation, so this post is already authorized.
          await call("/authorize/complete", callback);
          // Cleared only after the post SUCCEEDS. Clearing first would mean a
          // transient failure stranded the user on `/oauth/callback` with the
          // one thing that could route them home already gone — and a reload,
          // the obvious thing to try, would do nothing.
          clearPendingAuthorization();
          // Spent: its reload copy goes with the callback route. Kept on a
          // failure above, for the same reason the marker is — a reload is the
          // obvious retry, and it needs the answer.
          consumeOAuthCallbackParams();
          window.history.replaceState(
            {},
            "",
            handoffRequestPath(pending!.requestId),
          );
        }
      } catch (cause) {
        if (route?.kind === "claim") {
          await settleFailedClaim(route.handoffToken, cause);
          return;
        }
        const claimRefusal =
          cause instanceof HandoffCallError
            ? readClaimRefusal(cause.details)
            : null;
        if (claimRefusal) {
          setRefusal(claimRefusal);
          return;
        }
        if (pending && callback && callbackMatchesPending(pending, callback)) {
          setRetryableCompletion({ callback, pending });
        }
        setError(cause instanceof Error ? cause.message : String(cause));
        return;
      }
      await refresh();
    })();
  }, [isAuthLoading, refresh, claimHandoff, settleFailedClaim]);

  /** Retry a claim that failed without an answer, from the link in memory. */
  const retryClaim = useCallback(async () => {
    const link = claimLinkRef.current;
    const route = link ? matchHandoffRoute(link.split(/[?#]/)[0] ?? "") : null;
    if (route?.kind !== "claim") return;
    setBusy(true);
    setError(null);
    setRetryableClaim(false);
    try {
      await claimHandoff(route.handoffToken);
    } catch (cause) {
      await settleFailedClaim(route.handoffToken, cause);
      setBusy(false);
      return;
    }
    setBusy(false);
    await refresh();
  }, [claimHandoff, settleFailedClaim, refresh]);

  /** Retry a failed `/authorize/complete` with the answer still in memory. */
  const retryCompletion = useCallback(async () => {
    if (!retryableCompletion) return;
    const { callback, pending } = retryableCompletion;
    setBusy(true);
    setError(null);
    try {
      await call("/authorize/complete", callback);
      clearPendingAuthorization();
      consumeOAuthCallbackParams();
      setRetryableCompletion(null);
      window.history.replaceState(
        {},
        "",
        handoffRequestPath(pending.requestId),
      );
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [retryableCompletion, refresh]);

  // Poll only while the outstanding step is someone else's.
  useEffect(() => {
    if (!state || !isWaitingHandoffStatus(state.status)) return;
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [state, refresh]);

  const act = useCallback(
    async (work: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await work();
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  /**
   * Cancel, WITHOUT the refresh every other action does.
   *
   * `/cancel` clears the continuation cookie — that is the point, the request
   * is over and the cookie authorizes nothing now. So the usual follow-up
   * `/state` call has nothing to authenticate with, comes back 401, and the
   * page shows an error for an action that worked. The cancel response already
   * carries the new status; using it is both correct and one fewer round trip.
   */
  const cancel = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await call<{ status: string }>("/cancel", {});
      setState((current) =>
        current ? { ...current, status: result.status, live: false } : current,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  const authorize = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const { authorizationUrl } = await call<{ authorizationUrl: string }>(
        "/authorize",
        {},
      );
      // Written before navigating, because after `assign` nothing here runs
      // again. The request id is all it holds; the authority to finish is the
      // cookie, which the browser sends on its own.
      if (state)
        rememberPendingAuthorization(state.requestId, authorizationUrl);
      window.location.assign(authorizationUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }, [state]);

  /**
   * Sign in and come back to THIS link.
   *
   * The return path is the link as it was opened (`claimLinkRef`), NOT the
   * address bar: a refused claim has already taken the token out of the URL,
   * and coming back needs it. `rememberHandoffSignInReturn` keeps that path
   * same-origin and sends only a nonce through AuthKit; see its docblock.
   *
   * A `null` nonce means the return could not be stored, so the user signs in
   * without one and lands on the app shell rather than back here. Refusing to
   * sign them in at all would be a worse answer to "storage is unavailable".
   */
  const signInAndReturn = useCallback(() => {
    setBusy(true);
    const nonce = rememberHandoffSignInReturn(
      claimLinkRef.current ??
        `${window.location.pathname}${window.location.search}`,
      window.location.origin,
    );
    void Promise.resolve(
      signIn(nonce ? { state: { [HANDOFF_SIGN_IN_STATE_KEY]: nonce } } : {}),
    ).catch((cause) => {
      setBusy(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [signIn]);

  /**
   * Drop this session and come straight back to the link, signed out.
   *
   * `navigate: false` then an explicit `assign`, mirroring what the sidebar's
   * sign-out already does: WorkOS's own logout redirect only goes to a URI the
   * dashboard allowlists, and a per-link handoff URL will never be on that
   * list. Clearing the session locally and navigating ourselves keeps the
   * return exact.
   *
   * It lands on the SIGN_IN_REQUIRED screen, which is correct — from there the
   * user signs in as the right account and the claim goes through.
   */
  const switchAccount = useCallback(() => {
    setBusy(true);
    // See `sign-out-latch`: without this, the refresh timer notices the
    // revoked session mid-navigation and redirects to sign-in, losing the
    // handoff link this function exists to return to.
    markSignOutInProgress();
    // And the gate, for the same reason: Convex drops its identity on the
    // render that loses the user. See `pause-queries-before-auth-clear`.
    pauseQueriesBeforeAuthClear();
    // The link itself, from memory: the address bar no longer carries the
    // token after a refusal. Loading it puts the token back in the URL only for
    // the claim that follows, which takes it out again either way.
    const back =
      claimLinkRef.current ??
      `${window.location.pathname}${window.location.search}`;
    // Revoke the session being dropped before WorkOS forgets it; bounded,
    // never rejects. See `revoke-session`.
    void startSessionRevocation(getAccessToken)
      .then(() => signOut({ navigate: false }))
      .catch(() => {
        // A failed sign-out still gets the navigation: the page re-reads the
        // session on load, so a session that did survive simply lands the user
        // back on this same screen rather than on a blank one.
      })
      .finally(() => window.location.assign(back));
  }, [signOut, getAccessToken]);

  if (refusal && !state) {
    return (
      <ClaimRefusal
        refusal={refusal}
        signedInAs={user?.email ?? null}
        busy={busy}
        onSignIn={signInAndReturn}
        onSwitchAccount={switchAccount}
      />
    );
  }

  // WHAT THIS SCREEN MAY AND MAY NOT CLAIM. Reaching it means the resume above
  // could not show this browser was the one that claimed the link — which says
  // nothing about WHO did. "You already used this" was therefore false in the
  // most common way to arrive here: opening the link in incognito, on a second
  // machine, or after a chat client's preview crawler spent it, where the user
  // is certain they never used it and the page appears to be lying.
  //
  // So the heading states only what is always true — the link was opened
  // elsewhere — and the body carries the rule that explains every one of those
  // cases without having to tell them apart.
  if (error && !state) {
    return (
      <Shell>
        <h1 className="text-lg font-semibold">
          {usedLink
            ? "This link was opened somewhere else"
            : retryableClaim
              ? "This link could not be opened yet"
              : "This link cannot be used"}
        </h1>
        {usedLink ? (
          <p className="text-sm text-muted-foreground">
            Connection links only work in the browser that first opened them.
            Create a new link from the CLI to connect again.
          </p>
        ) : (
          <ErrorCard
            error={error}
            variant="inline"
            onRetry={
              retryableCompletion
                ? () => {
                    if (!busy) void retryCompletion();
                  }
                : retryableClaim
                  ? () => {
                      if (!busy) void retryClaim();
                    }
                  : undefined
            }
          />
        )}
      </Shell>
    );
  }

  if (!state) {
    return (
      <Shell>
        <div className="flex items-center gap-3">
          <Spinner />
          <span className="text-sm text-muted-foreground">
            Opening this connection request…
          </span>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">
          {state.requestedName ?? state.serverName ?? "Connect an MCP server"}
        </h1>
        <p className="break-all font-mono text-xs text-muted-foreground">
          {state.displayUrl}
        </p>
        {state.hasQuery && (
          <p className="text-xs text-muted-foreground">
            This URL carries query parameters. Their values are hidden here
            because they may themselves be a credential.
          </p>
        )}
      </div>

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          {error}
        </p>
      )}

      {isWaitingHandoffStatus(state.status) && (
        <div className="flex items-center gap-3">
          <Spinner />
          <span className="text-sm text-muted-foreground">
            {state.status === "discovering"
              ? "Checking what this server requires…"
              : state.status === "authorizing"
                ? "Waiting for authorization to finish…"
                : "Verifying the connection…"}
          </span>
        </div>
      )}

      {state.status === "awaiting_project" && (
        <div className="space-y-3">
          <p className="text-sm">Choose where this server should live.</p>
          <ul className="space-y-2">
            {state.projects.map((project) => (
              <li key={project.id}>
                <button
                  type="button"
                  disabled={busy}
                  className="w-full rounded-md border px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-50"
                  onClick={() =>
                    void act(() =>
                      call("/select-project", { projectId: project.id }),
                    )
                  }
                >
                  {project.name}
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            disabled={busy}
            className="text-sm underline disabled:opacity-50"
            onClick={() => void act(() => call("/create-project", {}))}
          >
            {state.projects.length
              ? "Create a new personal project instead"
              : "Create a personal project and continue"}
          </button>
        </div>
      )}

      {state.status === "awaiting_authorization" && (
        <div className="space-y-3">
          <p className="text-sm">
            This server needs your permission before MCPJam can use it. You will
            be sent to the server's own sign-in page.
          </p>
          <button
            type="button"
            disabled={busy}
            className="w-full rounded-md bg-foreground px-3 py-2 text-sm text-background disabled:opacity-50"
            onClick={() => void authorize()}
          >
            {busy ? "Preparing…" : "Authorize"}
          </button>
        </div>
      )}

      {state.status === "ready" && (
        <p className="text-sm">
          Connected. You can close this page and go back to where you started.
        </p>
      )}

      {isTerminalHandoffStatus(state.status) && state.status !== "ready" && (
        <div className="space-y-2">
          <p className="text-sm">
            {state.errorMessage ??
              (state.status === "expired"
                ? "This request expired. Start a new one where you began."
                : "This request is no longer active.")}
          </p>
          {/* `errorRetryable` is the backend's judgement, not a guess from the
              status: offering "try again" for a refusal that will never clear
              is worse than offering nothing. */}
          {state.errorRetryable === true && (
            <p className="text-xs text-muted-foreground">
              Starting a new request from where you began may work.
            </p>
          )}
        </div>
      )}

      {!isTerminalHandoffStatus(state.status) && (
        <button
          type="button"
          disabled={busy}
          className="text-xs text-muted-foreground underline disabled:opacity-50"
          onClick={() => void cancel()}
        >
          Cancel this request
        </button>
      )}
    </Shell>
  );
}

export default ServerConnectionHandoff;
