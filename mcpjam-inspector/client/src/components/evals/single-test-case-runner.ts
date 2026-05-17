import { HOSTED_MODE } from "@/lib/config";
import type { ModelDefinition } from "@/shared/types";
import type { EvalCase, EvalSuite } from "./types";
import type { PromptTurn } from "@/shared/prompt-turns";
import type { EvalMatchOptions } from "@/shared/eval-matching";
import type { HostConfigInputV2 } from "@/lib/host-config-v2";

/**
 * Per-Run hostConfig override shape sent in the request. Subset of
 * `HostConfigInputV2` — only fields the server records on the iteration
 * snapshot. Model / system / temperature stay on `advancedConfig`.
 */
export type HostConfigRunOverride = {
  hostStyle?: string;
  hostContext?: Record<string, unknown>;
  clientCapabilities?: Record<string, unknown>;
  hostCapabilitiesOverride?: Record<string, unknown>;
  chatUiOverride?: Record<string, unknown>;
  mcpProfile?: Record<string, unknown>;
  connectionDefaults?: {
    headers?: Record<string, string>;
    requestTimeout?: number;
  };
};

/**
 * Project a `HostConfigInputV2` into the request-shape subset. Strips
 * model / system / temperature / requireToolApproval / serverIds because
 * those are routed through `advancedConfig` and the suite environment.
 */
export function projectHostConfigRunOverride(
  input: HostConfigInputV2,
): HostConfigRunOverride {
  return {
    hostStyle: input.hostStyle,
    hostContext: input.hostContext,
    clientCapabilities: input.clientCapabilities,
    hostCapabilitiesOverride: input.hostCapabilitiesOverride,
    chatUiOverride: input.chatUiOverride as
      | Record<string, unknown>
      | undefined,
    mcpProfile: input.mcpProfile as Record<string, unknown> | undefined,
    connectionDefaults: input.connectionDefaults,
  };
}

type TestCaseRunOverrides = Partial<
  Pick<
    EvalCase,
    | "query"
    | "expectedToolCalls"
    | "isNegativeTest"
    | "runs"
    | "expectedOutput"
    | "advancedConfig"
    | "matchOptions"
  >
>;
type TestCaseRunOverridesWithTurns = TestCaseRunOverrides & {
  promptTurns?: PromptTurn[];
};

interface PrepareSingleTestCaseRunParams {
  projectId: string | null;
  suite: Pick<EvalSuite, "environment">;
  testCase: Pick<EvalCase, "_id" | "models">;
  getAccessToken: () => Promise<string | null>;
  selectedModel?: string | null;
  testCaseOverrides?: TestCaseRunOverridesWithTurns;
  /** One-off run override; does not persist on the case. */
  matchOptionsOverride?: EvalMatchOptions;
  /**
   * One-off hostConfig override for this Run. Edited via the test case
   * host header; recorded on the iteration snapshot. Subset of
   * `HostConfigInputV2` — see `projectHostConfigRunOverride`.
   */
  hostConfigOverride?: HostConfigRunOverride;
}

export interface TestCaseModelOption {
  value: string;
  label: string;
  provider: string;
  model: string;
  customProviderName?: string;
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
      ...(availableModel.customProviderName
        ? { customProviderName: availableModel.customProviderName }
        : {}),
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
  projectId,
  suite,
  testCase,
  getAccessToken,
  selectedModel,
  testCaseOverrides,
  matchOptionsOverride,
  hostConfigOverride,
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

  const convexAuthToken = HOSTED_MODE ? null : await getAccessToken();

  return {
    modelValue,
    request: {
      projectId,
      testCaseId: testCase._id,
      model,
      provider,
      serverIds: suite.environment?.servers || [],
      convexAuthToken,
      testCaseOverrides,
      matchOptionsOverride,
      hostConfigOverride,
    },
  };
}
