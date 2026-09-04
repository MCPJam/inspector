import type { EvalSuiteFileCaseImport } from "@mcpjam/sdk/contract";
import type { PromptTurn, PromptTurnToolCall } from "@/shared/steps";
import type { TestStep } from "@/shared/steps";
import type {
  EvalTraceBlobV1,
  EvalTraceBrowserInteractionStepView,
} from "@/shared/eval-trace";
import type { EvalStreamToolCall } from "@/shared/eval-stream-events";
import type {
  EvalMatchOptions,
  Predicate,
  CasePredicates,
} from "@/shared/eval-matching";
import type { TraceEnvelope, TraceMessage } from "./trace-viewer-adapter";
import type { EvalStepStatusEntry } from "./eval-stream-reducer";
// The judge config envelope is product-neutral and shared with Swarms; the
// canonical definition lives in the shared session-quality module. Aliased +
// re-exported under the historical Eval* names so eval call sites are unchanged.
import type {
  GoalJudgeConfig as EvalJudgeConfig,
  GoalJudgeConfigOverride as EvalJudgeConfigOverride,
  GoalJudgeRunOverride as EvalJudgeRunOverride,
} from "@/components/shared/session-quality/judge-config";
export type { EvalJudgeConfig, EvalJudgeConfigOverride, EvalJudgeRunOverride };

/**
 * One criterion the suite's judge is asked to apply to every case.
 *
 * `weight` and `scale` are deliberately absent rather than optional-and-
 * ignored: the judge returns one score per case plus the criteria it hit, so
 * there is nothing for a per-criterion weight to weigh. Adding the field
 * without the machinery would let an author express a preference the grader
 * silently discards.
 */
export type EvalJudgeRubricCriterion = {
  id: string;
  label: string;
  description?: string;
  required?: boolean;
};

export type EvalJudgeRubric = { criteria: EvalJudgeRubricCriterion[] };

/**
 * Host identity an eval run executed against. Hand-mirrored from the Convex
 * `insightHostSnapshotValidator` (convex/lib/insightHostSnapshot.ts) per the
 * two-repo layout. Model/config fields are resolved from the run's pinned
 * `hostConfigId` snapshot, never the live host pointer.
 */
export type InsightHostSnapshot = {
  namedHostId?: string;
  hostConfigId?: string;
  name?: string;
  modelId?: string;
  hostStyle?: string;
  temperature?: number;
  systemPromptExcerpt?: string;
  serverCount?: number;
  optionalServerCount?: number;
  builtInToolIds?: string[];
  source: "run_snapshot" | "name_only" | "unknown";
};

/**
 * Cross-host group quality result. Hand-mirrored from the Convex
 * `runGroupQualityResultValidator` (convex/lib/runGroupQualityValidators.ts).
 * One per launch group — compares the suite across its sibling host runs.
 */
export type RunGroupQualityResult = {
  summary: string;
  generatedAt: number;
  modelUsed: string;
  runIds: string[];
  findings: Array<{
    title: string;
    severity: "info" | "warning" | "critical";
    category:
      | "host_divergence"
      | "all_hosts_failed"
      | "tool_path_divergence"
      | "efficiency_divergence"
      | "environment_failure";
    attribution:
      | "unknown"
      | "server_design"
      | "host_prompt"
      | "model_behavior"
      | "test_design"
      | "environment";
    confidence: "low" | "medium" | "high";
    caseKey?: string;
    caseTitle?: string;
    affectedHosts: string[];
    baselineHosts: string[];
    evidence: string[];
    recommendation: string;
  }>;
  hostSummaries: Array<{
    hostName: string;
    runId: string;
    namedHostId?: string;
    modelId?: string;
    verdict: "incomplete" | "weak" | "mixed" | "strong";
    summary: string;
  }>;
};

/**
 * What a converter CLAIMED about one imported case.
 *
 * `exact` is CONVERTER-CLAIMED exact: the converter says it applied a
 * structural mapping rule, cited in `note`. MCPJam has NOT verified semantic
 * equivalence, and no surface may render this as "verified" or "accepted" —
 * the copy is "claimed exact".
 *
 * Claim-only. Who approved an approximation, when, and why is a PER-RUN
 * decision frozen on the run ({@link EvalImportRunDecision},
 * {@link ImportApprovalReceipt}), never stored on the case.
 *
 * ALIASED to the suite-file contract's own type rather than restated, so the
 * four statuses cannot drift out of step with what a converter may write.
 */
export type EvalCaseImportClaim = EvalSuiteFileCaseImport;

/**
 * The run's FROZEN decision about one imported case, written at launch.
 *
 * `claimed_exact` carries no actor because no human decided anything — the run
 * took the converter's word, having first checked it against the tool
 * snapshot. `approved_approximation` carries all three facts an override owes:
 * who, when, and why.
 *
 * Read this, never the case's current claim, when showing what a past run did:
 * a case edited after the run would otherwise retroactively rewrite what that
 * run is shown to have decided.
 */
export type EvalImportRunDecision =
  | { status: "claimed_exact" }
  | {
      status: "approved_approximation";
      approvedBy: string;
      approvedAt: number;
      reason: string;
    };

/** One frozen approval of an approximated import, as the run recorded it. */
export type ImportApprovalReceipt = {
  testCaseId: string;
  caseKey?: string;
  sourceCaseKey?: string;
  approvedBy: string;
  approvedAt: number;
  reason: string;
};

/** One reason a run's import evidence is incomplete. */
export type ImportEligibilityIssue = {
  code: string;
  testCaseId?: string;
  caseKey?: string;
  toolName?: string;
};

/**
 * Whether a run's imported cases carry evidence a gate may rely on.
 *
 * Computed by the platform from the run's OWN frozen snapshot. Never
 * recomputed here from the suite's current cases: those can be edited after
 * the run, and recomputing would let an edit change what a finished run is
 * shown to have proved.
 *
 * `incomplete` is NOT a test verdict. It means the run is not gateable, and
 * every surface that renders it must say so in those words rather than as a
 * failure.
 */
export type ImportEligibility = {
  status: "legacy" | "eligible" | "incomplete";
  gateable: boolean;
  importedCaseCount: number;
  claimedExactCaseIds: string[];
  approvedApproximationCaseIds: string[];
  approvedApproximationReceipts: ImportApprovalReceipt[];
  issues: ImportEligibilityIssue[];
};

export type EvalSuiteConfigTest = {
  title: string;
  query: string;
  provider: string;
  model: string;
  runs: number;
  expectedToolCalls: Array<{
    toolName: string;
    arguments: Record<string, any>;
  }>;
  isNegativeTest?: boolean; // When true, test passes if NO tools are called
  scenario?: string; // Description of why app should NOT trigger (negative tests only)
  expectedOutput?: string; // The output or experience expected from the MCP server
  /**
   * Unified authored test steps — the source of truth for execution. Replaces
   * the legacy `promptTurns`/`caseType`/`probeConfig` fields, which the Convex
   * mutations now reject. `promptTurns` lingers only as a read-time fallback
   * while legacy rows are migrated.
   */
  steps?: TestStep[];
  promptTurns?: PromptTurn[];
  advancedConfig?: Record<string, unknown>;
  /** Effective validator options for this entry, resolved at run-start. */
  matchOptions?: EvalMatchOptions;
  testCaseId?: string;
  /**
   * The claim FROZEN into this run's snapshot — what the case claimed when the
   * run started, not what it claims now.
   */
  import?: EvalCaseImportClaim;
  /** The run's own decision about this case. Absent on a native case. */
  importRunDecision?: EvalImportRunDecision;
};

export type EvalSuite = {
  _id: string;
  createdBy: string;
  projectId?: string;
  name: string;
  description: string;
  configRevision: string;
  environment: {
    servers: string[];
    serverBindings?: Array<{
      serverName: string;
      projectServerId?: string;
    }>;
    /**
     * Reproducible-evals pin: the computer environment each eval iteration
     * boots a fresh sandbox from. Set via the suite settings env-picker.
     */
    computerEnvironmentId?: string;
  };
  createdAt: number;
  updatedAt: number;
  latestRunId?: string;
  source?: "ui" | "sdk";
  /**
   * Epoch ms of the newest CI (SDK-ingested) run — the durable server-side
   * "suite has CI runs" signal (backfilled). The CI tab scopes on this.
   */
  lastSdkRunAt?: number;
  runCounter?: number;
  defaultPassCriteria?: {
    minimumPassRate: number;
  };
  /** Suite-level default validator options (used unless a case overrides). */
  defaultMatchOptions?: EvalMatchOptions;
  /**
   * Suite-level default deterministic predicate gate ("Default checks" in UI).
   * Resolved per-case via `testCase.predicates.mode` (`inherit` ⇒ use as-is,
   * `replace` ⇒ ignored, `extend` ⇒ prepended to case list). Snapshotted onto
   * `testIteration.testCaseSnapshot.predicates` at run-precreate time.
   */
  defaultPredicates?: Predicate[];
  /**
   * Suite-level floor on per-case iteration count (1–10). When set, every
   * case in a suite run executes at least this many iterations. Resolved
   * backend-side into `configSnapshot.tests[].runs` at run-create time, so
   * the runner reads the already-floored value. A per-run "Iterations"
   * override still wins; per-case quick runs are unaffected.
   */
  minIterations?: number;
  /**
   * Suite-level advisory judge configuration. Authoritative source for
   * judgeModel / threshold / enabled flag — runs snapshot this at
   * run-create time, the action reads from the snapshot, and the
   * run-detail card displays it read-only with an explicit "override
   * for this run" disclosure as the escape hatch. Hand-mirrors the
   * Convex `v.object` (no codegen for backend → inspector types).
   */
  judgeConfig?: EvalJudgeConfig;
  /**
   * B10a — the suite's own grading criteria, handed to the judge as one block
   * alongside each case's own expectation.
   *
   * DISTINCT from `rubric`: that one is deterministic predicates the journeys
   * surface evaluates itself, this one is prose the judge reads. A criterion
   * here has no predicate and never gates on its own; it changes what the
   * judge was ASKED, which is why editing it retires the suite's calibration.
   */
  judgeRubric?: EvalJudgeRubric;
  /**
   * G6 — the suite configuration's revision number, newest first in
   * `listSuiteRevisions`. Absent on a backend that predates suite history, so
   * every reader must treat absence as "this deployment has no history" rather
   * than "this suite has none".
   */
  revisionNumber?: number;
  /**
   * B9a — the verdict policy this suite's runs are decided under.
   *
   * `2` is the fraction-and-validity policy; ABSENT is legacy, decided by
   * `defaultPassCriteria.minimumPassRate` (a PERCENT) over
   * `max(case.iterations, minIterations)`. The two are not convertible, which
   * is why absence is read rather than defaulted — reading a historical
   * percent as a fraction silently moves every bar by a factor of a hundred.
   */
  verdictPolicyVersion?: 2;
  /**
   * The v2 defaults a case inherits. FRACTIONS in [0,1], never percents;
   * a percent exists only in front of a reader.
   */
  verdictPolicyDefaults?: {
    repetitions: number;
    passThreshold: number;
    validity?: {
      minEligibleTrials?: number;
      minCompletionRate?: number;
      maxEvaluatorErrorRate?: number;
    };
  };
  _creationTime?: number; // Convex auto field
  tags?: string[];
  defaultConfig?: {
    modelId: string;
    provider?: string;
    systemPrompt: string;
    temperature: number;
  };
  /**
   * Multi-host fan-out. When non-empty, "Run all hosts" fires one run per
   * attachment with that host's snapshot. Server names are resolved at
   * read time so the UI doesn't have to fetch each host's config to fan
   * out. Legacy suites (no attachments) keep the flat `environment.servers`
   * path.
   */
  hostAttachments?: Array<{
    namedHostId: string;
    enabledOptionalServerIds: string[];
    hostName: string | null;
    resolvedServerNames: string[];
  }>;
  /**
   * Snapshot pointer to a `serverAttachment` row of scope 'standalone'
   * — a named, project-scoped, frozen server selection. When present,
   * the suite's run-time resolver uses the row's `selectedServerIds`
   * for ALL attached hosts (bypassing per-attachment server picks).
   * Editing the project pool does NOT propagate; to change the
   * selection, create a new attachment and re-point the suite.
   */
  serverAttachmentId?: string;
  /** Hydrated by the backend resolver when serverAttachmentId is set. */
  serverAttachment?: EvalServerAttachment;
  /**
   * Attach-ordered project environments (`projectEnvironments` docs). When
   * non-empty, Run all fans out ONE run per environment (replacing
   * hostAttachments as the fan-out axis — env pointers win over the legacy
   * host/server pointers above). The backend resolves each environment at
   * run start; the client never derives servers from these ids.
   */
  environmentIds?: string[];
  /**
   * Epoch ms of the schedule's next due firing, or absent when nothing is due.
   * Denormalized on the suite by the scheduler; never computed client-side.
   */
  scheduleNextDueAt?: number;
  /** Synthetic-monitor schedule; absent ⇒ never scheduled. */
  schedule?: {
    intervalMinutes: number;
    enabled: boolean;
    state: "active" | "paused_quota" | "paused_auth" | "paused_failures";
    consecutiveFailures?: number;
    /**
     * The user a scheduled run executes AS. Its runs spend this person's
     * access, and the schedule pauses itself (`paused_auth`) when they lose
     * it — which is why the settings row names them rather than reporting a
     * boolean.
     */
    createdByUserId?: string;
    /**
     * Multi-environment suites pin the schedule to ONE member environment
     * (required by `setSuiteSchedule`); single-env suites may omit it and
     * the run-start default applies.
     */
    environmentId?: string;
  };
};

export type EvalServerAttachment = {
  _id: string;
  name: string;
  serverIds: string[];
  resolvedServerNames: string[];
};

export type EvalCase = {
  _id: string;
  testSuiteId: string;
  createdBy: string;
  projectId?: string;
  caseKey?: string;
  title: string;
  query: string;
  models: Array<{
    model: string;
    provider: string;
  }>;
  runs: number;
  expectedToolCalls: Array<{
    toolName: string;
    arguments: Record<string, any>;
  }>;
  isNegativeTest?: boolean; // When true, test passes if NO tools are called
  scenario?: string; // Description of why app should NOT trigger (negative tests only)
  expectedOutput?: string; // The output or experience expected from the MCP server
  /**
   * Unified authored test steps — the source of truth for execution and the
   * "is this a render check?" detection (`isModelFree(steps)`). Replaces the
   * legacy `promptTurns`/`caseType`/`probeConfig`, which the Convex mutations
   * now reject. The legacy fields linger only as read-time fallbacks while
   * pre-migration rows are converted.
   */
  steps?: TestStep[];
  promptTurns?: PromptTurn[];
  advancedConfig?: Record<string, unknown>;
  /** Case-level validator override; merged on top of suite defaults. */
  matchOptions?: EvalMatchOptions;
  /**
   * Case-level predicate gate override. Three explicit modes (`inherit`,
   * `replace`, `extend`) eliminate the predicates / additionalPredicates
   * ambiguity (Phase 2 plan). `undefined` is treated as
   * `{ mode: "inherit", list: [] }`.
   */
  predicates?: CasePredicates;
  /**
   * Per-case judge override. V1 carries opt-out only — no alt model or
   * threshold (see backend `convex/lib/judgeConfig.ts` for rationale).
   */
  judgeConfigOverride?: EvalJudgeConfigOverride;
  /** Case kind; absent ⇒ prompt case. */
  caseType?: import("@/shared/probe-config").TestCaseType;
  /** Pinned tool call for widget_probe cases. */
  probeConfig?: import("@/shared/probe-config").ProbeConfig;
  lastMessageRun?: string | null;
  /**
   * Epoch ms of the last SDK-ingest write to this case's definition.
   * Present ⇒ the case is synced from CI and manual edits may be
   * overwritten by the next CI report.
   */
  lastSdkWriteAt?: number;
  /**
   * The converter's CLAIM about this case, when it was imported rather than
   * authored here. ABSENT means natively authored, which is a different fact
   * from "imported, faithfulness unknown".
   */
  import?: EvalCaseImportClaim;
  _creationTime?: number; // Convex auto field
};

export type EvalIteration = {
  _id: string;
  testCaseId?: string;
  projectId?: string;
  testCaseSnapshot?: {
    caseKey?: string;
    title: string;
    query: string;
    provider: string;
    model: string;
    runs?: number;
    expectedToolCalls: Array<{
      toolName: string;
      arguments: Record<string, any>;
    }>;
    isNegativeTest?: boolean; // When true, test passes if NO tools are called
    scenario?: string; // Description of why app should NOT trigger (negative tests only)
    expectedOutput?: string; // The output or experience expected from the MCP server
    /**
     * Unified authored test steps frozen at run-precreate time. The snapshot
     * now carries `steps` (not `promptTurns`); run-detail readers convert via
     * `stepsToPromptTurns(steps)` for legacy turn-shaped display. `promptTurns`
     * remains only as a read-time fallback for pre-migration iterations.
     */
    steps?: TestStep[];
    promptTurns?: PromptTurn[];
    advancedConfig?: Record<string, unknown>;
    /** Effective validator options used for this iteration's pass/fail. */
    matchOptions?: EvalMatchOptions;
    /**
     * Effective deterministic predicate gate frozen at run-precreate time.
     * Resolved from suite `defaultPredicates` + the case `predicates`
     * envelope; matches the contract documented on
     * {@link EvalTestSuite.defaultPredicates}. Without this field, run-detail
     * UIs silently fall through to live suite/case state instead of the
     * snapshot the iteration was actually evaluated against.
     */
    predicates?: Predicate[];
    /**
     * Case kind frozen at run-precreate time. Absent ⇒ prompt case. Probe
     * iterations carry display-only model/provider sentinels
     * ('none'/'widget-probe') in this snapshot.
     */
    caseType?: import("@/shared/probe-config").TestCaseType;
    /** Pinned probe call, snapshotted for replay stability. */
    probeConfig?: import("@/shared/probe-config").ProbeConfig;
  };
  suiteRunId?: string;
  /** How the iteration was triggered, stamped at creation by the backend.
   *  Absent on legacy rows → readers fall back to the `suiteRunId` heuristic. */
  trigger?: "quick" | "suite" | "replay";
  configRevision?: string;
  createdBy: string;
  createdAt: number;
  startedAt?: number;
  iterationNumber: number;
  updatedAt: number;
  blob?: string;
  /**
   * PR-4 R6: present on iterations whose transcript was written via the
   * unified chatSessions path (eval→chatSessions writer flag on).
   * Trace-repair candidate selection considers iterations with either
   * `blob` or `chatSessionId` as trace-bearing — both source paths feed
   * the source-aware `getTestIterationBlob` action.
   */
  chatSessionId?: string;
  /**
   * PR-4 R6: set when the inspector's fanout-failure fallback flipped
   * the iteration to legacy-only reads. Doesn't change trace-repair
   * eligibility — readers still get a usable transcript via
   * `getTestIterationBlob` regardless of which source feeds it.
   */
  preferLegacyBlob?: boolean;
  /**
   * LIFECYCLE, not verdict: how far the trial got, never how it graded. A
   * trial that ran and graded badly is `completed` with `result: "failed"`.
   * `setup_failed` (the environment never came up) and `skipped` (deliberately
   * not run) are the two an older deployment cannot emit.
   */
  status:
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "timed_out"
    | "setup_failed"
    | "skipped";
  result: "pending" | "passed" | "failed" | "cancelled" | "timed_out";
  actualToolCalls: Array<{
    toolName: string;
    arguments: Record<string, any>;
  }>;
  tokensUsed: number;
  error?: string;
  errorDetails?: string;
  resultSource?: "reported" | "derived";
  externalIterationId?: string;
  // Widened to `unknown` because the backend metadata column now round-trips
  // non-scalar entries — specifically `predicates: PredicateResult[]` from the
  // state-based eval gate. Existing readers (turnCount, firstFailedTurnIndex,
  // compareRunId, mismatchCount…) already runtime-check via `typeof`, so the
  // wider type is backwards-compatible. Per-key parsers live next to their
  // call sites; see `predicates-list.tsx` for the predicates parser.
  metadata?: Record<string, unknown>;
  _creationTime?: number; // Convex auto field
};

export type CompareModelOverride = {
  systemPrompt?: string;
  temperature?: string;
  providerFlagsJson?: string;
};

export type EditorMode = "config" | "run";

/** Compare run column trace mode — same values as TraceViewer view modes. */
export type RunColumnTab =
  | "timeline"
  | "chat"
  | "raw"
  | "tools"
  | "browser"
  | "steps";

export type CompareRunRecord = {
  modelValue: string;
  modelLabel: string;
  provider: string;
  model: string;
  status:
    | "idle"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "timed_out"
    | "setup_failed"
    | "skipped";
  /**
   * When `status === "running"` and there is no iteration yet, true if this run
   * replaces a prior completed/failed attempt (user hit Retry or re-ran compare).
   */
  isRetrying?: boolean;
  iteration: EvalIteration | null;
  error?: string | null;
  startedAt: number | null;
  completedAt: number | null;
  result:
    | "pending"
    | "passed"
    | "failed"
    | "cancelled"
    | "timed_out"
    | "setup_failed"
    | "skipped"
    | null;
  metrics: {
    durationMs: number | null;
    toolCallCount: number;
    tokensUsed: number;
    missingCount: number | null;
    unexpectedCount: number | null;
    argumentMismatchCount: number | null;
    mismatchCount: number | null;
  };
  /** Immediate chat preview shown before the first live stream event arrives. */
  previewTrace?: TraceEnvelope | null;
  /**
   * Expected tool calls captured from the in-memory form at run-start time.
   * Preferred over the persisted testCase snapshot until an iteration snapshot
   * arrives, so unsaved edits (e.g. adding tools before saving) are reflected
   * immediately in showToolsTab and the pre-stream Results preview.
   */
  previewExpectedToolCalls?: PromptTurnToolCall[] | null;
  /** Stable step-complete trace snapshots populated during streaming. */
  streamingTrace?: EvalTraceBlobV1;
  /** In-flight messages collected after the last authoritative snapshot. */
  streamingDraftMessages?: TraceMessage[];
  /**
   * Live browser frames from the headless-Chromium harness, projected onto the
   * persisted step-view shape. Merged into the streaming trace envelope as
   * `browserInteractionSteps` so the Replay filmstrip fills in while the run is
   * still going.
   */
  streamingLiveBrowserSteps?: EvalTraceBrowserInteractionStepView[];
  /**
   * Highest live-frame `sequence` accepted, carried alongside the steps so the
   * reducer's monotonic guard survives being rebuilt from this record on every
   * event (otherwise every frame would look like the first one).
   */
  streamingLiveBrowserFrameSequence?: number;
  /** Live actual tool calls collected from streamed snapshots. */
  streamingActualToolCalls?: EvalStreamToolCall[];
  /** Live metrics from stream events. */
  streamingMetrics?: {
    tokensUsed: number;
    toolCallCount: number;
  };
  /**
   * Live per-step lifecycle status keyed by `stepStatusKey` (turn granularity
   * in v1). Populated from `step_status` stream events; drives the left-pane
   * step-card "ticking" during a quick run.
   */
  streamingStepStatus?: Record<string, EvalStepStatusEntry>;
};

/**
 * A policy-2 verdict as the backend decided it.
 *
 * Deliberately shallow: the client renders reasons and denominators and must
 * not re-derive the verdict, so only the fields the UI displays are named and
 * the rest of the contract shape rides along untyped.
 */
export type EvalRunVerdictSummary = {
  verdict?: "passed" | "failed" | "inconclusive";
  reasons?: string[];
  validity?: {
    valid?: boolean;
    eligibleTrials?: number;
    attemptedTrials?: number;
    configuredTrials?: number;
    completionRate?: number | null;
    evaluatorErrorRate?: number | null;
    notMeasured?: boolean;
  } & Record<string, unknown>;
} & Record<string, unknown>;

export type EvalSuiteRunSummary = {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  policyBlockedIterations?: number;
};

export type EvalSuiteRun = {
  /**
   * Whether this run's imported cases carry evidence a gate may rely on.
   *
   * Served by the CANONICAL selected-run queries (`getTestSuiteRun` /
   * `getTestSuiteRunDetails`), not by the run LIST projection — so a list row
   * legitimately has none, and absence here must never be rendered as
   * `legacy`. Absent also on a deployment that predates the projection.
   */
  importEligibility?: ImportEligibility;
  _id: string;
  suiteId: string;
  createdBy: string;
  projectId?: string;
  runNumber: number;
  configRevision: string;
  configSnapshot: {
    tests: EvalSuiteConfigTest[];
    environment: {
      servers: string[];
      serverBindings?: Array<{
        serverName: string;
        projectServerId?: string;
      }>;
      computerEnvironmentId?: string;
    };
    /**
     * Frozen reproducible-env pin for this run: the exact built image each
     * iteration's sandbox launched from. Surfaced in run-detail so users can
     * see which environment a run used (and spot mismatches when comparing).
     */
    computerEnvironment?: {
      environmentId: string;
      environmentBuildId: string;
      e2bTemplateId: string;
      e2bBuildId?: string;
      baseImageDigests: string[];
      provider: "e2b" | "stub";
    };
    /**
     * Project-environment provenance: the environment this run resolved at
     * start, frozen with the revision it resolved. Drives the run-detail
     * "Environment" chip (name + rev). Distinct from `computerEnvironment`
     * above, which is the sandbox-image pin ("Sandbox image" chip).
     */
    environmentRef?: {
      environmentId: string;
      name: string;
      revision: number;
    };
    /** The environment's standalone server-group pointer at resolve time. */
    environmentServerAttachmentId?: string;
    /**
     * Plugin provenance for this run (BE-5): identity + `bundleHash` of every
     * plugin version the environment pinned, in pin order.
     *
     * EXACT AND IMMUTABLE. It records which bundles executed, so nothing may
     * re-resolve it to the plugin's current active version — that is the whole
     * reason a re-import cannot change what an in-flight run or a replay means.
     * It is provenance, not a restorable pin: no surface may offer to "restore"
     * these versions, or the ephemeral Playground override becomes persistent
     * through the back door.
     *
     * Absent on a legacy run, a plugin-free environment, or a pre-BE-5 backend.
     */
    environmentPluginVersions?: Array<{
      pluginId: string;
      pluginVersionId: string;
      name: string;
      bundleHash: string;
    }>;
    /**
     * The servers those versions materialized at launch — the suite twin of a
     * journey target's `pluginServerIds`. Cross-checked at execution, never
     * trusted: a recorded id the live resolution no longer contributes fails
     * the run rather than silently shrinking it.
     */
    environmentPluginServerIds?: string[];
    /**
     * This run is the "without skills" arm of an A/B compare: no skills were
     * pinned from ANY channel (host, environment, or plugin).
     *
     * Worth showing, because a skill-less run and a run whose skills failed to
     * load look identical in the transcript. Note the deliberate backend
     * asymmetry — the arm drops plugin SKILLS, not plugin SERVERS, so
     * `environmentPluginVersions` above is still populated for it.
     */
    skillsExcluded?: boolean;
    /**
     * Suite-level judge config snapshotted at run-create. The run-detail
     * card reads `modelUsed` / `threshold` from here when displaying the
     * judge config, so a config edit after the run started doesn't
     * silently re-render in-flight scoring with new values.
     */
    judgeConfig?: EvalJudgeConfig;
  };
  status:
    | "pending"
    | "running"
    /**
     * Every trial finished; the run is HELD for its gating judge, up to 30
     * minutes. NOT terminal, and `result` is still `"pending"` — only the
     * backend's `finalizeAfterJudge` moves it on. Anything that treats this as
     * done reports a run with no verdict as though it had one.
     */
    | "grading"
    | "completed"
    | "failed"
    | "cancelled"
    | "timed_out";
  summary?: EvalSuiteRunSummary;
  passCriteria?: {
    minimumPassRate: number;
  };
  /** One-off validator override applied to all iterations in this run. */
  matchOptionsOverride?: EvalMatchOptions;
  /**
   * Per-run judge override from the "⚙ Override for this run" disclosure.
   * Cleared (whole field wiped) when the user re-runs the judge without
   * re-confirming the override.
   */
  judgeConfigOverride?: EvalJudgeRunOverride;
  result?:
    | "pending"
    | "passed"
    | "failed"
    | "cancelled"
    | "timed_out"
    /**
     * Verdict policy 2 only: the run could not be measured well enough to
     * decide (too few gradeable trials, too many evaluator errors). NOT a
     * failure — folding it into `failed` reports a defect nothing observed —
     * and excluded from pass/fail metrics rather than counted on either side.
     */
    | "inconclusive";
  /**
   * The verdict policy this run was decided under, frozen at run start.
   * Absent means legacy percent grading, where `inconclusive` cannot occur
   * and there is no `verdictSummary`.
   */
  verdictPolicyVersion?: 2;
  /**
   * The backend's decision record: resolved validity policy, measured rates
   * with their denominators and exclusions, per-case and per-variant
   * aggregates, and the exact reasons. Displayed, never recomputed — a second
   * client-side derivation would disagree with the gate that already ran.
   * Absent when the stored summary failed contract validation at the API
   * boundary, because a partially-valid decision is not evidence.
   */
  verdictSummary?: EvalRunVerdictSummary;
  /** Why a policy-2 run could not be decided from its own evidence. */
  verdictPolicyIntegrityError?: string;
  stoppedAt?: number;
  stopReason?:
    | "user_cancelled"
    | "run_timeout"
    | "iteration_timeout"
    | "stale_worker";
  source?: "ui" | "sdk" | "api" | "schedule" | "github_check";
  replayedFromRunId?: string;
  /** Set when this run was created by the Auto fix suite replay step. */
  traceRepairJobId?: string;
  hasServerReplayConfig?: boolean;
  externalRunId?: string;
  framework?: string;
  ciMetadata?: {
    provider?: string;
    pipelineId?: string;
    jobId?: string;
    runUrl?: string;
    branch?: string;
    commitSha?: string;
  };
  notes?: string;
  createdAt: number;
  completedAt?: number;
  /** Legacy field from Convex; no longer used for UI gating or trends. */
  isActive?: boolean;
  expectedIterations?: number;
  /**
   * The named host this run was triggered against, when the suite has
   * host attachments. Absent for legacy single-environment runs. Used by
   * the run list / run-detail UI to group concurrent host fan-out into a
   * "host matrix" view.
   */
  namedHostId?: string;
  /**
   * Client-generated UUID shared by every per-host run from the same
   * multi-host eval launch. The UI groups runs by this id; runs without
   * a `runGroupId` (legacy or single-host launches) render as standalone
   * rows. Set client-side at fan-out and persisted on `testSuiteRun`.
   */
  runGroupId?: string;
  /**
   * Model the run actually executed with, persisted at launch (Phase 1).
   * Absent on pre-attribution rows — fall back to the env join.
   */
  effectiveModelId?: string;
  /** `"client_default"` inherited the host model; `"override"` used env.modelId. */
  modelSource?: "client_default" | "override";
  _creationTime?: number;
  runInsightsJobId?: number;
  runInsightsStatus?: "pending" | "completed" | "failed";
  runInsights?: {
    summary: string;
    generatedAt: number;
    modelUsed: string;
    baselineRunId?: string;
    toolSnapshotHash?: string;
    caseInsights: Array<{
      caseKey: string;
      testCaseId?: string;
      title: string;
      status:
        | "new_failure"
        | "still_failing"
        | "fixed"
        | "new_case"
        | "removed_case";
      summary: string;
    }>;
  };
  serverQualityJobId?: string;
  serverQualityStatus?: "pending" | "completed" | "failed";
  serverQuality?: {
    summary: string;
    generatedAt: number;
    modelUsed: string;
    /**
     * Host identity this run executed against. Mirrors the Convex
     * `insightHostSnapshotValidator`. Optional — legacy runs and
     * failed/cancelled saves omit it.
     */
    host?: InsightHostSnapshot;
    toolInsights: Array<{
      toolName: string;
      rating: "good" | "needs_improvement" | "poor";
      issues: string[];
      suggestions: string[];
      /** Pattern slug the violation maps to. Allowlist-validated server-side. */
      patternSlug?: string;
      /** PR-B auditability metadata (optional; populated by the judge). */
      evidence?: string[];
      confidence?: "low" | "medium" | "high";
      attribution?:
        | "server_design"
        | "agent_behavior"
        | "test_design"
        | "unknown";
    }>;
    workflowInsights: Array<{
      caseKey: string;
      title: string;
      toolCallCount: number;
      optimalCallCount?: number;
      efficiency: "optimal" | "acceptable" | "inefficient" | "excessive";
      issues: string[];
      suggestions: string[];
      /** Pattern slug the violation maps to. Allowlist-validated server-side. */
      patternSlug?: string;
      /** PR-B auditability metadata (optional; populated by the judge). */
      evidence?: string[];
      confidence?: "low" | "medium" | "high";
      attribution?:
        | "server_design"
        | "agent_behavior"
        | "test_design"
        | "unknown";
    }>;
  };
  // Goal-completion judge (advisory LLM-as-judge): grades each case's final
  // answer against its expectedOutput. Mirrors the Convex `v.object` by hand.
  // Advisory only — never changes the run's deterministic `passed`/`result`.
  goalCompletionJobId?: string;
  goalCompletionStatus?: "pending" | "completed" | "failed";
  goalCompletion?: {
    summary: string;
    generatedAt: number;
    /** The judge model actually used for this run. */
    modelUsed: string;
    /** Per-run advisory pass threshold (`passed = score >= threshold`). */
    threshold: number;
    cases: Array<{
      caseKey: string;
      /**
       * The case AND ITS REPETITION — `${caseKey}#${iterationNumber}` — which
       * is the only key that identifies one trial under verdict policy v2. A
       * join on `caseKey` alone is ambiguous the moment a case runs more than
       * once, and it silently attributes one trial's verdict to another.
       * Absent on runs judged before the key existed.
       */
      gradingKey?: string;
      /** The trial this verdict graded, when the backend resolved one. */
      iterationId?: string;
      /** How fully the final answer satisfied expectedOutput, in [0,1]. */
      score: number;
      /** Advisory pass = score >= threshold. Does NOT gate the run. */
      passed: boolean;
      reason: string;
      rubricHits: string[];
      /**
       * Whether the judge actually ANSWERED. An `error` or `skipped` case
       * carries a score the judge did not produce from evidence, so it is a
       * non-answer rather than a low grade.
       */
      status?: "scored" | "error" | "skipped";
      /** The rubric this verdict was graded against. */
      rubricHash?: string;
      rubricSource?: "expected_output" | "assertions" | "suite_criteria";
    }>;
  };
  // Groundedness judge (second named advisory judge): grades whether each
  // case's final answer is SUPPORTED by its tool trajectory — a different
  // question from goal completion. Mirrors the Convex `v.object` by hand.
  // Advisory only — never changes the run's deterministic `passed`/`result`.
  groundednessJobId?: string;
  groundednessStatus?: "pending" | "completed" | "failed";
  groundedness?: {
    summary: string;
    generatedAt: number;
    modelUsed: string;
    threshold: number;
    cases: Array<{
      caseKey: string;
      /** Fraction of load-bearing claims the trajectory supports, in [0,1]. */
      score: number;
      passed: boolean;
      reason: string;
      /** The specific claims the trajectory does not support. */
      unsupportedClaims: string[];
    }>;
  };
};

export type EvalRunNumericDiff = {
  base: number | null;
  compare: number | null;
  delta: number | null;
  percentDelta: number | null;
};

export type EvalRunTextPreview = {
  text: string;
  truncated: boolean;
};

export type EvalRunDiffCaseStatus =
  | "unchanged_passed"
  | "unchanged_failed"
  | "regressed"
  | "fixed"
  | "new_case"
  | "removed_case"
  | "changed";

export type EvalRunDiffSide = {
  outcome: "passed" | "failed" | "absent";
  iterationIds: string[];
  representativeIterationId: string | null;
  traceBlobIds: string[];
  input: EvalRunTextPreview | null;
  output: EvalRunTextPreview | null;
  expectedToolCalls: Array<{
    toolName: string;
    arguments: unknown;
  }>;
  actualToolCalls: Array<{
    toolName: string;
    arguments: unknown;
  }>;
  error: string | null;
  metrics: {
    durationMs: number | null;
    totalTokens: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cachedInputTokens: number | null;
    reasoningTokens: number | null;
    estimatedCostUsd: number | null;
  };
};

/** Delivery channel a pinned skill reached the run through. */
export type EvalRunSkillChannel =
  | "host"
  | "environment"
  | "plugin"
  | "mcp-server";

/** One skill's identity + content fingerprint on one side of a comparison. */
export type EvalRunSkillSide = {
  contentHash: string;
  /** Complete-artifact hash; present only when supporting files diverge it. */
  aggregateHash?: string;
  /** Authored-skill revision, when the run recorded one. */
  versionNumber?: number;
  /** MCP-captured revision, when the run recorded one. */
  serverSkillVersionNumber?: number;
};

export type EvalRunSkillChange = {
  key: string;
  name: string;
  modelRef?: string;
  channels: EvalRunSkillChannel[];
  kind: "added" | "removed" | "changed";
  /** The skill was renamed between the runs; ids still matched it as one skill. */
  renamedFrom?: string;
  base?: EvalRunSkillSide;
  compare?: EvalRunSkillSide;
  /** `v3 → v4`, present only when BOTH sides recorded a revision number. */
  versionDelta?: string;
};

/**
 * Which skills changed between two runs — the configuration attribution that
 * usually explains the case-level regressions next to it.
 *
 * `null` (not an empty section) when neither run recorded pinned skills:
 * rendering "no skills changed" for two legacy runs would be a claim nobody
 * verified.
 */
export type EvalRunSkillDiff = {
  base: { excluded: boolean; count: number };
  compare: { excluded: boolean; count: number };
  /** Added / removed / changed only, changed first. Unchanged are counted. */
  changes: EvalRunSkillChange[];
  unchangedCount: number;
};

export type EvalRunDiff = {
  suite: {
    id: string;
    name: string;
    source?: "ui" | "sdk";
  };
  baseRun: {
    id: string;
    runNumber: number;
    source: "ui" | "sdk" | null;
    framework: string | null;
    createdAt: number;
    completedAt: number | null;
    result?: "pending" | "passed" | "failed" | "cancelled";
    summary: EvalSuiteRunSummary | null;
  };
  compareRun: {
    id: string;
    runNumber: number;
    source: "ui" | "sdk" | null;
    framework: string | null;
    createdAt: number;
    completedAt: number | null;
    result?: "pending" | "passed" | "failed" | "cancelled";
    summary: EvalSuiteRunSummary | null;
  };
  metrics: {
    startOffsetMs: EvalRunNumericDiff;
    wallDurationMs: EvalRunNumericDiff;
    totalTokens: EvalRunNumericDiff;
    inputTokens: EvalRunNumericDiff;
    outputTokens: EvalRunNumericDiff;
    cachedInputTokens: EvalRunNumericDiff;
    reasoningTokens: EvalRunNumericDiff;
    estimatedCostUsd: EvalRunNumericDiff;
  };
  scores: {
    passRatePercent: EvalRunNumericDiff;
    total: EvalRunNumericDiff;
    passed: EvalRunNumericDiff;
    failed: EvalRunNumericDiff;
  };
  /** See {@link EvalRunSkillDiff}. Absent on responses from an older backend. */
  skills?: EvalRunSkillDiff | null;
  cases: Array<{
    caseKey: string;
    title: string;
    testCaseId: string | null;
    status: EvalRunDiffCaseStatus;
    configChanged: boolean;
    base: EvalRunDiffSide;
    compare: EvalRunDiffSide;
    metrics: {
      durationMs: EvalRunNumericDiff;
      totalTokens: EvalRunNumericDiff;
      inputTokens: EvalRunNumericDiff;
      outputTokens: EvalRunNumericDiff;
      cachedInputTokens: EvalRunNumericDiff;
      reasoningTokens: EvalRunNumericDiff;
      estimatedCostUsd: EvalRunNumericDiff;
    };
  }>;
};

export type EvalRefinementSession = {
  _id: string;
  status: "pending_candidate" | "ready" | "verifying" | "completed" | "failed";
  outcome?: "improved_test" | "still_ambiguous" | "server_likely";
  failureSignature?: string;
  testWeaknessHypothesis?: string;
  serverHypothesis?: string;
  confidenceChecklist?: string[];
  candidateParaphraseQuery?: string;
  verificationRuns: Array<{
    label: string;
    iterationId?: string;
    provider: string;
    model: string;
    query: string;
    passed: boolean;
    failureSignature?: string;
  }>;
  attributionSummary?: string;
  promotedAt?: number;
  updatedAt: number;
  baseSnapshot?: {
    caseKey?: string;
    title: string;
    query: string;
    runs: number;
    models: Array<{ model: string; provider: string }>;
    expectedToolCalls: Array<{
      toolName: string;
      arguments: Record<string, any>;
    }>;
    isNegativeTest?: boolean;
    scenario?: string;
    expectedOutput?: string;
    advancedConfig?: Record<string, unknown>;
  };
  candidateSnapshot?: {
    caseKey?: string;
    title: string;
    query: string;
    runs: number;
    models: Array<{ model: string; provider: string }>;
    expectedToolCalls: Array<{
      toolName: string;
      arguments: Record<string, any>;
    }>;
    isNegativeTest?: boolean;
    scenario?: string;
    expectedOutput?: string;
    advancedConfig?: Record<string, unknown>;
  };
};

export type EvalRunRefinementCase = {
  sourceIterationId: string;
  testCaseId?: string;
  caseKey: string;
  title: string;
  query: string;
  failureSignature?: string;
  failureStreak: number;
  session: EvalRefinementSession | null;
};

export type EvalSuiteOverviewEntry = {
  suite: EvalSuite;
  latestRun: EvalSuiteRun | null;
  recentRuns: EvalSuiteRun[];
  passRateTrend: number[];
  totals: {
    passed: number;
    failed: number;
    runs: number;
  };
};

export type SuiteAggregate = {
  filteredIterations: EvalIteration[];
  totals: {
    passed: number;
    failed: number;
    cancelled: number;
    pending: number;
    tokens: number;
  };
  byCase: Array<{
    testCaseId: string;
    title: string;
    provider: string;
    model: string;
    runs: number;
    passed: number;
    failed: number;
    cancelled: number;
    tokens: number;
  }>;
};

// Query response types for Convex queries
export type SuiteDetailsQueryResponse = {
  testCases: EvalCase[];
  iterations: EvalIteration[];
};

export type TagGroupAggregate = {
  tag: string;
  suiteCount: number;
  totals: { passed: number; failed: number; runs: number };
  passRate: number; // 0-100
  entries: EvalSuiteOverviewEntry[];
};

export type CommitGroup = {
  commitSha: string;
  shortSha: string; // first 7 chars
  branch: string | null;
  timestamp: number; // most recent run time
  /**
   * `inconclusive` is the verdict-policy-2 outcome: the commit's runs were
   * decided by nobody, so the group is neither green nor red. Without it a
   * commit whose every run was unmeasurable falls through the pass/fail counts
   * and renders as "All runs passed".
   */
  status: "passed" | "failed" | "running" | "mixed" | "inconclusive";
  runs: EvalSuiteRun[];
  suiteMap: Map<string, string>; // suiteId → suite name
  summary: {
    total: number;
    passed: number;
    failed: number;
    running: number;
    inconclusive: number;
  };
};
