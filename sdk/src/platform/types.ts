/**
 * Wire DTOs for the MCPJam Platform API (`/api/v1`).
 *
 * These mirror the public projections documented in the repo OpenAPI spec
 * (`docs/reference/openapi.json`) and emitted by the Convex catalog reads
 * (`mcpjam-backend/convex/publicApi/dtos.ts`). Write tolerant readers:
 * additive fields are non-breaking and must be ignored, never relied on
 * being absent.
 */
import type { ServerDoctorResult } from "../server-doctor-core.js";

/** Collection envelope: `nextCursor` is omitted on the last page. */
export type PlatformPage<TItem> = {
  items: TItem[];
  nextCursor?: string;
};

export interface PlatformMe {
  id: string;
  email: string;
  name: string;
  imageUrl: string | null;
  profilePictureUrl: string | null;
  plan: string | null;
  createdAt: number | null;
  updatedAt: number | null;
}

/** A hosted model catalog entry. Unknown additive fields are tolerated. */
export interface PlatformModel {
  id: string;
  name?: string;
  provider?: string;
  [field: string]: unknown;
}

export interface PlatformProject {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  organizationId: string | null;
  visibility: string | null;
  /** Caller's role on the project when the upstream query resolves one. */
  role?: string;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface PlatformProjectServer {
  id: string;
  projectId: string | null;
  name: string;
  enabled: boolean;
  transportType: string;
  /** Endpoint for HTTP-transport servers; null for stdio. */
  url: string | null;
  useOAuth: boolean;
  hasClientSecret: boolean;
  oauthScopes?: string[];
  createdAt: number | null;
  updatedAt: number | null;
}

export interface PlatformEvalRunSummary {
  id: string | null;
  status: string | null;
  passRate: number | null;
  passed: number | null;
  failed: number | null;
  createdAt: number | null;
}

export interface PlatformEvalSuite {
  id: string;
  name: string | null;
  projectId: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  latestRun: PlatformEvalRunSummary | null;
  totals: { passed: number; failed: number; runs: number };
  passRateTrend: number[];
}

export interface PlatformChatSession {
  id: string;
  title: string | null;
  status: string | null;
  projectId: string | null;
  /** "private" | "project". */
  visibility: string | null;
  lastActivityAt: number | null;
  createdAt: number | null;
  isPinned?: boolean;
  isUnread?: boolean;
}

/**
 * Full eval run record, as returned by `GET /projects/{p}/eval-runs/{runId}`
 * and the suite run-history listing. Distinct from `PlatformEvalRunSummary`,
 * the condensed latest-run projection embedded in `PlatformEvalSuite`.
 */
export interface PlatformEvalRun {
  id: string;
  suiteId: string;
  runNumber: number | null;
  /** Poll until terminal: "completed" | "failed" | "cancelled". */
  status: string;
  /** Pass/fail verdict once terminal: "passed" | "failed" | null. */
  result: string | null;
  summary: {
    total?: number;
    passed?: number;
    failed?: number;
    passRate?: number;
  } | null;
  /** Run origin: "ui" | "api" | "sdk". */
  source: string;
  notes: string | null;
  /**
   * The project environment this run executed against, read from the run's
   * immutable config snapshot — NOT the suite's current attachments, which may
   * have changed since. `null` for a legacy (saved-server-selection) run, and
   * absent on API deployments that predate run environment attribution.
   */
  environment?: PlatformEvalRunEnvironment | null;
  createdAt: number;
  completedAt: number | null;
}

/**
 * Identity of the environment revision a run was pinned to. `name`/`revision`
 * are nullable only for tolerance of older snapshots that recorded a partial
 * ref; a current run always carries all three.
 */
export interface PlatformEvalRunEnvironment {
  id: string;
  name: string | null;
  revision: number | null;
}

/** `202` response of `POST /projects/{p}/eval-runs`. */
export interface PlatformEvalRunCreated {
  runId: string;
  suiteId: string;
  status: string;
  /** Per-case upsert outcomes for inline tests; empty on plain reruns. */
  caseUpsert: {
    committed?: Array<{ id?: string; name?: string }>;
    failed?: Array<{ id?: string; name?: string; error?: string }>;
  };
  /**
   * The servers the run connects to — explicit, or derived server-side from
   * the suite's saved selection when the request omitted serverIds. Absent
   * on older API deployments.
   */
  servers?: Array<{ id: string; name?: string }>;
  /**
   * The environment the run is pinned to, at the revision whose servers were
   * connected. Present even when the request omitted it: a suite with exactly
   * one attached environment auto-selects, and this is how a caller learns
   * that happened. `null` for a legacy run; absent on older API deployments.
   */
  environment?: PlatformEvalRunEnvironment | null;
}

/**
 * `201` response of `POST /projects/{p}/eval-suites` — an authored, runnable
 * suite created from test-case definitions (NOT run; execute it with
 * `run_eval_suite`). Tolerant reader: unknown fields pass through.
 */
export interface PlatformEvalSuiteCreated {
  suiteId: string;
  /** Suite name as persisted; echoes the request name. */
  name: string | null;
  /** The HTTP servers the suite was configured against. */
  servers?: Array<{ id: string; name?: string }>;
  /** Per-case create outcomes, mirroring eval-run caseUpsert. */
  caseUpsert: {
    committed?: Array<{ id?: string; name?: string }>;
    failed?: Array<{ id?: string; name?: string; error?: string }>;
  };
}

/**
 * Public match-option vocabulary, mirroring the suite/case UI controls. The
 * route layer translates these to the internal match-option model.
 */
export interface PublicMatchOptions {
  /**
   * `any` = order ignored; `in-order` = expected calls must appear in order
   * (extra calls allowed between them); `exact` = exact sequence.
   */
  toolCallOrder: "any" | "in-order" | "exact";
  /** `unlimited`, or the max number of unexpected extra tool calls allowed. */
  extraToolCalls: "unlimited" | number;
  /** Argument comparison strictness. */
  arguments: "ignore" | "partial" | "exact";
}

/**
 * A deterministic pass/fail check. `type` is the check vocabulary (e.g.
 * `responseContains`, `toolCalledWith`); the remaining fields depend on it.
 */
export interface PublicCheck {
  type: string;
  [key: string]: unknown;
}

/** Per-case check override: how the case's checks combine with suite defaults. */
export interface PublicCheckOverride {
  mode: "inherit" | "replace" | "extend";
  list: PublicCheck[];
}

export interface PlatformExpectedToolCall {
  tool: string;
  arguments?: Record<string, unknown>;
}

export interface PlatformEvalSuiteSettings {
  /** Minimum pass rate as a percentage, 0–100. */
  minimumAccuracy: number | null;
  matchOptions: PublicMatchOptions | null;
  checks: PublicCheck[];
  judge: { enabled: boolean; model: string | null };
}

export interface PlatformEvalSuiteHost {
  id: string;
  name: string;
  /** Server names this host runs against, when resolved. */
  servers?: string[];
}

export interface PlatformEvalSuiteSchedule {
  enabled: boolean;
  /** Interval in minutes; preserved (not cleared) when `enabled` is false. */
  intervalMinutes: number | null;
  /**
   * The single attached environment scheduled runs launch (a schedule fires one
   * run, so a multi-environment suite must pin one). `null` for a legacy suite;
   * absent on older API deployments.
   */
  environmentId?: string | null;
}

/**
 * Full eval suite, returned by `GET`/`PATCH /eval-suites/{id}`. Public-model
 * shape — the route layer maps this to/from the internal Convex suite. Tolerant
 * reader: unknown fields pass through.
 */
export interface PlatformEvalSuiteDetail {
  id: string;
  name: string | null;
  description: string | null;
  projectId: string | null;
  /** LEGACY server selection by name. Not the project-environment attachments. */
  environment: { servers: string[] };
  /**
   * Attached project environments, in attach order. A non-empty list makes the
   * suite environment-based: its runs resolve one of these instead of the
   * legacy selection above. Absent on older API deployments.
   */
  environmentIds?: string[];
  /** Suite-level execution config; null when none is pinned. */
  executionConfig: {
    model: string;
    systemPrompt: string;
    temperature: number;
  } | null;
  /** Host attachments (multi-host). */
  hosts: PlatformEvalSuiteHost[];
  settings: PlatformEvalSuiteSettings;
  schedule: PlatformEvalSuiteSchedule;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface PlatformEvalCaseModel {
  model: string;
  provider?: string;
}

/**
 * One authored test step — the unified test model (mirrors the inspector's
 * `shared/steps.ts` `TestStep`). Typed permissively at this boundary
 * (discriminated on `kind`); per-kind detail fields ride along.
 *
 * REPLACES the old per-case `kind` / `prompt` / `turns` / `expectedToolCalls`
 * / `renderCheck` projection (Phase 2.5 clean break).
 */
export interface PlatformEvalStep {
  id: string;
  kind: "prompt" | "toolCall" | "interact" | "assert";
  [field: string]: unknown;
}

/**
 * A single eval test case. The case body is an ordered `steps` array
 * (prompt / toolCall / interact / assert). Public-model shape; the route maps
 * to/from the internal case.
 */
export interface PlatformEvalCase {
  id: string;
  title: string;
  /** Ordered test steps that define the case. */
  steps: PlatformEvalStep[];
  expectedOutput?: string;
  /** Iterations to run per eval run (← internal runs). */
  iterations: number;
  isNegative: boolean;
  scenario?: string;
  /** Execution models (plural — preserves compare behavior). */
  models: PlatformEvalCaseModel[];
  matchOptions?: PublicMatchOptions;
  checks?: PublicCheckOverride;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface PlatformEvalSuiteDeleted {
  id: string;
  deleted: true;
}

export interface PlatformEvalCaseDeleted {
  id: string;
  deleted: true;
}

/** A host in a project (list projection). */
export interface PlatformHost {
  id: string;
  name: string;
  hostConfigId: string;
  modelId: string;
  serverCount: number;
  createdAt: number;
  updatedAt: number;
}

/** Full host detail, including the resolved host config DTO. */
export interface PlatformHostDetail {
  id: string;
  name: string;
  /** Resolved host-config v2 DTO (model, capabilities, hostContext, …). */
  config: Record<string, unknown>;
}

export interface PlatformHostDeleted {
  id: string;
  deleted: true;
}

// ── Project Environments ─────────────────────────────────────────────────────
//
// A named, project-scoped, live-editable execution bundle that eval suites and
// journeys run against: one host, an optional standalone server group, an
// optional pinned skill selection, and optional pinned plugin versions.
//
// NOT a `PlatformImage` (a Computer sandbox base image), and not the eval-suite
// `environment` servers bag — this is the concept that owns the word.
//
// Environments are REVISIONED for optimistic concurrency: every mutation takes
// the `expectedRevision` you last read, and a stale value is rejected with 409
// CONFLICT rather than clobbering a concurrent edit.

/**
 * An explicit, pinned skill selection. Empty lists are rejected — clear the
 * field (`null` on update) to mean "no pinned skills".
 */
export interface PlatformEnvironmentSkillSelection {
  mode: "explicit";
  skillIds: string[];
}

export interface PlatformEnvironment {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  hostId: string;
  /** Set only when the environment pins a standalone server group. */
  serverAttachmentId?: string;
  /**
   * The environment's model OVERRIDE, if it sets one.
   *
   * ABSENT means the environment INHERITS the model pinned by its host — not
   * that it has no model. To learn what will actually run, resolve the
   * environment and read `effectiveModelId`.
   */
  modelId?: string;
  skillSelection?: PlatformEnvironmentSkillSelection;
  /**
   * Pinned plugin VERSIONS. Narrow by design: a version is pinnable only when
   * its plugin is installed and enabled, the version is `ready`, at most one
   * version per plugin is pinned, and none of its skills carry supporting
   * files. Not a general-purpose plugin list.
   */
  pluginVersionIds?: string[];
  /**
   * Sandbox-image pin: a `PlatformImage` id this environment's reproducibility
   * runs boot a fresh sandbox from. Must be a project-shared image (personal
   * drafts are rejected — promote first). Applies to eval runs today.
   */
  sandboxImageId?: string;
  /** Pass back as `expectedRevision` on the next mutation. */
  revision: number;
  /** Archived environments cannot be edited or launched until restored. */
  archived: boolean;
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface PlatformEnvironmentCreateBody {
  name: string;
  description?: string;
  hostId: string;
  serverAttachmentId?: string;
  /** Model to run instead of the host's; omit to inherit the host's. */
  modelId?: string;
  skillSelection?: PlatformEnvironmentSkillSelection;
  pluginVersionIds?: string[];
  /** Project-shared `PlatformImage` id to pin; omit for the default image. */
  sandboxImageId?: string;
}

/**
 * Update body. Three-state on the clearable fields: omit to leave unchanged,
 * pass `null` to CLEAR, pass a value to set. An empty array is rejected — it is
 * not a way to clear.
 */
export interface PlatformEnvironmentUpdateBody {
  /** Required: the revision you last read. Stale ⇒ 409 CONFLICT. */
  expectedRevision: number;
  name?: string;
  /** An empty string clears the description. */
  description?: string;
  hostId?: string;
  serverAttachmentId?: string | null;
  /**
   * New model override, or `null` to CLEAR it and fall back to the host's
   * model. Omit to leave unchanged. An empty string is rejected — it is not a
   * way to clear.
   */
  modelId?: string | null;
  skillSelection?: PlatformEnvironmentSkillSelection | null;
  pluginVersionIds?: string[] | null;
  /** New sandbox-image pin, or null to clear it. Omit to leave unchanged. */
  sandboxImageId?: string | null;
}

/**
 * What this deployment's environment surface supports.
 *
 * FOR VERSION SKEW, not feature flagging. The SDK ships independently of the
 * backend, so a client that would send `modelId` must first confirm the
 * deployment accepts it — an unknown field is a hard validator error there, not
 * a silently ignored one. A deployment too old to answer reports `false` for
 * everything.
 */
export interface PlatformEnvironmentCapabilities {
  /** `modelId` is accepted on create and update. */
  modelOverrides: boolean;
  /** Environment cells may vary by model on one host (the compare grid). */
  modelMatrix: boolean;
}

/** Body for the archive/restore sub-actions — the precondition only. */
export interface PlatformEnvironmentRevisionBody {
  expectedRevision: number;
}

/**
 * What an environment resolves to right now: the host's current config, the
 * closed server set, and the pinned plugin versions. The same resolution an
 * eval run performs, exposed so an external runner can connect the exact set
 * before launching.
 */
export interface PlatformEnvironmentResolved {
  environment: { id: string; name: string; revision: number };
  hostId: string;
  hostName: string;
  /** The host's config at resolve time — hosts rotate configs live. */
  hostConfigId: string;
  /** The environment's stored override, when it sets one. */
  modelId?: string;
  /**
   * The model this environment WILL RUN — the override if it has one, else the
   * host config's. Always present on a successful resolve: an environment with
   * no model anywhere cannot be resolved for launch at all, and fails with a
   * 409 carrying `details.reason: "environment_model_required"`.
   *
   * Optional in the type only for deploy skew, where the backend predates the
   * field.
   */
  effectiveModelId?: string;
  /** Which of the two supplied {@link effectiveModelId}. */
  modelSource?: "environment" | "host";
  serverAttachmentId?: string;
  /** The closed NON-plugin server set. */
  selectedServerIds: string[];
  /**
   * `selectedServerIds` plus the servers contributed by pinned plugin
   * versions — the set a run actually connects. Identical to
   * `selectedServerIds` when the environment pins no plugins.
   */
  effectiveServerIds: string[];
  pluginVersions: Array<{
    pluginId: string;
    pluginVersionId: string;
    name: string;
    bundleHash: string;
  }>;
  /** Connectable projection of `effectiveServerIds`, healed to live servers. */
  servers: Array<{ serverId: string; name: string }>;
  /** The environment's sandbox-image pin, when set (and the backend is new
   *  enough to carry it through the resolve). */
  sandboxImageId?: string;
}

// ── Agent Plugins ────────────────────────────────────────────────────────────
//
// A plugin bundle (agent-plugins.org format) imported into a project. Each
// immutable VERSION materializes MCP servers and skills as ordinary project
// rows; environments pin `pluginVersionIds` to run them. This surface is
// READ-ONLY — import, activate, enable/disable and uninstall stay in the app.

/** One live (installed, non-uninstalled) plugin in a project. */
export interface PlatformPlugin {
  id: string;
  projectId: string;
  /** Normalized plugin name — the namespace its skills load under. */
  name: string;
  displayName?: string;
  description?: string;
  /** Disabled plugins keep their versions but resolve for no run. */
  enabled: boolean;
  /** The version environment pins default to; absent before first activate. */
  activeVersionId?: string;
  createdAt: number;
  updatedAt: number;
}

/** Per-component tallies of one imported version. `apps` counts preserved
 *  `.app.json` metadata entries only (no runtime effect). */
export interface PlatformPluginComponentCounts {
  skills: number;
  servers: number;
  apps: number;
  assets: number;
  unsupported: number;
}

/** One MCP server a plugin version declares, with its materialized row. */
export interface PlatformPluginServerComponent {
  componentId: string;
  /** Stable key within the version (normalized server map key). */
  componentKey: string;
  declaredName: string;
  /** Where the component can execute; `local`/`computer` never run hosted. */
  placement: "remote" | "local" | "computer";
  /** Declared auth timing: setup right after import, or on first use. */
  authenticationPolicy: "on_install" | "on_use";
  /** The project server row this component materialized as. */
  materializedServerId: string;
}

/** One skill a plugin version declares, with its materialized row. */
export interface PlatformPluginSkillComponent {
  componentId: string;
  componentKey: string;
  declaredName: string;
  /** Namespaced model-facing reference: `<plugin-name>/<skill-name>`. */
  modelRef: string;
  materializedSkillId: string;
}

/** One immutable imported version with its component projections. */
export interface PlatformPluginVersion {
  id: string;
  pluginId: string;
  /** `manifest.version` — metadata only; `bundleHash` is the identity. */
  declaredVersion?: string;
  bundleHash: string;
  manifestHash?: string;
  /** Only `ready` versions resolve at runtime or serve bundle bytes. */
  status: "staging" | "ready" | "invalid";
  componentCounts: PlatformPluginComponentCounts;
  servers: PlatformPluginServerComponent[];
  skills: PlatformPluginSkillComponent[];
  createdAt: number;
  readyAt?: number;
}

// ── Sandbox images ───────────────────────────────────────────────────────────
//
// A project's custom Computer base image: a blueprint plus its builds. Named
// "image" (the OCI term) and NOT "environment" — a Project Environment is an
// unrelated concept (a client + server group + skill/plugin bundle that suites
// and journeys run against), and it owns that word.

export interface PlatformImageBuild {
  id: string;
  status: "queued" | "building" | "ready" | "failed";
  provider: "e2b" | "stub";
  e2bBuildId?: string;
  baseImageDigests: string[];
  logPreview?: string;
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

/** A project's custom Computer sandbox image (its blueprint + latest build).
 * The list and detail routes return the same shape. */
export interface PlatformImage {
  id: string;
  projectId: string;
  name: string;
  blueprint: string;
  contentHash: string;
  sharing: "user" | "project";
  isOwner: boolean;
  currentBuild: PlatformImageBuild | null;
  createdAt: number;
  updatedAt: number;
}

export interface PlatformImageDeleted {
  id: string;
  deleted: true;
}

/** Result of linting blueprint YAML via `POST …/images/validate`. Always
 * HTTP 200 — `ok: false` is a successful lint with structured errors. */
export type PlatformImageBlueprintValidation =
  | { ok: true; baseImageDigest: string }
  | { ok: false; errors: { path: string; message: string }[] };

/** `POST …/build` is async (202): the build runs in the background — poll the
 * builds list for status. */
export interface PlatformImageBuildStarted {
  id: string;
  buildId: string;
  reused: boolean;
}

export interface PlatformComputerAttached {
  imageId: string;
  computerId: string;
  status: string;
}

export interface PlatformComputerReset {
  projectId: string;
  reset: boolean;
}

/** `200` response of `POST /eval-suites/{id}/cases/generate`. */
export interface PlatformEvalCasesGenerated {
  /** The backend LLM that authored the cases — NOT the case execution model. */
  generationModel: string;
  created: PlatformEvalCase[];
  counts: { normal?: number; negative?: number };
  /** Drafts that were generated but failed to persist (never silently dropped). */
  skipped?: Array<{ title: string; error: string }>;
}

export interface PlatformEvalIteration {
  id: string;
  testCaseId: string | null;
  title: string | null;
  iterationNumber: number;
  status: string;
  result: string | null;
  model: string | null;
  provider: string | null;
  startedAt: number | null;
  /** Wall-clock duration; null until terminal. */
  durationMs: number | null;
  tokensUsed: number | null;
  /** Structured token usage (input/output/cached/reasoning) when available. */
  usage: Record<string, unknown> | null;
  actualToolCalls: Array<Record<string, unknown>>;
  expectedToolCalls: Array<Record<string, unknown>>;
  error: string | null;
}

/** Public-safe evidence for one eval step (resolved URLs, no blob ids). */
export interface PlatformEvalStepEvidence {
  /** Widget→host tool calls the interaction triggered. */
  toolCalls?: Array<{
    name: string;
    args: unknown;
    ok: boolean;
    error?: string;
  }>;
  /** Resolved screenshot URL for the step's render/interaction. */
  screenshotUrl?: string;
  /** Resolved iteration replay `.webm` URL (same on every step of the run). */
  videoUrl?: string;
  /** Playback offset of this step within the replay video, when known. */
  videoOffsetMs?: number;
  /** "scripted" (authored) vs "computer_use" (model-driven) interaction. */
  source?: "computer_use" | "scripted";
  /** Human-readable interaction target (e.g. the button label). */
  locatorLabel?: string;
}

/**
 * One row per authored test step, in author order — the public mirror of the
 * fail-fast step engine. `status` is the per-step verdict; `evidence` is present
 * only when the step produced a screenshot / video / widget tool call.
 */
export interface PlatformEvalStepResult {
  stepId: string;
  stepIndex: number;
  kind: "prompt" | "toolCall" | "interact" | "assert";
  status: "ok" | "fail" | "skipped" | "pending";
  reason: string | null;
  evidence?: PlatformEvalStepEvidence;
}

/**
 * Share link for a chatbox. The URL embeds the access token; it is visible
 * to any caller who can read the chatbox (same audience as the hosted UI).
 */
export interface PlatformChatboxLink {
  /** App-relative share path. */
  path: string;
  /** Absolute share URL. */
  url: string;
}

/** A server attached to a chatbox (HTTP servers only). */
export interface PlatformChatboxServer {
  id: string;
  name: string;
  url: string | null;
  useOAuth: boolean;
}

/** Summary of a published chatbox, as returned by the list endpoint. */
export interface PlatformChatbox {
  id: string;
  projectId: string | null;
  name: string;
  description: string | null;
  /** Who can use it: "project_members" | "invited_only" | "anyone_with_link". */
  mode: string | null;
  /** Chat surface style the chatbox renders (e.g. "claude", "chatgpt"). */
  hostStyle: string | null;
  hostId: string | null;
  hostName: string | null;
  serverCount: number;
  serverNames: string[];
  link: PlatformChatboxLink | null;
  createdAt: number | null;
  updatedAt: number | null;
}

/** A chatbox's full read-only settings: summary plus host execution config. */
export interface PlatformChatboxDetail extends PlatformChatbox {
  /** Model the chatbox chats with. */
  modelId: string | null;
  systemPrompt: string | null;
  temperature: number | null;
  requireToolApproval: boolean;
  servers: PlatformChatboxServer[];
}

/**
 * Response of `POST /projects/{p}/servers/{s}/doctor` — the hosted doctor
 * result, passed through verbatim by the API. Includes the probe outcome,
 * connection state, and full tools/resources/prompts listings with
 * per-collection checks, which is why `show_servers` needs only one call
 * per server.
 */
export type PlatformDoctorReport = ServerDoctorResult<unknown>;

/**
 * Response of `POST /projects/{p}/tunnels` — the relay grant the caller
 * hosts the tunnel WebSocket with, plus the registered server record's
 * identity. The `url` embeds the plaintext `?k=` bearer secret (also
 * persisted on the server record so evals/chatboxes can target it); treat
 * the whole grant as a credential. Re-creating rotates the secret and
 * revokes the previous grant.
 */
export interface PlatformTunnelGrant {
  serverId: string;
  name?: string;
  /** True when a server record with this name already existed. */
  existed?: boolean;
  /** Previous URL, present when the existing record's URL was replaced. */
  previousUrl?: string;
  /** Previous transport, present when the record existed (e.g. "stdio"). */
  previousTransportType?: string;
  slug: string;
  /** Public tunnel URL with the `?k=` bearer secret. */
  url: string;
  /** Bearer for the relay edge WebSocket handshake. */
  connectToken: string;
  connectTokenExpiresAt?: number;
  relayWsUrl: string;
  secretVersion?: number;
}

/** Response of `POST /projects/{p}/tunnels/{serverId}/close`. */
export interface PlatformTunnelClosed {
  serverId: string;
  status: string;
}

// ── Journeys (the API surface for the Swarms product) ────────────────────────
//
// "Swarm" is deliberately not a resource noun. A swarm is a container users
// author in the UI; what EXECUTES is a journey (a persona pursuing a goal
// against one or more environments) and what it produces is a journey run.
//
// FLAG-GATED BETA (`sandboxes-enabled`). Reads are open — an empty list leaks
// nothing — but launching, cancelling and authoring are enforced server-side
// per organization, so an unflagged caller gets a structured
// FEATURE_UNAVAILABLE error from those.

export interface PlatformJourney {
  id: string;
  projectId: string;
  name: string;
  /** What the persona is trying to accomplish. Drives the whole run. */
  goal: string;
  personaId: string;
  /** The swarm container this journey was authored under, if any. Opaque. */
  swarmId: string | null;
  /** Environments this journey fans out across. Empty on a host-pinned journey. */
  environmentIds: string[];
  serverAttachmentId?: string;
  /** Sessions run against EACH target. Total sessions = targets x this. */
  sessionsPerTarget: number | null;
  maxTurns: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface PlatformJourneyRunTarget {
  hostId: string;
  hostName?: string;
  /** Execution identity. Two targets can share a `hostId`. */
  targetId?: string;
  modelId?: string;
}

export interface PlatformJourneyRunAttempt {
  chatSessionId: string | null;
  hostId: string;
  targetId: string | null;
  sessionIndex: number;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface PlatformJourneyRun {
  id: string;
  projectId: string;
  journeyId: string;
  /**
   * The batch this run was launched with. Sibling runs of one co-launched
   * wave share it; a solo relaunch is a wave of one.
   */
  waveId?: string;
  status: "running" | "completed" | "partial" | "failed" | "rate_limited";
  /**
   * True when someone STOPPED this run. It reports `status: "failed"` because
   * the backend records cancellation as a marker rather than a status literal
   * — so check this before showing a run as a failure.
   */
  canceled: boolean;
  /** True when the runner went silent and the watchdog settled the run. */
  stale: boolean;
  /** Raw marker behind `canceled` / `stale`, when present. */
  error?: string;
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    rateLimited: number;
  };
  targets: PlatformJourneyRunTarget[];
  persona?: {
    personaId: string | null;
    name: string | null;
    role: string | null;
  };
  /** Per-session execution records. Present on the single-run read. */
  attempts?: PlatformJourneyRunAttempt[];
  targetSummaries?: Array<{
    hostId: string;
    targetId?: string;
    total: number;
    succeeded: number;
    failed: number;
    rateLimited: number;
  }>;
  createdAt: number;
  lastHeartbeatAt?: number;
}

export interface PlatformJourneyRunSession {
  /**
   * The session's document id — the same value `listChatSessions` returns as
   * `id`, so a session found here can be looked up there.
   */
  id: string;
  /**
   * The RUNTIME key for the same session, which the chat transport and the
   * app's deep links use. Distinct from `id` and not interchangeable with it.
   */
  chatSessionId: string;
  projectId: string;
  hostId?: string;
  runId?: string;
  journeyId?: string;
  personaId?: string;
  personaLabel?: string;
  status: string | null;
  readiness: unknown;
  goalScore: unknown;
  messageCount: number;
  preview?: string;
  modelId?: string;
  startedAt: number | null;
  lastActivityAt: number | null;
}

// ── Scenarios (the API surface for user testing) ─────────────────────────────
//
// A scenario is a project environment published for people outside the project
// to talk to. Internally these are `chatboxes` rows and will stay that way —
// the rename is a transport-DTO boundary, not a migration. The older
// `list_chatboxes` / `get_chatbox` operations still work against the old
// routes until GA.

export interface PlatformScenario {
  id: string;
  environmentId: string;
  name: string;
  /**
   * Who may open the share link. `anyone_with_link` is the widest — anyone
   * holding the URL, signed in or not.
   */
  mode: "project_members" | "invited_only" | "anyone_with_link";
  /**
   * Bumped whenever access NARROWS (mode change, member removal, link
   * rotation). Sessions minted under an older version stop working, which is
   * what makes those changes take effect at once rather than at expiry.
   */
  accessVersion: number;
  /** The share link. Null when the scenario has no link token. */
  link: string | null;
  /** False when the environment was already published and this returned it. */
  created?: boolean;
}

export interface PlatformScenarioDeleted {
  environmentId: string;
  /** False when the environment had no scenario — not an error. */
  deleted: boolean;
  id?: string;
}

/** Result of `POST /projects/{p}/journeys/{journeyId}/runs`. */
export interface PlatformJourneyRunLaunched {
  /** The run id. Poll `getJourneyRun` with it, or stop it with `cancel`. */
  id: string;
  journeyId: string;
  projectId: string;
  /**
   * Always `"running"` — the run row exists and its fan-out has been started.
   * The response is a 202: nothing here says the journey has finished, only
   * that it is under way.
   */
  status: string;
  /**
   * True when an idempotency key replayed onto a run that ALREADY existed, so
   * nothing new was started. A retry of a dropped response lands here, which
   * is how you tell "I launched it" from "it was already going".
   */
  deduped: boolean;
}

/** Result of `POST /projects/{p}/journey-runs/{runId}/cancel`. */
export interface PlatformJourneyRunCanceled {
  id: string;
  /** The run's terminal status after the cancel settled it. */
  status: PlatformJourneyRun["status"];
  canceled: true;
  /** True when the run was ALREADY canceled and this call did nothing. */
  alreadyCanceled: boolean;
  /** Attempts this call moved to terminal. Zero on an idempotent replay. */
  finalized: number;
}

// ---------------------------------------------------------------------------
// Server connections
// ---------------------------------------------------------------------------

/**
 * One saved server a URL could refer to, offered when it matches more than one.
 *
 * Present only on an `AMBIGUOUS_SERVER` error. Without it that refusal is a
 * dead end on every surface that is not a browser: the caller is told to
 * re-send with a `serverId` and has no way to discover which ids exist.
 */
export interface PlatformServerConnectionCandidate {
  id: string;
  name: string;
  /** Redacted — query values are replaced, because a keyed-endpoint URL's
   * query can be the credential itself. */
  url: string;
}

export interface PlatformServerConnectionError {
  code: string;
  message: string;
  /** Whether retrying THIS request could succeed. False for a denied consent
   * or an unsupported auth method, where only a different action helps. */
  retryable: boolean;
  candidates?: PlatformServerConnectionCandidate[];
}

/**
 * The state of one "connect this MCP server" request.
 *
 * Returned by every server-connection route, so a caller polls the same shape
 * it created. `handoffUrl` is the exception that proves the rule: it appears
 * only in the CREATE response, because the raw handoff token exists exactly
 * once and nothing stores it.
 */
export interface PlatformServerConnection {
  connectionRequestId: string;
  status:
    | "discovering"
    | "awaiting_project"
    | "awaiting_authorization"
    | "authorizing"
    | "validating"
    | "ready"
    | "failed"
    | "expired"
    | "cancelled";
  /**
   * Where the user finishes in a browser. Present for BOTH
   * `awaiting_project` and `awaiting_authorization` — choosing a project needs
   * a page just as much as granting consent does.
   *
   * TREAT THIS AS PRIVATE. It is a capability for one person: never post it to
   * a shared channel, and never let a model echo it into prose.
   */
  handoffUrl?: string;
  expiresAt: string;
  projectId?: string;
  serverId?: string;
  server?: {
    id: string;
    name: string;
    url: string;
    enabled: boolean;
  };
  error?: PlatformServerConnectionError;
}

/** Body for `POST /server-connections`. */
export interface PlatformServerConnectionCreateBody {
  url: string;
  projectId?: string;
  /** Disambiguates when a project has several saved servers on one URL. */
  serverId?: string;
  /** Used only when a server row is created; ignored on reuse. */
  name?: string;
  reauthorize?: boolean;
}
