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
  let mode: Episode["mode"] = "unknown";
  let episode: Episode | undefined;
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
    if (useSignOutStore.getState().isSigningOut) return;
    pendingClear++;
    const current = new AbortController();
    controller = current;
    const isCurrent = () => controller === current && !current.signal.aborted;
    let lastToken: string | null = null; // Memory only, never included in logs.
    const getToken: (
      args: AuthTokenRequest & { forceRefreshToken: boolean },
    ) => Promise<string | null | undefined> = fetchToken;
    setAuth(
      async (args) => {
        if (!isCurrent()) return null;
        // Recovery has no trustworthy cached identity. Convex's initial forced
        // refresh path also restarts a socket stopped by the previous rejection.
        if (!args.forceRefreshToken && state.getState().queriesPaused)
          return null;
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
          if (!isCurrent()) return null;
          stage("token_error");
          fail();
          return null;
        }
        if (!isCurrent()) return null;
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
        return token;
      },
      (accepted) => {
        if (!isCurrent()) return;
        authenticated = accepted;
        if (accepted) {
          rejected = false;
          stage("accepted");
          state.setState({ authConfirmed: true });
        } else {
          fail();
        }
        onChange?.(accepted);
      },
      (refreshing) => {
        if (!isCurrent()) return;
        if (refreshing) {
          rejected = true;
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
          block();
          stage("subscriptions_cancelled");
        } else if (rejected && authenticated) {
          // Convex only finishes an established session's rejection refresh here
          // after accepting the replacement. Failure calls onChange(false) first;
          // clearAuth/setAuth invalidate this closure before their reset callbacks.
          rejected = false;
          stage("accepted");
          state.setState({ authConfirmed: true });
        }
        onRefreshChange?.(refreshing);
      },
    );
  };
  client.clearAuth = () => {
    invalidate();
    const attempt = ++pendingClear;
    // React runs provider cleanup before subscriber cleanup on account changes.
    // Let unsubscriptions commit first; a replacement setAuth supersedes this
    // clear so an active connection never briefly receives an anonymous identity.
    queueMicrotask(() => {
      if (!closed && attempt === pendingClear) clearAuth();
    });
  };
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
    stopWatchingReadiness();
    stopWatchingSignOut();
    await close();
  };
}
