/**
 * Typed client + upload helpers for the OpenAI plugin import backend surface.
 *
 * The inspector calls Convex functions by string name (the backend is a
 * separate repo with no shared generated `api`), so this module is the single
 * typed seam over the plugin import functions in `mcpjam-backend`
 * `convex/plugins.ts` / `convex/pluginsNode.ts`. Callers pass a
 * `ConvexReactClient` (from `useConvex()`), matching the imperative pattern in
 * `client/src/lib/apis/*` and `use-playground-project-executions.ts`.
 *
 * Upload flow (backend BE-3 "Upload"):
 *   1. `generateBundleUploadUrl` — mint a Convex `_storage` upload URL.
 *   2. POST the ZIP bytes to that URL → `{ storageId }`.
 *   3. `createImport` — stage a `pluginImports` row referencing the blob.
 *   4. `inspectImport` (Node action) — parse + validate → preview_ready/failed.
 *
 * `commitImport` (backend BE-4) is a TYPED STUB: the commit action is not yet
 * merged, so calling it throws a clear error. Wire the real call the moment
 * BE-4 lands (see `PLUGIN_COMMIT_NOT_AVAILABLE`).
 */

import type { ConvexReactClient } from "convex/react";
import type { ParsedPluginBundle } from "@mcpjam/sdk/plugin-bundle";
import { parsePluginBundle } from "@mcpjam/sdk/plugin-bundle";
import {
  createFolderPluginSource,
  type PluginFolderFiles,
} from "./plugin-file-source";
import { folderToZipBlob } from "./folder-to-zip";
import type {
  CommitImportOptions,
  CommitImportResult,
  InspectImportResult,
  PluginImportRecord,
} from "./plugin-import-types";

// Convex function references. Kept as named constants so a backend rename is a
// one-line change and every call site is greppable.
const FN = {
  generateBundleUploadUrl: "plugins:generateBundleUploadUrl",
  createImport: "plugins:createImport",
  getPluginImport: "plugins:getPluginImport",
  inspectImport: "pluginsNode:inspectImport",
  // BE-4 — not merged yet; only referenced by the stub below.
  commitImport: "pluginsNode:commitImport",
} as const;

/**
 * The `useConvex()` client exposes `query`/`mutation`/`action`. We accept the
 * broad `ConvexReactClient` type but only touch those three methods, each
 * called by string name (mirrored, not generated, so the args/returns are cast
 * to the hand-written DTOs above).
 */
export type PluginConvexClient = Pick<
  ConvexReactClient,
  "query" | "mutation" | "action"
>;

// ---------------------------------------------------------------------------
// Thin typed wrappers over the backend functions.
// ---------------------------------------------------------------------------

/** Mint a Convex `_storage` upload URL (project-admin gated on the backend). */
export async function generateBundleUploadUrl(
  convex: PluginConvexClient,
  args: { projectId: string },
): Promise<string> {
  return (await convex.mutation(
    FN.generateBundleUploadUrl as any,
    args as any,
  )) as string;
}

/** Stage a `pluginImports` row for an already-uploaded bundle blob. */
export async function createImport(
  convex: PluginConvexClient,
  args: { projectId: string; bundleStorageId: string; sourceLabel?: string },
): Promise<{ importId: string }> {
  return (await convex.mutation(FN.createImport as any, args as any)) as {
    importId: string;
  };
}

/** Read an import's status/preview/failure (backend member-gated). */
export async function getPluginImport(
  convex: PluginConvexClient,
  args: { importId: string },
): Promise<PluginImportRecord | null> {
  return (await convex.query(
    FN.getPluginImport as any,
    args as any,
  )) as PluginImportRecord | null;
}

/** Run the Node inspect action → preview_ready / failed. */
export async function inspectImport(
  convex: PluginConvexClient,
  args: { importId: string },
): Promise<InspectImportResult> {
  return (await convex.action(
    FN.inspectImport as any,
    args as any,
  )) as InspectImportResult;
}

/** Stable error code thrown by the commit stub until BE-4 is merged. */
export const PLUGIN_COMMIT_NOT_AVAILABLE = "PLUGIN_COMMIT_NOT_AVAILABLE";

/**
 * TYPED STUB for `pluginsNode.commitImport` (backend BE-4, not merged).
 *
 * The commit action — which materializes plugin components and flips the
 * version to `ready` — does not exist in the deployed backend yet, so this
 * intentionally throws rather than calling a nonexistent function. The typed
 * surface (args + return) is defined so INS-2 can build the confirm step
 * against a stable signature; replace the throw with
 * `convex.action(FN.commitImport, ...)` when BE-4 lands and reconcile
 * `CommitImportOptions` / `CommitImportResult` with the merged validators.
 */
export async function commitImport(
  _convex: PluginConvexClient,
  _args: { importId: string; options?: CommitImportOptions },
): Promise<CommitImportResult> {
  throw new Error(
    `${PLUGIN_COMMIT_NOT_AVAILABLE}: plugin import commit (backend BE-4) is not available yet`,
  );
}

// ---------------------------------------------------------------------------
// Upload orchestration.
// ---------------------------------------------------------------------------

/** POST bundle bytes to a Convex storage upload URL → the new storage id. */
export async function uploadBundleToStorage(
  uploadUrl: string,
  bundle: Blob,
): Promise<string> {
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": bundle.type || "application/zip" },
    body: bundle,
  });
  if (!response.ok) {
    throw new Error(
      `Failed to upload plugin bundle (${response.status} ${response.statusText})`,
    );
  }
  const body = (await response.json()) as { storageId?: string };
  if (!body.storageId) {
    throw new Error("Upload response did not include a storageId");
  }
  return body.storageId;
}

/** Phases the orchestrator passes to an optional progress callback. */
export type StartPluginImportPhase = "uploading" | "inspecting";

export interface StartPluginImportArgs {
  projectId: string;
  /** ZIP bytes of the plugin bundle (hosted ZIP upload or folderToZip output). */
  bundle: Blob;
  /** Optional display label (backend sanitizes; a local path is never stored). */
  sourceLabel?: string;
  /**
   * Progress callback. Fires `uploading` before the upload and `inspecting`
   * after the import row is staged (so the runner can surface the inspect phase
   * instead of jumping straight from uploading to done).
   */
  onPhase?: (phase: StartPluginImportPhase) => void;
}

export interface StartPluginImportResult {
  importId: string;
  bundleStorageId: string;
  /** Result of the inspect pass (preview_ready / failed). */
  inspect: InspectImportResult;
}

/**
 * Error thrown when the flow fails AFTER a `pluginImports` row was staged (e.g.
 * `inspectImport` rejects). It carries the staged `importId` so the caller can
 * still subscribe to / recover the row instead of stranding it — a bare rethrow
 * loses the id.
 */
export class PluginImportError extends Error {
  readonly importId: string;
  readonly bundleStorageId: string;
  constructor(
    message: string,
    context: { importId: string; bundleStorageId: string; cause?: unknown },
  ) {
    super(message, { cause: context.cause });
    this.name = "PluginImportError";
    this.importId = context.importId;
    this.bundleStorageId = context.bundleStorageId;
  }
}

/**
 * Full upload → stage → inspect for a ZIP bundle. `createImport` does not
 * trigger inspection on the backend, so we schedule `inspectImport` here and
 * await its terminal preview_ready / failed result. Callers then read the
 * sanitized preview via `getPluginImport` (or the `usePluginImport` hook).
 *
 * If `inspectImport` throws after staging, the staged `importId` is preserved
 * on a thrown `PluginImportError` so the caller keeps a handle to the row.
 */
export async function startPluginImportFromZip(
  convex: PluginConvexClient,
  args: StartPluginImportArgs,
): Promise<StartPluginImportResult> {
  args.onPhase?.("uploading");
  const uploadUrl = await generateBundleUploadUrl(convex, {
    projectId: args.projectId,
  });
  const bundleStorageId = await uploadBundleToStorage(uploadUrl, args.bundle);
  const { importId } = await createImport(convex, {
    projectId: args.projectId,
    bundleStorageId,
    sourceLabel: args.sourceLabel,
  });
  // The row now exists; a later failure must not lose its id.
  args.onPhase?.("inspecting");
  try {
    const inspect = await inspectImport(convex, { importId });
    return { importId, bundleStorageId, inspect };
  } catch (cause) {
    throw new PluginImportError(
      cause instanceof Error ? cause.message : "Plugin inspect failed",
      { importId, bundleStorageId, cause },
    );
  }
}

export interface StartPluginImportFromFolderArgs {
  projectId: string;
  /** Selected folder CONTENTS (path/bytes entries, paths validated by the SDK). */
  files: PluginFolderFiles;
  sourceLabel?: string;
  onPhase?: (phase: StartPluginImportPhase) => void;
}

/**
 * Local/Electron entry point: zip the selected folder, then run the same
 * upload → stage → inspect path as a hosted ZIP. Because the SDK bundle hash is
 * content-addressed, a folder and a ZIP of identical contents yield the same
 * ready version (import-source parity).
 */
export async function startPluginImportFromFolder(
  convex: PluginConvexClient,
  args: StartPluginImportFromFolderArgs,
): Promise<StartPluginImportResult> {
  const bundle = folderToZipBlob(args.files);
  return startPluginImportFromZip(convex, {
    projectId: args.projectId,
    bundle,
    sourceLabel: args.sourceLabel,
    onPhase: args.onPhase,
  });
}

/**
 * Parse a selected plugin folder locally with the SHARED SDK parser (reusing
 * its manifest / MCP-config / skill normalization and deterministic hashing),
 * without uploading. Lets local mode show an instant preview and compute the
 * bundle hash the backend will assign to the uploaded ZIP. Throws
 * `PluginBundleError` on validation failure — callers render `error.issues`.
 */
export async function previewPluginFolderLocally(
  files: PluginFolderFiles,
): Promise<ParsedPluginBundle> {
  return parsePluginBundle(createFolderPluginSource(files));
}
