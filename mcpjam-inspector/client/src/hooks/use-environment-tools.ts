import { useCallback, useEffect, useRef, useState } from "react";
import type { Tool } from "@modelcontextprotocol/client";
import { authFetch } from "@/lib/session-token";
import { shouldQueryProjectId } from "@/hooks/useProjects";
import type { EnvironmentPreviewServerSource } from "@/hooks/use-environment-preview";

/**
 * Client mirror of `GET /api/web/environments/:environmentId/tools` —
 * the environment's live tool surface, listed over the same ephemeral
 * server-side connections a chat turn uses.
 *
 * This is deliberately NOT `useAggregatedTools`: that hook reads the
 * browser's own connections, and in environment mode there are none — the
 * backend connects per turn, and plugin-contributed servers aren't even
 * representable in the browser's name-keyed catalog. One request returns
 * every server's tools (or its per-server error), so the Tools rail can show
 * what a turn will actually run against.
 */
export interface EnvironmentServerTools {
  serverId: string;
  name: string;
  source: EnvironmentPreviewServerSource | null;
  tools: Tool[];
  /** Present when THIS server failed to connect/list; siblings still load. */
  error?: string;
}

export interface UseEnvironmentToolsResult {
  servers: EnvironmentServerTools[] | null;
  isLoading: boolean;
  /** Whole-route failure (auth, resolve). Per-server failures live on rows. */
  error: string | null;
  refresh: () => void;
}

/**
 * Same target-keyed commit discipline as `use-environment-preview.ts`: an
 * environment switch blanks the list in the same render that changes the id,
 * and a slow response for environment A can never land as environment B's
 * tools. The `revision` dependency refetches after a live edit of the same
 * environment without blanking the panel.
 */
export function useEnvironmentTools(
  projectId: string | null,
  environmentId: string | null,
  revision?: number | null
): UseEnvironmentToolsResult {
  const [committed, setCommitted] = useState<{
    key: string | null;
    servers: EnvironmentServerTools[] | null;
    error: string | null;
    isLoading: boolean;
  }>({ key: null, servers: null, error: null, isLoading: false });
  const [refreshToken, setRefreshToken] = useState(0);
  const requestSeqRef = useRef(0);

  const normalizedProjectId = projectId?.trim() || null;
  const normalizedEnvironmentId = environmentId?.trim() || null;
  const targetKey =
    normalizedProjectId &&
    shouldQueryProjectId(normalizedProjectId) &&
    normalizedEnvironmentId
      ? `${normalizedProjectId}::${normalizedEnvironmentId}`
      : null;

  useEffect(() => {
    const seq = ++requestSeqRef.current;
    if (!targetKey || !normalizedProjectId || !normalizedEnvironmentId) {
      setCommitted({ key: null, servers: null, error: null, isLoading: false });
      return;
    }
    let active = true;
    setCommitted((current) =>
      current.key === targetKey
        ? { ...current, isLoading: true }
        : { key: targetKey, servers: null, error: null, isLoading: true }
    );
    (async () => {
      try {
        const response = await authFetch(
          `/api/web/environments/${encodeURIComponent(
            normalizedEnvironmentId
          )}/tools?projectId=${encodeURIComponent(normalizedProjectId)}`
        );
        const payload = (await response.json().catch(() => null)) as {
          servers?: EnvironmentServerTools[];
          error?: { message?: string } | string;
          message?: string;
        } | null;
        if (!active || seq !== requestSeqRef.current) return;
        if (!response.ok || !Array.isArray(payload?.servers)) {
          // Same probe order as `use-environment-preview`: `error` (string or
          // {message}) first, then a top-level `message` — some route error
          // envelopes carry only the latter, and dropping it would flatten an
          // actionable resolve/auth failure into the generic fallback.
          const message =
            typeof payload?.error === "string"
              ? payload.error
              : payload?.error?.message ||
                payload?.message ||
                "Couldn't load this environment's tools.";
          setCommitted({
            key: targetKey,
            servers: null,
            error: message,
            isLoading: false,
          });
          return;
        }
        setCommitted({
          key: targetKey,
          servers: payload.servers,
          error: null,
          isLoading: false,
        });
      } catch (caught) {
        if (!active || seq !== requestSeqRef.current) return;
        setCommitted({
          key: targetKey,
          servers: null,
          error:
            caught instanceof Error
              ? caught.message
              : "Couldn't load this environment's tools.",
          isLoading: false,
        });
      }
    })();
    return () => {
      active = false;
    };
  }, [
    targetKey,
    normalizedProjectId,
    normalizedEnvironmentId,
    revision,
    refreshToken,
  ]);

  const refresh = useCallback(() => setRefreshToken((n) => n + 1), []);

  const matchesTarget = committed.key === targetKey;
  return {
    servers: matchesTarget ? committed.servers : null,
    error: matchesTarget ? committed.error : null,
    isLoading: targetKey ? (matchesTarget ? committed.isLoading : true) : false,
    refresh,
  };
}
