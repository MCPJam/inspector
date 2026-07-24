/**
 * Plugin import progress hooks.
 *
 * `usePluginImport` subscribes to a `pluginImports` row via Convex `useQuery`
 * (reactive — no manual polling loop; the row pushes on every state
 * transition) and returns the typed record plus derived phase flags.
 *
 * `usePluginImportRunner` drives the imperative upload → stage → inspect flow
 * (`plugin-import-client.ts`) and tracks the pre-row local phase (`uploading`)
 * that no server subscription can report yet, then hands off to the reactive
 * subscription once an `importId` exists.
 *
 * INS-1 provides the data/runner surface only; INS-2 owns the Add-plugin UI
 * that consumes these.
 */

import { useCallback, useState } from "react";
import { useConvex, useQuery } from "convex/react";
import {
  startPluginImportFromFolder,
  startPluginImportFromZip,
  type StartPluginImportResult,
} from "@/lib/plugins/plugin-import-client";
import type { PluginFolderFiles } from "@/lib/plugins/plugin-file-source";
import {
  isTerminalImportStatus,
  type PluginImportRecord,
} from "@/lib/plugins/plugin-import-types";

const GET_PLUGIN_IMPORT_FN = "plugins:getPluginImport";

export interface UsePluginImportResult {
  /** The import row, `undefined` while loading, `null` if not found/skipped. */
  record: PluginImportRecord | null | undefined;
  isLoading: boolean;
  /** True once the import reached a terminal state (completed/failed). */
  isTerminal: boolean;
  isInspecting: boolean;
  isPreviewReady: boolean;
  isFailed: boolean;
}

/**
 * Reactively subscribe to an import's progress. Pass `null`/`undefined` for
 * `importId` to skip the subscription (Convex "skip" sentinel) before an
 * import exists.
 */
export function usePluginImport(
  importId: string | null | undefined,
): UsePluginImportResult {
  const record = useQuery(
    GET_PLUGIN_IMPORT_FN as any,
    importId ? ({ importId } as any) : "skip",
  ) as PluginImportRecord | null | undefined;

  const status = record?.status;
  return {
    record,
    isLoading: importId != null && record === undefined,
    isTerminal: status !== undefined && isTerminalImportStatus(status),
    isInspecting: status === "inspecting" || status === "uploaded",
    isPreviewReady: status === "preview_ready",
    isFailed: status === "failed",
  };
}

/** Local phase of the imperative runner before/around the server subscription. */
export type PluginImportRunnerPhase =
  | "idle"
  | "uploading"
  | "inspecting"
  | "done"
  | "error";

export interface UsePluginImportRunnerState {
  phase: PluginImportRunnerPhase;
  importId: string | null;
  error: Error | null;
}

export interface UsePluginImportRunner extends UsePluginImportRunnerState {
  /** Upload + stage + inspect a prebuilt ZIP bundle (hosted or local). */
  startFromZip: (args: {
    projectId: string;
    bundle: Blob;
    sourceLabel?: string;
  }) => Promise<StartPluginImportResult>;
  /** Zip a selected folder, then run the same flow (local/Electron mode). */
  startFromFolder: (args: {
    projectId: string;
    files: PluginFolderFiles;
    sourceLabel?: string;
  }) => Promise<StartPluginImportResult>;
  /** Reset back to idle (e.g. when the modal closes or a retry starts). */
  reset: () => void;
}

/**
 * Imperative driver for a single import attempt. Pair the returned `importId`
 * with `usePluginImport(importId)` to render live progress once staging
 * succeeds. The runner surfaces the `uploading` phase (before an import row
 * exists) and the `inspecting` phase (while the Node action runs) so the UI can
 * show progress across the whole flow, not just the server-visible part.
 */
export function usePluginImportRunner(): UsePluginImportRunner {
  const convex = useConvex();
  const [state, setState] = useState<UsePluginImportRunnerState>({
    phase: "idle",
    importId: null,
    error: null,
  });

  const run = useCallback(
    async (
      exec: () => Promise<StartPluginImportResult>,
    ): Promise<StartPluginImportResult> => {
      setState({ phase: "uploading", importId: null, error: null });
      try {
        // `startPluginImportFrom*` performs upload → createImport → inspect in
        // sequence; we cannot observe the importId until it resolves, so the
        // runner reports `uploading` across upload+stage, then the result
        // carries the id and the terminal inspect status.
        const result = await exec();
        setState({
          phase: result.inspect.status === "failed" ? "error" : "done",
          importId: result.importId,
          error:
            result.inspect.status === "failed"
              ? new Error(
                  result.inspect.failureCode
                    ? `Inspection failed: ${result.inspect.failureCode}`
                    : "Inspection failed",
                )
              : null,
        });
        return result;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setState({ phase: "error", importId: null, error });
        throw error;
      }
    },
    [],
  );

  const startFromZip = useCallback<UsePluginImportRunner["startFromZip"]>(
    (args) => run(() => startPluginImportFromZip(convex, args)),
    [convex, run],
  );

  const startFromFolder = useCallback<UsePluginImportRunner["startFromFolder"]>(
    (args) => run(() => startPluginImportFromFolder(convex, args)),
    [convex, run],
  );

  const reset = useCallback(() => {
    setState({ phase: "idle", importId: null, error: null });
  }, []);

  return { ...state, startFromZip, startFromFolder, reset };
}
