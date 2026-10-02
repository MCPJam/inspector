/**
 * One iteration's result → the trial observation the v2 aggregator consumes,
 * plus the evidence a report shows for it.
 *
 * The observation goes through the finalization adapter the backend uses
 * (`evalV2TrialObservation`, mirrored in `contract/verdict-aggregate.ts`),
 * over the same columns it reads off a hosted iteration row: the lifecycle
 * status, the legacy result, and the scores with their definitions. So a
 * local trial is classified — completed, execution failure, evaluator error —
 * by the rule a hosted trial is, and a provider refusal or a broken grader
 * never becomes a failing assertion.
 */

import type { IterationResult } from "../EvalTest.js";
import type { EvaluationConfigSnapshot } from "../contract/types.js";
import {
  evalV2TrialObservation,
  type EvalTrialObservation,
  type EvalV2IterationEvidence,
} from "../contract/verdict-aggregate.js";
import {
  actualToolCallsFromPrompts,
  iterationScoreMetadata,
  resolveIterationLifecycleStatus,
} from "../eval-result-mapping.js";
import { redactTelemetryString } from "../telemetry-redaction.js";
import type {
  SuiteFileIterationEvidence,
  SuiteFileRefusalAttribution,
  SuiteFileToolPolicyBlock,
} from "./types.js";

/** Longest execution error kept on a report row. */
const MAX_ERROR_CHARS = 2000;

function legacyResult(
  iteration: IterationResult,
  status: EvalV2IterationEvidence["status"]
): EvalV2IterationEvidence["result"] {
  if (status === "completed") return iteration.passed ? "passed" : "failed";
  if (status === "cancelled") return "cancelled";
  if (status === "timed_out") return "timed_out";
  if (status === "pending" || status === "running") return "pending";
  return "failed";
}

function sanitizeError(error: string | undefined): string | undefined {
  if (error === undefined || error.trim() === "") return undefined;
  const redacted = redactTelemetryString(error);
  return redacted.length > MAX_ERROR_CHARS
    ? `${redacted.slice(0, MAX_ERROR_CHARS)}…`
    : redacted;
}

/**
 * A tool call's arguments as evidence. A model that sends malformed JSON
 * leaves the raw text where the object should be (the call is still
 * recorded, as it was attempted): it is kept, bounded, beside an empty
 * `arguments` rather than failing the report contract after every case ran.
 */
function toolCallArguments(value: unknown): {
  arguments: Record<string, unknown>;
  rawArguments?: string;
} {
  if (value === undefined || value === null) return { arguments: {} };
  if (typeof value === "object" && !Array.isArray(value)) {
    return { arguments: value as Record<string, unknown> };
  }
  let raw: string;
  if (typeof value === "string") {
    raw = value;
  } else {
    try {
      raw = JSON.stringify(value) ?? String(value);
    } catch {
      raw = String(value);
    }
  }
  return {
    arguments: {},
    rawArguments:
      raw.length > MAX_ERROR_CHARS ? `${raw.slice(0, MAX_ERROR_CHARS)}…` : raw,
  };
}

export function observeIteration(args: {
  iteration: IterationResult;
  iterationNumber: number;
  evaluationConfig: EvaluationConfigSnapshot | undefined;
  refusal?: SuiteFileRefusalAttribution;
  policyBlocks: readonly SuiteFileToolPolicyBlock[];
  stage?: Record<string, unknown>;
}): {
  observation: EvalTrialObservation;
  evidence: SuiteFileIterationEvidence;
} {
  const { iteration } = args;
  const status = resolveIterationLifecycleStatus(iteration);
  const metadata = iterationScoreMetadata(iteration, args.evaluationConfig);
  const observation = evalV2TrialObservation({
    status,
    result: legacyResult(iteration, status),
    ...(metadata ? { metadata: metadata as Record<string, unknown> } : {}),
  });
  const definitions = new Map(
    (args.evaluationConfig?.definitions ?? []).map((definition) => [
      definition.scorerId,
      definition,
    ])
  );
  const error = sanitizeError(iteration.error);
  const prompts = iteration.prompts ?? [];
  const durationMs = iteration.latencies.reduce(
    (sum, latency) => sum + (latency.e2eMs ?? 0),
    0
  );
  const evidence: SuiteFileIterationEvidence = {
    iterationNumber: args.iterationNumber,
    status,
    ...(observation.taskVerdict !== undefined
      ? { taskVerdict: observation.taskVerdict }
      : {}),
    ...(observation.evaluatorError ? { evaluatorError: true } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(args.refusal !== undefined ? { refusal: args.refusal } : {}),
    toolCalls: iteration.captureError
      ? []
      : actualToolCallsFromPrompts(prompts).map((call) => ({
          toolName: call.toolName,
          ...toolCallArguments(call.arguments),
        })),
    policyBlocks: [...args.policyBlocks],
    scores: (iteration.scores ?? []).map((score) => {
      const role = definitions.get(score.scorerId)?.role;
      return {
        scorerId: score.scorerId,
        ...(role !== undefined ? { role } : {}),
        status: score.status,
        ...(score.passed !== undefined ? { passed: score.passed } : {}),
        ...(score.rationale !== undefined
          ? { reason: redactTelemetryString(score.rationale) }
          : {}),
      };
    }),
    ...(args.stage ? { stage: args.stage } : {}),
    durationMs,
    tokens: {
      input: iteration.tokens.input,
      output: iteration.tokens.output,
      total: iteration.tokens.total,
    },
  };
  return { observation, evidence };
}

/**
 * A planned iteration that never ran, withdrawn by the harness: `cancelled`
 * when the caller aborted, `skipped` when the runner stopped scheduling after
 * a credential or billing refusal. Both leave every denominator, and neither
 * is ever a pass.
 */
export function unstartedIteration(
  iterationNumber: number,
  status: "cancelled" | "skipped"
): { observation: EvalTrialObservation; evidence: SuiteFileIterationEvidence } {
  return {
    observation: { status },
    evidence: {
      iterationNumber,
      status,
      toolCalls: [],
      policyBlocks: [],
      scores: [],
      durationMs: 0,
      tokens: { input: 0, output: 0, total: 0 },
    },
  };
}
