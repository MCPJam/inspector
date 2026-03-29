/**
 * Shared 4-check verification matrix for refinement candidates.
 * Labels must stay stable — runner and client both depend on them.
 */

export const FALLBACK_VERIFICATION_MODELS: Array<{
  model: string;
  provider: string;
}> = [
  { model: "openai/gpt-5-mini", provider: "openai" },
  { model: "anthropic/claude-haiku-4.5", provider: "anthropic" },
];

export type ModelConfig = { model: string; provider: string };

export type RefinementVerificationPlanStep = {
  label: "same-model-1" | "same-model-2" | "paraphrase" | "cross-model";
  model: string;
  provider: string;
  query: string;
};

export type BuildRefinementVerificationPlanArgs = {
  session:
    | {
        candidateParaphraseQuery?: string;
        candidateSnapshot?: {
          query: string;
          models: ModelConfig[];
        } | null;
      }
    | null
    | undefined;
  representativeIteration:
    | {
        testCaseSnapshot?: { model?: string; provider?: string };
      }
    | null
    | undefined;
  suiteModels: ModelConfig[];
};

export function buildRefinementVerificationPlan(
  args: BuildRefinementVerificationPlanArgs,
): RefinementVerificationPlanStep[] {
  const session = args.session;
  const candidate = session?.candidateSnapshot;
  if (!session || !candidate) {
    return [];
  }

  const representativeIteration = args.representativeIteration;
  const suiteModels = args.suiteModels;

  const currentModel =
    representativeIteration?.testCaseSnapshot?.model ??
    candidate.models?.[0]?.model ??
    suiteModels[0]?.model ??
    FALLBACK_VERIFICATION_MODELS[0].model;
  const currentProvider =
    representativeIteration?.testCaseSnapshot?.provider ??
    candidate.models?.find((modelConfig) => modelConfig.model === currentModel)
      ?.provider ??
    suiteModels.find((modelConfig) => modelConfig.model === currentModel)
      ?.provider ??
    FALLBACK_VERIFICATION_MODELS.find(
      (modelConfig) => modelConfig.model === currentModel,
    )?.provider ??
    "openai";

  const modelPool = [
    ...candidate.models,
    ...suiteModels,
    ...FALLBACK_VERIFICATION_MODELS,
  ];
  const crossModel =
    modelPool.find(
      (modelConfig) =>
        modelConfig.model !== currentModel ||
        modelConfig.provider !== currentProvider,
    ) ?? {
      model: currentModel,
      provider: currentProvider,
    };

  return [
    {
      label: "same-model-1",
      model: currentModel,
      provider: currentProvider,
      query: candidate.query,
    },
    {
      label: "same-model-2",
      model: currentModel,
      provider: currentProvider,
      query: candidate.query,
    },
    {
      label: "paraphrase",
      model: currentModel,
      provider: currentProvider,
      query: session.candidateParaphraseQuery ?? candidate.query,
    },
    {
      label: "cross-model",
      model: crossModel.model,
      provider: crossModel.provider,
      query: candidate.query,
    },
  ];
}
