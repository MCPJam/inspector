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
  handoffRequestPath,
  isTerminalHandoffStatus,
  isWaitingHandoffStatus,
  matchHandoffRoute,
  readCallbackParams,
  readPendingAuthorization,
  rememberPendingAuthorization,
} from "@/lib/server-connection-handoff";
import { getRuntimeWorkosClientId } from "@/lib/runtime-config";

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
 * is deliberately mounted WITHOUT `AuthKitProvider` so a signed-out visitor or
 * a guest can use it, so it has no token to send — which meant the ownership
 * check compared "nobody" against an owner and refused EVERY account-owned
 * link. The flow was unusable for signed-in users: create a request from the
 * CLI, open the link in the very same account, get "This authorization link
 * belongs to a different account."
 *
 * The session cookie is already sent on every call here, but it seals a
 * REFRESH token, not an identity — redeeming it server-side would rotate the
 * browser's session as a side effect of a claim. So the exchange goes through
 * the same proxy the app itself uses, which re-seals the rotated token
 * correctly.
 *
 * BEST EFFORT, ALWAYS. No session, no client id, a network failure, a 400 for
 * a signed-out visitor: all resolve to `null`, the claim proceeds without a
 * header, and possession of the single-use token remains the capability for
 * guest-owned requests exactly as before.
 */
async function bestEffortAccessToken(): Promise<string | null> {
  const clientId =
    getRuntimeWorkosClientId() ??
    (import.meta.env.VITE_WORKOS_CLIENT_ID as string | undefined);
  if (!clientId) return null;
  try {
    const response = await fetch("/user_management/authenticate", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: clientId,
      }),
    });
    if (!response.ok) return null;
    const payload = (await response.json().catch(() => null)) as {
      access_token?: unknown;
    } | null;
    return typeof payload?.access_token === "string"
      ? payload.access_token
      : null;
  } catch {
    return null;
  }
}

async function call<T>(
  path: string,
  body?: unknown,
  accessToken?: string | null
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
    | (T & { message?: string })
    | null;
  if (!response.ok) {
    throw new Error(
      payload?.message ?? "Something went wrong. Please try again."
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

export function ServerConnectionHandoff() {
  const [state, setState] = useState<HandoffState | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  useEffect(() => {
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
            await bestEffortAccessToken()
          );
          // `replaceState`, not push: the token URL must not be somewhere the
          // back button can return to, and it is single-use anyway.
          window.history.replaceState(
            {},
            "",
            handoffRequestPath(result.requestId)
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
            handoffRequestPath(pending!.requestId)
          );
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        return;
      }
      await refresh();
    })();
  }, [refresh]);

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
    [refresh]
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
        current ? { ...current, status: result.status, live: false } : current
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
        {}
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

  if (error && !state) {
    return (
      <Shell>
        <h1 className="text-lg font-semibold">This link cannot be used</h1>
        <p className="text-sm text-muted-foreground">{error}</p>
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
                      call("/select-project", { projectId: project.id })
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
