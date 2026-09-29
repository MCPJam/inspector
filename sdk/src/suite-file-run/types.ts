/**
 * The public shapes of `runSuiteFile`: what a caller passes in, what comes
 * back, and the progress events in between.
 *
 * Built from the SDK's existing types — server configs, the v2 verdict
 * decision, tool-policy snapshots, iteration statuses — rather than parallel
 * copies of them, so a result reads the same vocabulary the rest of the SDK
 * and the hosted platform speak.
 */

import type { MCPServerConfig } from "../mcp-client-manager/types.js";
import type { BaseUrls } from "../model-factory.js";
import type { McpjamGetAuth } from "../mcpjam-model-lease.js";
import type { IterationStatus } from "../contract/chain.js";
import type {
  EvalCaseVerdictAggregation,
  EvalVerdictDecision,
} from "../contract/verdict-policy.js";
import type {
  ToolPolicyDecisionReason,
  ToolPolicySnapshot,
  ToolSafetyClassification,
} from "../contract/tool-policy.js";
import type { EvalSuiteFileToolPolicy } from "../contract/suite-file.js";
import type { SuiteFileRunErrorCategory, SuiteFileRunPhase } from "./errors.js";
import type { LocalEvalRunReport } from "./report.js";

// ── options ──────────────────────────────────────────────────────────────────

/**
 * One target server's binding: the connection config, and optionally a
 * NON-SECRET label saying where it came from (`".mcp.json"`, `"--server"`).
 * The label is reported; the config never is.
 */
export type SuiteFileServerBinding = {
  config: MCPServerConfig;
  source?: string;
};

export type SuiteFileInferenceMode = "auto" | "byok" | "mcpjam";

/**
 * How to reach MCPJam-hosted inference. Resolved lazily — only when a
 * selected case actually needs the platform rail — so a BYOK-only run never
 * touches the caller's login.
 */
export type McpjamInferenceConnection = {
  /** MCPJam app origin, e.g. `https://app.mcpjam.com` — not the `/api/v1` base. */
  baseUrl: string;
  /** A concrete project id. The `default` sentinel is not accepted here. */
  projectId: string;
  /** Returns the CURRENT bearer; read for every mint, retry and revoke. */
  getAuth: McpjamGetAuth;
  /** Extra platform-API headers. Never sent to a provider, proxy or MCP server. */
  headers?: Readonly<Record<string, string>>;
};

export type SuiteFileInferenceOptions = {
  /** `auto` (default): a supplied provider key wins, else MCPJam if it can. */
  mode?: SuiteFileInferenceMode;
  /**
   * Provider API keys by provider id (`anthropic`, `openai`, …). Explicit:
   * the runner never reads environment variables for them.
   */
  providerKeys?: Readonly<Partial<Record<string, string>>>;
  /** Non-secret provider base URLs (a gateway, a local stub). */
  baseUrls?: Omit<BaseUrls, "mcpjam">;
  /**
   * Called at most once, and only when the platform rail is needed. The
   * signal aborts when the setup deadline passes or the run is cancelled.
   */
  resolveMcpjam?: (signal: AbortSignal) => Promise<McpjamInferenceConnection>;
};

/** A run-scoped approval of one `approximated` imported case. */
export type SuiteFileImportApproval = {
  caseId: string;
  reason: string;
};

export type RunSuiteFileOptions = {
  /** Bindings for the file's target servers, keyed by server NAME. */
  servers: Readonly<Record<string, SuiteFileServerBinding>>;
  /** Exact authored case ids. Omitted: every enabled case. */
  caseIds?: readonly string[];
  inference: SuiteFileInferenceOptions;
  /** One existing host template id, emulated. */
  hostTemplateId?: string;
  importApprovals?: readonly SuiteFileImportApproval[];
  /** Iterations of ONE case in flight at once. Default 1. */
  concurrency?: number;
  /** Bounds each iteration's executor run (not grading, not setup). Default 120000. */
  iterationTimeoutMs?: number;
  /** Model steps per prompt. Default 10. */
  maxSteps?: number;
  /** Bounds each setup operation (connect, list tools, mint). Default 30000. */
  setupTimeoutMs?: number;
  signal?: AbortSignal;
  /** Observer; a throwing observer is a warning, never a changed verdict. */
  onProgress?: (event: SuiteFileRunProgressEvent) => void;
};

// ── progress ─────────────────────────────────────────────────────────────────

export type SuiteFileRunProgressEvent =
  | {
      type: "setup";
      stage: "connect" | "discover" | "credentials" | "lease";
      server?: string;
      model?: string;
    }
  | {
      type: "caseStart";
      caseId: string;
      index: number;
      total: number;
      iterations: number;
    }
  | { type: "iteration"; caseId: string; completed: number; total: number }
  | { type: "caseFinish"; caseId: string; state: SuiteFileCaseRun["state"] };

// ── results ──────────────────────────────────────────────────────────────────

/**
 * How the invocation ended — independent of the verdict.
 *
 *   - `completed` — every planned iteration of every selected case ran.
 *   - `aborted`   — the caller's signal stopped it.
 *   - `stopped`   — the runner stopped scheduling work after a credential or
 *                   billing refusal made further requests pointless.
 */
export type SuiteFileRunTermination = "completed" | "aborted" | "stopped";

export type SuiteFileInferenceRail = "byok" | "mcpjam";

/** Why a run-affecting problem is attached to a result. */
export type SuiteFileRunIssue = {
  code: string;
  phase: SuiteFileRunPhase;
  category: SuiteFileRunErrorCategory | "observer" | "cleanup";
  message: string;
  caseId?: string;
  iterationNumber?: number;
};

export type SuiteFileToolPolicyBlock = {
  caseId: string;
  iterationNumber: number;
  toolName: string;
  toolCallId?: string;
  reason: ToolPolicyDecisionReason;
  classification: ToolSafetyClassification;
};

/** What a provider or the platform said when it refused a call. */
export type SuiteFileRefusalAttribution =
  "credentials" | "billing" | "rateLimited" | "unavailable";

export type SuiteFileIterationEvidence = {
  iterationNumber: number;
  /** The LIFECYCLE — never inferred from a pass/fail. */
  status: IterationStatus;
  /** Only for a completed iteration whose grader worked. */
  taskVerdict?: "passed" | "failed";
  evaluatorError?: boolean;
  /** Sanitized execution error, when the executor failed. */
  error?: string;
  /** A provider/platform refusal behind `error`, when one was observed. */
  refusal?: SuiteFileRefusalAttribution;
  toolCalls: Array<{
    toolName: string;
    arguments: Record<string, unknown>;
    /**
     * What the model sent when it was not a JSON object — malformed JSON,
     * typically. `arguments` is then `{}`. Bounded like `error`.
     */
    rawArguments?: string;
  }>;
  policyBlocks: SuiteFileToolPolicyBlock[];
  /** Gating/advisory score rows, as the evaluators reported them. */
  scores: Array<{
    scorerId: string;
    role?: string;
    status: string;
    passed?: boolean;
    reason?: string;
  }>;
  /** The canonical stage chain, when derivable. */
  stage?: Record<string, unknown>;
  durationMs: number;
  tokens: { input: number; output: number; total: number };
};

export type SuiteFileJudgeState = {
  /** Whether the file (or the hosted defaults it inherits) configures a judge. */
  configured: boolean;
  effective: {
    enabled: boolean;
    autoRun: boolean;
    role: "advisory" | "gating" | "required";
    threshold?: number;
    model?: string;
  };
  /** A local run never runs a judge in this release. */
  run: false;
  skipReason: "disabled" | "notAutomatic" | "localJudgeUnsupported";
};

export type SuiteFileCaseRun = {
  caseId: string;
  title: string;
  intent?: string;
  kind?: "capability" | "regression";
  isNegativeTest: boolean;
  declaredModel: string;
  declaredProvider?: string;
  /** The model string the runner executed. */
  effectiveModel: string;
  rail: SuiteFileInferenceRail;
  provider: string;
  configuredIterations: number;
  passThreshold: number;
  /** Identifies the evaluator definitions that actually graded this case. */
  evaluationConfigHash: string;
  scorerIds: string[];
  judge: SuiteFileJudgeState;
  import?: {
    status: "exact" | "approximated";
    sourceCaseKey?: string;
    /** Local approval evidence; no authenticated hosted actor is claimed. */
    approval?: {
      reason: string;
      approvedAt: string;
      actor: "local-invocation";
    };
  };
  state: "completed" | "interrupted" | "notStarted";
  iterations: SuiteFileIterationEvidence[];
  /** The case row of the decision, when one was produced. */
  aggregation?: EvalCaseVerdictAggregation;
};

export type SuiteFileRunVerdict =
  "passed" | "failed" | "inconclusive" | "notEstablished";

export type SuiteFileRunResult = {
  /** `passed` only for a completed run whose decision passed. */
  verdict: SuiteFileRunVerdict;
  passed: boolean;
  termination: SuiteFileRunTermination;
  /** True only when every planned iteration reached a terminal state. */
  complete: boolean;
  /**
   * The v2 decision, validated against `evalVerdictDecisionSchema`. For an
   * interrupted run this is a PARTIAL decision over the planned population —
   * never a completed release gate; read `verdict`.
   */
  decision: EvalVerdictDecision | null;
  cases: SuiteFileCaseRun[];
  /** Skipped (disabled / unselected) cases, with why. */
  skippedCases: Array<{ caseId: string; reason: "disabled" | "notSelected" }>;
  toolPolicy: {
    declared?: EvalSuiteFileToolPolicy;
    snapshot?: ToolPolicySnapshot;
    blocks: SuiteFileToolPolicyBlock[];
  };
  warnings: string[];
  issues: SuiteFileRunIssue[];
  report: LocalEvalRunReport;
};
