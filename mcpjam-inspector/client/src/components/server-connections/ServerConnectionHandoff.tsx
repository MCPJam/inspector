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
} from "@/lib/server-connection-handoff";
import {
  readClaimRefusal,
  type ClaimRefusalDetails,
} from "@/shared/server-connection-claim-refusal";
import { useAuth } from "@workos-inc/authkit-react";

const API = "/api/web/server-connections";

/** Slow enough to be polite to a shared backend, fast enough that a discovery
 * finishing feels immediate. Only ever runs while a step belongs to someone
 * else — the page stops on every status the user must act on. */
const POLL_INTERVAL_MS = 2_000;

interface HandoffState {
  requestId: string;
  status: string;
  live: boolean;
  displayUrl: string;
  hasQuery: boolean;
  requestedName: string | null;
  serverName: string | null;
  isGuestOwner: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  errorRetryable: boolean | null;
  projects: Array<{ id: string; name: string }>;
}

/**
 * Who the visitor is, when they are signed in — for the CLAIM and nothing else.
 *
 * The backend refuses an account-owned handoff link to anyone but its owner,
 * and it can only tell who is asking from a verified bearer token. This page
 * used to send none, so the ownership check compared "nobody" against an owner
 * and refused EVERY account-owned link: create a request from the CLI, open
 * the link in the very same account, get "This authorization link belongs to a
 * different account."
 *
 * `getAccessToken` comes from `AuthKitProvider`, which `main.tsx` now mounts
 * around this page. Deliberately the SDK and not a fetch at a known URL: the
 * `/user_management` proxy is mounted only when `!HOSTED_MODE`, so a
 * hand-rolled call to it 404s in hosted and silently reproduces the same
 * refusal. Only the SDK knows which AuthKit origin this deployment uses.
 *
 * BEST EFFORT, ALWAYS. A signed-out visitor, a guest, an expired session or a
 * refresh that throws all resolve to `null`, the claim proceeds without a
 * header, and possession of the single-use token remains the capability for a
 * guest-owned request exactly as before.
 */
async function bestEffortAccessToken(
  getAccessToken: () => Promise<string | undefined>,
): Promise<string | null> {
  try {
    const token = await getAccessToken();
    return typeof token === "string" && token ? token : null;
  } catch {
    return null;
  }
}

/**
 * A failed call, with the envelope's `details` kept.
 *
 * The page used to throw a bare `Error` carrying only the message, which is
 * enough to REPORT a failure and not enough to ACT on one. A refused claim is
 * the case that needs more: whether to offer "sign in" or "switch account"
 * lives in `details`, not in the prose.
 */
class HandoffCallError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HandoffCallError";
  }
}

function isUsedLinkError(error: unknown): boolean {
  return (
    error instanceof HandoffCallError &&
    typeof error.details === "object" &&
    error.details !== null &&
    (error.details as { reason?: unknown }).reason === "REQUEST_NOT_FOUND"
  );
}

async function call<T>(
  path: string,
  body?: unknown,
  accessToken?: string | null,
): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method: body === undefined ? "GET" : "POST",
    // Same-origin is the default, but stating it makes the cookie requirement
    // legible next to the fetch that depends on it.
    credentials: "same-origin",
    ...(body === undefined
      ? {}
      : {
          headers: {
            "content-type": "application/json",
            ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
          },
          body: JSON.stringify(body),
        }),
  });
  const payload = (await response.json().catch(() => null)) as
    | (T & { message?: string; details?: unknown })
    | null;
  if (!response.ok) {
    throw new HandoffCallError(
      payload?.message ?? "Something went wrong. Please try again.",
      response.status,
      payload?.details,
    );
  }
  if (!payload) throw new Error("The server sent an unreadable response.");
  return payload;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
      <div className="w-full max-w-md space-y-6">{children}</div>
    </div>
  );
}

function Spinner() {
  return (
    <div
      className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground"
      role="status"
      aria-label="Working"
    />
  );
}

/**
 * The claim was refused because of WHO is asking — the one failure on this page
 * with something to do about it.
 *
 * Both branches say the link survives, because it does: the backend checks the
 * claimant before it consumes the token, so the same URL still works after
 * signing in or switching accounts. That is the fact the old single message
 * left out, and the reason people treated a recoverable state as a dead end.
 */
function ClaimRefusal({
  refusal,
  signedInAs,
  busy,
  onSignIn,
  onSwitchAccount,
}: {
  refusal: ClaimRefusalDetails;
  signedInAs: string | null;
  busy: boolean;
  onSignIn: () => void;
  onSwitchAccount: () => void;
}) {
  const owner = refusal.ownerHint;

  if (refusal.reason === "sign-in-required") {
    return (
      <Shell>
        <div className="space-y-2">
          <h1 className="text-lg font-semibold">
            Sign in to finish connecting
          </h1>
          <p className="text-sm text-muted-foreground">
            {owner
              ? `This connection request was created by ${owner}. Sign in to that account to continue.`
              : "This connection request was created by an MCPJam account. Sign in to continue."}
          </p>
          <p className="text-sm text-muted-foreground">
            This link is still valid — nothing has been used up.
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          className="w-full rounded-md bg-foreground px-3 py-2 text-sm text-background disabled:opacity-50"
          onClick={onSignIn}
        >
          {busy ? "Opening sign-in…" : "Sign in"}
        </button>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="space-y-2">
        <h1 className="text-lg font-semibold">
          This link belongs to a different account
        </h1>
        <p className="text-sm text-muted-foreground">
          {signedInAs ? (
            <>
              You are signed in as{" "}
              <span className="font-medium text-foreground">{signedInAs}</span>.{" "}
            </>
          ) : null}
          {owner
            ? `This connection request was created by ${owner}.`
            : "This connection request was created by a different MCPJam account."}
        </p>
        {/* Named explicitly because the CLI is where these links come from, and
            an agent driving it cannot see which account it is acting as. The
            mismatch is almost always "the browser and the terminal are logged
            into different accounts", and `whoami` is the one command that
            settles it. */}
        <p className="text-sm text-muted-foreground">
          If you started this from the MCPJam CLI, that is the account it is
          logged into — <code className="font-mono text-xs">mcpjam whoami</code>{" "}
          will confirm which.
        </p>
        <p className="text-sm text-muted-foreground">
          This link is still valid. Switch accounts and open it again.
        </p>
      </div>
      <button
        type="button"
        disabled={busy}
        className="w-full rounded-md bg-foreground px-3 py-2 text-sm text-background disabled:opacity-50"
        onClick={onSwitchAccount}
      >
        {busy ? "Signing out…" : "Switch account"}
      </button>
    </Shell>
  );
}

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
  const claimed = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setState(await call<HandoffState>("/state"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

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
      const callback = readCallbackParams(window.location.search);
      const pending = readPendingAuthorization();

      try {
        if (route?.kind === "claim") {
          const result = await call<{ requestId: string }>(
            "/claim",
            { handoffToken: route.handoffToken },
            // Only the claim carries identity. Every later step authenticates
            // with the continuation cookie, which is scoped to this request.
            await bestEffortAccessToken(getAccessToken),
          );
          // Record what this token became, so a later reopen of THIS link can
          // tell the continuation cookie is describing the same request rather
          // than whichever one this browser claimed most recently.
          rememberClaimedHandoff(route.handoffToken, result.requestId);
          // `replaceState`, not push: the token URL must not be somewhere the
          // back button can return to, and it is single-use anyway.
          window.history.replaceState(
            {},
            "",
            handoffRequestPath(result.requestId),
          );
        } else if (callbackMatchesPending(pending, callback)) {
          // Returned from the authorization server. The cookie travelled with
          // the top-level navigation, so this post is already authorized.
          await call("/authorize/complete", callback);
          // Cleared only after the post SUCCEEDS. Clearing first would mean a
          // transient failure stranded the user on `/oauth/callback` with the
          // one thing that could route them home already gone — and a reload,
          // the obvious thing to try, would do nothing.
          clearPendingAuthorization();
          window.history.replaceState(
            {},
            "",
            handoffRequestPath(pending!.requestId),
          );
        }
      } catch (cause) {
        // A refusal about WHO is asking is recoverable, and gets its own
        // screen with the action that recovers it. Everything else is the
        // existing dead-end report.
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
        if (route?.kind === "claim" && isUsedLinkError(cause)) {
          const claimedRequestId = readClaimedHandoff(route.handoffToken);
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
        setError(cause instanceof Error ? cause.message : String(cause));
        return;
      }
      await refresh();
    })();
  }, [isAuthLoading, refresh]);

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
   * The return path is the address bar as it stands, which on a refused claim
   * still carries the handoff token — the page only strips it after a claim
   * SUCCEEDS. `rememberHandoffSignInReturn` keeps that path same-origin and
   * sends only a nonce through AuthKit; see its docblock.
   *
   * A `null` nonce means the return could not be stored, so the user signs in
   * without one and lands on the app shell rather than back here. Refusing to
   * sign them in at all would be a worse answer to "storage is unavailable".
   */
  const signInAndReturn = useCallback(() => {
    setBusy(true);
    const nonce = rememberHandoffSignInReturn(
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
    const back = `${window.location.pathname}${window.location.search}`;
    void Promise.resolve(signOut({ navigate: false }))
      .catch(() => {
        // A failed sign-out still gets the navigation: the page re-reads the
        // session on load, so a session that did survive simply lands the user
        // back on this same screen rather than on a blank one.
      })
      .finally(() => window.location.assign(back));
  }, [signOut]);

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
            : "This link cannot be used"}
        </h1>
        <p className="text-sm text-muted-foreground">
          {usedLink
            ? "Connection links only work in the browser that first opened them. Create a new link from the CLI to connect again."
            : error}
        </p>
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
