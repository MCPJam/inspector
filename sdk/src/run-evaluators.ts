import { toEvaluatorResult } from "./contract/evaluator-derive.js";
import type { IterationResult } from "./EvalTest.js";
import { canonicalDigest } from "./contract/canonical.js";
import {
  buildEvaluationConfigSnapshot,
  definitionHash,
  errorScoreResult,
} from "./contract/derive.js";
import type { EvaluationConfigSnapshot } from "./contract/types.js";
import type {
  EvaluatorDefinition,
  EvaluatorRawOutcome,
  EvaluatorResult,
} from "./contract/evaluator-types.js";
import { runEvaluatorsProjected } from "./evaluators/run.js";
import type { EvaluatorRunOptions } from "./evaluators/types.js";

export interface RunIterationEvidence {
  iterationId: string;
  status: string;
  capture: "complete" | "unknown";
  toolCalls: { toolName: string; arguments?: unknown }[];
  provider?: string;
  model?: string;
  hostConfigHash?: string;
  caseId?: string;
  executionVariantId?: string;
}
export interface RunEvaluatorContextV1 {
  schemaVersion: 1;
  caseId: string;
  externalRunId?: string;
  sourceConfigHash: string;
  executionVariantId?: string;
  iterations: readonly RunIterationEvidence[];
}
export interface RunEvaluatorObservation {
  eligibleIterations: number;
  exclusions: { iterationId: string; reason: string }[];
  categories?: { value: string; count: number }[];
}
export interface RunEvaluator {
  definition: EvaluatorDefinition;
  timeoutMs?: number;
  evaluate(
    context: RunEvaluatorContextV1,
    signal?: AbortSignal
  ):
    | { outcome: EvaluatorRawOutcome; observation: RunEvaluatorObservation }
    | Promise<{
        outcome: EvaluatorRawOutcome;
        observation: RunEvaluatorObservation;
      }>;
}
export interface CaseRunEvaluation {
  schemaVersion: 1;
  scope: "case_run";
  caseId: string;
  externalRunId?: string;
  evidence: { totalIterations: number };
  evaluationConfig: EvaluationConfigSnapshot;
  results: EvaluatorResult[];
  observations: (RunEvaluatorObservation & {
    evaluatorId: string;
    definitionHash: string;
    excludedIterations: number;
  })[];
  provenance: { executionVariantId?: string; sourceConfigHash: string };
}

/** Evidence cannot form one comparable case-run population. This is not a case failure. */
export class RunEvaluatorContextError extends Error {
  readonly code = "INCOMPATIBLE_PROVENANCE";
  constructor(message: string) {
    super(message);
    this.name = "RunEvaluatorContextError";
  }
}

function caseRunAdapters(evaluators: readonly RunEvaluator[]) {
  if (evaluators.some((evaluator) => evaluator.definition.role !== "advisory"))
    throw new Error("Run evaluators must be advisory");
  return evaluators.map((evaluator) => ({
    ...evaluator,
    definition: {
      ...evaluator.definition,
      implementationHash: canonicalDigest({
        scope: "case_run",
        schemaVersion: 1,
        implementationHash: evaluator.definition.implementationHash,
      }),
    },
  }));
}

/** Preserve unavailable advisory measurements while the already-computed iteration evidence is reported. */
export function unavailableCaseRunEvaluation(
  evaluators: readonly RunEvaluator[],
  input: {
    caseId: string;
    externalRunId?: string;
    sourceConfigHash: string;
    executionVariantId?: string;
    iterationIds: readonly string[];
  }
): CaseRunEvaluation {
  if (
    !input.caseId ||
    !input.sourceConfigHash ||
    new Set(input.iterationIds).size !== input.iterationIds.length ||
    input.iterationIds.some((id) => !id)
  )
    throw new Error(
      "Unavailable run evaluation requires valid case, config and iteration identities"
    );
  const evaluationConfig = buildEvaluationConfigSnapshot(
    caseRunAdapters(evaluators).map((evaluator) => evaluator.definition)
  );
  return {
    schemaVersion: 1,
    scope: "case_run",
    caseId: input.caseId,
    ...(input.externalRunId ? { externalRunId: input.externalRunId } : {}),
    evidence: { totalIterations: input.iterationIds.length },
    evaluationConfig,
    results: evaluationConfig.definitions.map((definition) =>
      toEvaluatorResult(
        errorScoreResult(
          definition,
          new Error("Case-run evidence has incompatible provenance")
        )
      )
    ),
    observations: evaluationConfig.definitions.map((definition) => ({
      evaluatorId: definition.scorerId,
      definitionHash: definitionHash(definition),
      eligibleIterations: 0,
      excludedIterations: input.iterationIds.length,
      exclusions: input.iterationIds.map((iterationId) => ({
        iterationId,
        reason: "incompatible_provenance",
      })),
    })),
    provenance: {
      sourceConfigHash: input.sourceConfigHash,
      ...(input.executionVariantId
        ? { executionVariantId: input.executionVariantId }
        : {}),
    },
  };
}

/** Shared evidence boundary for local runs and read-only backtests. Never mixes populations. */
export function buildRunEvaluatorContext(
  input: Omit<RunEvaluatorContextV1, "schemaVersion">
): RunEvaluatorContextV1 {
  if (!input.caseId || !input.sourceConfigHash)
    throw new Error(
      "Run evaluator context requires case identity and configuration hash"
    );
  const ids = new Set<string>();
  for (const iteration of input.iterations) {
    if (!iteration.iterationId || ids.has(iteration.iterationId))
      throw new Error("Run evaluator iteration identities must be unique");
    ids.add(iteration.iterationId);
    if (iteration.caseId !== undefined && iteration.caseId !== input.caseId)
      throw new RunEvaluatorContextError("Run evaluators cannot mix cases");
    if (iteration.executionVariantId !== input.executionVariantId)
      throw new RunEvaluatorContextError(
        "Run evaluators cannot mix execution variants"
      );
  }
  for (const field of ["provider", "model", "hostConfigHash"] as const) {
    if (
      new Set(
        input.iterations.map((iteration) => iteration[field] ?? "__unknown__")
      ).size > 1
    )
      throw new RunEvaluatorContextError(
        `Run evaluators cannot mix ${field} provenance`
      );
  }
  return { schemaVersion: 1, ...structuredClone(input) };
}

/** Prompt history is explicit capture; no history is unknown, never an observed no-tool choice. */
export function runEvaluatorContextFromIterations(
  input: Omit<RunEvaluatorContextV1, "schemaVersion" | "iterations"> & {
    iterations: readonly IterationResult[];
  }
): RunEvaluatorContextV1 {
  const iterations = input.iterations.map(
    (iteration, index): RunIterationEvidence => {
      const prompts = iteration.prompts ?? [];
      const providers = new Set(
        prompts.map((prompt) => prompt.getProvider() ?? "__unknown__")
      );
      const models = new Set(
        prompts.map((prompt) => prompt.getModel() ?? "__unknown__")
      );
      if (providers.size > 1 || models.size > 1)
        throw new RunEvaluatorContextError(
          "Run evaluators cannot mix model/provider provenance within an iteration"
        );
      return {
        iterationId: `${input.caseId}:${index}`,
        caseId: input.caseId,
        executionVariantId: input.executionVariantId,
        status: iteration.status ?? "unknown",
        capture: prompts.length ? "complete" : "unknown",
        toolCalls: prompts.flatMap((prompt) =>
          prompt.getToolCalls().map((call) => ({
            toolName: call.toolName,
            arguments: call.arguments,
          }))
        ),
        provider: prompts[0]?.getProvider(),
        model: prompts[0]?.getModel(),
        hostConfigHash: iteration.hostSnapshot
          ? canonicalDigest(iteration.hostSnapshot)
          : undefined,
      };
    }
  );
  return buildRunEvaluatorContext({ ...input, iterations });
}

/** Advisory case-run measurements never enter the per-iteration definition inventory or verdict. */
export async function evaluateCaseRun(
  evaluators: readonly RunEvaluator[],
  context: RunEvaluatorContextV1,
  options?: EvaluatorRunOptions
): Promise<CaseRunEvaluation> {
  const frozen = buildRunEvaluatorContext(context);
  const adapters = caseRunAdapters(evaluators);
  const evaluationConfig = buildEvaluationConfigSnapshot(
    adapters.map((evaluator) => evaluator.definition)
  );
  const observations = new Map<string, RunEvaluatorObservation>();
  let closed = false;
  const results = await runEvaluatorsProjected(
    adapters.map((evaluator) => ({
      definition: evaluator.definition,
      timeoutMs: evaluator.timeoutMs,
      async evaluate(_unused, signal) {
        const value = await evaluator.evaluate(structuredClone(frozen), signal);
        const observation = value.observation;
        const known = new Set(
          frozen.iterations.map((iteration) => iteration.iterationId)
        );
        if (
          !Number.isSafeInteger(observation.eligibleIterations) ||
          observation.eligibleIterations < 0 ||
          observation.eligibleIterations + observation.exclusions.length !==
            frozen.iterations.length ||
          new Set(observation.exclusions.map((item) => item.iterationId))
            .size !== observation.exclusions.length ||
          observation.exclusions.some((item) => !known.has(item.iterationId))
        ) {
          throw new Error(
            "Run evaluator returned inconsistent evidence coverage"
          );
        }
        if (!closed && !signal?.aborted)
          observations.set(
            evaluator.definition.scorerId,
            structuredClone(observation)
          );
        return value.outcome;
      },
    })),
    { schemaVersion: 1 } as any,
    options
  );
  closed = true;
  return {
    schemaVersion: 1,
    scope: "case_run",
    caseId: frozen.caseId,
    ...(frozen.externalRunId ? { externalRunId: frozen.externalRunId } : {}),
    evidence: { totalIterations: frozen.iterations.length },
    evaluationConfig,
    results,
    observations: evaluationConfig.definitions.map((definition) => {
      const observation = observations.get(definition.scorerId) ?? {
        eligibleIterations: 0,
        exclusions: frozen.iterations.map((iteration) => ({
          iterationId: iteration.iterationId,
          reason: "evaluator_unavailable",
        })),
      };
      return {
        evaluatorId: definition.scorerId,
        definitionHash: definitionHash(definition),
        ...observation,
        excludedIterations: observation.exclusions.length,
      };
    }),
    provenance: {
      sourceConfigHash: frozen.sourceConfigHash,
      ...(frozen.executionVariantId
        ? { executionVariantId: frozen.executionVariantId }
        : {}),
    },
  };
}

function consistency(
  kind: "selectionStability" | "argumentConsistency",
  options: {
    id?: string;
    minAgreement?: number;
    minEligibleIterations?: number;
    toolName?: string;
  }
): RunEvaluator {
  const { minAgreement = 0.8, minEligibleIterations = 2 } = options;
  if (!Number.isFinite(minAgreement) || minAgreement < 0 || minAgreement > 1)
    throw new Error("minAgreement must be in [0,1]");
  if (!Number.isSafeInteger(minEligibleIterations) || minEligibleIterations < 2)
    throw new Error("minEligibleIterations must be an integer >= 2");
  if (kind === "argumentConsistency" && !options.toolName?.trim())
    throw new Error("argumentConsistency requires toolName");
  return {
    definition: {
      scorerId: options.id ?? kind,
      idSource: options.id ? "explicit" : "generated",
      scorerVersion: "1",
      role: "advisory",
      deterministic: true,
      passThreshold: minAgreement,
      implementationHash: canonicalDigest({
        scope: "case_run",
        kind,
        minAgreement,
        minEligibleIterations,
        toolName: options.toolName ?? null,
        coverage: "completed-captured",
      }),
    },
    evaluate(context) {
      const exclusions: RunEvaluatorObservation["exclusions"] = [];
      const counts = new Map<string, number>();
      for (const iteration of context.iterations) {
        let reason: string | undefined;
        if (iteration.status !== "completed") reason = "execution_incomplete";
        else if (iteration.capture !== "complete") reason = "capture_unknown";
        const call =
          kind === "selectionStability"
            ? iteration.toolCalls[0]
            : iteration.toolCalls.find(
                (call) => call.toolName === options.toolName
              );
        if (!reason && kind === "argumentConsistency" && !call)
          reason = "tool_not_called";
        if (
          !reason &&
          kind === "argumentConsistency" &&
          call?.arguments === undefined
        )
          reason = "arguments_unknown";
        if (reason) {
          exclusions.push({ iterationId: iteration.iterationId, reason });
          continue;
        }
        const category =
          kind === "selectionStability"
            ? call
              ? `tool:${call.toolName}`
              : "no_tool"
            : `arguments:${canonicalDigest(call!.arguments)}`;
        counts.set(category, (counts.get(category) ?? 0) + 1);
      }
      const categories = [...counts]
        .map(([value, count]) => ({ value, count }))
        .sort(
          (a, b) =>
            b.count - a.count ||
            (a.value < b.value ? -1 : a.value > b.value ? 1 : 0)
        );
      const eligibleIterations = context.iterations.length - exclusions.length;
      const observation = { eligibleIterations, exclusions, categories };
      if (eligibleIterations < minEligibleIterations)
        return {
          outcome: {
            kind: "skipped",
            explanation:
              "Insufficient eligible captured iterations to measure consistency",
          },
          observation,
        };
      return {
        outcome: {
          kind: "scored",
          score: categories[0].count / eligibleIterations,
          explanation: `Consistency, not correctness: modal choice ${categories[0].count}/${eligibleIterations}; coverage ${eligibleIterations}/${context.iterations.length}`,
        },
        observation,
      };
    },
  };
}
export function selectionStability(
  options: {
    id?: string;
    minAgreement?: number;
    minEligibleIterations?: number;
  } = {}
): RunEvaluator {
  return consistency("selectionStability", options);
}
export function argumentConsistency(
  toolName: string,
  options: {
    id?: string;
    minAgreement?: number;
    minEligibleIterations?: number;
  } = {}
): RunEvaluator {
  return consistency("argumentConsistency", { ...options, toolName });
}
