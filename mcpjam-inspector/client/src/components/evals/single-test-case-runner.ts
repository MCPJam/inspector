import type { ProviderTokens } from "@/hooks/use-ai-provider-keys";
import { isMCPJamProvidedModel, type ModelDefinition } from "@/shared/types";
import type { EvalCase, EvalSuite } from "./types";
import type { PromptTurn } from "@/shared/prompt-turns";

type TestCaseRunOverrides = Pick<
  EvalCase,
  | "query"
  | "expectedToolCalls"
  | "isNegativeTest"
  | "runs"
  | "expectedOutput"
  | "advancedConfig"
>;
type TestCaseRunOverridesWithTurns = TestCaseRunOverrides & {
  promptTurns?: PromptTurn[];
};

interface PrepareSingleTestCaseRunParams {
  workspaceId: string | null;
  suite: Pick<EvalSuite, "environment">;
  testCase: Pick<EvalCase, "_id" | "models">;
  getAccessToken: () => Promise<string | null>;
  getToken: (provider: keyof ProviderTokens) => string | null | undefined;
  hasToken: (provider: keyof ProviderTokens) => boolean;
  selectedModel?: string | null;
  testCaseOverrides?: TestCaseRunOverridesWithTurns;
}

export interface TestCaseModelOption {
  value: string;
  label: string;
  provider: string;
  model: string;
}

const TEST_CASE_MODEL_SELECTION_STORAGE_PREFIX =
  "eval-test-case-model-selection";

export function getDefaultTestCaseModelValue(
  testCase: Pick<EvalCase, "models"> | null | undefined,
): string | null {
  const modelConfig = testCase?.models?.[0];

  if (!modelConfig?.provider || !modelConfig.model) {
    return null;
  }

  return `${modelConfig.provider}/${modelConfig.model}`;
}

export function buildTestCaseModelOptions(
  availableModels: ModelDefinition[],
  testCase: Pick<EvalCase, "models"> | null | undefined,
): TestCaseModelOption[] {
  const options = new Map<string, TestCaseModelOption>();

  for (const availableModel of availableModels) {
    const value = `${availableModel.provider}/${String(availableModel.id)}`;
    options.set(value, {
      value,
      label: availableModel.name,
      provider: availableModel.provider,
      model: String(availableModel.id),
    });
  }

  for (const modelConfig of testCase?.models ?? []) {
    const value = `${modelConfig.provider}/${modelConfig.model}`;
    if (!options.has(value)) {
      options.set(value, {
        value,
        label: modelConfig.model,
        provider: modelConfig.provider,
        model: modelConfig.model,
      });
    }
  }

  return Array.from(options.values());
}

function getTestCaseModelSelectionStorageKey(testCaseId: string) {
  return `${TEST_CASE_MODEL_SELECTION_STORAGE_PREFIX}:${testCaseId}`;
}

export function getPersistedTestCaseModelValue(
  testCaseId: string | null | undefined,
): string | null {
  if (!testCaseId || typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage.getItem(
      getTestCaseModelSelectionStorageKey(testCaseId),
    );
  } catch {
    return null;
  }
}

export function setPersistedTestCaseModelValue(
  testCaseId: string | null | undefined,
  modelValue: string | null,
) {
  if (!testCaseId || typeof window === "undefined") {
    return;
  }

  try {
    const storageKey = getTestCaseModelSelectionStorageKey(testCaseId);
    if (modelValue) {
      window.localStorage.setItem(storageKey, modelValue);
    } else {
      window.localStorage.removeItem(storageKey);
    }
  } catch {
    // Ignore storage errors and keep the in-memory selection working.
  }
}

export function resolveSelectedTestCaseModelValue(params: {
  testCaseId: string | null | undefined;
  testCase: Pick<EvalCase, "models"> | null | undefined;
  modelOptions: TestCaseModelOption[];
}) {
  const { testCaseId, testCase, modelOptions } = params;
  const optionValues = new Set(modelOptions.map((option) => option.value));
  const preferredValues = [
    getPersistedTestCaseModelValue(testCaseId),
    getDefaultTestCaseModelValue(testCase),
    modelOptions[0]?.value ?? null,
  ];

  return (
    preferredValues.find(
      (candidate): candidate is string =>
        typeof candidate === "string" && optionValues.has(candidate),
    ) ?? null
  );
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

  // When running in an org-backed workspace the server resolves API keys
  // from the org config, so we skip populating modelApiKeys.
  const modelApiKeys: Record<string, string> = {};

  if (!workspaceId && !isMCPJamProvidedModel(model)) {
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
