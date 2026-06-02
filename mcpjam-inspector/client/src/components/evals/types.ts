import type { PromptTurn, PromptTurnToolCall } from "@/shared/prompt-turns";
import type { EvalTraceBlobV1 } from "@/shared/eval-trace";
import type { EvalStreamToolCall } from "@/shared/eval-stream-events";
import type {
  EvalMatchOptions,
  Predicate,
  CasePredicates,
} from "@/shared/eval-matching";
import type { TraceEnvelope, TraceMessage } from "./trace-viewer-adapter";

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
  promptTurns?: PromptTurn[];
  advancedConfig?: Record<string, unknown>;
  /** Effective validator options for this entry, resolved at run-start. */
  matchOptions?: EvalMatchOptions;
  testCaseId?: string;
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
  };
  createdAt: number;
  updatedAt: number;
  latestRunId?: string;
  source?: "ui" | "sdk";
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
   * Suite-level advisory judge configuration. Authoritative source for
   * judgeModel / threshold / enabled flag — runs snapshot this at
   * run-create time, the action reads from the snapshot, and the
   * run-detail card displays it read-only with an explicit "override
   * for this run" disclosure as the escape hatch. Hand-mirrors the
   * Convex `v.object` (no codegen for backend → inspector types).
   */
  judgeConfig?: EvalJudgeConfig;
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
  lastMessageRun?: string | null;
  _creationTime?: number; // Convex auto field
};

/**
 * Suite-level judge config envelope. Currently carries goalCompletion only;
 * the envelope shape is forward-compatible with additional judges (refusal
 * judge, future serverQuality move-here, etc.) without a second pass on
 * the type surface.
 */
export type EvalJudgeConfig = {
  goalCompletion?: {
    enabled?: boolean;
    judgeModel?: string;
    threshold?: number;
    /**
     * When true, the judge fires automatically as each run completes
     * (matches the dominant industry pattern — most eval platforms run
     * scorers inline with the eval rather than on-demand). Default off
     * so suites preserve the cost-conscious V1 behavior until they opt in.
     */
    autoRun?: boolean;
  };
};

/** Per-case judge override. Opt-out only in V1. */
export type EvalJudgeConfigOverride = {
  goalCompletion?: {
    enabled?: boolean;
  };
};

/** Per-run exploration override; persists on the run for transparency. */
export type EvalJudgeRunOverride = {
  goalCompletion?: {
    judgeModel?: string;
    threshold?: number;
  };
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
    promptTurns?: PromptTurn[];
    advancedConfig?: Record<string, unknown>;
    /** Effective validator options used for this iteration's pass/fail. */
    matchOptions?: EvalMatchOptions;
  };
  suiteRunId?: string;
  configRevision?: string;
  createdBy: string;
  createdAt: number;
  startedAt?: number;
  iterationNumber: number;
  updatedAt: number;
  blob?: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  result: "pending" | "passed" | "failed" | "cancelled";
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
export type RunColumnTab = "timeline" | "chat" | "raw" | "tools";

export type CompareRunRecord = {
  modelValue: string;
  modelLabel: string;
  provider: string;
  model: string;
  status: "idle" | "running" | "completed" | "failed" | "cancelled";
  /**
   * When `status === "running"` and there is no iteration yet, true if this run
   * replaces a prior completed/failed attempt (user hit Retry or re-ran compare).
   */
  isRetrying?: boolean;
  iteration: EvalIteration | null;
  error?: string | null;
  startedAt: number | null;
  completedAt: number | null;
  result: "pending" | "passed" | "failed" | "cancelled" | null;
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
  /** Live actual tool calls collected from streamed snapshots. */
  streamingActualToolCalls?: EvalStreamToolCall[];
  /** Live metrics from stream events. */
  streamingMetrics?: {
    tokensUsed: number;
    toolCallCount: number;
  };
};

export type EvalSuiteRunSummary = {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
};

export type EvalSuiteRun = {
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
    };
    /**
     * Suite-level judge config snapshotted at run-create. The run-detail
     * card reads `modelUsed` / `threshold` from here when displaying the
     * judge config, so a config edit after the run started doesn't
     * silently re-render in-flight scoring with new values.
     */
    judgeConfig?: EvalJudgeConfig;
  };
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
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
  result?: "pending" | "passed" | "failed" | "cancelled";
  source?: "ui" | "sdk";
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
      /** How fully the final answer satisfied expectedOutput, in [0,1]. */
      score: number;
      /** Advisory pass = score >= threshold. Does NOT gate the run. */
      passed: boolean;
      reason: string;
      rubricHits: string[];
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
  status: "passed" | "failed" | "running" | "mixed";
  runs: EvalSuiteRun[];
  suiteMap: Map<string, string>; // suiteId → suite name
  summary: { total: number; passed: number; failed: number; running: number };
};
