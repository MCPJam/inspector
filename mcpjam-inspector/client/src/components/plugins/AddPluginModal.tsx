import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  FileArchive,
  FolderOpen,
  Loader2,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Badge } from "@mcpjam/design-system/badge";
import type { PluginValidationIssue } from "@mcpjam/sdk/plugin-bundle";
import { PluginBundleError } from "@mcpjam/sdk/plugin-bundle";
import {
  folderSelectionToPluginZip,
  parsePluginBundleFromZip,
  readSelectedFileBytes,
} from "@/lib/plugins/folder-bundle";
import {
  PluginApiError,
  type PluginCommitResult,
} from "@/lib/plugins/plugin-api-types";
import {
  pluginPreviewAnalyticsProps,
  sanitizePluginCode,
} from "@/lib/plugins/plugin-analytics";
import {
  usePluginImport,
  usePluginImportActions,
  usePluginSetupStatus,
} from "@/hooks/usePluginImportApi";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import { PluginImportPreviewContent } from "./PluginImportPreviewContent";
import {
  describePluginReadiness,
  pluralize,
  shortBundleHash,
} from "./plugin-presentation";

/**
 * Connect → **Add plugin** (PR INS-2 of
 * docs/plans/openai-plugin-import-cross-repo.md).
 *
 * One dialog walks the whole backend import state machine — source selection →
 * upload/inspect progress → preview → confirmation → post-install setup — on
 * top of the INS-1 client (`usePluginImportApi`). Nothing here re-implements
 * validation, hashing, or upload; the SDK parser judges the bundle client-side
 * before an upload URL is minted, and the backend re-judges the same bytes.
 *
 * Three invariants this component is responsible for:
 *
 * 1. **Installed means the import ROW reached `completed`.** The success view
 *    is gated on the reactive row, never on the local commit promise or on a
 *    component count we computed ourselves — no component of a plugin is
 *    runtime-visible until the version is flipped ready during finalize.
 * 2. **Retry resumes.** The dialog stays mounted across close/open and keeps
 *    its `importId`, so a failed commit or a closed dialog resumes from the
 *    existing `preview_ready` import instead of re-uploading. `createImport`
 *    does NOT auto-schedule inspection, so an import stuck at `uploaded`
 *    resumes by re-driving `inspectImport` — not by starting over.
 * 3. **`reused: true` is not a fresh install.** Re-importing identical bytes
 *    is content-addressed and returns the SAME ready version; the summary says
 *    so rather than implying a new revision was created.
 */

type Busy = "preflight" | "importing" | "committing" | null;

interface SelectedBundle {
  kind: "zip" | "folder";
  /** File or folder name — never a path. Used as the backend `sourceLabel`. */
  label: string;
  zipBytes: Uint8Array;
  /** Content-defined identity the backend will recompute on the same bytes. */
  bundleHash: string;
  /** Non-fatal parser findings, shown before the upload is offered. */
  warnings: PluginValidationIssue[];
}

interface UiFailure {
  code: string;
  message: string;
  issues?: PluginValidationIssue[];
}

function toUiFailure(error: unknown, fallback: string): UiFailure {
  if (error instanceof PluginBundleError) {
    // The parser collects every issue before throwing, so the preflight panel
    // can list them all rather than only the first fatal one.
    return {
      code: error.code,
      message: error.issues.find((i) => i.severity === "error")?.message ??
        fallback,
      issues: error.issues,
    };
  }
  if (error instanceof PluginApiError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "UNKNOWN",
    message: error instanceof Error ? error.message : fallback,
  };
}

function IssueList({ issues }: { issues: PluginValidationIssue[] }) {
  return (
    <ul className="mt-2 space-y-1">
      {issues.map((issue, index) => (
        <li key={`${issue.code}-${index}`} className="text-xs">
          <code className="text-[11px]">{issue.code}</code>
          {issue.path ? (
            <span className="ml-1 text-[11px] text-muted-foreground">
              {issue.path}
            </span>
          ) : null}
          <span
            className={cn(
              "ml-1",
              issue.severity === "error"
                ? "text-destructive"
                : "text-muted-foreground",
            )}
          >
            {issue.message}
          </span>
        </li>
      ))}
    </ul>
  );
}

export interface AddPluginModalProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * The CONVEX project id (`sharedProjectId`). Null in local/unsynced mode —
   * import is a cloud operation, so the dialog explains that instead of
   * offering a picker that cannot succeed.
   */
  projectId: string | null;
  /** Fired after an import reaches `completed`, with the new version id. */
  onInstalled?: (result: { pluginId: string; pluginVersionId: string }) => void;
}

export function AddPluginModal({
  isOpen,
  onClose,
  projectId,
  onInstalled,
}: AddPluginModalProps) {
  const actions = usePluginImportActions();
  const [selected, setSelected] = useState<SelectedBundle | null>(null);
  const [importId, setImportId] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [failure, setFailure] = useState<UiFailure | null>(null);
  const [commitResult, setCommitResult] = useState<PluginCommitResult | null>(
    null,
  );
  const zipInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const row = usePluginImport(importId);
  // Post-install component health. Only meaningful once the row completed —
  // before that there is no ready version to ask about.
  const setupStatus = usePluginSetupStatus(
    row?.status === "completed" ? (row.pluginVersionId ?? null) : null,
  );

  // A plugin is installed when the IMPORT ROW says so. Deriving it from the
  // local commit promise (or from any client-side component tally) would let
  // the UI claim an install before the version was flipped ready.
  const isInstalled = row?.status === "completed" && !!row.pluginVersionId;

  const previewedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!row?.preview || row.status !== "preview_ready") return;
    if (previewedRef.current === row.importId) return;
    previewedRef.current = row.importId;
    track("plugin_import_previewed", {
      location: "add_plugin_modal",
      ...pluginPreviewAnalyticsProps(row.preview),
    });
  }, [row?.importId, row?.status, row?.preview]);

  const installedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isInstalled || !row) return;
    if (installedRef.current === row.importId) return;
    installedRef.current = row.importId;
    onInstalled?.({
      pluginId: row.pluginId!,
      pluginVersionId: row.pluginVersionId!,
    });
  }, [isInstalled, row, onInstalled]);

  const reset = useCallback(() => {
    setSelected(null);
    setImportId(null);
    setBusy(null);
    setFailure(null);
    setCommitResult(null);
    previewedRef.current = null;
    installedRef.current = null;
    if (zipInputRef.current) zipInputRef.current.value = "";
    if (folderInputRef.current) folderInputRef.current.value = "";
  }, []);

  // Switching projects invalidates an in-flight import: the row belongs to the
  // old project and a commit would target it. Start clean.
  useEffect(() => {
    reset();
  }, [projectId, reset]);

  const handleZipPicked = useCallback(
    async (file: File) => {
      setFailure(null);
      setBusy("preflight");
      try {
        const zipBytes = await readSelectedFileBytes(file);
        const parsed = await parsePluginBundleFromZip(zipBytes);
        setSelected({
          kind: "zip",
          label: file.name,
          zipBytes,
          bundleHash: parsed.bundleHash,
          warnings: parsed.warnings,
        });
      } catch (error) {
        setSelected(null);
        setFailure(toUiFailure(error, "That ZIP is not a valid plugin bundle."));
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const handleFolderPicked = useCallback(async (files: File[]) => {
    setFailure(null);
    setBusy("preflight");
    try {
      // Validates AND builds the uploadable ZIP from exactly the entries the
      // parser judged, so the backend inspects the same facts.
      const { parsed, zipBytes } = await folderSelectionToPluginZip(files);
      const rootName =
        (files[0] as { webkitRelativePath?: string })?.webkitRelativePath?.split(
          "/",
        )[0] ?? parsed.manifest.name;
      setSelected({
        kind: "folder",
        label: rootName,
        zipBytes,
        bundleHash: parsed.bundleHash,
        warnings: parsed.warnings,
      });
    } catch (error) {
      setSelected(null);
      setFailure(
        toUiFailure(error, "That folder is not a valid plugin bundle."),
      );
    } finally {
      setBusy(null);
    }
  }, []);

  const startImport = useCallback(async () => {
    if (!selected || !projectId) return;
    setFailure(null);
    setBusy("importing");
    track("plugin_import_started", {
      location: "add_plugin_modal",
      source_kind: selected.kind,
      bundle_bytes: selected.zipBytes.byteLength,
    });
    try {
      const result = await actions.startImport({
        projectId,
        bundle: selected.zipBytes,
        sourceLabel: selected.label,
      });
      setImportId(result.importId);
      if (result.inspect.status === "failed") {
        const code = result.inspect.failureCode ?? "INSPECT_FAILED";
        track("plugin_import_failed", {
          location: "add_plugin_modal",
          phase: "inspect",
          code: sanitizePluginCode(code),
        });
        // The row carries the sanitized message; keep the code as the fallback
        // so the panel is never empty while the subscription catches up.
        setFailure({ code, message: "The bundle could not be inspected." });
      }
    } catch (error) {
      const uiFailure = toUiFailure(error, "The plugin import failed.");
      track("plugin_import_failed", {
        location: "add_plugin_modal",
        phase: "upload",
        code: sanitizePluginCode(uiFailure.code),
      });
      setFailure(uiFailure);
    } finally {
      setBusy(null);
    }
  }, [actions, projectId, selected]);

  const resumeInspect = useCallback(async () => {
    if (!importId) return;
    setFailure(null);
    setBusy("importing");
    try {
      const result = await actions.inspectImport(importId);
      if (result.status === "failed") {
        setFailure({
          code: result.failureCode ?? "INSPECT_FAILED",
          message: "The bundle could not be inspected.",
        });
      }
    } catch (error) {
      setFailure(toUiFailure(error, "The bundle could not be inspected."));
    } finally {
      setBusy(null);
    }
  }, [actions, importId]);

  const commit = useCallback(
    async (setActive: boolean) => {
      if (!importId) return;
      setFailure(null);
      setBusy("committing");
      try {
        const result = await actions.commitImport(importId, { setActive });
        setCommitResult(result);
        if (result.status === "failed") {
          const code = result.failureCode ?? "COMMIT_FAILED";
          track("plugin_import_failed", {
            location: "add_plugin_modal",
            phase: "commit",
            code: sanitizePluginCode(code),
          });
          setFailure({ code, message: "The plugin could not be installed." });
          return;
        }
        track("plugin_import_completed", {
          location: "add_plugin_modal",
          set_active: setActive,
          reused: result.reused === true,
          ...(row?.preview ? pluginPreviewAnalyticsProps(row.preview) : {}),
        });
      } catch (error) {
        const uiFailure = toUiFailure(error, "The plugin could not be installed.");
        track("plugin_import_failed", {
          location: "add_plugin_modal",
          phase: "commit",
          code: sanitizePluginCode(uiFailure.code),
        });
        setFailure(uiFailure);
      } finally {
        setBusy(null);
      }
    },
    [actions, importId, row?.preview],
  );

  /**
   * What "try again" means depends on how far the import got. Resuming an
   * existing `preview_ready` import (rather than re-uploading) is an explicit
   * acceptance criterion; `uploaded` resumes by driving the inspect action the
   * client owns.
   */
  const retry = useMemo(() => {
    if (!importId || !row) {
      return selected ? { label: "Try again", run: startImport } : null;
    }
    if (row.status === "preview_ready") {
      return { label: "Retry install", run: () => commit(true) };
    }
    if (row.status === "uploaded" || row.status === "inspecting") {
      return { label: "Resume inspection", run: resumeInspect };
    }
    // `failed` is terminal for this import row (the backend refuses to commit
    // anything that is not `preview_ready`), so a retry has to be a new
    // import of the same bytes.
    return selected
      ? {
          label: "Start a new import",
          run: async () => {
            setImportId(null);
            setCommitResult(null);
            previewedRef.current = null;
            await startImport();
          },
        }
      : null;
  }, [commit, importId, resumeInspect, row, selected, startImport]);

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      // Deliberately does NOT reset: an import in flight (or a preview waiting
      // for a decision) survives a close so reopening resumes it. A finished
      // import is cleared, because its dialog has nothing left to resume.
      if (isInstalled) reset();
      onClose();
    }
  };

  const rowFailure = row?.failure;
  const activeFailure: UiFailure | null =
    failure ??
    (rowFailure ? { code: rowFailure.code, message: rowFailure.message } : null);

  const isBusy = busy !== null;
  const progressLabel =
    busy === "preflight"
      ? "Checking the bundle…"
      : busy === "importing"
        ? "Uploading and inspecting…"
        : busy === "committing"
          ? "Installing…"
          : row?.status === "inspecting"
            ? "Inspecting…"
            : row?.status === "committing"
              ? "Installing…"
              : null;

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        className="flex max-h-[85vh] flex-col sm:max-w-2xl"
        data-testid="add-plugin-modal"
      >
        <DialogHeader>
          <DialogTitle>Add plugin</DialogTitle>
          <DialogDescription>
            Import an OpenAI plugin bundle. MCPJam stores the original archive
            and creates a versioned, read-only projection of its skills and MCP
            servers.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 space-y-3 overflow-y-auto">
          {projectId === null ? (
            <p
              className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-sm text-muted-foreground"
              data-testid="add-plugin-no-project"
            >
              Plugin import needs a synced cloud project. Sign in and select a
              project to import a plugin.
            </p>
          ) : isInstalled ? (
            <InstalledSummary
              commitResult={commitResult}
              bundleHash={row?.preview?.bundleHash}
              setupComponents={setupStatus?.components}
            />
          ) : (
            <>
              {/* Source selection is always available until an import starts. */}
              {!importId ? (
                <SourcePicker
                  selected={selected}
                  disabled={isBusy}
                  zipInputRef={zipInputRef}
                  folderInputRef={folderInputRef}
                  onZip={handleZipPicked}
                  onFolder={handleFolderPicked}
                  onClear={reset}
                />
              ) : null}

              {progressLabel ? (
                <div
                  className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-sm text-muted-foreground"
                  data-testid="add-plugin-progress"
                  role="status"
                >
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  {progressLabel}
                </div>
              ) : null}

              {activeFailure ? (
                <div
                  className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2"
                  data-testid="add-plugin-failure"
                >
                  <div className="flex items-center gap-2 text-sm font-medium text-destructive">
                    <TriangleAlert className="h-3.5 w-3.5" aria-hidden />
                    {activeFailure.message}
                  </div>
                  <code className="mt-1 block text-[11px] text-muted-foreground">
                    {activeFailure.code}
                  </code>
                  {activeFailure.issues ? (
                    <IssueList issues={activeFailure.issues} />
                  ) : null}
                </div>
              ) : null}

              {/* Client-side warnings on a bundle that PASSED preflight — the
                  backend will re-derive its own warning list at inspect. */}
              {selected && !importId && selected.warnings.length > 0 ? (
                <div
                  className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2"
                  data-testid="add-plugin-preflight-warnings"
                >
                  <div className="text-xs font-medium text-amber-700 dark:text-amber-300">
                    {pluralize(selected.warnings.length, "warning")}
                  </div>
                  <IssueList issues={selected.warnings} />
                </div>
              ) : null}

              {row?.status === "preview_ready" && row.preview ? (
                <PluginImportPreviewContent preview={row.preview} />
              ) : null}
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t pt-3">
          {isInstalled ? (
            <Button
              onClick={() => {
                reset();
                onClose();
              }}
            >
              Done
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onClose()}>
                Close
              </Button>
              {activeFailure && retry ? (
                <Button
                  variant="outline"
                  disabled={isBusy}
                  onClick={() => void retry.run()}
                  data-testid="add-plugin-retry"
                >
                  {retry.label}
                </Button>
              ) : null}
              {row?.status === "preview_ready" ? (
                <>
                  {/* Install-only vs install-and-connect is the backend's
                      `setActive` choice: both materialize the version, but only
                      install-and-connect points the plugin at it, which is what
                      makes the revision the one new attachments offer. */}
                  <Button
                    variant="outline"
                    disabled={isBusy}
                    onClick={() => void commit(false)}
                    data-testid="add-plugin-install-only"
                  >
                    Install only
                  </Button>
                  <Button
                    disabled={isBusy}
                    onClick={() => void commit(true)}
                    data-testid="add-plugin-install-connect"
                  >
                    Install and connect
                  </Button>
                </>
              ) : !importId ? (
                <Button
                  disabled={!selected || isBusy || !projectId}
                  onClick={() => void startImport()}
                  data-testid="add-plugin-continue"
                >
                  Continue
                </Button>
              ) : null}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SourcePicker({
  selected,
  disabled,
  zipInputRef,
  folderInputRef,
  onZip,
  onFolder,
  onClear,
}: {
  selected: SelectedBundle | null;
  disabled: boolean;
  zipInputRef: React.RefObject<HTMLInputElement | null>;
  folderInputRef: React.RefObject<HTMLInputElement | null>;
  onZip: (file: File) => void | Promise<void>;
  onFolder: (files: File[]) => void | Promise<void>;
  onClear: () => void;
}) {
  if (selected) {
    return (
      <div
        className="flex items-center gap-3 rounded-md border border-border/60 bg-muted/20 px-3 py-2"
        data-testid="add-plugin-selected-source"
      >
        {selected.kind === "zip" ? (
          <FileArchive className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{selected.label}</p>
          <p className="text-[11px] text-muted-foreground">
            Revision {shortBundleHash(selected.bundleHash)}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          disabled={disabled}
          onClick={onClear}
        >
          Change
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <input
        ref={zipInputRef}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void onZip(file);
        }}
      />
      <input
        ref={folderInputRef}
        type="file"
        // @ts-expect-error webkitdirectory is not in the DOM type definitions
        webkitdirectory=""
        directory=""
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          if (files.length > 0) void onFolder(files);
        }}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => zipInputRef.current?.click()}
        className="flex flex-col items-center gap-2 rounded-lg border-2 border-dashed border-muted-foreground/25 p-6 text-center transition-colors hover:border-muted-foreground/50 disabled:opacity-50"
        data-testid="add-plugin-choose-zip"
      >
        <FileArchive className="h-5 w-5 text-muted-foreground" aria-hidden />
        <span className="text-sm font-medium">Choose a ZIP</span>
        <span className="text-[11px] text-muted-foreground">
          Up to 25 MB compressed
        </span>
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => folderInputRef.current?.click()}
        className="flex flex-col items-center gap-2 rounded-lg border-2 border-dashed border-muted-foreground/25 p-6 text-center transition-colors hover:border-muted-foreground/50 disabled:opacity-50"
        data-testid="add-plugin-choose-folder"
      >
        <FolderOpen className="h-5 w-5 text-muted-foreground" aria-hidden />
        <span className="text-sm font-medium">Choose a folder</span>
        <span className="text-[11px] text-muted-foreground">
          Zipped locally before upload
        </span>
      </button>
    </div>
  );
}

function InstalledSummary({
  commitResult,
  bundleHash,
  setupComponents,
}: {
  commitResult: PluginCommitResult | null;
  bundleHash?: string;
  setupComponents?: Array<{
    componentKey: string;
    readiness: Parameters<typeof describePluginReadiness>[0];
  }>;
}) {
  // Content-addressed re-import: the same bytes always resolve to the SAME
  // ready version, so claiming a fresh install here would be a lie.
  const reused = commitResult?.reused === true;
  return (
    <div className="space-y-3" data-testid="add-plugin-installed">
      <div className="flex items-center gap-2">
        <CheckCircle2
          className="h-4 w-4 text-emerald-600 dark:text-emerald-400"
          aria-hidden
        />
        <span className="text-sm font-medium">
          {reused ? "Already imported" : "Plugin installed"}
        </span>
        {bundleHash ? (
          <code className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {shortBundleHash(bundleHash)}
          </code>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {reused
          ? "These exact bytes were already imported, so the existing revision was reused instead of creating a new one."
          : "The revision is stored and its components are available to this project."}
      </p>

      {setupComponents && setupComponents.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-xs font-medium">Component setup</p>
          <ul className="space-y-1">
            {setupComponents.map((component) => {
              const described = describePluginReadiness(component.readiness);
              return (
                <li
                  key={component.componentKey}
                  className="flex items-center gap-2 text-xs"
                >
                  <span className="font-medium">{component.componentKey}</span>
                  <Badge
                    variant={
                      described.tone === "ready" ? "secondary" : "outline"
                    }
                    className="font-normal"
                  >
                    {described.label}
                  </Badge>
                  <span className="ml-auto text-[11px] text-muted-foreground">
                    {described.detail}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
