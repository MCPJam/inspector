import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "@/lib/toast";
import { reportCaught } from "@/lib/error-reporting";
import type { McpProtocolVersion } from "@/lib/client-config-v2";
import {
  applyMcpProtocolVersionOverride,
  type ProjectServerConfigDto,
  type ProjectServerConfigInput,
  type ProtocolOverrideAutoEnrollRecord,
} from "@/lib/project-server-config";
import { useActiveMcpProfile } from "@/contexts/active-mcp-profile-context";
import { shouldQueryProjectId } from "@/hooks/useProjects";

export interface ServerProtocolPin {
  /** This server's pinned wire version, if any. */
  override: McpProtocolVersion | undefined;
  /** The host's default wire version; undefined means "auto" or none. */
  hostDefault: McpProtocolVersion | undefined;
  /** Saves a new pin and reconnects. Undefined while the pin can't be edited. */
  onOverrideChange:
    ((next: McpProtocolVersion | undefined) => Promise<void>) | undefined;
}

/**
 * The per-server MCP wire-version pin and the reconnect that applies it.
 *
 * The pin lives on the project layer
 * (`projectServerRefs.mcpProtocolVersionOverride`), not the server's own
 * config, so changing it is a `projectServerConfig:setConfig` round-trip
 * rather than a server update.
 */
export function useServerProtocolPin({
  projectId,
  serverId,
  isUserReady,
  hostDefaultMcpProtocolVersion,
  reconnect,
}: {
  projectId: string | null;
  /** The hosted server document id; the project config is keyed by it. */
  serverId: string | undefined;
  isUserReady: boolean;
  hostDefaultMcpProtocolVersion: McpProtocolVersion | "auto" | undefined;
  /**
   * Reconnects without an interactive OAuth flow and counts as in flight, so
   * the configuration Save is blocked for its duration. Must be stable.
   */
  reconnect: () => Promise<void>;
}): ServerProtocolPin {
  // Only a real Convex project id may reach this query — `getConfig` validates
  // `projectId` as `v.id("projects")`, and a LOCAL id (UUID, or a `local_` /
  // `project_` placeholder) makes it reject during render. Same guard every
  // other project-scoped Convex consumer uses; callers in local mode should
  // pass null, but this keeps a stray local id from taking down the page.
  const canQueryProjectServerConfig =
    isUserReady && shouldQueryProjectId(projectId);
  const projectServerConfigDto = useQuery(
    "projectServerConfig:getConfig" as never,
    canQueryProjectServerConfig ? ({ projectId } as never) : "skip"
  ) as ProjectServerConfigDto | null | undefined;
  const setProjectServerConfigMutation = useMutation(
    "projectServerConfig:setConfig" as never
  ) as unknown as (args: {
    projectId: string;
    input: ProjectServerConfigInput;
  }) => Promise<ProjectServerConfigDto>;
  const currentMcpProtocolVersionOverride = useMemo<
    McpProtocolVersion | undefined
  >(
    () =>
      serverId
        ? (projectServerConfigDto?.overrides?.[serverId]
            ?.mcpProtocolVersionOverride as McpProtocolVersion | undefined)
        : undefined,
    [projectServerConfigDto, serverId]
  );
  // Host default — prefer the explicit prop passed by the Servers tab
  // (which has direct access to `previewedHost.config.mcpProfile`),
  // falling back to `useActiveMcpProfile()` for renderers that mount
  // this modal inside an `ActiveMcpProfileProvider` scope (chat,
  // playground). Mixing the two sources lets the chip work everywhere
  // without forcing the Servers tab to also wire up the provider just
  // for the chip's source attribution.
  const activeMcpProfile = useActiveMcpProfile();
  const storedHostDefaultMcpProtocolVersion =
    hostDefaultMcpProtocolVersion ?? activeMcpProfile?.mcpProtocolVersion;
  const resolvedHostDefaultMcpProtocolVersion: McpProtocolVersion | undefined =
    storedHostDefaultMcpProtocolVersion === "auto"
      ? undefined
      : storedHostDefaultMcpProtocolVersion;
  const canEditMcpProtocolVersionOverride = Boolean(
    canQueryProjectServerConfig &&
    serverId &&
    projectServerConfigDto !== undefined
  );
  const protocolOverrideAutoEnrolledRef = useRef<
    Map<string, ProtocolOverrideAutoEnrollRecord>
  >(new Map());

  // Pending reconnect bookkeeping for the override-save → reconnect
  // race (see `handleMcpProtocolVersionOverrideChange` below). Holds the
  // target override value the user just wrote; the watcher effect
  // fires reconnect once the Convex query reflects the new value. The
  // tick counter forces the effect to re-run when the timeout fallback
  // fires, even if the Convex value hasn't changed (e.g. a hung
  // refetch).
  const pendingReconnectRef = useRef<{
    target: McpProtocolVersion | undefined;
  } | null>(null);
  const [pendingReconnectTick, setPendingReconnectTick] = useState(0);
  const fallbackReconnectTimerRef = useRef<number | null>(null);
  // The safety-net timer below outlives the modal: closing it a moment after
  // the toggle otherwise still fires a reconnect 1.5s later, against a server
  // the user has navigated away from.
  useEffect(
    () => () => {
      if (fallbackReconnectTimerRef.current !== null) {
        window.clearTimeout(fallbackReconnectTimerRef.current);
      }
    },
    []
  );
  /**
   * The wire-mode override's own reconnect. Both paths below reach it — the
   * reactive watcher and the 1.5s safety net — because neither goes through
   * the connect switch. Errors are reported, not toasted: the toggle owns
   * that.
   */
  const reconnectForWireModeOverride = useCallback(async () => {
    try {
      await reconnect();
    } catch (err) {
      reportCaught(err, {
        source: "server_detail_wire_mode_reconnect",
        level: "warning",
      });
    }
  }, [reconnect]);

  useEffect(() => {
    const pending = pendingReconnectRef.current;
    if (!pending) return;
    if (currentMcpProtocolVersionOverride !== pending.target) return;
    pendingReconnectRef.current = null;
    void reconnectForWireModeOverride();
  }, [
    currentMcpProtocolVersionOverride,
    reconnectForWireModeOverride,
    pendingReconnectTick,
  ]);

  const handleMcpProtocolVersionOverrideChange = async (
    next: McpProtocolVersion | undefined
  ): Promise<void> => {
    if (!canQueryProjectServerConfig || !projectId) {
      toast.error(
        "Wire mode override requires a project context; cannot save without projectId."
      );
      return;
    }
    if (!serverId) return;
    // `setConfig` replaces the entire `(serverIds, overrides)` pair on
    // the server. If the underlying Convex query is still loading
    // (`projectServerConfigDto === undefined`), defaulting to
    // `serverIds: []` / `overrides: {}` would wipe the project's
    // membership list and every other server's overrides — a
    // data-loss bug that fires if the user is fast enough to toggle
    // before hydration finishes. Bail out and surface a clear retry
    // hint instead.
    if (projectServerConfigDto === undefined) {
      toast.error(
        "Project configuration is still loading. Try again in a moment."
      );
      return;
    }
    try {
      // Shared splice + implicit-enrollment bookkeeping — same helper the
      // Add Server flow uses (`applyMcpProtocolVersionOverride`). The
      // `null` case is genuinely the empty baseline (no row yet).
      await applyMcpProtocolVersionOverride({
        projectId,
        serverId,
        current: projectServerConfigDto ?? null,
        next,
        setConfig: setProjectServerConfigMutation,
        autoEnrollCache: protocolOverrideAutoEnrolledRef.current,
      });
      // Reconnect-after-save race: `onReconnect` ultimately reads from
      // `activeHostConfig.serverConnectionOverrides` to compute the new
      // wire mode. That value is a derivation of the same Convex row we
      // just wrote, but `useQuery` doesn't repopulate synchronously —
      // there's a brief window where the reactive subscription hasn't
      // pushed the new snapshot yet. We can't read `activeHostConfig`
      // from here (it lives in `use-server-state`), but we CAN observe
      // the override on `projectServerConfigDto`, which is fed by the
      // same mutation. Schedule reconnect inside an effect that waits
      // until the read-back matches the value we just wrote — same
      // "wait for reactive refetch" gate, but expressible at this
      // boundary. Falls back to a 1.5s deadline so a stuck refetch
      // (network blip) doesn't strand the toggle in a half-applied
      // state — the reconnect runs anyway and the user can retry.
      pendingReconnectRef.current = { target: next };
      // Fallback: if the reactive refetch is delayed (network blip,
      // backend slow), trigger reconnect after 1.5s anyway. The watcher
      // effect short-circuits if it already fired.
      fallbackReconnectTimerRef.current = window.setTimeout(() => {
        fallbackReconnectTimerRef.current = null;
        if (pendingReconnectRef.current?.target === next) {
          pendingReconnectRef.current = null;
          void reconnectForWireModeOverride();
        }
      }, 1500);
      // Tick the watcher so it re-evaluates immediately in case the
      // query already returned the new value before this handler ran.
      setPendingReconnectTick((t) => t + 1);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : "The protocol version could not be changed. Try again."
      );
    }
  };

  return {
    override: currentMcpProtocolVersionOverride,
    hostDefault: resolvedHostDefaultMcpProtocolVersion,
    onOverrideChange: canEditMcpProtocolVersionOverride
      ? handleMcpProtocolVersionOverrideChange
      : undefined,
  };
}
