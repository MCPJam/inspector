import type { ConvexReactClient } from "convex/react";
import {
  generateEvalTests,
  type GeneratedEvalTestCase,
  type GenerationOptions,
  type ServerAttachmentInput,
} from "@/lib/apis/evals-api";
import { HOSTED_MODE } from "@/lib/config";
import { resolvePromptTurns, type PromptTurn } from "@/shared/steps";
import { promptTurnsToSteps, type TestStep } from "@/shared/steps";

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
  /**
   * Authored test steps (the unified `steps` model). The Convex mutation
   * rejects the legacy `promptTurns`/`caseType`/`probeConfig` fields, so case
   * authors describe the case as `steps`. Callers that still think in
   * `query`/`expectedToolCalls`/`promptTurns` shapes are converted to `steps`
   * via {@link buildStepsForCaseInput} before the mutation runs.
   */
  steps?: TestStep[];
};

/**
 * Derive the unified `steps` array from a legacy-shaped case input
 * (query / expectedToolCalls / expectedOutput / optional promptTurns). Used by
 * the curated-case + generated-case create paths so they speak `steps` to the
 * Convex mutation instead of the rejected `promptTurns`.
 */
export function buildStepsForCaseInput(input: {
  query?: string;
  expectedToolCalls?: Array<unknown>;
  expectedOutput?: string;
  promptTurns?: PromptTurn[];
}): TestStep[] {
  const turns = resolvePromptTurns({
    promptTurns: input.promptTurns,
    query: input.query,
    expectedToolCalls: input.expectedToolCalls,
    expectedOutput: input.expectedOutput,
  });
  return promptTurnsToSteps(turns);
}

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
    steps: buildStepsForCaseInput({
      query: test.query,
      expectedToolCalls: test.expectedToolCalls,
      expectedOutput: test.expectedOutput,
      promptTurns: test.promptTurns,
    }),
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
  projectId: string | null | undefined;
  suiteId: string;
  serverIds: string[];
  createTestCase: (input: CreateEvalTestCaseInput) => Promise<unknown>;
  /** When true, skips API call and creation if the suite already has test cases. */
  skipIfExistingCases?: boolean;
  /**
   * When true, guests are running generation and should use the guest bearer
   * token instead of a WorkOS token.
   */
  isDirectGuest?: boolean;
  /** Override case listing; used when the caller already has the suite's cases. */
  listExistingCases?: () =>
    | Array<Record<string, unknown>>
    | Promise<Array<Record<string, unknown>>>;
  /**
   * Optional server-attachment metadata for the suite the cases are being
   * generated against. When provided, the backend scopes the LLM prompt to
   * the attachment's servers and (for ≥2 servers) requires explicit
   * cross-server coverage.
   */
  serverAttachment?: ServerAttachmentInput;
  /**
   * Optional generation knobs (per-bucket case mix, vary-user-styles) forwarded
   * to the backend. Absent → today's default generation.
   */
  generationOptions?: GenerationOptions;
};

function getCreatedTestCaseId(created: unknown): string | null {
  if (typeof created === "string" && created.length > 0) {
    return created;
  }
  if (
    created &&
    typeof created === "object" &&
    "_id" in created &&
    typeof (created as { _id: unknown })._id === "string"
  ) {
    return (created as { _id: string })._id;
  }
  return null;
}

export type GenerateAndPersistEvalTestsResult = {
  skippedBecauseExistingCases: boolean;
  createdCount: number;
  apiReturnedTests: number;
  /** Ids of persisted test cases, in API response order. */
  createdTestCaseIds: string[];
};

export async function generateAndPersistEvalTests(
  options: GenerateAndPersistEvalTestsOptions,
): Promise<GenerateAndPersistEvalTestsResult> {
  const {
    convex,
    getAccessToken,
    projectId,
    suiteId,
    serverIds,
    createTestCase,
    skipIfExistingCases = false,
    isDirectGuest = false,
    listExistingCases,
    serverAttachment,
    generationOptions,
  } = options;

  let existingList: Array<Record<string, unknown>> = [];
  if (listExistingCases) {
    const listed = await listExistingCases();
    existingList = Array.isArray(listed) ? listed : [];
  } else {
    const existingTestCases = await convex.query(
      "testSuites:listTestCases" as any,
      { suiteId },
    );
    existingList = Array.isArray(existingTestCases)
      ? (existingTestCases as Array<Record<string, unknown>>)
      : [];
  }

  if (skipIfExistingCases && existingList.length > 0) {
    return {
      skippedBecauseExistingCases: true,
      createdCount: 0,
      apiReturnedTests: 0,
      createdTestCaseIds: [],
    };
  }

  let modelsToUse = collectModelsFromTestCases(existingList);
  if (modelsToUse.length === 0) {
    modelsToUse = defaultEvalModels();
  }

  // `getAccessToken` already resolves the guest bearer for guests (see
  // use-convex-access-token), so no `isDirectGuest` branch is needed here.
  const accessToken = HOSTED_MODE ? null : await getAccessToken();
  if (!HOSTED_MODE && !accessToken) {
    throw new Error("Not authenticated");
  }

  const result = await generateEvalTests({
    projectId: isDirectGuest ? null : projectId,
    serverIds,
    convexAuthToken: accessToken,
    ...(serverAttachment ? { serverAttachment } : {}),
    ...(generationOptions ? { generationOptions } : {}),
  });

  const tests = result.tests ?? [];
  if (tests.length === 0) {
    return {
      skippedBecauseExistingCases: false,
      createdCount: 0,
      apiReturnedTests: 0,
      createdTestCaseIds: [],
    };
  }

  let createdCount = 0;
  const createdTestCaseIds: string[] = [];
  for (const test of tests) {
    try {
      const created = await createTestCase(
        toCreateTestCaseInput(suiteId, modelsToUse, test),
      );
      const id = getCreatedTestCaseId(created);
      if (id) {
        createdTestCaseIds.push(id);
      }
      createdCount++;
    } catch (err) {
      console.error("Failed to create test case:", err);
    }
  }

  return {
    skippedBecauseExistingCases: false,
    createdCount,
    apiReturnedTests: tests.length,
    createdTestCaseIds,
  };
}
