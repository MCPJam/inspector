import { create } from "zustand";

/**
 * Why the Convex auth token could not be refreshed.
 *
 * - `transient` — the token fetch failed its whole retry ladder (network down,
 *   upstream timeout). The session itself is probably fine, so retrying in
 *   place can genuinely recover.
 * - `signed_out` — WorkOS rejected the refresh outright. authkit has wiped the
 *   session and latched to its ERROR state; retrying can only re-throw, so the
 *   only way forward is signing in again.
 */
export type SessionRefreshFailureKind = "transient" | "signed_out";

interface SessionRefreshState {
  status: "idle" | "failed" | "retrying";
  kind: SessionRefreshFailureKind | null;
  /**
   * Bumped by `retry()`. `useUnifiedConvexAuth` lists this in its deps, so a
   * bump hands Convex a fresh `getAccessToken` identity, which re-runs
   * `client.setAuth` and re-authenticates in place — no page reload.
   */
  retryNonce: number;
  notifyFailure: (kind: SessionRefreshFailureKind) => void;
  retry: () => void;
  clear: () => void;
}

export const useSessionRefreshStore = create<SessionRefreshState>(
  (set, get) => ({
    status: "idle",
    kind: null,
    retryNonce: 0,
    notifyFailure: (kind) => {
      // A dead session never degrades back into a retryable one: once WorkOS
      // has rejected the refresh, a later network-flavored exhaustion must not
      // relabel it and offer a Retry that cannot possibly work.
      if (get().kind === "signed_out") {
        set({ status: "failed" });
        return;
      }
      set({ status: "failed", kind });
    },
    retry: () =>
      set((state) => ({
        status: "retrying",
        retryNonce: state.retryNonce + 1,
      })),
    clear: () => set({ status: "idle", kind: null }),
  }),
);
