/**
 * Typed client for the backend plugin import API (PR INS-1 of
 * docs/plans/openai-plugin-import-cross-repo.md).
 *
 * Follows the repo's Convex convention: string function references through
 * `convex/react` hooks with hand-mirrored result types (two-repo layout — see
 * `client/src/lib/plugins/plugin-api-types.ts` for the mirrored contracts).
 *
 * Everything here is flag-gated behind `plugins-enabled` (fail-closed):
 * query hooks resolve to `undefined` (skipped) and the imperative actions
 * throw `PluginApiError("PLUGINS_DISABLED")` while the flag is off or still
 * loading. The backend does not read the flag — project-admin authorization
 * is the security boundary; this gate is a rollout control.
 *
 * Import flow (backend state machine: uploaded → inspecting → preview_ready
 * → committing → completed, any non-terminal → failed):
 *
 *   const actions = usePluginImportActions();
 *   const { importId } = await actions.startImport({ projectId, bundle });
 *   const row = usePluginImport(importId);       // reactive subscription
 *   // row.status === "preview_ready" → show row.preview, then:
 *   await actions.commitImport(importId, { setActive: true });
 */

import { useCallback, useMemo } from "react";
import { useAction, useConvexAuth, useMutation, useQuery } from "convex/react";
import {
  assertPluginBundleWithinCap,
  toPluginApiError,
  uploadPluginBundleToUrl,
} from "@/lib/plugins/plugin-api";
import { shouldQueryProjectId } from "./useProjects";
import {
  PluginApiError,
  type PluginCommitResult,
  type PluginDetail,
  type PluginImportRow,
  type PluginInspectResult,
  type PluginRuntimePreview,
  type PluginSetupStatus,
  type PluginSummary,
  type PluginVersionDetail,
} from "@/lib/plugins/plugin-api-types";
import { usePluginsEnabled } from "./usePluginsEnabled";

// ---------------------------------------------------------------------------
// Query hooks (reactive Convex subscriptions — the "polling" of the plan's
// import-progress requirement is a live subscription, not an interval).
// All skip while `plugins-enabled` is off/loading, auth has not resolved, or
// arguments are absent. Project-scoped hooks additionally gate on
// `shouldQueryProjectId` (the useProjects/useChatboxes convention): a
// transient LOCAL project id (UUID or `local_`/`project_` placeholder) is
// truthy but would throw an ArgumentValidationError during hydration.
// ---------------------------------------------------------------------------

/** Shared gate: `plugins-enabled` (fail-closed) AND Convex auth resolved. */
function usePluginQueriesReady(): boolean {
  const enabled = usePluginsEnabled();
  const { isAuthenticated } = useConvexAuth();
  return enabled && isAuthenticated;
}

/**
 * Subscribe to an import row's progress (`plugins.getPluginImport`).
 * `undefined` while skipped or loading; re-renders on every status
 * transition, including the terminal `completed` / `failed` states with
 * their `preview` / structured `failure`.
 */
export function usePluginImport(
  importId: string | null | undefined,
): PluginImportRow | undefined {
  const ready = usePluginQueriesReady();
  return useQuery(
    "plugins:getPluginImport" as any,
    ready && importId ? ({ importId } as any) : "skip",
  ) as PluginImportRow | undefined;
}

/** Live (non-uninstalled) plugins in a project (`plugins.listProjectPlugins`). */
export function useProjectPlugins(
  projectId: string | null | undefined,
): PluginSummary[] | undefined {
  const ready = usePluginQueriesReady();
  return useQuery(
    "plugins:listProjectPlugins" as any,
    ready && shouldQueryProjectId(projectId) ? ({ projectId } as any) : "skip",
  ) as PluginSummary[] | undefined;
}

/** A plugin with its versions, newest first (`plugins.getProjectPlugin`). */
export function useProjectPlugin(
  pluginId: string | null | undefined,
): PluginDetail | undefined {
  const ready = usePluginQueriesReady();
  return useQuery(
    "plugins:getProjectPlugin" as any,
    ready && pluginId ? ({ pluginId } as any) : "skip",
  ) as PluginDetail | undefined;
}

/** A version with its component projections (`plugins.getPluginVersion`). */
export function usePluginVersion(
  pluginVersionId: string | null | undefined,
): PluginVersionDetail | undefined {
  const ready = usePluginQueriesReady();
  return useQuery(
    "plugins:getPluginVersion" as any,
    ready && pluginVersionId ? ({ pluginVersionId } as any) : "skip",
  ) as PluginVersionDetail | undefined;
}

/** Per-version component readiness (`plugins.getPluginSetupStatus`). */
export function usePluginSetupStatus(
  pluginVersionId: string | null | undefined,
): PluginSetupStatus | undefined {
  const ready = usePluginQueriesReady();
  return useQuery(
    "plugins:getPluginSetupStatus" as any,
    ready && pluginVersionId ? ({ pluginVersionId } as any) : "skip",
  ) as PluginSetupStatus | undefined;
}

/**
 * Runtime resolution probe for exact version pins
 * (`plugins.resolvePluginRuntimePreview`). Never falls back from a missing
 * version to the plugin's active version; unavailable pins come back with
 * explicit reasons.
 */
export function usePluginRuntimePreview(
  projectId: string | null | undefined,
  pluginVersionIds: string[] | null | undefined,
): PluginRuntimePreview | undefined {
  const ready = usePluginQueriesReady();
  return useQuery(
    "plugins:resolvePluginRuntimePreview" as any,
    ready && shouldQueryProjectId(projectId) && pluginVersionIds
      ? ({ projectId, pluginVersionIds } as any)
      : "skip",
  ) as PluginRuntimePreview | undefined;
}

// ---------------------------------------------------------------------------
// Imperative actions.
// ---------------------------------------------------------------------------

export interface StartPluginImportArgs {
  projectId: string;
  /** The bundle ZIP (from `buildPluginZip` or a user-picked .zip file). */
  bundle: Blob | Uint8Array;
  /**
   * Display label for the source. The backend strips any path component and
   * caps length, so passing a file/folder name is safe.
   */
  sourceLabel?: string;
}

export interface StartPluginImportResult {
  importId: string;
  /** Result of the inspect action (`preview_ready` or `failed`). */
  inspect: PluginInspectResult;
}

export interface PluginImportActions {
  /** Mint a storage upload URL (`plugins.generateBundleUploadUrl`). */
  generateBundleUploadUrl: (projectId: string) => Promise<string>;
  /** Stage an uploaded bundle blob as an import (`plugins.createImport`). */
  createImport: (args: {
    projectId: string;
    bundleStorageId: string;
    sourceLabel?: string;
  }) => Promise<{ importId: string }>;
  /** Run the Node inspect action (`pluginsNode.inspectImport`). */
  inspectImport: (importId: string) => Promise<PluginInspectResult>;
  /** Commit a preview-ready import (`pluginsNode.commitImport`). */
  commitImport: (
    importId: string,
    options?: { setActive?: boolean },
  ) => Promise<PluginCommitResult>;
  /**
   * Full upload path: mint URL → POST the ZIP to storage → `createImport` →
   * `inspectImport`. Resolves once inspection lands `preview_ready` (or
   * `failed` — inspect failures are recorded on the row, not thrown).
   * Subscribe with `usePluginImport(importId)` for live progress.
   */
  startImport: (
    args: StartPluginImportArgs,
  ) => Promise<StartPluginImportResult>;
}

/**
 * Guarded imperative wrappers around the plugin import mutations/actions.
 * Every call rejects with `PluginApiError("PLUGINS_DISABLED")` while the
 * `plugins-enabled` flag is off or unresolved (fail-closed), and maps Convex
 * rejections to structured `PluginApiError`s (stable codes, RATE_LIMITED
 * scope/retryAfter).
 */
export function usePluginImportActions(): PluginImportActions {
  const enabled = usePluginsEnabled();
  const generateUploadUrlMutation = useMutation(
    "plugins:generateBundleUploadUrl" as any,
  );
  const createImportMutation = useMutation("plugins:createImport" as any);
  const inspectImportAction = useAction("pluginsNode:inspectImport" as any);
  const commitImportAction = useAction("pluginsNode:commitImport" as any);

  const requireEnabled = useCallback(() => {
    if (!enabled) {
      throw new PluginApiError(
        "PLUGINS_DISABLED",
        "Plugin import is not enabled for this account.",
      );
    }
  }, [enabled]);

  const generateBundleUploadUrl = useCallback(
    async (projectId: string): Promise<string> => {
      requireEnabled();
      try {
        return (await generateUploadUrlMutation({
          projectId,
        } as any)) as string;
      } catch (err) {
        throw toPluginApiError(err, "Could not create an upload URL");
      }
    },
    [requireEnabled, generateUploadUrlMutation],
  );

  const createImport = useCallback(
    async (args: {
      projectId: string;
      bundleStorageId: string;
      sourceLabel?: string;
    }): Promise<{ importId: string }> => {
      requireEnabled();
      try {
        return (await createImportMutation(args as any)) as {
          importId: string;
        };
      } catch (err) {
        throw toPluginApiError(err, "Could not create the plugin import");
      }
    },
    [requireEnabled, createImportMutation],
  );

  const inspectImport = useCallback(
    async (importId: string): Promise<PluginInspectResult> => {
      requireEnabled();
      try {
        return (await inspectImportAction({
          importId,
        } as any)) as PluginInspectResult;
      } catch (err) {
        throw toPluginApiError(err, "Could not inspect the plugin bundle");
      }
    },
    [requireEnabled, inspectImportAction],
  );

  const commitImport = useCallback(
    async (
      importId: string,
      options?: { setActive?: boolean },
    ): Promise<PluginCommitResult> => {
      requireEnabled();
      try {
        return (await commitImportAction({
          importId,
          ...(options ? { options } : {}),
        } as any)) as PluginCommitResult;
      } catch (err) {
        throw toPluginApiError(err, "Could not install the plugin");
      }
    },
    [requireEnabled, commitImportAction],
  );

  const startImport = useCallback(
    async (args: StartPluginImportArgs): Promise<StartPluginImportResult> => {
      requireEnabled();
      // Size-check BEFORE minting: generateBundleUploadUrl is rate-limited,
      // and an oversized bundle must not burn a token on a doomed upload.
      // uploadPluginBundleToUrl re-checks as defense in depth.
      assertPluginBundleWithinCap(args.bundle);
      const uploadUrl = await generateBundleUploadUrl(args.projectId);
      const bundleStorageId = await uploadPluginBundleToUrl(
        uploadUrl,
        args.bundle,
      );
      const { importId } = await createImport({
        projectId: args.projectId,
        bundleStorageId,
        sourceLabel: args.sourceLabel,
      });
      const inspect = await inspectImport(importId);
      return { importId, inspect };
    },
    [requireEnabled, generateBundleUploadUrl, createImport, inspectImport],
  );

  return useMemo(
    () => ({
      generateBundleUploadUrl,
      createImport,
      inspectImport,
      commitImport,
      startImport,
    }),
    [
      generateBundleUploadUrl,
      createImport,
      inspectImport,
      commitImport,
      startImport,
    ],
  );
}

export interface PluginManagementActions {
  /** Reversible kill switch (`plugins.setEnabled`). */
  setEnabled: (pluginId: string, enabled: boolean) => Promise<void>;
  /**
   * Point the plugin at a different ready version (`plugins.activateVersion`).
   * Affects which version NEW attachments offer; environments that already pin
   * a version keep it until they are explicitly upgraded.
   */
  activateVersion: (pluginId: string, pluginVersionId: string) => Promise<void>;
  /**
   * Soft uninstall (`plugins.softDeletePlugin`). Rejects with `CONFLICT` while
   * a live environment still pins one of the plugin's versions — surface that
   * message rather than retrying.
   */
  softDeletePlugin: (pluginId: string) => Promise<void>;
  /** Undo a soft uninstall (`plugins.restorePlugin`). */
  restorePlugin: (pluginId: string) => Promise<void>;
}

/**
 * Guarded wrappers around the plugin LIFECYCLE mutations (project-admin gated
 * backend-side). Same fail-closed flag gate and structured-error mapping as
 * {@link usePluginImportActions}; kept in this module so there is one plugin
 * client, not an import client plus a parallel management client.
 */
export function usePluginManagementActions(): PluginManagementActions {
  const enabled = usePluginsEnabled();
  const setEnabledMutation = useMutation("plugins:setEnabled" as any);
  const activateVersionMutation = useMutation("plugins:activateVersion" as any);
  const softDeleteMutation = useMutation("plugins:softDeletePlugin" as any);
  const restoreMutation = useMutation("plugins:restorePlugin" as any);

  const requireEnabled = useCallback(() => {
    if (!enabled) {
      throw new PluginApiError(
        "PLUGINS_DISABLED",
        "Plugin management is not enabled for this account.",
      );
    }
  }, [enabled]);

  const setEnabled = useCallback(
    async (pluginId: string, nextEnabled: boolean): Promise<void> => {
      requireEnabled();
      try {
        await setEnabledMutation({ pluginId, enabled: nextEnabled } as any);
      } catch (err) {
        throw toPluginApiError(
          err,
          nextEnabled
            ? "Could not enable the plugin"
            : "Could not disable the plugin",
        );
      }
    },
    [requireEnabled, setEnabledMutation],
  );

  const activateVersion = useCallback(
    async (pluginId: string, pluginVersionId: string): Promise<void> => {
      requireEnabled();
      try {
        await activateVersionMutation({ pluginId, pluginVersionId } as any);
      } catch (err) {
        throw toPluginApiError(err, "Could not activate that plugin version");
      }
    },
    [requireEnabled, activateVersionMutation],
  );

  const softDeletePlugin = useCallback(
    async (pluginId: string): Promise<void> => {
      requireEnabled();
      try {
        await softDeleteMutation({ pluginId } as any);
      } catch (err) {
        throw toPluginApiError(err, "Could not uninstall the plugin");
      }
    },
    [requireEnabled, softDeleteMutation],
  );

  const restorePlugin = useCallback(
    async (pluginId: string): Promise<void> => {
      requireEnabled();
      try {
        await restoreMutation({ pluginId } as any);
      } catch (err) {
        throw toPluginApiError(err, "Could not restore the plugin");
      }
    },
    [requireEnabled, restoreMutation],
  );

  return useMemo(
    () => ({ setEnabled, activateVersion, softDeletePlugin, restorePlugin }),
    [setEnabled, activateVersion, softDeletePlugin, restorePlugin],
  );
}
