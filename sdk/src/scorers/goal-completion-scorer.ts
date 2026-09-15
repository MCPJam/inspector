import { generateObject } from "ai";
import { z } from "zod";
import {
  createModelFromString,
  type CreateModelOptions,
} from "../model-factory.js";
import { canonicalDigest, sha256Hex } from "../contract/canonical.js";
import {
  assertGoalJudgeRequestFits,
  buildGoalJudgeRequest,
  collectInlineJudgeArtifacts,
  goalJudgeArtifactTokenUpperBound,
  interpretGoalJudgeOutput,
  GOAL_JUDGE_TEMPLATE_VERSION,
  GOAL_JUDGE_THRESHOLD,
  renderGoalJudgeTemplate,
  validateJudgeRubric,
  type JudgeEvidence,
  type JudgeModelLimits,
  type JudgeRubric,
} from "../contract/goal-completion.js";
import type {
  ScorerContextV1,
  ScorerRole,
  ScorerErrorPolicy,
} from "../contract/types.js";
import { authoredRequiredRole } from "../contract/policy-spelling.js";
import { isRequiredRole } from "../predicates/policy.js";
import { DEFAULT_SCORER_TIMEOUT_MS, type Scorer } from "./types.js";

export type GoalCompletionScorerOptions = {
  mode: "goalCompletion";
  id: string;
  model: string;
  apiKey: string;
  baseUrls?: CreateModelOptions["baseUrls"];
  customProviders?: CreateModelOptions["customProviders"];
  rubric?: JudgeRubric;
  threshold?: number;
  role?: ScorerRole;
  onError?: ScorerErrorPolicy;
  onSkipped?: ScorerErrorPolicy;
  label?: string;
  timeoutMs?: number;
  /** Limits from the selected provider or its tokenizer; never guessed from the model name. */
  modelLimits:
    JudgeModelLimits | ((evidence: JudgeEvidence) => Promise<JudgeModelLimits>);
  /** Resolve recorded artifacts and tool catalogs when the runner stores them externally. */
  evidence?: (
    context: ScorerContextV1
  ) => JudgeEvidence | Promise<JudgeEvidence>;
};

/** Built-in v4 policy. Legacy custom judge prompts retain their existing implementation hash. */
export function goalCompletionScorer(
  options: GoalCompletionScorerOptions
): Scorer {
  if (!options.id?.trim())
    throw new Error("A goal-completion judge requires an explicit id.");
  if (options.rubric) validateJudgeRubric(options.rubric);
  const threshold = options.threshold ?? GOAL_JUDGE_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
    throw new Error("Judge threshold must be in [0,1].");
  const model = createModelFromString(options.model, {
    apiKey: options.apiKey,
    baseUrls: options.baseUrls,
    customProviders: options.customProviders,
  });
  const timeoutMs = options.timeoutMs ?? DEFAULT_SCORER_TIMEOUT_MS;
  return {
    definition: {
      scorerId: options.id.trim(),
      idSource: "explicit",
      scorerVersion: "4",
      implementationHash: canonicalDigest({
        templateVersion: GOAL_JUDGE_TEMPLATE_VERSION,
        template: renderGoalJudgeTemplate(),
        rubric: options.rubric ?? null,
        model: options.model,
      }),
      deterministic: false,
      passThreshold: threshold,
      role:
        options.role && isRequiredRole(options.role)
          ? authoredRequiredRole()
          : "advisory",
      model: options.model,
      ...(options.label ? { label: options.label } : {}),
      ...(options.onError ? { onError: options.onError } : {}),
      ...(options.onSkipped ? { onSkipped: options.onSkipped } : {}),
    },
    timeoutMs,
    async score(context, signal) {
      const recorded: JudgeEvidence = options.evidence
        ? await options.evidence(context)
        : {
            version: 1 as const,
            trace: context.trace,
            context: { ...context },
            toolDefinitions: context.toolDefinitions,
            unavailable: context.evidenceUnavailable,
            uncaptured:
              context.toolDefinitions === undefined ? ["toolDefinitions"] : [],
          };
      const evidence = {
        ...recorded,
        artifacts: [
          ...(recorded.artifacts ?? []),
          ...collectInlineJudgeArtifacts({
            trace: recorded.trace,
            context: recorded.context,
          }),
        ],
      };
      const firstUser = context.trace.messages.find(
        (message) => message.role === "user"
      );
      const key = context.scenario.scenarioKey ?? options.id;
      const request = buildGoalJudgeRequest(
        {
          caseKey: key,
          gradingKey: context.gradingKey ?? key,
          title: context.scenario.title,
          query:
            typeof firstUser?.content === "string"
              ? firstUser.content
              : JSON.stringify(firstUser?.content ?? ""),
          expectedOutput: context.expectedOutput,
          isNegativeTest: context.scenario.isNegativeTest,
          suiteRubric: options.rubric,
          evidence,
        },
        threshold
      );
      const limits =
        typeof options.modelLimits === "function"
          ? await options.modelLimits(evidence)
          : options.modelLimits;
      const servingLimits = {
        ...limits,
        artifactInputTokens:
          limits.artifactInputTokens ??
          (!options.customProviders && !options.baseUrls
            ? goalJudgeArtifactTokenUpperBound(
                options.model,
                evidence.artifacts
              )
            : undefined),
      };
      assertGoalJudgeRequestFits(request, servingLimits);
      const timeout = AbortSignal.timeout(timeoutMs);
      const { object } = await generateObject({
        model,
        schema: z.object({
          score: z.number().min(0).max(1),
          reason: z.string().min(1),
          rubricHits: z.array(z.string()),
        }),
        system: request.system,
        messages: [{ role: "user", content: request.content }],
        maxOutputTokens: limits.outputTokens,
        temperature: 0,
        maxRetries: 0,
        abortSignal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      const result = interpretGoalJudgeOutput(
        object,
        request.hasRubric,
        threshold
      );
      return {
        kind: "scored",
        value: result.score,
        rationale: result.reason,
        judgeTemplateVersion: GOAL_JUDGE_TEMPLATE_VERSION,
        judgeTemplateHash: sha256Hex(renderGoalJudgeTemplate()),
        evidenceHash: sha256Hex(JSON.stringify(evidence)),
        evidenceManifest: request.manifest,
        evidence: result.rubricHits,
        model: options.model,
        promptHash: canonicalDigest({
          system: request.system,
          content: request.content,
        }),
      };
    },
  };
}
