import type { ConvexReactClient } from "convex/react";
import {
  generateEvalTests,
  type GeneratedEvalTestCase,
} from "@/lib/apis/evals-api";
import type { PromptTurn } from "@/shared/prompt-turns";

export type CreateEvalTestCaseInput = {
  suiteId: string;
  title: string;
  query: string;
  models: Array<{ model: string; provider: string }>;
  expectedToolCalls: Array<unknown>;
  runs: number;
  isNegativeTest: boolean;
  scenario?: string;
  expectedOutput?: string;
  promptTurns?: PromptTurn[];
};

function getLegacyExpectedToolCalls(
  promptTurns: PromptTurn[] | undefined,
  fallback: Array<unknown> | undefined,
): Array<unknown> {
  const firstTurn = promptTurns?.[0];
  if (firstTurn) {
    return firstTurn.expectedToolCalls ?? [];
  }
  return fallback ?? [];
}

function toCreateTestCaseInput(
  suiteId: string,
  models: Array<{ model: string; provider: string }>,
  test: GeneratedEvalTestCase,
): CreateEvalTestCaseInput {
  const isNegativeTest =
    test.isNegativeTest === true ||
    (Array.isArray(test.promptTurns) &&
      test.promptTurns.length > 0 &&
      test.promptTurns.every((turn) => turn.expectedToolCalls.length === 0));

  return {
    suiteId,
    title: test.title || "Generated test",
    query: test.query || test.promptTurns?.[0]?.prompt || "",
    models,
    expectedToolCalls: getLegacyExpectedToolCalls(
      test.promptTurns,
      test.expectedToolCalls,
    ),
    runs: test.runs || 1,
    isNegativeTest,
    scenario: test.scenario,
    expectedOutput: test.expectedOutput,
    promptTurns: test.promptTurns,
  };
}

function collectModelsFromTestCases(
  testCases: Array<Record<string, unknown>>,
): Array<{ model: string; provider: string }> {
  const uniqueModels = new Map<string, { model: string; provider: string }>();

  for (const testCase of testCases) {
    const models = testCase.models;
    if (!Array.isArray(models)) continue;
    for (const modelConfig of models) {
      if (
        modelConfig &&
        typeof modelConfig === "object" &&
        "model" in modelConfig &&
        "provider" in modelConfig &&
        typeof (modelConfig as { model: unknown }).model === "string" &&
        typeof (modelConfig as { provider: unknown }).provider === "string"
      ) {
        const { model, provider } = modelConfig as {
          model: string;
          provider: string;
        };
        const key = `${provider}:${model}`;
        if (!uniqueModels.has(key)) {
          uniqueModels.set(key, { model, provider });
        }
      }
    }
  }

  return Array.from(uniqueModels.values());
}

function defaultEvalModels(): Array<{ model: string; provider: string }> {
  return [{ model: "anthropic/claude-haiku-4.5", provider: "anthropic" }];
}

export type GenerateAndPersistEvalTestsOptions = {
  convex: ConvexReactClient;
  getAccessToken: () => Promise<string | undefined | null>;
  workspaceId: string | null | undefined;
  suiteId: string;
  serverIds: string[];
  createTestCase: (input: CreateEvalTestCaseInput) => Promise<unknown>;
  /** When true, skips API call and creation if the suite already has test cases. */
  skipIfExistingCases?: boolean;
};

export type GenerateAndPersistEvalTestsResult = {
  skippedBecauseExistingCases: boolean;
  createdCount: number;
  apiReturnedTests: number;
};

export async function generateAndPersistEvalTests(
  options: GenerateAndPersistEvalTestsOptions,
): Promise<GenerateAndPersistEvalTestsResult> {
  const {
    convex,
    getAccessToken,
    workspaceId,
    suiteId,
    serverIds,
    createTestCase,
    skipIfExistingCases = false,
  } = options;

  const existingTestCases = await convex.query(
    "testSuites:listTestCases" as any,
    { suiteId },
  );

  const existingList = Array.isArray(existingTestCases)
    ? (existingTestCases as Array<Record<string, unknown>>)
    : [];

  if (skipIfExistingCases && existingList.length > 0) {
    return {
      skippedBecauseExistingCases: true,
      createdCount: 0,
      apiReturnedTests: 0,
    };
  }

  let modelsToUse = collectModelsFromTestCases(existingList);
  if (modelsToUse.length === 0) {
    modelsToUse = defaultEvalModels();
  }

  const accessToken = await getAccessToken();
  if (!accessToken) {
    throw new Error("Not authenticated");
  }

  const result = await generateEvalTests({
    workspaceId,
    serverIds,
    convexAuthToken: accessToken,
  });

  const tests = result.tests ?? [];
  if (tests.length === 0) {
    return {
      skippedBecauseExistingCases: false,
      createdCount: 0,
      apiReturnedTests: 0,
    };
  }

  let createdCount = 0;
  for (const test of tests) {
    try {
      await createTestCase(toCreateTestCaseInput(suiteId, modelsToUse, test));
      createdCount++;
    } catch (err) {
      console.error("Failed to create test case:", err);
    }
  }

  return {
    skippedBecauseExistingCases: false,
    createdCount,
    apiReturnedTests: tests.length,
  };
}
