import type {
  EvalExpectedToolCall,
  EvalTraceInput,
} from "@mcpjam/evaluators/internal/eval-reporting-types";
export type {
  EvalExpectedToolCall,
  EvalTraceSpanCategory,
  EvalTraceSpanStatus,
  EvalTraceSpanInput,
  EvalTraceInput,
} from "@mcpjam/evaluators/internal/eval-reporting-types";
import type { MCPClientManager } from "./mcp-client-manager/MCPClientManager.js";
import type { EvalMatchOptions } from "./matchers.js";
import type { IterationStatus } from "./contract/chain.js";
import type { EvalSuiteFileValidity } from "./contract/suite-file.js";
import type {
  EvalExecutionVariant,
  EvalVerdictDecision,
  EvalVerdictPolicyVersion,
} from "./contract/verdict-policy.js";

export type EvalCiMetadata = {
  provider?: string;
  pipelineId?: string;
  jobId?: string;
  runUrl?: string;
  repositoryUrl?: string;
  prUrl?: string;
  branchUrl?: string;
  branch?: string;
  commitSha?: string;
  dirty?: boolean;
  pullRequestNumber?: number;
};

export type EvalWidgetCsp = {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
};

export type EvalWidgetPermissions = {
  camera?: Record<string, never>;
  microphone?: Record<string, never>;
  geolocation?: Record<string, never>;
  clipboardWrite?: Record<string, never>;
};

export type EvalWidgetSnapshotInput = {
  toolCallId: string;
  toolName: string;
  protocol: "mcp-apps";
  serverId: string;
  resourceUri: string;
  toolMetadata: Record<string, unknown>;
  widgetCsp: EvalWidgetCsp | null;
  widgetPermissions: EvalWidgetPermissions | null;
  widgetPermissive: boolean;
  prefersBorder: boolean;
  widgetHtml?: string;
  widgetHtmlBlobId?: string;
  injectedOpenAiCompat?: boolean;
};

export type EvalResultInput = {
  caseTitle: string;
  query?: string;
  passed: boolean;
  durationMs?: number;
  provider?: string;
  model?: string;
  expectedToolCalls?: EvalExpectedToolCall[];
  actualToolCalls?: EvalExpectedToolCall[];
  tokens?: { input?: number; output?: number; total?: number };
  error?: string;
  errorDetails?: string;
  trace?: EvalTraceInput;
  externalIterationId?: string;
  externalCaseId?: string;
  /**
   * The case's DECLARED identity (`EvalTestConfig.id`) — the id an author
   * committed beside the test.
   *
   * The backend resolves by this first (`by_testSuite_declaredCaseId`), falling
   * back to the content-hash key, and ADOPTS: an id-bearing upload that resolves
   * by hash to a case with no declared id patches the id on without touching the
   * immutable `caseKey`. That is what lets a renamed test keep its history.
   *
   * Must equal `externalCaseId` when both are present — the SDK enforces that at
   * construction and the backend rejects a mismatch at ingest. Never a silent
   * precedence between two identity claims.
   */
  caseId?: string;
  /**
   * The authored analytics grouping label for this case. `null` explicitly
   * records an unlabelled modern producer; omission remains legacy-compatible.
   */
  intent?: string | null;
  /**
   * This trial's LIFECYCLE status — what happened to the execution, which is a
   * different question from `passed` (the task verdict).
   *
   * A graded failure is `completed` + `passed: false`: the trial ran, and the
   * server under test failed it. `failed` means the EXECUTION failed,
   * `setup_failed` that the environment never came up, `skipped` that the trial
   * was deliberately not run, `timed_out`/`cancelled` that it was stopped.
   * `pending`/`running` are non-terminal and rejected at ingest — a finished
   * trial cannot describe itself as still going.
   *
   * Optional ONLY for the legacy wire: a reporter that predates the verdict
   * policy omits it and the backend's named compatibility adapter derives a
   * status from the presence of an execution error (never from `passed`). Every
   * v2 report sends it.
   */
  status?: IterationStatus;
  /** Extensible per-iteration metadata; predicate verdicts are nested here. */
  metadata?: Record<string, unknown>;
  isNegativeTest?: boolean;
  /** Reference output for judge scorers; emitted by the result mappers. */
  expectedOutput?: string;
  advancedConfig?: Record<string, unknown>;
  widgetSnapshots?: EvalWidgetSnapshotInput[];
  /**
   * Per-result match options. When present, the inspector snapshots
   * these onto the appended iteration's `testCaseSnapshot.matchOptions`
   * so historical pass/fail computation honors them.
   */
  matchOptions?: EvalMatchOptions;
};

export type MCPServerReplayConfig = {
  serverId: string;
  url: string;
  preferSSE?: boolean;
  accessToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
};

export interface SelectedEvalClient {
  id: string;
  name: string;
  configId: string;
  versionId: string;
  versionNumber: number;
}

export type MCPJamReportingConfig = {
  /** Saved client selected at the beginning of this run. */
  selectedClient?: SelectedEvalClient;
  /** Explicitly end a partial run without certifying its incomplete population. Requires target termination support. */
  terminalStatus?: "cancelled" | "timed_out";
  enabled?: boolean;
  /** Local transport controls; never included in the reporting payload. */
  transport?: {
    signal?: AbortSignal;
    timeoutMs?: number;
    /** Budget for one HTTP request including retries/body; each chunk has its own budget. */
    operationTimeoutMs?: number;
    maxResponseBytes?: number;
    maxRequestBytes?: number;
    maxArtifactBytes?: number;
  };
  apiKey?: string;
  baseUrl?: string;
  /**
   * MCPJam project id results are filed under (`MCPJAM_PROJECT_ID` env var
   * works too). Defaults to the API key org's Default project.
   */
  project?: string;
  /** Defaults to server IDs from resolved replay configs; pass [] to opt out. */
  serverNames?: string[];
  serverReplayConfigs?: MCPServerReplayConfig[];
  suiteName?: string;
  suiteDescription?: string;
  notes?: string;
  passCriteria?: {
    minimumPassRate: number;
  };
  strict?: boolean;
  /**
   * When not `false`, auto-reported results fail if the trace shows tool
   * execution errors. Default: strict tool outcomes (equivalent to `true`).
   */
  failOnToolError?: boolean;
  externalRunId?: string;
  /**
   * Links sibling runs launched together so they share a run number and group
   * in MCPJam. Set by `runWithClient` when given several clients; a
   * caller-supplied value is used as-is. 1-128 characters.
   */
  runGroupId?: string;
  framework?: string;
  /** Auto-detected when omitted. An explicit object is preserved; `{}` opts out. */
  ci?: EvalCiMetadata;
  expectedIterations?: number;
  tags?: string[];
  /** Optional advisory case-run envelopes, persisted after terminalization. */
  runEvaluations?: import("./run-evaluators.js").CaseRunEvaluation[];
  runName?: string;
  runTags?: string[];
  runMetadata?: Record<string, string | number | boolean>;
  /**
   * Host configuration that drove this eval run. Sent unconditionally: the
   * `GET /sdk/v1/info` capability probe this once negotiated through was
   * deleted, and no probe replaced it — an older backend ignores the extra
   * field rather than rejecting it. When `iteration.hostSnapshot` is present
   * (Stage 4 per-iteration capture), it takes precedence; this field is the
   * fallback for executors that don't expose `getHostSnapshot` and runs
   * without per-iteration capture. The reporter computes the content
   * hash internally — callers never set `hostConfigHash`.
   */
  host?: import("./host-config/host.js").Host;
  /**
   * `evaluationConfigHash` for this run — the digest of the scorer definitions
   * every iteration graded with.
   *
   * Sent on the run-start body so the backend can persist it on
   * `testSuiteRun` and fold it into the run fingerprint: reusing an
   * `externalRunId` with a different evaluation config is a conflict, not a
   * duplicate. Same no-probe rule as `host` above — an un-upgraded backend
   * ignores it.
   */
  evaluationConfigHash?: string;
  /**
   * Verdict-policy v2 run configuration, frozen by the backend at run start.
   *
   * PRESENT ⇒ this run is decided under `EVAL_VERDICT_POLICY_VERSION`:
   * per-case `repetitions`, FRACTIONAL `passThreshold`s in [0,1], and an
   * explicit validity policy. ABSENT ⇒ the run is decided the legacy way, by
   * suite-wide {@link MCPJamReportingConfig.passCriteria.minimumPassRate}
   * PERCENT.
   *
   * The two are never mixed: a fraction reinterpreted as a percent (or the
   * reverse) reports a verdict for a question nobody asked, so the backend
   * REFUSES a v2 request it cannot honor rather than falling back.
   */
  verdictPolicy?: EvalRunVerdictPolicyRequest;
};

/** One case's v2 policy, as declared on the run-start body. */
export type EvalRunVerdictPolicyCaseRequest = {
  /** The case's DECLARED identity — must match the results' `caseId`. */
  caseId: string;
  /**
   * The (model, provider) combinations this case runs under. Each variant owns
   * its own trials and its own aggregate, so a case that passes on one model
   * and fails on another cannot average into a single misleading verdict.
   */
  executionVariants?: EvalExecutionVariant[];
  /** Overrides the suite default; a COUNT of trials, not a rate. */
  repetitions?: number;
  /** Overrides the suite default. A FRACTION in [0,1], never a percent. */
  passThreshold?: number;
};

export type EvalRunVerdictPolicyRequest = {
  verdictPolicyVersion: EvalVerdictPolicyVersion;
  defaults: {
    repetitions: number;
    /** FRACTION in [0,1]. */
    passThreshold: number;
    /**
     * DECLARED, not resolved: an omitted `minEligibleTrials` is the
     * "every configured trial attempted" coverage rule, which is a different
     * claim from any number. The backend resolves and FREEZES it on the run.
     */
    validity?: EvalSuiteFileValidity;
  };
  cases: EvalRunVerdictPolicyCaseRequest[];
};

export type ReportEvalResultsInput = MCPJamReportingConfig & {
  suiteName: string;
  results: EvalResultInput[];
  agent?: {
    getServerReplayConfigs?: () => MCPServerReplayConfig[] | undefined;
  };
  /**
   * Optional executor surface used by Stage 5 host-config wire pickup as
   * a fallback when no per-iteration `hostSnapshot` and no
   * {@link MCPJamReportingConfig.host} were supplied. Structurally typed
   * so any object exposing `getHostSnapshot()` (e.g. `HostRunner`,
   * `HostRuntime`) qualifies — the reporter never holds a reference
   * beyond reading the snapshot.
   */
  executor?: {
    getHostSnapshot?: () =>
      import("./host-config/public-types.js").HostJson | undefined;
  };
  mcpClientManager?: MCPClientManager;
};

/** Optional evidence omitted without changing core iteration persistence. */
export type EvalReportingWarning = {
  code:
    | "RUN_METADATA_OMITTED"
    | "RUN_EVALUATIONS_OMITTED"
    | "RUN_EVALUATIONS_NOT_CONFIRMED";
  message: string;
};

export type ReportEvalResultsOutput = {
  /** Core run persisted; these optional additions were not stored or confirmed. */
  warnings?: EvalReportingWarning[];
  /** Link derived only from validated hosted identity. */
  url?: string;
  suiteId: string;
  runId: string;
  /**
   * The project the run landed in, echoed by the ingest response. Present
   * only against a backend that sends it — deliberately optional so an older
   * deployment still parses, and so the zero-config `project: "default"` case
   * (where the client never knew the id) resolves to a real one.
   *
   * Its job is the deep link: without it a printed run URL cannot carry
   * `?project=`, and the app has to guess which project to open.
   */
  projectId?: string;
  status:
    | "pending"
    | "running"
    | "grading"
    | "completed"
    | "failed"
    | "cancelled"
    | "timed_out";
  /**
   * The run's verdict.
   *
   * `inconclusive` is a v2 outcome and NOT a synonym for `failed`: it means
   * nobody could measure the run (no eligible trials, evaluator errors over
   * the policy's ceiling, evidence outside the run's frozen snapshot). A gate
   * that collapses it into `failed` reports the server under test as broken
   * when the harness was.
   */
  result: "passed" | "failed" | "inconclusive" | "pending";
  summary: {
    total: number;
    passed: number;
    failed: number;
    passRate: number;
  };
  /**
   * The policy version the backend actually decided under. ABSENT ⇒ legacy
   * suite-wide percentage aggregation, which is also what an un-upgraded
   * deployment reports.
   */
  verdictPolicyVersion?: EvalVerdictPolicyVersion;
  /**
   * The v2 decision, verbatim from the backend: per-case aggregates with their
   * eligible denominators, the validity outcome, and the exact reasons.
   *
   * Consumers RENDER this; they never recompute a verdict from it. The backend
   * decided against the run's frozen snapshot, and a client re-deriving one
   * from iteration rows can only disagree with the gate that already ran.
   */
  verdictSummary?: EvalVerdictDecision;
  /**
   * Why a v2 run could not be decided, set alongside `result: "inconclusive"`.
   */
  verdictPolicyIntegrityError?: string;
};

/** Persistence is independent of the eval verdict. Unknown acknowledgement is null. */
export type EvalReportingReceipt = {
  schemaVersion: 1;
  state: "not_requested" | "pending" | "persisted" | "failed";
  acceptedIterations: number;
  acknowledgedIterations: number | null;
  pendingIterations: number | null;
  report?: ReportEvalResultsOutput;
  warnings?: EvalReportingWarning[];
  error?: { code: string; message: string };
  reason?: "disabled" | "missing_api_key";
};
