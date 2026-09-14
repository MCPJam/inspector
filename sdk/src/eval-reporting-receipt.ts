import { snapshotReportingInput } from "./eval-reporting-config.js";
import type {
  EvalReportingReceipt,
  ReportEvalResultsInput,
} from "./eval-reporting-types.js";
import { reportEvalResults } from "./report-eval-results.js";

/** Safe for logs: transport error bodies may contain credentials or trace content. */
export function reportingReceiptError(_error: unknown): {
  code: string;
  message: string;
} {
  return {
    code: "EVAL_REPORTING_FAILED",
    message: "Eval results could not be confirmed as persisted.",
  };
}

export function notRequestedReceipt(
  reason: "disabled" | "missing_api_key"
): EvalReportingReceipt {
  return {
    schemaVersion: 1,
    state: "not_requested",
    acceptedIterations: 0,
    acknowledgedIterations: 0,
    pendingIterations: 0,
    reason,
  };
}

/** @internal Keep the original exception available for the legacy strict contract. */
export async function captureEvalReporting(
  input: ReportEvalResultsInput
): Promise<{
  receipt: EvalReportingReceipt;
  error?: unknown;
}> {
  if (input.enabled === false)
    return { receipt: notRequestedReceipt("disabled") };
  if (!(input.apiKey ?? process.env.MCPJAM_API_KEY)?.trim()) {
    if (input.strict) {
      const error = new Error("Strict eval reporting requires an API key");
      return {
        error,
        receipt: {
          schemaVersion: 1,
          state: "failed",
          acceptedIterations: 0,
          acknowledgedIterations: 0,
          pendingIterations: 0,
          error: { code: "MISSING_API_KEY", message: error.message },
        },
      };
    }
    return { receipt: notRequestedReceipt("missing_api_key") };
  }
  const acceptedIterations = Array.isArray(input.results)
    ? input.results.length
    : 0;
  try {
    input = snapshotReportingInput(input);
    const report = await reportEvalResults(input);
    return {
      receipt: {
        schemaVersion: 1,
        state: "persisted",
        acceptedIterations,
        acknowledgedIterations: acceptedIterations,
        pendingIterations: 0,
        report,
        ...(report.warnings?.length ? { warnings: report.warnings } : {}),
      },
    };
  } catch (error) {
    // A previous chunk might have committed before a later request failed.
    return {
      error,
      receipt: {
        schemaVersion: 1,
        state: "failed",
        acceptedIterations,
        acknowledgedIterations: null,
        pendingIterations: null,
        error: reportingReceiptError(error),
      },
    };
  }
}

/** Always resolves with persistence state, independently of strict mode or verdict. */
export async function reportEvalResultsWithReceipt(
  input: ReportEvalResultsInput
): Promise<EvalReportingReceipt> {
  return (await captureEvalReporting(input)).receipt;
}
