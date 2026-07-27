import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  EnvironmentOverrides,
  HostedExecutionTarget,
} from "@/shared/execution-target";
import { usePreviewedEnvironmentId } from "@/hooks/use-previewed-environment-id";
import {
  useEnvironmentPreview,
  type EnvironmentPreview,
  type EnvironmentPreviewPlugin,
  type EnvironmentPreviewServer,
} from "@/hooks/use-environment-preview";
import { useProjectEnvironmentsEnabled } from "@/hooks/useProjectEnvironmentsEnabled";
import { useProjectEnvironments } from "@/hooks/useProjectEnvironments";

/**
 * Playground "environment mode" (Project Environments — Phase 2.1).
 *
 * The Playground has exactly two mutually exclusive modes in v1:
 *
 *   HOST / AD-HOC — today's behavior. One or more previewed hosts, servers
 *     selected from the browser's connected set, names resolved to Convex ids
 *     by the send-time preflight.
 *   ENVIRONMENT   — one named bundle. The SERVER re-resolves everything (host
 *     runtime config, server set, three-channel skills, pinned plugins) from
 *     one atomic read; the browser only points at it and, optionally, narrows
 *     the server set for the turn.
 *
 * Environment mode is deliberately incompatible with multi-host comparison:
 * comparison exists to run the same turn against several hosts, and an
 * environment already pins exactly one. The caller enforces that (it owns the
 * multi-host state) — this hook just reports which mode is active.
 *
 * ## The override tri-state, which is the whole point of this hook
 *
 * `serverOverrideIds` is `string[] | null`, and `null` is NOT "empty":
 *
 *   null  ⇒ follow the environment. No `environmentOverrides` field is sent at
 *           all, so the backend resolves the environment's own set.
 *   []    ⇒ an EXPLICIT override meaning "run this turn with no MCP servers".
 *   [ids] ⇒ an explicit narrowing.
 *
 * Collapsing `[]` into `null` would silently re-enable servers the user just
 * turned off, so the two never share a representation anywhere on the path from
 * this hook to `normalizeExecutionTarget`.
 *
 * A refreshed preview updates the displayed BASE (the preview route never
 * applies an override, so what it returns is always the environment's own set)
 * and never touches `serverOverrideIds`. The override is cleared on exactly one
 * event: the selected environment CHANGES. An environment EDIT — a new revision
 * of the same environment — is live-config semantics and leaves the user's
 * per-turn narrowing intact.
 *
 * ## Plugins (INS-4) use the SAME tri-state, and are equally ephemeral
 *
 * `pluginVersionOverrideIds` is the RETAINED subset of the environment's pinned
 * plugin versions. Like the server override it lives in component state only:
 * no session column, no delta store, no snapshot. A reload runs the
 * environment's plugin set again, and the server rejects any id the environment
 * does not pin — the selection is a request to narrow, never a grant.
 */
export interface PlaygroundEnvironmentState {
  /** True when the flag is on AND an environment is selected. */
  isEnvironmentMode: boolean;
  environmentId: string | null;
  preview: EnvironmentPreview | null;
  isPreviewLoading: boolean;
  previewError: string | null;
  /**
   * True while an environment is selected but has not yet resolved to a usable
   * preview (initial resolve, or the gap after switching to a different one).
   *
   * The caller GATES SENDS on this. Activating the target is synchronous but
   * everything that has to agree with it is not: the chat scope re-keys on the
   * new `executionTarget`, and the environment's host only becomes the
   * previewed host once the preview lands. A turn submitted inside that window
   * would carry the new environment id together with the PREVIOUS host's model,
   * system prompt and approval setting, and the scope reset that follows can
   * discard the in-flight message.
   *
   * A preview ERROR does not count as pending: there is nothing left to wait
   * for, and the backend is the authority on whether that environment can run.
   */
  isResolutionPending: boolean;
  refreshPreview: () => void;
  /** `null` ⇒ follow the environment. An array (INCLUDING `[]`) ⇒ explicit. */
  serverOverrideIds: string[] | null;
  /** True iff the user explicitly overrode — i.e. `serverOverrideIds !== null`. */
  hasExplicitOverride: boolean;
  /** `null` ⇒ follow the environment's pins. An array (INCLUDING `[]`) ⇒ explicit. */
  pluginVersionOverrideIds: string[] | null;
  hasExplicitPluginOverride: boolean;
  /**
   * The environment's pinned plugin versions to render, id-first; `enabled`
   * folds in the local override. Empty when the environment pins none — an
   * environment with no plugins shows no plugin chrome at all.
   */
  plugins: Array<EnvironmentPreviewPlugin & { enabled: boolean }>;
  /**
   * The environment-owned server entries to render, id-first. Base entries come
   * from the preview; `enabled` folds in the local override. These are NEVER
   * merged into the ordinary project-server list: plugin-contributed servers are
   * intentionally hidden from `servers:getProjectServers`, so a name-keyed
   * catalog cannot represent them.
   */
  servers: Array<EnvironmentPreviewServer & { enabled: boolean }>;
  /** The wire target, or `undefined` outside environment mode. */
  executionTarget: HostedExecutionTarget | undefined;
  /** Sent ONLY when the user explicitly overrode; `undefined` otherwise. */
  environmentOverrides: EnvironmentOverrides | undefined;
  selectEnvironment: (environmentId: string | null) => void;
  clearEnvironment: () => void;
  /** Back to "follow the environment" (`serverOverrideIds` → `null`). */
  resetServersToEnvironment: () => void;
  setServerEnabled: (serverId: string, enabled: boolean) => void;
  /** Back to "follow the environment" (`pluginVersionOverrideIds` → `null`). */
  resetPluginsToEnvironment: () => void;
  setPluginVersionEnabled: (pluginVersionId: string, enabled: boolean) => void;
}

export function usePlaygroundEnvironment(
  projectId: string | null
): PlaygroundEnvironmentState {
  const flagEnabled = useProjectEnvironmentsEnabled();
  const [storedEnvironmentId, setStoredEnvironmentId] =
    usePreviewedEnvironmentId(projectId);
  // Fail closed: a persisted id must not resurrect the mode for a user whose
  // flag was turned back off.
  const environmentId = flagEnabled ? storedEnvironmentId : null;

  const [serverOverrideIds, setServerOverrideIds] = useState<string[] | null>(
    null
  );
  const [pluginVersionOverrideIds, setPluginVersionOverrideIds] = useState<
    string[] | null
  >(null);

  // Clear the override when — and ONLY when — the SELECTED environment changes.
  // Keyed on the id, never on the preview object or its revision: a re-fetch or
  // a live edit must not discard what the user chose for this turn.
  const lastEnvironmentIdRef = useRef<string | null>(environmentId);
  useEffect(() => {
    if (lastEnvironmentIdRef.current === environmentId) return;
    lastEnvironmentIdRef.current = environmentId;
    setServerOverrideIds(null);
    setPluginVersionOverrideIds(null);
  }, [environmentId]);

  // The reactive list is already the client's source of truth for environment
  // rows, so the selected row's `revision` comes for free — no extra query.
  // Feeding it to the preview makes an edit elsewhere (another tab, a
  // collaborator) refetch, instead of leaving the UI describing a bundle the
  // next turn will no longer run.
  const environments = useProjectEnvironments(flagEnabled ? projectId : null);
  const selectedRevision = useMemo(() => {
    if (!environmentId) return null;
    return (
      environments?.find((env) => env.environmentId === environmentId)
        ?.revision ?? null
    );
  }, [environments, environmentId]);

  const { preview, isLoading, error, refresh } = useEnvironmentPreview(
    flagEnabled ? projectId : null,
    environmentId,
    selectedRevision
  );

  const servers = useMemo(() => {
    const base = preview?.servers ?? [];
    if (serverOverrideIds === null) {
      return base.map((server) => ({ ...server, enabled: true }));
    }
    const enabledIds = new Set(serverOverrideIds);
    return base.map((server) => ({
      ...server,
      enabled: enabledIds.has(server.serverId),
    }));
  }, [preview, serverOverrideIds]);

  const plugins = useMemo(() => {
    const base = preview?.plugins ?? [];
    if (pluginVersionOverrideIds === null) {
      return base.map((plugin) => ({ ...plugin, enabled: true }));
    }
    const enabledIds = new Set(pluginVersionOverrideIds);
    return base.map((plugin) => ({
      ...plugin,
      enabled: enabledIds.has(plugin.pluginVersionId),
    }));
  }, [preview, pluginVersionOverrideIds]);

  const selectEnvironment = useCallback(
    (next: string | null) => {
      if (!flagEnabled) return;
      // The effect above also clears on the resulting id change; doing it here
      // too keeps the transition atomic for a caller that reads the state in
      // the same tick. CONDITIONAL on the id actually changing, though —
      // re-picking the environment that is already selected is a no-op
      // selection, and clearing an explicit server override on it would throw
      // away a per-turn choice the user never asked to undo.
      if (next !== environmentId) {
        setServerOverrideIds(null);
        setPluginVersionOverrideIds(null);
      }
      setStoredEnvironmentId(next);
    },
    [flagEnabled, environmentId, setStoredEnvironmentId]
  );

  const clearEnvironment = useCallback(() => {
    setServerOverrideIds(null);
    setPluginVersionOverrideIds(null);
    setStoredEnvironmentId(null);
  }, [setStoredEnvironmentId]);

  const resetServersToEnvironment = useCallback(
    () => setServerOverrideIds(null),
    []
  );

  const setServerEnabled = useCallback(
    (serverId: string, enabled: boolean) => {
      setServerOverrideIds((current) => {
        // First interaction: materialize the override from the environment's
        // own set, so turning ONE server off doesn't read as "only this one".
        const base =
          current ?? (preview?.servers ?? []).map((server) => server.serverId);
        if (enabled) {
          return base.includes(serverId) ? [...base] : [...base, serverId];
        }
        return base.filter((id) => id !== serverId);
      });
    },
    [preview]
  );

  const resetPluginsToEnvironment = useCallback(
    () => setPluginVersionOverrideIds(null),
    []
  );

  const setPluginVersionEnabled = useCallback(
    (pluginVersionId: string, enabled: boolean) => {
      setPluginVersionOverrideIds((current) => {
        // Same materialization rule as the server override: the first toggle
        // starts from the environment's own pins, so switching ONE plugin off
        // does not read as "only this one".
        const base =
          current ??
          (preview?.plugins ?? []).map((plugin) => plugin.pluginVersionId);
        if (enabled) {
          return base.includes(pluginVersionId)
            ? [...base]
            : [...base, pluginVersionId];
        }
        return base.filter((id) => id !== pluginVersionId);
      });
    },
    [preview]
  );

  const isEnvironmentMode = flagEnabled && !!environmentId;

  return {
    isEnvironmentMode,
    environmentId,
    preview: isEnvironmentMode ? preview : null,
    isPreviewLoading: isEnvironmentMode && isLoading,
    previewError: isEnvironmentMode ? error : null,
    isResolutionPending: isEnvironmentMode && !preview && !error,
    refreshPreview: refresh,
    serverOverrideIds,
    hasExplicitOverride: serverOverrideIds !== null,
    servers,
    pluginVersionOverrideIds,
    hasExplicitPluginOverride: pluginVersionOverrideIds !== null,
    plugins,
    executionTarget:
      isEnvironmentMode && environmentId
        ? { kind: "environment", environmentId }
        : undefined,
    environmentOverrides:
      isEnvironmentMode &&
      (serverOverrideIds !== null || pluginVersionOverrideIds !== null)
        ? {
            ...(serverOverrideIds !== null
              ? { serverIds: serverOverrideIds }
              : {}),
            ...(pluginVersionOverrideIds !== null
              ? { pluginVersionIds: pluginVersionOverrideIds }
              : {}),
          }
        : undefined,
    selectEnvironment,
    clearEnvironment,
    resetServersToEnvironment,
    setServerEnabled,
    resetPluginsToEnvironment,
    setPluginVersionEnabled,
  };
}
