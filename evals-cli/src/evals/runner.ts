import { MCPClient } from "@mastra/mcp";
import { streamText, Tool, ToolChoice, ModelMessage } from "ai";
import { getUserIdFromApiKeyOrNull } from "../db/user";
import {
  convertMastraToolsToVercelTools,
  validateAndNormalizeMCPClientConfiguration,
  validateLlms,
  validateTestCase,
  LlmsConfig,
  TestCase,
} from "../utils/validators";
import { createLlmModel, extractToolNamesAsArray } from "../utils/helpers";
import { Logger } from "../utils/logger";
import { dbClient } from "../db";
import { evaluateResults } from "./evaluator";

const MAX_STEPS = 20;

type ToolMap = Record<string, Tool>;
type EvaluationResult = ReturnType<typeof evaluateResults>;

type UsageTotals = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

type ConfigSummary = {
  tests: TestCase[];
  environment: { servers: string[] };
  llms: string[];
};

type DbClient = ReturnType<typeof dbClient> | null;

type PersistenceContext = {
  enabled: boolean;
  apiKey?: string;
  db: DbClient;
  testRunId?: string;
  configSummary: ConfigSummary;
  totalPlannedTests: number;
};

const accumulateTokenCount = (
  current: number | undefined,
  increment: number | undefined,
): number | undefined => {
  if (typeof increment !== "number" || Number.isNaN(increment)) {
    return current;
  }

  return (current ?? 0) + increment;
};

const ensureApiKeyIsValid = async (apiKey?: string) => {
  if (!apiKey) {
    return;
  }

  await getUserIdFromApiKeyOrNull(apiKey);
};

const prepareSuite = async (
  tests: unknown,
  environment: unknown,
  llms: unknown,
) => {
  const mcpClientOptions =
    validateAndNormalizeMCPClientConfiguration(environment);
  const validatedTests = validateTestCase(tests);
  const validatedLlms = validateLlms(llms);

  const mcpClient = new MCPClient(mcpClientOptions);
  const availableTools = await mcpClient.getTools();
  const vercelTools = convertMastraToolsToVercelTools(availableTools);

  const serverNames = Object.keys(mcpClientOptions.servers);

  Logger.initiateTestMessage(
    serverNames.length,
    Object.keys(availableTools).length,
    serverNames,
    validatedTests.length,
  );

  return {
    validatedTests,
    validatedLlms,
    vercelTools,
    serverNames,
    mcpClientOptions,
  };
};

const createPersistenceContext = (
  apiKey: string | undefined,
  configSummary: ConfigSummary,
  totalPlannedTests: number,
): PersistenceContext => ({
  enabled: Boolean(apiKey),
  apiKey,
  db: apiKey ? dbClient() : null,
  configSummary,
  totalPlannedTests,
});

const runDbAction = async <T>(
  persistence: PersistenceContext,
  action: string,
  payload: Record<string, unknown>,
): Promise<T | undefined> => {
  if (!persistence.enabled || !persistence.db) {
    return undefined;
  }

  try {
    return await (persistence.db as any).action(action, payload);
  } catch {
    return undefined;
  }
};

const ensureSuiteRecord = async (persistence: PersistenceContext) => {
  if (
    !persistence.enabled ||
    !persistence.apiKey ||
    persistence.testRunId ||
    !persistence.configSummary
  ) {
    return;
  }

  const createdId = await runDbAction<string>(
    persistence,
    "evals:createEvalTestSuiteWithApiKey",
    {
      apiKey: persistence.apiKey,
      name: undefined,
      config: persistence.configSummary,
      totalTests: persistence.totalPlannedTests,
    },
  );

  if (createdId) {
    persistence.testRunId = createdId;
  }
};

const createTestCaseRecord = async (
  persistence: PersistenceContext,
  test: TestCase,
  testNumber: number,
) => {
  if (!persistence.enabled || !persistence.apiKey) {
    return undefined;
  }

  const testCaseId = await runDbAction<string>(
    persistence,
    "evals:createEvalTestCaseWithApiKey",
    {
      apiKey: persistence.apiKey,
      title: String(test.title ?? `Group ${testNumber}`),
      query: String(test.query ?? ""),
      provider: String(test.provider ?? ""),
      model: String(test.model ?? ""),
      runs: Number(test.runs ?? 1),
    },
  );

  if (!persistence.testRunId) {
    await ensureSuiteRecord(persistence);
  }

  return testCaseId;
};

const createIterationRecord = async (
  persistence: PersistenceContext,
  testCaseId: string | undefined,
  iterationNumber: number,
  startedAt: number,
) => {
  if (!persistence.enabled || !persistence.apiKey || !testCaseId) {
    return undefined;
  }

  return await runDbAction<string>(
    persistence,
    "evals:createEvalTestIterationWithApiKey",
    {
      apiKey: persistence.apiKey,
      testCaseId,
      startedAt,
      iterationNumber,
      blob: undefined,
      actualToolCalls: [],
      tokensUsed: 0,
    },
  );
};

const updateIterationResult = async (
  persistence: PersistenceContext,
  evalTestId: string | undefined,
  passed: boolean,
  toolsCalled: string[],
  tokensUsed: UsageTotals,
  messages: ModelMessage[],
) => {
  if (!persistence.enabled || !persistence.apiKey || !evalTestId) {
    return;
  }

  await runDbAction(
    persistence,
    "evals:updateEvalTestIterationResultWithApiKey",
    {
      apiKey: persistence.apiKey,
      testId: evalTestId,
      status: "completed",
      result: passed ? "passed" : "failed",
      actualToolCalls: toolsCalled,
      tokensUsed: tokensUsed.totalTokens ?? 0,
      blob: undefined,
      blobContent: { messages },
    },
  );
};

const updateTestCaseResult = async (
  persistence: PersistenceContext,
  testCaseId: string | undefined,
  passedRuns: number,
  failedRuns: number,
) => {
  if (!persistence.enabled || !persistence.apiKey || !testCaseId) {
    return;
  }

  const result = failedRuns > 0 ? "failed" : "passed";

  await runDbAction(
    persistence,
    "evals:updateEvalTestCaseResultWithApiKey",
    {
      apiKey: persistence.apiKey,
      testCaseId,
      result,
    },
  );
};

const markSuiteFailed = async (persistence: PersistenceContext) => {
  if (!persistence.enabled || !persistence.apiKey || !persistence.testRunId) {
    return;
  }

  await runDbAction(
    persistence,
    "evals:updateEvalTestSuiteStatusWithApiKey",
    {
      apiKey: persistence.apiKey,
      testRunId: persistence.testRunId,
      status: "running",
      result: "failed",
    },
  );
};

const finalizeSuiteStatus = async (
  persistence: PersistenceContext,
  failedRuns: number,
) => {
  if (!persistence.enabled || !persistence.apiKey || !persistence.testRunId) {
    return;
  }

  await runDbAction(
    persistence,
    "evals:updateEvalTestSuiteStatusWithApiKey",
    {
      apiKey: persistence.apiKey,
      testRunId: persistence.testRunId,
      status: "completed",
      result: failedRuns > 0 ? "failed" : "passed",
      finishedAt: Date.now(),
    },
  );
};

type RunIterationParams = {
  test: TestCase;
  runIndex: number;
  totalRuns: number;
  llms: LlmsConfig;
  tools: ToolMap;
  persistence: PersistenceContext;
  testCaseId?: string;
};

const runIteration = async ({
  test,
  runIndex,
  totalRuns,
  llms,
  tools,
  persistence,
  testCaseId,
}: RunIterationParams): Promise<EvaluationResult> => {
  const { provider, model, advancedConfig, query } = test;
  const { system, temperature, toolChoice } = advancedConfig ?? {};

  Logger.testRunStart({
    runNumber: runIndex + 1,
    totalRuns,
    provider,
    model,
    temperature,
  });

  if (system) {
    Logger.conversation({ messages: [{ role: "system", content: system }] });
  }

  const userMessage: ModelMessage = {
    role: "user",
    content: query,
  };

  Logger.conversation({ messages: [userMessage] });

  const messageHistory: ModelMessage[] = [userMessage];
  const toolsCalled: string[] = [];
  let inputTokensUsed: number | undefined;
  let outputTokensUsed: number | undefined;
  let totalTokensUsed: number | undefined;
  let stepCount = 0;

  const runStartedAt = Date.now();
  const evalTestId = await createIterationRecord(
    persistence,
    testCaseId,
    runIndex + 1,
    runStartedAt,
  );

  while (stepCount < MAX_STEPS) {
    let assistantStreaming = false;

    const streamResult = await streamText({
      model: createLlmModel(provider, model, llms),
      system,
      temperature,
      tools,
      toolChoice: toolChoice as ToolChoice<Record<string, Tool>> | undefined,
      messages: messageHistory,
      onChunk: async (chunk) => {
        switch (chunk.chunk.type) {
          case "text-delta":
          case "reasoning-delta": {
            if (!assistantStreaming) {
              Logger.beginStreamingMessage("assistant");
              assistantStreaming = true;
            }
            Logger.appendStreamingText(chunk.chunk.text);
            break;
          }
          case "tool-call": {
            if (assistantStreaming) {
              Logger.finishStreamingMessage();
              assistantStreaming = false;
            }
            Logger.streamToolCall(chunk.chunk.toolName, chunk.chunk.input);
            break;
          }
          case "tool-result": {
            Logger.streamToolResult(chunk.chunk.toolName, chunk.chunk.output);
            break;
          }
          default:
            break;
        }
      },
    });

    await streamResult.consumeStream();

    if (assistantStreaming) {
      Logger.finishStreamingMessage();
      assistantStreaming = false;
    }

    const stepUsage = await streamResult.usage;
    const cumulativeUsage = await streamResult.totalUsage;

    inputTokensUsed = accumulateTokenCount(
      inputTokensUsed,
      stepUsage.inputTokens,
    );
    outputTokensUsed = accumulateTokenCount(
      outputTokensUsed,
      stepUsage.outputTokens,
    );

    const totalTokens =
      stepUsage.totalTokens ?? cumulativeUsage.totalTokens;
    totalTokensUsed = accumulateTokenCount(totalTokensUsed, totalTokens);

    const toolNamesForStep = extractToolNamesAsArray(
      await streamResult.toolCalls,
    );
    if (toolNamesForStep.length) {
      toolsCalled.push(...toolNamesForStep);
    }

    const responseMessages = ((await streamResult.response)?.messages ??
      []) as ModelMessage[];
    if (responseMessages.length) {
      messageHistory.push(...responseMessages);
    }

    stepCount++;

    const finishReason = await streamResult.finishReason;
    if (finishReason !== "tool-calls") {
      break;
    }
  }

  Logger.finishStreamingMessage();

  const evaluation = evaluateResults(test.expectedToolCalls, toolsCalled);
  const usage: UsageTotals = {
    inputTokens: inputTokensUsed,
    outputTokens: outputTokensUsed,
    totalTokens: totalTokensUsed,
  };

  Logger.toolSummary({
    expected: evaluation.expectedToolCalls,
    actual: evaluation.toolsCalled,
    missing: evaluation.missing,
    unexpected: evaluation.unexpected,
    passed: evaluation.passed,
  });

  Logger.testRunResult({
    passed: evaluation.passed,
    durationMs: Date.now() - runStartedAt,
    usage:
      usage.inputTokens !== undefined ||
      usage.outputTokens !== undefined ||
      usage.totalTokens !== undefined
        ? usage
        : undefined,
  });

  if (!evaluation.passed) {
    await markSuiteFailed(persistence);
  }

  await updateIterationResult(
    persistence,
    evalTestId,
    evaluation.passed,
    toolsCalled,
    usage,
    messageHistory,
  );

  return evaluation;
};

type RunTestCaseParams = {
  test: TestCase;
  testIndex: number;
  llms: LlmsConfig;
  tools: ToolMap;
  persistence: PersistenceContext;
};

const runTestCase = async ({
  test,
  testIndex,
  llms,
  tools,
  persistence,
}: RunTestCaseParams) => {
  const { runs, model, provider } = test;

  Logger.logTestGroupTitle(testIndex, test.title, provider, model);

  let passedRuns = 0;
  let failedRuns = 0;

  const testCaseId = await createTestCaseRecord(persistence, test, testIndex);

  for (let runIndex = 0; runIndex < runs; runIndex++) {
    const evaluation = await runIteration({
      test,
      runIndex,
      totalRuns: runs,
      llms,
      tools,
      persistence,
      testCaseId,
    });

    if (evaluation.passed) {
      passedRuns++;
    } else {
      failedRuns++;
    }
  }

  await updateTestCaseResult(persistence, testCaseId, passedRuns, failedRuns);

  return { passedRuns, failedRuns };
};

export const runEvals = async (
  tests: unknown,
  environment: unknown,
  llms: unknown,
  apiKey?: string,
) => {
  await ensureApiKeyIsValid(apiKey);

  const { validatedTests, validatedLlms, vercelTools, serverNames } =
    await prepareSuite(tests, environment, llms);

  const suiteStartedAt = Date.now();
  const totalPlannedTests = validatedTests.reduce(
    (sum, current) => sum + (current?.runs ?? 0),
    0,
  );

  const configSummary: ConfigSummary = {
    tests: validatedTests,
    environment: { servers: serverNames },
    llms: Object.keys(validatedLlms ?? {}),
  };

  const persistence = createPersistenceContext(
    apiKey,
    configSummary,
    totalPlannedTests,
  );
  await ensureSuiteRecord(persistence);

  let passedRuns = 0;
  let failedRuns = 0;

  for (let index = 0; index < validatedTests.length; index++) {
    const test = validatedTests[index];
    if(test) {
      const { passedRuns: casePassed, failedRuns: caseFailed } =
      await runTestCase({
        test,
        testIndex: index + 1,
        llms: validatedLlms,
        tools: vercelTools,
        persistence,
      });
      passedRuns += casePassed;
      failedRuns += caseFailed;
    }
  }

  Logger.suiteComplete({
    durationMs: Date.now() - suiteStartedAt,
    passed: passedRuns,
    failed: failedRuns,
  });

  await finalizeSuiteStatus(persistence, failedRuns);
};
