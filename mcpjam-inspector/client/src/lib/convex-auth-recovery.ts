import { flushSync } from "react-dom";
import type { ConvexReactClient } from "convex/react";
import * as Sentry from "@sentry/react";
import { useSessionRefreshStore } from "@/stores/session-refresh-store";
import { useSignOutStore } from "@/stores/sign-out-store";
import { reportCaught } from "./error-reporting";
import type { AuthTokenRequest } from "./unified-convex-auth";

type Outcome = "recovered" | "failed" | "cancelled";
type Stage =
  | "rejected"
  | "subscriptions_cancelled"
  | "token_same"
  | "token_new"
  | "token_missing"
  | "token_error"
  | "accepted"
  | "subscriptions_resumed";
type Episode = {
  id: string;
  startedAt: number;
  mode: "guest" | "workos" | "unknown";
  attempts: number;
  stages: { stage: Stage; at: number }[];
};
const installed = new WeakSet<ConvexReactClient>();

/**
 * Renew a token this close to its expiry when the page comes back (seconds).
 * Matches the client's `authRefreshTokenLeewaySeconds` in app-bootstrap.
 */
const RESUME_RENEW_LEEWAY_SECONDS = 60;
/** At most one resume renewal in this window, however many events fire. */
const RESUME_RENEW_MIN_INTERVAL_MS = 10_000;

/** The `exp` claim of a JWT, or null. Never logged; memory only. */
function tokenExpiry(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === "number" ? exp : null;
  } catch {
    return null;
  }
}

/** Install once, before mounting the provider. Only public Convex APIs are used. */
export function installConvexAuthRecovery(client: ConvexReactClient): void {
  if (installed.has(client)) return;
  installed.add(client);
  const setAuth = client.setAuth.bind(client);
  const clearAuth = client.clearAuth.bind(client);
  const close = client.close.bind(client);
  let controller: AbortController | undefined;
  let closed = false;
  let pendingClear = 0;
  let authenticated = false;
  let rejected = false;
  // A replacement token was handed to Convex during the current rejection.
  let replacementOffered = false;
  let mode: Episode["mode"] = "unknown";
  let episode: Episode | undefined;
  // The arguments of the current `setAuth`, so a resumed page can renew
  // through the same callbacks; and the token Convex is using right now.
  let currentArgs: Parameters<ConvexReactClient["setAuth"]> | undefined;
  let currentToken: string | null = null;
  let lastResumeRenewal = 0;
  const backend = new URL(client.url).hostname;
  const state = useSessionRefreshStore;

  const stage = (value: Stage) => {
    // Bounded diagnostic data. Never pass tokens, error messages or arguments.
    if (episode && episode.stages.length < 32) {
      episode.stages.push({ stage: value, at: Date.now() });
    }
  };
  const finish = (outcome: Outcome) => {
    if (!episode) return;
    const completed = episode;
    episode = undefined;
    try {
      const extra = { ...completed, outcome, finishedAt: Date.now(), backend };
      if (outcome === "failed") {
        reportCaught(new Error("Convex authentication recovery failed"), {
          source: "convex_auth_recovery",
          level: "warning",
          extra,
        });
      } else {
        Sentry.captureMessage("Convex authentication recovery", {
          level: "info",
          tags: {
            source: "convex_auth_recovery",
            auth_recovery_id: completed.id,
            convex_backend: backend,
            outcome,
          },
          extra,
        });
      }
    } catch {
      // Observability must never affect authentication.
    }
  };
  const invalidate = () => {
    controller?.abort();
    controller = undefined;
    authenticated = false;
    rejected = false;
    replacementOffered = false;
    state.setState({ authConfirmed: false });
    finish("cancelled");
  };
  const block = () => {
    flushSync(() =>
      state.setState({ authConfirmed: false, queriesPaused: true }),
    );
  };
  const fail = () => {
    authenticated = false;
    block();
    state.getState().notifyFailure("transient");
    finish("failed");
  };

  client.setAuth = (fetchToken, onChange, onRefreshChange) => {
    invalidate();
    currentArgs = [fetchToken, onChange, onRefreshChange];
    currentToken = null;
    if (useSignOutStore.getState().isSigningOut) return;
    pendingClear++;
    const current = new AbortController();
    controller = current;
    const isCurrent = () => controller === current && !current.signal.aborted;
    let lastToken: string | null = null; // Memory only, never included in logs.
    // Convex honors only the token fetch it started last: each start bumps
    // its config version and a fetch that finishes after a newer one began is
    // discarded. Two fetches overlap whenever a refused function's AuthError
    // arrives while a scheduled refresh is in flight (or two refusals arrive
    // together), and the token provider hands both the SAME fresh token. A
    // superseded fetch must therefore never record that token or decide the
    // recovery: if it did, the fetch Convex keeps would see the fresh token
    // as "unchanged after a rejection", fail the recovery, clear the socket's
    // identity, and replay queued mutations with none.
    let fetchSeq = 0;
    const getToken: (
      args: AuthTokenRequest & { forceRefreshToken: boolean },
    ) => Promise<string | null | undefined> = fetchToken;
    setAuth(
      async (args) => {
        if (!isCurrent()) return null;
        const seq = ++fetchSeq;
        const superseded = () => seq !== fetchSeq;
        // Recovery has no trustworthy cached identity. Convex's initial forced
        // refresh path also restarts a socket stopped by the previous rejection.
        if (!args.forceRefreshToken && state.getState().queriesPaused)
          return null;
        // The server refused the replacement too. Cancel every subscription
        // before Convex restarts the socket with yet another token.
        if (rejected && replacementOffered) {
          block();
          stage("subscriptions_cancelled");
        }
        let token: string | null | undefined;
        try {
          token = await getToken({
            ...args,
            signal: current.signal,
            onAttempt: (provider) => {
              if (!isCurrent()) return;
              mode = provider;
              if (episode) {
                episode.mode = provider;
                episode.attempts++;
              }
            },
          });
        } catch {
          if (!isCurrent() || superseded()) return null;
          stage("token_error");
          fail();
          return null;
        }
        if (!isCurrent()) return null;
        // Convex discards this result; only the newer fetch counts.
        if (superseded()) return token ?? null;
        stage(
          !token
            ? "token_missing"
            : token === lastToken
              ? "token_same"
              : "token_new",
        );
        if (!token || (rejected && token === lastToken)) {
          fail();
          return null;
        }
        lastToken = token;
        currentToken = token;
        if (rejected) replacementOffered = true;
        return token;
      },
      (accepted) => {
        if (!isCurrent()) return;
        authenticated = accepted;
        if (accepted) {
          rejected = false;
          replacementOffered = false;
          stage("accepted");
          state.setState((s) => ({
            authConfirmed: true,
            authEpoch: s.authEpoch + 1,
          }));
        } else {
          fail();
        }
        onChange?.(accepted);
      },
      (refreshing) => {
        if (!isCurrent()) return;
        if (refreshing) {
          rejected = true;
          replacementOffered = false;
          if (!episode) {
            try {
              episode = {
                id: crypto.randomUUID(),
                startedAt: Date.now(),
                mode,
                attempts: 0,
                stages: [],
              };
              state.setState({
                recoveryId: episode.id,
                recoveryAt: episode.startedAt,
              });
            } catch {
              // Even unavailable diagnostics/UUID generation must not stop the guard.
            }
          }
          stage("rejected");
          // The app stays mounted. Convex has stopped the socket and, on
          // restart, authenticates with the replacement before it
          // re-subscribes, so no subscription runs without identity. Open
          // Apps, chats and forms survive a refresh that succeeds; the
          // teardown waits for one that fails (`fail()`), or for the server
          // to refuse the replacement as well (above).
          state.setState({ authConfirmed: false });
        } else if (authenticated) {
          // Convex finishes a refresh here only after the server accepted the
          // replacement (a rejection's, or a scheduled one). Failure calls
          // onChange(false) first; clearAuth/setAuth invalidate this closure
          // before their reset callbacks.
          const recovering = rejected;
          rejected = false;
          replacementOffered = false;
          if (recovering) stage("accepted");
          state.setState((s) => ({
            authConfirmed: true,
            authEpoch: s.authEpoch + 1,
          }));
          if (recovering && !state.getState().queriesPaused)
            finish("recovered");
        }
        onRefreshChange?.(refreshing);
      },
    );
  };
  client.clearAuth = () => {
    invalidate();
    currentArgs = undefined;
    currentToken = null;
    const attempt = ++pendingClear;
    // React runs provider cleanup before subscriber cleanup on account changes.
    // Let unsubscriptions commit first; a replacement setAuth supersedes this
    // clear so an active connection never briefly receives an anonymous identity.
    queueMicrotask(() => {
      if (!closed && attempt === pendingClear) clearAuth();
    });
  };
  // A page that was hidden, frozen or asleep may have let the token run out:
  // Convex's own refresh is a single timer, which a background or suspended
  // page fires late, and the identity then expires under the open socket.
  // Coming back, renew BEFORE the next function finds the expired identity,
  // through the same `setAuth` the provider made, so the token provider
  // refreshes and the server never has to refuse anything.
  const renewOnResume = () => {
    if (closed || !currentArgs || !authenticated || rejected) return;
    if (document.visibilityState === "hidden") return;
    if (useSignOutStore.getState().isSigningOut) return;
    if (state.getState().status !== "idle") return;
    const exp = currentToken ? tokenExpiry(currentToken) : null;
    const leewayMs = RESUME_RENEW_LEEWAY_SECONDS * 1000;
    if (exp === null || exp * 1000 - Date.now() > leewayMs) return;
    const now = Date.now();
    if (now - lastResumeRenewal < RESUME_RENEW_MIN_INTERVAL_MS) return;
    lastResumeRenewal = now;
    client.setAuth(...currentArgs);
  };
  const resumeEvents: Array<[EventTarget | undefined, string]> =
    typeof window === "undefined"
      ? []
      : [
          [document, "visibilitychange"],
          [document, "resume"],
          [window, "focus"],
          [window, "online"],
          [window, "pageshow"],
        ];
  for (const [target, name] of resumeEvents)
    target?.addEventListener(name, renewOnResume);
  const stopWatchingReadiness = state.subscribe((next, previous) => {
    if (previous.queriesPaused && !next.queriesPaused && next.authConfirmed) {
      stage("subscriptions_resumed");
      finish("recovered");
    }
  });
  const stopWatchingSignOut = useSignOutStore.subscribe((next) => {
    if (next.isSigningOut) invalidate();
  });
  client.close = async () => {
    closed = true;
    invalidate();
    for (const [target, name] of resumeEvents)
      target?.removeEventListener(name, renewOnResume);
    stopWatchingReadiness();
    stopWatchingSignOut();
    await close();
  };
}
