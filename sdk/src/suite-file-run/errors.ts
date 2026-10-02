/**
 * The domain errors a local suite-file run refuses with.
 *
 * `runSuiteFile` exposes WHAT went wrong and WHEN — a stable `code`, the
 * `phase` it happened in and a coarse `category` — never a process exit code.
 * Mapping a category to a number is the CLI's job (`local-test-exit-code.ts`);
 * an SDK caller embedding the runner decides for itself what a refusal means.
 *
 * Expected trial failures are NOT errors: a case that failed its assertions is
 * evidence, returned in the result. What throws is input that cannot be run
 * (validation), an environment that cannot be set up (setup), and a report that
 * cannot be produced honestly (reporting). A run interrupted after execution
 * began returns its partial evidence instead of throwing, with an explicit
 * termination state.
 */

import type { SuiteFileRunResult } from "./types.js";

/** Where in the run a refusal happened. */
export type SuiteFileRunPhase =
  "validation" | "setup" | "execution" | "reporting";

/**
 * What KIND of refusal this is — the axis a caller branches on.
 *
 *   - `usage`       — the file, the selection or the options are wrong.
 *   - `unsupported` — valid input asking for something a local run cannot do
 *                     (a direct tool call, a widget, a gating judge, …).
 *   - `import`      — an imported case's claim or approval does not permit it
 *                     to run.
 *   - `policy`      — the tool policy is invalid against the tools the servers
 *                     actually expose (an unmatched `deny`).
 *   - `credentials` — a model or platform credential is missing or rejected.
 *   - `billing`     — the platform refused inference for a billing reason.
 *   - `setup`       — a binding, connection, tool catalog or platform service
 *                     failed before anything was measured.
 *   - `cancelled`   — the caller aborted before execution began.
 *   - `integrity`   — the run's own output failed validation.
 *   - `internal`    — an unexpected failure.
 */
export type SuiteFileRunErrorCategory =
  | "usage"
  | "unsupported"
  | "import"
  | "policy"
  | "credentials"
  | "billing"
  | "setup"
  | "cancelled"
  | "integrity"
  | "internal";

/**
 * Stable machine codes. New codes are additive; an existing one never changes
 * meaning.
 */
export const SUITE_FILE_RUN_ERROR_CODES = [
  // validation
  "SUITE_FILE_INVALID",
  "CASE_SELECTION_INVALID",
  "CASE_INVALID",
  "CASE_UNSUPPORTED",
  "JUDGE_UNSUPPORTED",
  "IMPORT_INELIGIBLE",
  "TARGET_UNSUPPORTED",
  "SERVER_BINDING_INVALID",
  "MODEL_UNSUPPORTED",
  "INFERENCE_CONFLICT",
  "HOST_TEMPLATE_UNKNOWN",
  "OPTIONS_INVALID",
  // setup
  "SERVER_BINDING_MISSING",
  "SERVER_CONNECT_FAILED",
  "TOOL_CATALOG_FAILED",
  "TOOL_NAME_CONFLICT",
  "TOOL_POLICY_INVALID",
  "CREDENTIALS_MISSING",
  "CREDENTIALS_REJECTED",
  "BILLING_REFUSED",
  "PLATFORM_UNAVAILABLE",
  "SETUP_TIMEOUT",
  "SETUP_FAILED",
  "CANCELLED",
  // reporting
  "REPORT_INVALID",
  "INTERNAL_ERROR",
] as const;

export type SuiteFileRunErrorCode = (typeof SUITE_FILE_RUN_ERROR_CODES)[number];

/**
 * One concrete problem inside a refusal — a case, a step, a server, a model.
 * Several are collected before throwing, so a file with three unsupported
 * cases names all three instead of the first.
 */
export type SuiteFileRunProblem = {
  message: string;
  caseId?: string;
  stepId?: string;
  stepIndex?: number;
  server?: string;
  model?: string;
  toolName?: string;
  /** A finer machine reason, e.g. the backend's import refusal reason. */
  reason?: string;
  /** Field pointer into the suite file, for a structural finding. */
  pointer?: string;
};

export type SuiteFileRunErrorDetails = {
  problems?: SuiteFileRunProblem[];
};

export class SuiteFileRunError extends Error {
  readonly code: SuiteFileRunErrorCode;
  readonly phase: SuiteFileRunPhase;
  readonly category: SuiteFileRunErrorCategory;
  /** Sanitized: case ids, server names, messages — never a credential. */
  readonly details: SuiteFileRunErrorDetails;
  /**
   * What had been observed when the refusal happened, if anything. Absent for
   * every refusal before execution began: there is no decision to fabricate.
   */
  readonly partialResult?: SuiteFileRunResult;

  constructor(args: {
    code: SuiteFileRunErrorCode;
    phase: SuiteFileRunPhase;
    category: SuiteFileRunErrorCategory;
    message: string;
    details?: SuiteFileRunErrorDetails;
    partialResult?: SuiteFileRunResult;
    cause?: unknown;
  }) {
    super(
      args.message,
      args.cause === undefined ? undefined : { cause: args.cause }
    );
    this.name = "SuiteFileRunError";
    this.code = args.code;
    this.phase = args.phase;
    this.category = args.category;
    this.details = args.details ?? {};
    if (args.partialResult) this.partialResult = args.partialResult;
  }
}

/** Build a refusal that lists every problem found at one stage. */
export function refusal(args: {
  code: SuiteFileRunErrorCode;
  phase: SuiteFileRunPhase;
  category: SuiteFileRunErrorCategory;
  summary: string;
  problems: SuiteFileRunProblem[];
  cause?: unknown;
}): SuiteFileRunError {
  const lines = args.problems.map((problem) => {
    const where = [
      problem.caseId !== undefined ? `case ${problem.caseId}` : undefined,
      problem.stepId !== undefined
        ? `step ${problem.stepId}`
        : problem.stepIndex !== undefined
          ? `step ${problem.stepIndex}`
          : undefined,
      problem.server !== undefined ? `server ${problem.server}` : undefined,
      problem.model !== undefined ? `model ${problem.model}` : undefined,
      problem.pointer ? problem.pointer : undefined,
    ].filter((part): part is string => part !== undefined);
    return `  ${where.length > 0 ? `${where.join(", ")}: ` : ""}${problem.message}`;
  });
  return new SuiteFileRunError({
    code: args.code,
    phase: args.phase,
    category: args.category,
    message:
      lines.length > 0 ? `${args.summary}\n${lines.join("\n")}` : args.summary,
    details: { problems: args.problems },
    ...(args.cause !== undefined ? { cause: args.cause } : {}),
  });
}

export function isSuiteFileRunError(
  value: unknown
): value is SuiteFileRunError {
  return value instanceof SuiteFileRunError;
}
