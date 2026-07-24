/**
 * Typed DTOs for the OpenAI plugin import backend surface.
 *
 * The inspector references Convex functions by string name (the backend is a
 * separate repository with no generated `api` object shared here), so these
 * types are hand-mirrored from `mcpjam-backend` `convex/plugins.ts`,
 * `convex/pluginsNode.ts`, and `convex/lib/pluginPreview.ts` (PRs BE-3/BE-4 of
 * docs/plans/openai-plugin-import-cross-repo.md). They are the client's typed
 * contract for `plugin-import-client.ts`; keep them in sync with the backend.
 *
 * The preview carries METADATA ONLY — the backend never puts resolved
 * env/header VALUES or secrets here; requirement NAMES only.
 */

import type { PluginSetupRequirement } from "@mcpjam/sdk/plugin-bundle";

/** `pluginImports.status` — the import state machine (backend BE-3). */
export type PluginImportStatus =
  | "uploaded"
  | "inspecting"
  | "preview_ready"
  | "committing"
  | "completed"
  | "failed";

/** States from which no further progress is possible. */
export const TERMINAL_IMPORT_STATUSES: readonly PluginImportStatus[] = [
  "completed",
  "failed",
];

export function isTerminalImportStatus(status: PluginImportStatus): boolean {
  return TERMINAL_IMPORT_STATUSES.includes(status);
}

export interface PluginImportPreviewSkill {
  modelRef: string;
  name: string;
  description: string;
  supportingFileCount: number;
  mcpToolDependencyCount: number;
  hasOpenaiMetadata: boolean;
  allowImplicitInvocation?: boolean;
}

export interface PluginImportPreviewServer {
  key: string;
  transport: "stdio" | "http";
  /** Requested env var NAMES only (stdio). Never values. */
  envRequirements?: Array<{ name: string; required: boolean }>;
  /** Requested header NAMES only (http). Never values. */
  headerRequirements?: Array<{ name: string; secret: boolean }>;
  oauth?: { timing?: "on_install" | "on_use"; scopes?: string[] };
  /** Presence only — never the (possibly path-bearing) working-dir string. */
  hasWorkingDirectory?: boolean;
}

export interface PluginImportPreviewApp {
  appId: string;
  binding: string;
  status: string;
  serverKey?: string;
}

export interface PluginImportPreviewAsset {
  kind: string;
  contentType: string;
  size: number;
}

export interface PluginImportPreviewUnsupported {
  kind: string;
  key: string;
  reason: string;
  pathCount: number;
}

export interface PluginImportPreviewWarning {
  code: string;
  severity: string;
  componentKey?: string;
  message: string;
}

/** Sanitized, metadata-only import preview (backend `buildImportPreview`). */
export interface PluginImportPreview {
  identity: {
    name: string;
    displayName?: string;
    version?: string;
    description?: string;
  };
  bundleHash: string;
  manifestHash: string;
  counts: {
    skills: number;
    servers: number;
    apps: number;
    assets: number;
    unsupported: number;
    warnings: number;
  };
  skills: PluginImportPreviewSkill[];
  servers: PluginImportPreviewServer[];
  apps: PluginImportPreviewApp[];
  assets: PluginImportPreviewAsset[];
  /** Requirement NAMES only — the SDK never puts values here. */
  setupRequirements: PluginSetupRequirement[];
  unsupported: PluginImportPreviewUnsupported[];
  warnings: PluginImportPreviewWarning[];
}

/** Stable sanitized failure ({code, message}) persisted on a failed import. */
export interface PluginImportFailure {
  code: string;
  message: string;
}

/** `plugins.getPluginImport` return shape. */
export interface PluginImportRecord {
  importId: string;
  projectId: string;
  status: PluginImportStatus;
  sourceLabel?: string;
  preview?: PluginImportPreview;
  failure?: PluginImportFailure;
  pluginId?: string;
  pluginVersionId?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

/** `pluginsNode.inspectImport` return shape. */
export interface InspectImportResult {
  importId: string;
  status: "preview_ready" | "failed";
  failureCode?: string;
}

/**
 * `pluginsNode.commitImport` options (backend BE-4). Typed ahead of the merged
 * contract; see the STUB note in `plugin-import-client.ts`. Shape is provisional
 * until BE-4 lands and MUST be reconciled then.
 */
export interface CommitImportOptions {
  /** Set the committed version as the plugin's active version. */
  activate?: boolean;
}

/** Provisional `pluginsNode.commitImport` return shape (backend BE-4). */
export interface CommitImportResult {
  pluginId: string;
  pluginVersionId: string;
  bundleHash: string;
}
