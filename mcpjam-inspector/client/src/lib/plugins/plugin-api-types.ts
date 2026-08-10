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

/**
 * One declared env var, mirroring sdk `PluginEnvRequirement` (field names are
 * the SDK's — `name`/`required`/`value`). `value` is a SCREENED NON-SECRET
 * literal the bundle declared (e.g. `{"MODE": "production"}`): the parser
 * never stores secret-looking values, so its presence is safe to render.
 * Absent until the backend's sdk dependency bump forwards it — treat absence
 * as "no declared literal".
 */
export interface PluginEnvRequirementEntry {
  name: string;
  required: boolean;
  value?: string;
}

/** One declared header, mirroring sdk `PluginHeaderRequirement`. */
export interface PluginHeaderRequirementEntry {
  name: string;
  secret: boolean;
  /** Screened non-secret literal header value, when declared. */
  value?: string;
}

export interface PluginImportPreviewServer {
  key: string;
  transport: "stdio" | "http";
  /**
   * Declared wire transport for http servers (sdk
   * `NormalizedPluginMcpServer.httpVariant`). Optional until the backend's
   * sdk bump forwards it.
   */
  httpVariant?: "streamable-http" | "sse" | (string & {});
  /** Requested env var names (stdio), plus screened non-secret literals. */
  envRequirements?: PluginEnvRequirementEntry[];
  /** Requested header names (http), plus screened non-secret literals. */
  headerRequirements?: PluginHeaderRequirementEntry[];
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

/**
 * One component the parser skipped under the spec's failure-isolation
 * boundaries (one bad server entry / skill / the whole mcp.json document).
 * Field names mirror sdk `PluginSkippedComponent` exactly (`kind`/`key`/
 * `reason`). `kind` is widened: render unknown kinds verbatim.
 */
export interface PluginImportPreviewSkippedComponent {
  kind: "server" | "skill" | "mcp-config" | (string & {});
  /** Server key, skill directory name, or the config path. */
  key: string;
  reason: string;
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
  /**
   * Components skipped by the parser's per-entry failure isolation (sdk
   * `ParsedPluginBundle.skipped`). Optional: the deployed backend does not
   * forward these yet — absent means "none reported", and import surfaces
   * must render nothing rather than inventing rows.
   */
  skippedComponents?: PluginImportPreviewSkippedComponent[];
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
  /**
   * Declared wire transport for http servers (sdk
   * `NormalizedPluginMcpServer.httpVariant`). Optional until the backend's
   * sdk bump forwards it; absent for stdio servers.
   */
  httpVariant?: "streamable-http" | "sse" | (string & {});
  /**
   * Declared env/header requirement entries for this server (sdk
   * `envRequirements`/`headerRequirements` on the normalized config, names
   * only plus screened non-secret literals). Optional: the deployed backend
   * does not project these yet — absent means the setup editor simply does
   * not render, never that requirements were checked and found empty.
   */
  envRequirements?: PluginEnvRequirementEntry[];
  headerRequirements?: PluginHeaderRequirementEntry[];
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
  /**
   * Agent Plugins schema version the bundle targets (sdk
   * `ParsedPluginBundle.schemaVersion`, e.g. "1.0.0"). Optional until the
   * backend's sdk bump forwards it.
   */
  schemaVersion?: string;
  servers: PluginVersionServerComponent[];
  skills: PluginVersionSkillComponent[];
}

/**
 * Widened: the credential-aware backend already reports values this mirror
 * may not list (`needs_setup` landed after the first deploy). Unknown values
 * must render as a neutral "setup required", never as ready.
 */
export type PluginComponentReadiness =
  | "needs_auth"
  | "needs_setup"
  | "local_runtime_required"
  | "computer_required"
  | "ready"
  | (string & {});

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
