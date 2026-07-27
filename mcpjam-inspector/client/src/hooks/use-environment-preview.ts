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

/** One plugin VERSION the environment pins, as the preview reports it. */
export interface EnvironmentPreviewPlugin {
  pluginId: string;
  pluginVersionId: string;
  name: string;
}

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
  plugins: EnvironmentPreviewPlugin[];
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
   *
   * It is NOT a complete staleness signal, and deliberately so: the referenced
   * host's config and an attached server group's membership are both live and
   * neither bumps this revision. See the focus-refetch effect below for why
   * that residual window is bounded and left to a refetch rather than a
   * subscription.
   */
  revision?: number | null
): UseEnvironmentPreviewResult {
  // Committed state carries the TARGET it describes. Everything returned below
  // is derived by comparing that target against the current one, so an
  // environment-id change blanks the preview in the very same render that
  // changes the id — a `useEffect` that cleared it afterwards would still let
  // one committed frame show the previous environment's name, host, counts and
  // server checkboxes, and a click landing on those stale checkboxes would
  // materialize an override out of another environment's server ids.
  //
  // The key deliberately excludes `revision`: a live EDIT of the SAME
  // environment must not blank the panel (live-config semantics), it must swap
  // the contents when the new body arrives.
  const [committed, setCommitted] = useState<{
    key: string | null;
    preview: EnvironmentPreview | null;
    error: string | null;
    isLoading: boolean;
  }>({ key: null, preview: null, error: null, isLoading: false });
  const [refreshToken, setRefreshToken] = useState(0);
  // Guards against a slow response for environment A landing after the user
  // already switched to B — the stale body would describe the wrong bundle.
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
    // `shouldQueryProjectId`, not a bare truthiness check: a local/placeholder
    // project id during a project transition is well-formed but not
    // queryable, and would surface as a spurious "couldn't be resolved" error.
    if (!targetKey || !normalizedProjectId || !normalizedEnvironmentId) {
      setCommitted({
        key: null,
        preview: null,
        error: null,
        isLoading: false,
      });
      return;
    }
    let active = true;
    setCommitted((current) =>
      current.key === targetKey
        ? { ...current, isLoading: true }
        : { key: targetKey, preview: null, error: null, isLoading: true }
    );
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
          setCommitted({
            key: targetKey,
            preview: null,
            error: readErrorMessage(
              payload,
              "This environment couldn't be resolved."
            ),
            isLoading: false,
          });
          return;
        }
        setCommitted({
          key: targetKey,
          preview: payload as EnvironmentPreview,
          error: null,
          isLoading: false,
        });
      } catch (caught) {
        if (!active || seq !== requestSeqRef.current) return;
        setCommitted({
          key: targetKey,
          preview: null,
          error:
            caught instanceof Error
              ? caught.message
              : "This environment couldn't be resolved.",
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

  // Refetch when the tab regains focus.
  //
  // The `revision` dependency above only catches edits to the environment ROW.
  // It does NOT catch the two other things a preview depends on: the referenced
  // host's config rotating, or an attached server group's membership changing —
  // neither bumps the environment's revision. That residual staleness is
  // bounded rather than silent: a per-turn override naming a server that is no
  // longer resolvable is REJECTED by the backend's runtime override validation
  // (`validateRuntimeServerOverride` — an id must be in the freshly resolved
  // base or an ordinary live project server), so the worst case is a stale
  // DISPLAY followed by a refused turn, never a turn that quietly runs the
  // wrong bundle. That is why this is a focus refetch and not a subscription or
  // a poll: it closes the common "edited in another tab, came back" case for
  // one request, and the expensive mechanism would buy only a faster redraw.
  //
  // Both signals are needed and neither subsumes the other: backgrounding the
  // tab fires only `visibilitychange`, switching to another application leaves
  // the tab "visible" and fires only `blur`/`focus`. Returning from a
  // backgrounded tab, though, fires BOTH — so the refetch is driven off an
  // explicit away→back EDGE rather than off either event directly. Refetching
  // per event would issue two requests for one return, and the loser is not
  // free: it flips `isLoading` a second time, which now gates sends.
  useEffect(() => {
    if (!targetKey) return;
    let isAway = false;
    const markAway = () => {
      isAway = true;
    };
    const onReturn = () => {
      if (document.visibilityState === "hidden") {
        isAway = true;
        return;
      }
      if (!isAway) return;
      isAway = false;
      setRefreshToken((n) => n + 1);
    };
    window.addEventListener("blur", markAway);
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("blur", markAway);
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [targetKey]);

  const matchesTarget = committed.key === targetKey;
  const preview = matchesTarget ? committed.preview : null;
  const error = matchesTarget ? committed.error : null;
  // Pending-for-a-new-target counts as loading, so the section shows
  // "Resolving environment…" across the switch instead of an empty gap.
  const isLoading = targetKey
    ? matchesTarget
      ? committed.isLoading
      : true
    : false;

  return { preview, isLoading, error, refresh };
}
