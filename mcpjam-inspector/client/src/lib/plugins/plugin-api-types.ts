/**
 * Hand-mirrored DTO types for the backend plugin API (PR INS-1 of
 * docs/plans/openai-plugin-import-cross-repo.md).
 *
 * Source of truth (two-repo layout — Convex lives in `mcpjam-backend`, types
 * are mirrored by hand):
 *   - convex/plugins.ts        (queries/mutations, summaries, import row)
 *   - convex/pluginsNode.ts    (inspectImport / commitImport actions)
 *   - convex/lib/pluginPreview.ts        (sanitized import preview)
 *   - convex/lib/pluginRateLimit.ts      (RATE_LIMITED error payload)
 *   - convex/lib/pluginRuntimeResolution.ts (runtime preview)
 *
 * Ids are opaque strings on this side of the wire.
 */

// ---------------------------------------------------------------------------
// Import state machine (backend `pluginImports.status`).
// ---------------------------------------------------------------------------

export const PLUGIN_IMPORT_STATUSES = [
  "uploaded",
  "inspecting",
  "preview_ready",
  "committing",
  "completed",
  "failed",
] as const;

export type PluginImportStatus = (typeof PLUGIN_IMPORT_STATUSES)[number];

/** Terminal states: the import row will not transition again. */
export function isPluginImportTerminal(status: PluginImportStatus): boolean {
  return status === "completed" || status === "failed";
}

/** States from which `commitImport` may be called (preview reviewed). */
export function isPluginImportCommittable(status: PluginImportStatus): boolean {
  return status === "preview_ready";
}

// ---------------------------------------------------------------------------
// Sanitized import preview (convex/lib/pluginPreview.ts). Metadata only —
// the backend guarantees no paths, no file content, no secrets.
// ---------------------------------------------------------------------------

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

export interface PluginSetupRequirement {
  serverKey: string;
  kind: "env" | "header" | "oauth";
  name: string;
  required: boolean;
  secret?: boolean;
}

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
  setupRequirements: PluginSetupRequirement[];
  unsupported: PluginImportPreviewUnsupported[];
  warnings: PluginImportPreviewWarning[];
}

/** Stable sanitized `{code, message}` persisted on a failed import. */
export interface PluginImportFailure {
  code: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Rows returned by the public queries.
// ---------------------------------------------------------------------------

/** `plugins.getPluginImport` — the progress-polling row. */
export interface PluginImportRow {
  importId: string;
  projectId: string;
  status: PluginImportStatus;
  sourceLabel?: string;
  preview?: PluginImportPreview;
  failure?: PluginImportFailure;
  /** Set once the import completes (commit materialized a version). */
  pluginId?: string;
  pluginVersionId?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

/** `plugins.listProjectPlugins` element / `getProjectPlugin` base. */
export interface PluginSummary {
  pluginId: string;
  projectId: string;
  name: string;
  displayName: string;
  description?: string;
  enabled: boolean;
  activeVersionId?: string;
  deletedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface PluginVersionSummary {
  pluginVersionId: string;
  pluginId: string;
  declaredVersion?: string;
  bundleHash: string;
  status: "staging" | "ready";
  componentCounts: {
    skills: number;
    servers: number;
    apps: number;
    assets: number;
    unsupported: number;
  };
  createdAt: number;
  readyAt?: number;
}

/** `plugins.getProjectPlugin` — summary plus versions (newest first). */
export interface PluginDetail extends PluginSummary {
  versions: PluginVersionSummary[];
}

export interface PluginVersionServerComponent {
  componentId: string;
  componentKey: string;
  declaredName: string;
  placement: "remote" | "local" | "computer";
  authenticationPolicy: "on_install" | "on_use";
  materializedServerId?: string;
}

export interface PluginVersionSkillComponent {
  componentId: string;
  componentKey: string;
  declaredName: string;
  modelRef: string;
  materializedSkillId?: string;
}

/** `plugins.getPluginVersion` — version summary plus component projections. */
export interface PluginVersionDetail extends PluginVersionSummary {
  manifestHash: string;
  servers: PluginVersionServerComponent[];
  skills: PluginVersionSkillComponent[];
}

export type PluginComponentReadiness =
  | "needs_auth"
  | "local_runtime_required"
  | "computer_required"
  | "ready";

/** `plugins.getPluginSetupStatus`. */
export interface PluginSetupStatus {
  pluginVersionId: string;
  status: "staging" | "ready";
  components: Array<{
    componentKey: string;
    placement: "remote" | "local" | "computer";
    authenticationPolicy: "on_install" | "on_use";
    readiness: PluginComponentReadiness;
  }>;
}

export type PluginUnavailableReason =
  | "not_found"
  | "not_ready"
  | "uninstalled"
  | "disabled"
  | (string & {});

/** `plugins.resolvePluginRuntimePreview`. */
export interface PluginRuntimePreview {
  pluginVersions: Array<{
    pluginId: string;
    pluginVersionId: string;
    name: string;
    bundleHash: string;
  }>;
  effectiveServerIds: string[];
  pluginSkills: Array<{ modelRef: string; materializedSkillId: string }>;
  unavailableComponents: Array<{
    pluginVersionId: string;
    reason: PluginUnavailableReason;
  }>;
}

// ---------------------------------------------------------------------------
// Action results.
// ---------------------------------------------------------------------------

/** `pluginsNode.inspectImport`. */
export interface PluginInspectResult {
  importId: string;
  status: "preview_ready" | "failed";
  failureCode?: string;
}

/** `pluginsNode.commitImport`. */
export interface PluginCommitResult {
  importId: string;
  status: "completed" | "failed";
  pluginVersionId?: string;
  /** True when the same bundle bytes already produced a ready version. */
  reused?: boolean;
  failureCode?: string;
}

// ---------------------------------------------------------------------------
// Structured errors. ConvexError payloads land on `err.data`; the backend
// throws stable machine-readable codes (convex/plugins.ts `fail`,
// pluginRateLimit.ts, createImport's oversized-bundle check).
// ---------------------------------------------------------------------------

/** Known stable error codes the plugin API can throw. Non-exhaustive. */
export type PluginApiErrorCode =
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "ARCHIVE_TOO_LARGE_COMPRESSED"
  /** Client-side only: the `plugins-enabled` flag is off (fail-closed). */
  | "PLUGINS_DISABLED"
  /** Client-side only: the direct-to-storage upload POST failed. */
  | "UPLOAD_FAILED"
  | (string & {});

export class PluginApiError extends Error {
  readonly code: PluginApiErrorCode;
  /** RATE_LIMITED: which bucket ("project" | "organization"). */
  readonly scope?: string;
  /** RATE_LIMITED: milliseconds until a token is available. */
  readonly retryAfter?: number;
  readonly details?: Record<string, string>;

  constructor(
    code: PluginApiErrorCode,
    message: string,
    extras?: {
      scope?: string;
      retryAfter?: number;
      details?: Record<string, string>;
    },
  ) {
    super(message);
    this.name = "PluginApiError";
    this.code = code;
    this.scope = extras?.scope;
    this.retryAfter = extras?.retryAfter;
    this.details = extras?.details;
  }
}
