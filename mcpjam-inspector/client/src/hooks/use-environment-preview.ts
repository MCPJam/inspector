import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/session-token";
import { shouldQueryProjectId } from "@/hooks/useProjects";

/**
 * Client mirror of the server's `EnvironmentPreview`
 * (`server/services/environments/runtime.ts` → `toEnvironmentPreview`).
 *
 * Hand-mirrored rather than imported: `runtime.ts` is a server module (Convex
 * client, Hono route errors) and pulling its types across would drag the module
 * into the browser graph. It is NOT a second copy of `ProjectEnvironmentView`
 * either — that mirrors the stored Convex ROW; this mirrors what the row
 * currently RESOLVES to, which is live (a host can change, a plugin can be
 * disabled) and therefore only obtainable from the runtime resolver.
 *
 * Deploy-skew posture matches the rest of the environment contracts: identity
 * fields are required, everything additive is optional/defaulted.
 */
export type EnvironmentPreviewServerSource =
  | "host_or_group"
  | "plugin"
  | "override";

export type EnvironmentPreviewSkillChannel = "host" | "environment" | "plugin";

export type EnvironmentSkillDelivery = "emulated" | "harness" | "unsupported";

export interface EnvironmentPreviewServer {
  serverId: string;
  name: string;
  source: EnvironmentPreviewServerSource | null;
}

export interface EnvironmentPreview {
  specVersion: number | null;
  environment: { environmentId: string; name: string; revision: number };
  host: {
    hostId: string;
    hostName: string | null;
    hostConfigId: string | null;
    modelId: string | null;
    hostStyle: string | null;
    harness: string | null;
  };
  servers: EnvironmentPreviewServer[];
  skills: Array<{
    skillId: string;
    name: string;
    description: string;
    channels: EnvironmentPreviewSkillChannel[];
    hasFiles: boolean;
  }>;
  plugins: Array<{ pluginId: string; pluginVersionId: string; name: string }>;
  capabilities: {
    requireToolApproval: boolean | null;
    respectToolVisibility: boolean | null;
    progressiveToolDiscovery: boolean | null;
    builtInToolIds: string[];
    hasComputer: boolean;
    serverCount: number;
    skillCount: number;
    skillDelivery: EnvironmentSkillDelivery;
    pluginCount: number;
    serversOverridden: boolean;
  };
}

export interface UseEnvironmentPreviewResult {
  preview: EnvironmentPreview | null;
  isLoading: boolean;
  /** Human-readable failure, or `null`. Never a thrown error — a Playground
   *  that can't preview must still render its host-mode chrome. */
  error: string | null;
  refresh: () => void;
}

function readErrorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object") {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string" && error.length > 0) return error;
    if (error && typeof error === "object") {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.length > 0) return message;
    }
    const message = (payload as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return fallback;
}

/**
 * Read what an environment currently resolves to.
 *
 * Goes through `GET /api/web/environments/:environmentId/preview` — the ONE
 * browser-reachable read path for this. The browser must never call `/api/v1`
 * (`session-token.ts` allowlists only `/api/v1/harness/`), and adding a second
 * read path would mean two projections of the same spec drifting apart.
 *
 * The route deliberately never applies a per-turn server override, so what
 * comes back is always the environment's OWN set — which is exactly why a
 * refreshed preview can update the displayed base without any risk of erasing
 * an explicit override the user set locally.
 */
export function useEnvironmentPreview(
  projectId: string | null,
  environmentId: string | null,
  /**
   * The selected row's current `revision`, from the reactive Convex list.
   * Passing it makes an edit — in another tab, or by a collaborator —
   * refetch the preview. Without it the next turn would resolve server-side
   * against the NEW revision while the UI still displayed the old host,
   * counts and server checkboxes, and toggling one of those stale boxes
   * would materialize an override out of obsolete server ids.
   */
  revision?: number | null
): UseEnvironmentPreviewResult {
  const [preview, setPreview] = useState<EnvironmentPreview | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  // Guards against a slow response for environment A landing after the user
  // already switched to B — the stale body would describe the wrong bundle.
  const requestSeqRef = useRef(0);

  useEffect(() => {
    const normalizedProjectId = projectId?.trim() || null;
    const normalizedEnvironmentId = environmentId?.trim() || null;
    const seq = ++requestSeqRef.current;
    // `shouldQueryProjectId`, not a bare truthiness check: a local/placeholder
    // project id during a project transition is well-formed but not
    // queryable, and would surface as a spurious "couldn't be resolved" error.
    if (
      !normalizedProjectId ||
      !shouldQueryProjectId(normalizedProjectId) ||
      !normalizedEnvironmentId
    ) {
      setPreview(null);
      setError(null);
      setIsLoading(false);
      return;
    }
    let active = true;
    setIsLoading(true);
    (async () => {
      try {
        const response = await authFetch(
          `/api/web/environments/${encodeURIComponent(
            normalizedEnvironmentId
          )}/preview?projectId=${encodeURIComponent(normalizedProjectId)}`
        );
        const payload = await response.json().catch(() => null);
        if (!active || seq !== requestSeqRef.current) return;
        if (!response.ok) {
          setPreview(null);
          setError(
            readErrorMessage(payload, "This environment couldn't be resolved.")
          );
          return;
        }
        setPreview(payload as EnvironmentPreview);
        setError(null);
      } catch (caught) {
        if (!active || seq !== requestSeqRef.current) return;
        setPreview(null);
        setError(
          caught instanceof Error
            ? caught.message
            : "This environment couldn't be resolved."
        );
      } finally {
        if (active && seq === requestSeqRef.current) setIsLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [projectId, environmentId, revision, refreshToken]);

  const refresh = useCallback(() => setRefreshToken((n) => n + 1), []);

  return { preview, isLoading, error, refresh };
}
