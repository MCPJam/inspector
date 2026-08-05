import { useCallback, useEffect, useState } from "react";
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
 *    whole sub-router), and `/ci-evals` is reachable by guests — `EvalTabGate`
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
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isRevoking, setIsRevoking] = useState(false);

  const refresh = useCallback(async () => {
    if (!enabled) {
      setKeys([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    try {
      const items = await listApiKeys();
      setKeys(items);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load API keys");
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setKeys([]);
      setLoading(false);
      setError(null);
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  const create = useCallback(
    async (args: { name: string; organizationId: string }) => {
      setIsCreating(true);
      try {
        const created = await createApiKey(args);
        await refresh();
        return created;
      } finally {
        setIsCreating(false);
      }
    },
    [refresh],
  );

  const revoke = useCallback(
    async (id: string) => {
      setIsRevoking(true);
      try {
        await revokeApiKey(id);
        await refresh();
      } finally {
        setIsRevoking(false);
      }
    },
    [refresh],
  );

  return {
    keys,
    loading,
    error,
    refresh,
    create,
    isCreating,
    revoke,
    isRevoking,
  };
}
