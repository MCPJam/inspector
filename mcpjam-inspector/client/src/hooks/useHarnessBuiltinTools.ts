import { useEffect, useState } from "react";
import { useConvexAuth } from "convex/react";
import { useHost } from "@/hooks/useClients";
import { authFetch } from "@/lib/session-token";

/**
 * A harness's native built-in tool, normalized for DISPLAY. Mirrors the server
 * DTO (`HarnessBuiltinToolInfo` in server/utils/harness/registry.ts). These run
 * INSIDE the harness sandbox via its own agent loop — they are NOT callable
 * through MCPJam, so render them read-only (no "Run").
 */
export type HarnessBuiltinToolInfo = {
  key: string;
  name: string;
  commonName?: string;
  toolUseKind?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

// Built-in catalogs are static published-package metadata — cache per harness
// id for the whole session so switching hosts (or remounting the rail) doesn't
// refetch.
const CACHE = new Map<string, HarnessBuiltinToolInfo[]>();

/**
 * For the given previewed host, when it runs a harness (e.g. Claude Code),
 * fetches that harness's native built-in tools so the Tools panel / Raw tab can
 * show what the host can do. Returns an empty list for non-harness (emulated)
 * hosts or a null host.
 *
 * Takes the resolved `previewedHostId` from the caller (PlaygroundTab /
 * PlaygroundMain already compute it via `usePreviewedHostId` with the correct
 * `sharedProjectId ?? activeProjectId` key) rather than re-deriving it, so the
 * lookup can't drift from the rest of the playground.
 *
 * REST over `authFetch` + local state (no `useQuery` — that's Convex here, not
 * React Query).
 */
export function useHarnessBuiltinTools(hostId: string | null): {
  harnessId: string | null;
  tools: HarnessBuiltinToolInfo[];
  loading: boolean;
} {
  const { isAuthenticated } = useConvexAuth();
  const { host } = useHost({ isAuthenticated, hostId });
  const harnessId = host?.config?.harness ?? null;

  const [tools, setTools] = useState<HarnessBuiltinToolInfo[]>(() =>
    harnessId ? (CACHE.get(harnessId) ?? []) : [],
  );
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!harnessId) {
      setTools([]);
      setLoading(false);
      return;
    }
    const cached = CACHE.get(harnessId);
    if (cached) {
      setTools(cached);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    authFetch(
      `/api/v1/harness/${encodeURIComponent(harnessId)}/builtin-tools`,
      { signal: controller.signal },
    )
      .then(async (res) => {
        if (!res.ok) throw new Error(`harness builtin-tools ${res.status}`);
        const body = (await res.json()) as { items?: HarnessBuiltinToolInfo[] };
        const items = Array.isArray(body.items) ? body.items : [];
        CACHE.set(harnessId, items);
        if (!cancelled) setTools(items);
      })
      .catch(() => {
        // Soft-fail: a harness host with an unreachable catalog just shows no
        // built-in section rather than breaking the Tools panel.
        if (!cancelled) setTools([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [harnessId]);

  return { harnessId, tools, loading };
}
