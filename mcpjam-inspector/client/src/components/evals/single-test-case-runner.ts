import type { ProviderTokens } from "@/hooks/use-ai-provider-keys";
import { isMCPJamProvidedModel } from "@/shared/types";
import type { EvalCase, EvalSuite } from "./types";

type TestCaseRunOverrides = Pick<
  EvalCase,
  "query" | "expectedToolCalls" | "runs"
>;

interface PrepareSingleTestCaseRunParams {
  workspaceId: string | null;
  suite: Pick<EvalSuite, "environment">;
  testCase: Pick<EvalCase, "_id" | "models">;
  getAccessToken: () => Promise<string | null>;
  getToken: (provider: keyof ProviderTokens) => string | null | undefined;
  hasToken: (provider: keyof ProviderTokens) => boolean;
  selectedModel?: string | null;
  testCaseOverrides?: TestCaseRunOverrides;
}

export function getDefaultTestCaseModelValue(
  testCase: Pick<EvalCase, "models"> | null | undefined,
): string | null {
  const modelConfig = testCase?.models?.[0];

  if (!modelConfig?.provider || !modelConfig.model) {
    return null;
  }

  return `${modelConfig.provider}/${modelConfig.model}`;
}

export async function prepareSingleTestCaseRun({
  workspaceId,
  suite,
  testCase,
  getAccessToken,
  getToken,
  hasToken,
  selectedModel,
  testCaseOverrides,
}: PrepareSingleTestCaseRunParams) {
  const modelValue =
    selectedModel ?? getDefaultTestCaseModelValue(testCase) ?? null;

  if (!modelValue) {
    throw new Error("Add a model first");
  }

  const [provider, ...modelParts] = modelValue.split("/");
  const model = modelParts.join("/");

  if (!provider || !model) {
    throw new Error("Invalid model selection");
  }

  const modelApiKeys: Record<string, string> = {};

  if (!isMCPJamProvidedModel(model)) {
    const tokenKey = provider.toLowerCase() as keyof ProviderTokens;
    if (!hasToken(tokenKey)) {
      throw new Error(
        `Please add your ${provider} API key in Settings before running this test`,
      );
    }

    const key = getToken(tokenKey);
    if (key) {
      modelApiKeys[provider] = key;
    }
  }

  return {
    modelValue,
    request: {
      workspaceId,
      testCaseId: testCase._id,
      model,
      provider,
      serverIds: suite.environment?.servers || [],
      modelApiKeys:
        Object.keys(modelApiKeys).length > 0 ? modelApiKeys : undefined,
      convexAuthToken: await getAccessToken(),
      testCaseOverrides,
    },
  };
}
