import { useEffect, useState } from "react";
import { authFetch } from "@/lib/session-token";

/**
 * What a harness can actually be asked to do, as the SERVER sees it.
 *
 * WHY THIS IS FETCHED RATHER THAN KNOWN. `lib/harness-capabilities.ts` answers
 * the same questions from a static map, and for most controls that is right —
 * whether Codex honours `temperature` is a property of Codex. Tool approval
 * stopped being one: Codex has two transports and only the app-server one can
 * pause, so the honest answer depends on what a given deployment enabled. A map
 * cannot know that, and the failure mode of guessing is the bad one — the host
 * editor greys out a switch for a runtime that supports it, and the capability
 * is unreachable from the product.
 *
 * Mirrors the `GET /v1/harness/:harnessId/capabilities` DTO.
 */
export type HarnessCapabilities = {
  harnessId: string;
  /** Present only for a harness with more than one transport (Codex). */
  transport?: string;
  supportsNativeToolApproval: boolean;
  supportsHostExecutedToolApproval: boolean;
  supportsMcpToolApproval: boolean;
  mcpDelivery: "native" | "host-executed";
};

// Static registry metadata for the life of the server process, so cache per id
// for the session rather than refetching on every host-editor mount.
const CACHE = new Map<string, HarnessCapabilities>();

/**
 * Fetch a harness's capabilities by id. `null` for an emulated host.
 *
 * SOFT-FAILS to `undefined` rather than to a guess: the caller falls back to
 * the static map, which is the pre-existing behaviour. An unreachable endpoint
 * must not silently flip a switch in either direction.
 */
export function useHarnessCapabilities(harnessId: string | null): {
  capabilities: HarnessCapabilities | undefined;
  loading: boolean;
} {
  const [capabilities, setCapabilities] = useState<
    HarnessCapabilities | undefined
  >(() => (harnessId ? CACHE.get(harnessId) : undefined));
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!harnessId) {
      setCapabilities(undefined);
      setLoading(false);
      return;
    }
    const cached = CACHE.get(harnessId);
    if (cached) {
      setCapabilities(cached);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    authFetch(`/api/v1/harness/${encodeURIComponent(harnessId)}/capabilities`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`harness capabilities ${res.status}`);
        // `v1Resource` returns the object itself, not a `{ resource }`
        // envelope (unlike the `{ items }` page the tool catalog uses).
        const body = (await res.json()) as HarnessCapabilities;
        if (typeof body?.harnessId !== "string") {
          throw new Error("harness capabilities: unexpected shape");
        }
        CACHE.set(harnessId, body);
        if (!cancelled) setCapabilities(body);
      })
      .catch(() => {
        if (!cancelled) setCapabilities(undefined);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [harnessId]);

  return { capabilities, loading };
}
