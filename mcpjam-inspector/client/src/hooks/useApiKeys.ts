import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ApiKey,
  type CreatedApiKey,
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from "@/lib/apis/web/api-keys";

/**
 * The `/api/web/api-keys/*` state machine, extracted from `ApiKeysRoute` so
 * the SDK eval quickstart can mint a key inline without duplicating it.
 *
 * Two behaviors the settings page could hard-code but a second caller can't:
 *
 *  - `enabled`. The list call requires a session bearer
 *    (`server/routes/web/api-keys.ts` mounts `bearerAuthMiddleware` on the
 *    whole sub-router), and `/evals/runs` is reachable by guests — `EvalTabGate`
 *    only gates the playground variant. Firing the list for a signed-out
 *    visitor produces a guaranteed 401 and, on the settings page's behavior,
 *    an error toast on a page they never asked to manage keys from.
 *  - Errors are RETURNED, not toasted. The settings page owns the whole
 *    viewport and a toast reads fine there; the quickstart is one card in a
 *    scrolling page and needs to render failures in place, next to the button
 *    that caused them.
 */
export interface UseApiKeysOptions {
  /**
   * Whether to fetch. Pass the caller's "is this a signed-in WorkOS user"
   * signal. `false` leaves the hook idle: no request, `loading: false`, and
   * an empty key list — never a spurious error.
   */
  enabled: boolean;
}

export interface UseApiKeysResult {
  keys: ApiKey[];
  /** True while the list request is in flight. Never true when disabled. */
  loading: boolean;
  /** Last list failure, or null. Cleared by a successful refresh. */
  error: string | null;
  refresh: () => Promise<void>;
  /**
   * Mint a key and refresh the list. RESOLVES with the created key (whose
   * `value` is the one-time plaintext) or REJECTS — callers decide how to
   * surface the failure. Deliberately not swallowed into state: the settings
   * page toasts, the quickstart renders inline.
   */
  create: (args: {
    name: string;
    organizationId: string;
  }) => Promise<CreatedApiKey>;
  isCreating: boolean;
  revoke: (id: string) => Promise<void>;
  isRevoking: boolean;
}

export function useApiKeys({ enabled }: UseApiKeysOptions): UseApiKeysResult {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  // Starts true whenever the hook is (or becomes) enabled, so the gap between
  // "auth resolved" and "the effect fired the list request" reads as loading
  // rather than as an empty list. Otherwise a route mounted before auth
  // resolves flashes "No API keys yet" at someone who has keys.
  const [loading, setLoading] = useState(enabled);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isRevoking, setIsRevoking] = useState(false);

  // Monotonic refresh id. `create`/`revoke` each end in a refresh, so two
  // list requests can be in flight at once — the one this hook fired on mount
  // and the one that follows a mint. If the mount request resolves LAST, its
  // older list wins and the key that was just created disappears from `keys`
  // (or a revoked one comes back) until something refreshes again. Only the
  // newest request may commit.
  const refreshGeneration = useRef(0);

  // `enabled` read LIVE, not captured. `create`/`revoke` end in a refresh, and
  // that call runs after their own network round trip — by which point the user
  // may have signed out. A `refresh` closed over `enabled: true` would then
  // still fire the list request (a guaranteed 401) and, because it bumps the
  // generation last, its result would be the one allowed to commit — putting
  // the previous session's keys back on screen for a signed-out viewer.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const refresh = useCallback(async () => {
    if (!enabledRef.current) {
      // Bumped here too: a refresh in flight when the hook goes disabled must
      // not land afterwards and repopulate the list for a signed-out viewer.
      refreshGeneration.current += 1;
      setKeys([]);
      setLoading(false);
      setHasLoadedOnce(false);
      setError(null);
      return;
    }
    const generation = ++refreshGeneration.current;
    const isCurrent = () => refreshGeneration.current === generation;
    setLoading(true);
    try {
      const items = await listApiKeys();
      if (!isCurrent()) return;
      setKeys(items);
      setError(null);
    } catch (err) {
      if (!isCurrent()) return;
      setError(err instanceof Error ? err.message : "Failed to load API keys");
    } finally {
      // Same guard: a superseded request must not clear the spinner that the
      // request now in flight is responsible for.
      if (isCurrent()) {
        setLoading(false);
        setHasLoadedOnce(true);
      }
    }
    // Stable: `enabled` is read through `enabledRef`, so a mutation's
    // trailing refresh can never be a stale, still-enabled closure.
  }, []);

  // Unconditional, because `refresh` owns BOTH branches. An inline
  // `if (!enabled) { …reset… }` here instead is what let a request fired while
  // enabled still commit after sign-out: the reset it duplicated did not bump
  // the generation the guard reads. `enabled` is in the deps because `refresh`
  // is stable — it's what re-fires this on the sign-in / sign-out toggle.
  useEffect(() => {
    void refresh();
  }, [enabled, refresh]);

  // Both mutations resolve on their OWN request and let the list refresh
  // settle in the background. Awaiting the refresh here would hold
  // `isCreating` true through a follow-up GET, which keeps the dialog on
  // "Creating…" and — worse — delays the one-time key reveal behind a request
  // that has nothing to do with it. A slow or failing list must not be able to
  // cost the user a key they can never see again. The generation guard in
  // `refresh` is what makes the un-awaited call safe.
  const create = useCallback(
    async (args: { name: string; organizationId: string }) => {
      setIsCreating(true);
      try {
        return await createApiKey(args);
      } finally {
        setIsCreating(false);
        void refresh();
      }
    },
    [refresh],
  );

  const revoke = useCallback(
    async (id: string) => {
      setIsRevoking(true);
      try {
        await revokeApiKey(id);
      } finally {
        setIsRevoking(false);
        void refresh();
      }
    },
    [refresh],
  );

  return {
    keys,
    // Enabled but never yet completed a list ⇒ still loading, even in the
    // render between the enable flip and the effect that fires the request.
    loading: loading || (enabled && !hasLoadedOnce),
    error,
    refresh,
    create,
    isCreating,
    revoke,
    isRevoking,
  };
}
