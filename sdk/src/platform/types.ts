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
import type {
  EvaluationConfigSnapshot,
  ScoreResult,
} from "../contract/types.js";

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

/**
 * An organization the caller belongs to — the ids `list_projects` and
 * `create_project` take as `organizationId`.
 *
 * Deliberately thin. The backing query is the browser app shell's, so it
 * carries billing and Stripe fields this transport DTO drops: an organization
 * on the machine surfaces is a SCOPE (an id, a name, and enough context to
 * pick between two of them), not an account-management object.
 */
export interface PlatformOrganization {
  id: string;
  name: string;
  /** Billing plan slug (`free` / `team` / `enterprise`) when resolved. */
  plan: string | null;
  /** Caller's role in the organization (`owner` / `admin` / `member`). */
  myRole: string | null;
  /** Whether the caller created the organization. */
  isCreator: boolean;
  logoUrl: string | null;
  createdAt: number | null;
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
 * Which session surface a row came from. Open-ended on the wire: switch on it
 * and tolerate an unknown value rather than assuming this list is closed.
 */
export type PlatformSessionSourceType = "direct" | "scenario" | "eval" | "swarm";

/** The session's parent run, discriminated on `kind`. Also open-ended. */
export interface PlatformSessionParentRef {
  kind: "evalRun" | "journeyRun" | "scenario";
  /** Human-readable parent name; null when the parent row is gone. */
  label: string | null;
  iterationId?: string;
  /** eval only; null means Quick Run (no suite run exists). */
  suiteRunId?: string | null;
  suiteId?: string | null;
  journeyRunId?: string;
  journeyRefId?: string | null;
  scenarioId?: string;
}

/** Where a human goes to read a session. Always present. */
export interface PlatformSessionLink {
  /** App-relative path, including `?project=`. */
  path: string;
  /** Absolute URL for the same target. */
  url: string;
}

/**
 * One row of the unified, cross-surface sessions feed
 * (`GET /projects/{projectId}/sessions`).
 *
 * Distinct from `PlatformChatSession`, which is the Playground-only projection
 * behind the older `/chat-sessions` route: this one spans every surface,
 * carries a typed parent reference, and pages on an opaque cursor.
 */
export interface PlatformSessionSummary {
  id: string;
  chatSessionId: string;
  projectId: string | null;
  sourceType: PlatformSessionSourceType;
  origin: string | null;
  status: string;
  synthetic: boolean;
  lockReason: string | null;
  title: string | null;
  firstMessagePreview: string;
  /** Direct sessions only: "private" | "project". null elsewhere. */
  visibility: string | null;
  ownedByViewer: boolean;
  startedAt: number;
  lastActivityAt: number;
  modelId: string | null;
  messageCount: number;
  /** Absent (not 0) when the session never reported the counter. */
  cumulativeUserMessageCount?: number;
  cumulativeToolCallCount?: number;
  cumulativeInputTokens?: number;
  cumulativeOutputTokens?: number;
  parentRef: PlatformSessionParentRef | null;
  link: PlatformSessionLink;
  /**
   * Transcript-scope results only: a window of the transcript around the
   * match. `null` when no window could be located; ABSENT on title-scope
   * results, which have no transcript to quote.
   */
  matchPreview?: string | null;
}

/**
 * The sessions page, plus the server's echo of the search scope it actually
 * honored.
 *
 * The echo exists so a client can tell an UNDERSTOOD `scope` from an IGNORED
 * one. A backend predating the parameter drops it silently and returns title
 * results; without the marker those are indistinguishable from the transcript
 * results the caller asked for. `scope` is optional here precisely because
 * such a backend omits it — its absence is the signal, and callers requesting
 * a non-default scope must check for it.
 */
export type PlatformSessionsPage = PlatformPage<PlatformSessionSummary> & {
  scope?: string;
};

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
  /**
   * Whether the run's score evidence verified at ingest.
   *
   * TRI-STATE, and the third state matters: `"valid"` means the backend
   * checked and the definitions and results agree; `"invalid"` means they did
   * not; `null`/absent means NO VERDICT WAS PRODUCED — an API deployment that
   * predates integrity checking. A score gate must treat `null` exactly like
   * `"invalid"`: absent evidence is not valid evidence.
   */
  scoreIntegrity?: "valid" | "invalid" | null;
  createdAt: number;
  completedAt: number | null;
  /**
   * The common actionable-insights envelope. Present on the DETAIL response
   * only (lists stay compact) and absent on servers deployed before the
   * envelope existed — treat absence as `not_available`.
   */
  insights?: PlatformInsightsEnvelope;
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
  name: string;
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

// ── Run comparison ───────────────────────────────────────────────────────────
//
// The public projection of the backend's run diff. Three naming decisions are
// load-bearing and deliberate:
//
//   1. The internal diff's top-level `scores` is run-summary COUNTERS, and it
//      collides by name with score-contract data. On this wire it is
//      `passSummary`, and the word "scores" appears only inside
//      `scoreContract` / `scoreDeltas`.
//   2. `traceBlobIds` never crosses this boundary. The internal diff carries
//      `_storage` ids; the DTO whitelist drops them.
//   3. New rate fields are FRACTIONS and carry no `Percent` in the name. The
//      one legacy percent field keeps its name so nobody mistakes it.

/** A base/compare pair with its delta. Rates in these are fractions. */
export interface PlatformNumericDiff {
  base: number | null;
  compare: number | null;
  delta: number | null;
  percentDelta: number | null;
}

export type PlatformCompareCaseStatus =
  | "unchanged_passed"
  | "unchanged_failed"
  | "regressed"
  | "fixed"
  | "new_case"
  | "removed_case"
  | "changed";

export interface PlatformScoreContractSide {
  evaluationConfigHash: string | null;
  /** `null` means NO verdict — treat it exactly like `"invalid"` for gating. */
  scoreIntegrity: "valid" | "invalid" | null;
  scoredIterations: number;
  quarantinedIterations: number;
}

export interface PlatformScoreContractScorer {
  scorerId: string;
  gating: boolean;
  deterministic: boolean;
  /** Same id, different definition hash — the two sides did not measure alike. */
  definitionChanged: boolean;
  passRate: PlatformNumericDiff;
  meanValue: PlatformNumericDiff;
  errorCount: { base: number; compare: number };
}

export interface PlatformScoreContractDiff {
  base: PlatformScoreContractSide;
  compare: PlatformScoreContractSide;
  evaluationConfigChanged: boolean;
  scorers: PlatformScoreContractScorer[];
}

export interface PlatformCaseScoreSide {
  status: "scored" | "error" | "skipped" | "not_applicable";
  value: number | null;
  passed: boolean | null;
}

export interface PlatformCaseScoreDelta {
  scorerId: string;
  gating: boolean;
  deterministic: boolean;
  definitionChanged: boolean;
  base: PlatformCaseScoreSide | null;
  compare: PlatformCaseScoreSide | null;
  value: PlatformNumericDiff;
}

export interface PlatformRunCompareCaseSide {
  outcome: "passed" | "failed" | "absent";
  /** Iteration ids are public; `traceBlobIds` are NOT and never appear here. */
  iterationIds: string[];
  representativeIterationId: string | null;
  error: string | null;
}

export interface PlatformRunCompareCase {
  caseKey: string;
  title: string;
  status: PlatformCompareCaseStatus;
  /** The scenario's own config (prompt, steps, expectations) changed. */
  configChanged: boolean;
  /** This case's evaluation config changed. */
  evaluationConfigChanged: boolean;
  scoreDeltas: PlatformCaseScoreDelta[];
  base: PlatformRunCompareCaseSide;
  compare: PlatformRunCompareCaseSide;
}

export interface PlatformRunCompareSide {
  id: string;
  runNumber: number;
  result: string;
  createdAt: number;
  completedAt: number | null;
  summary: {
    total: number;
    passed: number;
    failed: number;
    passRate: number;
  } | null;
}

/**
 * The compare wire.
 *
 * There is deliberately NO `baseline_not_found` member. A missing baseline
 * arrives as a thrown `PlatformApiError` (404 with
 * `details.reason === "BASELINE_NOT_FOUND"`), so a caller that forgets to
 * handle it fails loudly instead of reading fields off a union member it never
 * narrowed.
 */
export interface PlatformRunCompare {
  suite: { id: string; name: string };
  baseline: {
    policy: "previous_completed" | "run";
    baseRunId: string;
  };
  baseRun: PlatformRunCompareSide;
  compareRun: PlatformRunCompareSide;
  /**
   * Run-summary counters — NOT score-contract data. Named `passSummary` here
   * precisely because the internal field is called `scores` and the collision
   * is a live foot-gun.
   */
  passSummary: {
    passRatePercent: PlatformNumericDiff;
    total: PlatformNumericDiff;
    passed: PlatformNumericDiff;
    failed: PlatformNumericDiff;
  };
  metrics: {
    wallDurationMs: PlatformNumericDiff;
    totalTokens: PlatformNumericDiff;
    estimatedCostUsd: PlatformNumericDiff;
  };
  scoreContract: PlatformScoreContractDiff;
  cases: PlatformRunCompareCase[];
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
  /**
   * Per-scorer verdicts for this iteration, in the evaluation contract's
   * shape. `null` when the run predates scoring, or when the stored payload
   * failed validation at the boundary — a public caller never receives
   * partially-trusted score data.
   */
  scores?: ScoreResult[] | null;
  /**
   * The definitions those scores were produced under, plus their hash.
   *
   * Ships with `scores` or not at all: `role` and the error policies live here,
   * so results without it cannot be told apart as gating or advisory.
   */
  evaluationConfig?: EvaluationConfigSnapshot | null;
  /** Set when the backend downgraded this iteration's verdict at ingest. */
  scoreIntegrity?: "score_integrity_invalid" | null;
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
 * Share link for a scenario. The URL embeds the access token; it is visible
 * to any caller who can read the scenario (same audience as the hosted UI).
 */
export interface PlatformScenarioLink {
  /** App-relative share path. */
  path: string;
  /** Absolute share URL. */
  url: string;
}

/** A server attached to a scenario (HTTP servers only). */
export interface PlatformScenarioServer {
  id: string;
  name: string;
  url: string | null;
  useOAuth: boolean;
}

/** Summary of a published scenario, as returned by the list endpoint. */
export interface PlatformScenarioSummary {
  id: string;
  projectId: string | null;
  name: string;
  description: string | null;
  /** Who can use it: "project_members" | "invited_only" | "anyone_with_link". */
  mode: string | null;
  /** Chat surface style the scenario renders (e.g. "claude", "chatgpt"). */
  hostStyle: string | null;
  hostId: string | null;
  hostName: string | null;
  serverCount: number;
  serverNames: string[];
  link: PlatformScenarioLink | null;
  createdAt: number | null;
  updatedAt: number | null;
}

/** A scenario's full read-only settings: summary plus host execution config. */
export interface PlatformScenarioDetail extends PlatformScenarioSummary {
  /** Model the scenario chats with. */
  modelId: string | null;
  systemPrompt: string | null;
  temperature: number | null;
  requireToolApproval: boolean;
  servers: PlatformScenarioServer[];
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
 * persisted on the server record so evals/scenarios can target it); treat
 * the whole grant as a credential. Re-creating rotates the secret and
 * revokes the previous grant.
 */
export interface PlatformTunnelGrant {
  serverId: string;
  name: string;
  /** True when a server record with this name already existed. */
  existed: boolean;
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
  /** Common insights envelope (detail response only; lists stay compact).
   * Absent on servers deployed before the envelope existed. */
  insights?: PlatformInsightsEnvelope;
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
  /**
   * ARCHIVAL state (`active` | `archived`) — a run session stays `active`
   * forever unless archived, so this says nothing about how it went. Read
   * `outcome` for the verdict.
   */
  status: string | null;
  /**
   * How this session's run attempt ended: `succeeded` | `failed` |
   * `rate_limited` | `running` | `pending`, or null when the attempt cannot
   * be matched (historical runs). Absent on servers that predate the field.
   */
  outcome?: string | null;
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
// to talk to. It is a `scenarios` row all the way down: this used to be a
// transport-DTO rename over a `chatboxes` table, and that split is gone —
// storage, routes and operations all say scenario now.
//
// `PlatformScenario` here is the PUBLISH response. The list/read shapes are
// `PlatformScenarioSummary` and `PlatformScenarioDetail` above; they were
// named for the old table, and kept the `Summary` suffix rather than colliding
// with this one.

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
  /**
   * True when `publishScenario`'s create-time overrides (`name`,
   * `description`, `mode`) were NOT applied because the environment was
   * already published. Paired with `created: false`.
   *
   * Declared here rather than as an intersection at the two call sites that
   * return it. Both did — `Promise<PlatformScenario & { overridesIgnored?:
   * boolean }>` — which typed the field for a caller who read it off the
   * return value and left it invisible to anything holding a
   * `PlatformScenario`, including the spec↔types parity check. A field the
   * wire really carries belongs on the interface that describes the wire.
   */
  overridesIgnored?: boolean;
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

// ── Swarms authoring + insights ─────────────────────────────────────────────

/** A reusable synthetic character. The GOAL lives on the journey, not here. */
export interface PlatformPersona {
  /** Durable id — what journeys reference and every route here addresses. */
  id: string;
  projectId: string;
  /**
   * Stable slug key, shared with exported session data. Useful for correlating
   * transcripts; NOT an address for this API.
   */
  slug: string;
  name: string;
  role: string;
  notes: string | null;
  /** manual | generated | cluster — how the persona came to exist. */
  source: string;
  seedKeywords?: string[];
  avatar: { shape: number | null; palette: number | null };
  createdAt: number;
  updatedAt: number;
}

/** Result of deleting a persona. The delete is SOFT: history still resolves it. */
export interface PlatformPersonaDeleted {
  id: string;
  projectId: string;
  deleted: true;
}

/** Result of archiving a journey. Its runs and transcripts stay readable. */
export interface PlatformJourneyArchived {
  id: string;
  projectId: string;
  archived: true;
}

/** A swarm CONTAINER: shared execution config for the journeys authored in it. */
export interface PlatformSwarm {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  /** Default fan-out for journeys authored under this container. */
  environmentIds: string[];
  sessionsPerTarget: number | null;
  maxTurns: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface PlatformSwarmArchived {
  id: string;
  projectId: string;
  archived: true;
}

/** One rubric criterion's tally over a run. The four counts are NOT mergeable. */
export interface PlatformScorecardCriterion {
  id: string;
  label: string | null;
  kind: string;
  passCount: number;
  failCount: number;
  /** Claimed for grading and unfinished — includes crashed runners. */
  pendingCount: number;
  /**
   * Sessions whose GRADING broke. Distinct from `failCount` on purpose:
   * folding them together makes a crashed judge look like a regression.
   */
  failedGradingCount: number;
}

/** Deterministic rubric result for one run. No model involved. */
export interface PlatformRunScorecard {
  runId: string;
  /**
   * Every criterion the run's rubric declared, in snapshot order — including
   * ones nothing was graded against. An absent row would be indistinguishable
   * from a criterion that was never configured.
   */
  criteria: PlatformScorecardCriterion[];
  sessionsTotal: number;
  sessionsGraded: number;
}

export interface PlatformSwarmOverviewFinding {
  criterionId: string;
  label: string | null;
  kind: string | null;
  failCount: number;
  pendingCount: number;
  failedGradingCount: number;
  /**
   * The DENOMINATOR for any rate you compute. Never divide by the session
   * total — 3 failures of 4 graded sessions out of 40 attempted is not 7.5%.
   */
  sessionsGraded: number;
  /** Consecutive runs of this journey where the criterion failed. */
  runStreak: number;
}

export interface PlatformSwarmOverviewRun {
  runId: string;
  journeyId: string;
  journeyName: string;
  journeyArchived: boolean;
  personaName: string;
  status: string;
  waveId?: string;
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    rateLimited: number;
  };
  goalCompletion: {
    gradedCount: number;
    passedCount: number;
    avgScore: number | null;
    pendingCount: number | null;
    failedCount: number | null;
  } | null;
  findings: PlatformSwarmOverviewFinding[];
  targets: Array<{
    hostName: string;
    modelId: string;
    environmentName?: string;
  }>;
  createdAt: number;
}

/** Project-wide roll-up across recent runs. */
export interface PlatformSwarmOverview {
  runs: PlatformSwarmOverviewRun[];
  runsConsidered: number;
  goalCompletion: {
    gradedCount: number;
    passedCount: number;
    /** `null` when nothing is graded yet — never 0, which would read as "all failed". */
    passRate: number | null;
    runsWithGrades: number;
    trend: Array<{
      dayStartMs: number;
      gradedCount: number;
      passedCount: number;
      passRate: number;
    }>;
  };
}

/** A criterion that keeps failing, tracked across waves. */
export interface PlatformSwarmFinding {
  id: string;
  /** Stable identity across waves — what makes a streak a streak. */
  fingerprint: string;
  dimension: string;
  subject: { kind: string; id: string; label: string };
  /** new | recurring | regressed | resolved. */
  status: string;
  occurrenceCount: number;
  lastSeenWaveId: string;
  firstSeenAt: number;
  lastSeenAt: number;
  resolvedAt: number | null;
  dismissedAt: number | null;
  updatedAt: number;
}

export interface PlatformFindingDismissed {
  id: string;
  projectId: string;
  dismissed: boolean;
}

/**
 * The common actionable-insights envelope — one shape across Eval runs,
 * Swarm waves, and User Testing windows. Hand-mirrored from the backend's
 * `lib/insightsEnvelope.ts` (two-repo type discipline).
 *
 * Reading rules for consumers (including agents):
 * - Findings are AGGREGATED per run/wave/window; `evidence` points at
 *   exemplar sessions or iterations, not one finding per session.
 * - Only `actionTarget: "mcp_server"` with `actionability: "ready"`
 *   authorizes proposing a change to the MCP server. Every other action
 *   target names different work (agent config, eval case, environment,
 *   investigation) and must NOT be "fixed" in server code.
 * - `findings` is empty unless `status === "completed"`. An empty completed
 *   list is a real "nothing to act on" answer.
 * - Reads never trigger generation; `status` is observational.
 */
export type PlatformInsightsStatus =
  | "not_available"
  | "not_requested"
  | "pending"
  | "completed"
  | "failed";

export type PlatformInsightScope =
  | { kind: "eval_run"; id: string }
  | { kind: "swarm_wave"; id: string; runId: string }
  | {
      kind: "user_testing_window";
      id: string;
      scenarioId: string;
      windowStartAt: number;
      windowEndAt: number;
    };

export type PlatformInsightAttribution =
  | "unknown"
  | "server_contract"
  | "server_runtime"
  | "server_capability"
  | "agent_or_prompt"
  | "test_design"
  | "environment";

export type PlatformInsightActionTarget =
  | "investigate"
  | "mcp_server"
  | "agent_configuration"
  | "eval_case"
  | "environment";

export type PlatformInsightActionability =
  | "informational"
  | "investigate"
  | "ready";

export interface PlatformActionableFindingEvidence {
  sessionId?: string;
  iterationId?: string;
  kind: "tool_error" | "transcript" | "feedback" | "judge" | "contrast";
  /** Scrubbed and clipped at the producer. */
  excerpt: string;
  toolName?: string;
  errorCode?: string;
}

export interface PlatformActionableFinding {
  /** Stable remediation id (`rf_<16 hex>`) — survives dynamic error values. */
  id: string;
  /** The registry signal this derives from; several findings may share one. */
  signalFingerprint: string;
  title: string;
  category:
    | "unknown"
    | "tool_contract"
    | "tool_runtime"
    | "capability_gap"
    | "workflow"
    | "agent_behavior"
    | "test_design"
    | "environment";
  attribution: PlatformInsightAttribution;
  actionTarget: PlatformInsightActionTarget;
  actionability: PlatformInsightActionability;
  severity: "info" | "low" | "medium" | "high";
  confidence: "low" | "medium" | "high";
  /** Deterministic observation — counts and identities, never model prose. */
  observed: string;
  rootCause?: string;
  recommendation: string;
  acceptanceCriteria: string[];
  affected: {
    count: number;
    total: number;
    unit: "iterations" | "sessions";
  };
  patternSlug?: string;
  /** Present only when a server (and, for tool surfaces, tool) resolved
   * against the pinned snapshot. Required for `mcp_server`/`ready`. */
  target?: {
    serverId: string;
    toolName?: string;
    surface:
      | "description"
      | "input_schema"
      | "output_schema"
      | "handler"
      | "server_instructions"
      | "capability";
    fieldPath?: string;
    snapshotHash: string;
    currentDefinition?: {
      description?: string;
      inputSchemaJson?: string;
      outputSchemaJson?: string;
      truncated: boolean;
    };
  };
  evidence: PlatformActionableFindingEvidence[];
}

export interface PlatformInsightsEnvelope {
  schemaVersion: 1;
  scope: PlatformInsightScope;
  status: PlatformInsightsStatus;
  reasonCode: string | null;
  retryable: boolean;
  error: { code: string; message: string } | null;
  generatedAt: number | null;
  updatedAt: number | null;
  summary: string | null;
  coverage: {
    unit: "iterations" | "sessions";
    analyzed: number;
    total: number;
    gradedCount?: number;
    feedbackCount?: number;
    truncated: boolean;
    lowConfidence: boolean;
  };
  findings: PlatformActionableFinding[];
  /** Swarm only. Launch outcomes never appear as findings. */
  runHealth?: {
    targets: Array<{
      subjectKind: "environment" | "host";
      subjectId: string;
      subjectLabel: string;
      attempted: number;
      succeeded: number;
      failed: number;
      rateLimited: number;
    }>;
  };
  truncation: {
    truncated: boolean;
    omittedFindings: number;
    omittedEvidence: number;
    contractTruncated: boolean;
  };
}

/** Receipt for an eval-run insights (serverQuality) request. 202. */
export interface PlatformEvalRunInsightsRequested {
  runId: string;
  projectId: string;
  status: "pending";
}

/** LLM analysis over a whole wave. Requested explicitly; produced async. */
export interface PlatformWaveInsights {
  waveId: string;
  /** pending | completed | failed. Poll rather than re-requesting. */
  status: "pending" | "completed" | "failed";
  /** Directed lane. Null until generation completes. */
  insights: unknown | null;
  /**
   * Discovery lane — what the model noticed unprompted. Null while only the
   * directed lane has finished, which is a normal intermediate state.
   */
  discovery: unknown | null;
  errorCode: string | null;
  errorMessage: string | null;
  updatedAt: number;
}

/** Receipt for a wave-insights request. 202: scheduled, not done. */
export interface PlatformWaveInsightsRequested {
  waveId: string;
  projectId: string;
  status: "pending";
}

export interface PlatformWaveInsightsCanceled {
  waveId: string;
  projectId: string;
  canceled: true;
}

/**
 * What the caller may do in a project, so an agent on a static surface can
 * check before it plans rather than discovering a 403 mid-task.
 *
 * DESCRIPTIVE. Every enforcement point still runs on the write path; a stale
 * answer here produces the same clean denial it always would.
 */
export interface PlatformCapabilities {
  projectId: string;
  organizationId: string | null;
  /** Organization role: guest | member | admin | owner. */
  role: string;
  projectRole: string;
  /** Which channel the server resolved this request to. */
  surface: string;
  features: {
    sandboxes: {
      enabled: boolean;
      /** off | dark | enforce. Only `enforce` turns a disabled flag into a refusal. */
      mode: string;
      enforced: boolean;
      reason?: string;
    };
  };
  plan: {
    name: string;
    limits: Record<string, unknown>;
    features: Record<string, unknown>;
  } | null;
  /**
   * The booleans to branch on. Note that the exposure-REDUCING ones
   * (`cancelJourneyRun`, `unpublishUserTestingScenario`) stay true for an org
   * that has lost the beta — losing the feature is exactly when stopping it
   * matters most.
   */
  can: {
    readSwarms: boolean;
    readUserTesting: boolean;
    writeSwarms: boolean;
    launchJourneyRun: boolean;
    cancelJourneyRun: boolean;
    publishUserTestingScenario: boolean;
    unpublishUserTestingScenario: boolean;
    /**
     * Mode changes, member invites/removals, link rotation, renames — the
     * scenario controls an ordinary MEMBER can use. Guest execution is not
     * covered here; it is the one exposure control that needs admin, and it
     * has its own key below.
     */
    changeUserTestingExposure: boolean;
    /** The guest-execution spend caps. Genuinely project-admin upstream. */
    manageUserTestingGuestExecution: boolean;
    requestInsights: boolean;
    /** Reading eval suites, runs, iterations and traces. */
    readEvals: boolean;
    /** Authoring suites and cases — every eval write short of deleting. */
    writeEvalSuites: boolean;
    launchEvalRun: boolean;
    /**
     * Deleting a suite SOMEONE ELSE created — the project admin tier. The
     * creator of a suite may always delete it whatever their role, so a
     * `false` here does not mean you cannot delete your own.
     */
    deleteAnyEvalSuite: boolean;
    /** Same tier and same creator exception, for runs. */
    deleteAnyEvalRun: boolean;
    /**
     * Whether the trace export surface is open. Export still filters row by
     * row against the caller, so this is not a promise that every session in
     * the project lands in the file.
     */
    exportEvalTraces: boolean;
  };
}

/** A generated persona draft. Nothing is persisted until you create it. */
export interface PlatformPersonaDraft {
  name: string;
  role: string;
  notes?: string;
  [field: string]: unknown;
}

/** Draft output from the generation endpoints. Shape varies by request. */
export interface PlatformGenerationDrafts {
  [field: string]: unknown;
}

// ── User testing ────────────────────────────────────────────────────────────

/** One session a visitor had with a published scenario. SUMMARY, not transcript. */
export interface PlatformUserTestingSession {
  /** The address for the transcript route. */
  id: string;
  chatSessionId: string;
  messageCount: number;
  /** First message only. The transcript is a separate, explicit read. */
  preview: string;
  modelId?: string;
  toolCallCount?: number;
  /** The visitor abandoned mid-flow because a server demanded auth. */
  authInterrupted?: boolean;
  visitor: {
    displayName?: string;
    segment?: string;
    authType?: "signedIn" | "guest";
    recency?: "new" | "returning";
    deviceKind?: string;
    language?: string;
  };
  feedback: {
    rating: number | null;
    comment: string | null;
    count: number;
  };
  theme?: { id: string; label: string | null; keywords: string[] };
  startedAt: number;
  lastActivityAt: number;
}

/** One projected transcript message. Tool payloads and blobs are dropped. */
export interface PlatformTranscriptMessage {
  role: string;
  text: string;
  toolName?: string;
  createdAt?: number;
}

/**
 * A session's transcript, paged.
 *
 * The stored blob URL is never returned: it is a direct handle with no further
 * authorization, so handing it out would turn one authorized read into an
 * unbounded, unrevocable one.
 */
export interface PlatformUserTestingSessionDetail {
  id: string;
  scenarioId: string;
  chatSessionId: string | null;
  modelId: string | null;
  startedAt: number | null;
  lastActivityAt: number | null;
  /**
   * `null` — never 0 — when the transcript could not be read, which is why
   * this is nullable and the list DTO's is not. Zero would be a claim the
   * visitor said nothing, the opposite of what an unreadable blob means, and a
   * caller that only checked `messageCount` would act on it.
   */
  messageCount: number | null;
  /**
   * True when the stored conversation could not be read. Distinct from an
   * empty `messages`, which means the visitor genuinely said nothing.
   */
  transcriptUnavailable?: boolean;
  messages: PlatformTranscriptMessage[];
  nextCursor?: string;
}

/**
 * Scenario metadata after an update.
 *
 * NO `accessVersion`, deliberately: a mode change bumps it upstream, but the
 * envelope the route re-reads does not carry the new value, so the field was
 * null on every response while documenting itself as the revocation signal.
 * The publish response (`PlatformScenario`) carries the real one.
 */
export interface PlatformUserTestingScenario {
  id: string;
  projectId: string;
  name: string | null;
  description: string | null;
  mode: string | null;
}

/**
 * Scenario detail — the read shape, widened with the environment link and
 * the insights envelope.
 */
export interface PlatformUserTestingScenarioDetail
  extends PlatformUserTestingScenario {
  environmentId: string | null;
  /**
   * Present when the caller may have it. The envelope is gated on workspace
   * MEMBERSHIP while the scenario itself is visible more widely, so a
   * lower-privilege viewer gets the scenario without this field rather than
   * an error — same degradation as an older server that cannot produce one.
   */
  insights?: PlatformInsightsEnvelope;
}

/** Guest execution caps — the spend dial for anonymous visitors. */
export interface PlatformGuestExecution {
  enabled: boolean;
  computerEnabled: boolean;
  sharedSkillsEnabled: boolean;
  dailyCreditCap: number;
  dailyComputerStartCap: number;
  maxConcurrentComputers: number;
  harnessEnabled?: boolean;
  dailyHarnessSpendCapMicros?: number;
  dailyHarnessCallCap?: number;
  maxConcurrentHarnessRuns?: number;
}

export interface PlatformUserTestingInsightsRequested {
  scenarioId: string;
  projectId: string;
  windowId: string;
  status: "pending";
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
