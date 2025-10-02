import { MCPClient, MCPClientOptions } from "@mastra/mcp";
import { streamText, Tool, ToolChoice, ModelMessage, LanguageModel } from "ai";
import { ConvexHttpClient } from "convex/browser";
import { getUserIdFromApiKeyOrNull } from "../db/user";
import {
  createRunRecorder,
  createRunRecorderWithAuth,
  type SuiteConfig,
  type RunRecorder,
  type UsageTotals,
} from "../db/tests";
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
import { evaluateResults } from "./evaluator";
import { getUserId } from "../utils/user-id";
import { hogClient } from "../utils/hog";

const MAX_STEPS = 20;

type ToolMap = Record<string, Tool>;
type EvaluationResult = ReturnType<typeof evaluateResults>;

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
  const mcpClientOptions = validateAndNormalizeMCPClientConfiguration(
    environment,
  ) as MCPClientOptions;
  const validatedTests = validateTestCase(tests) as TestCase[];
  const validatedLlms = validateLlms(llms) as LlmsConfig;

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
  };
};

type RunIterationParams = {
  test: TestCase;
  runIndex: number;
  totalRuns: number;
  llms: LlmsConfig;
  tools: ToolMap;
  recorder: RunRecorder;
  testCaseId?: string;
};

const runIteration = async ({
  test,
  runIndex,
  totalRuns,
  llms,
  tools,
  recorder,
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
  const iterationId = await recorder.startIteration({
    testCaseId,
    iterationNumber: runIndex + 1,
    startedAt: runStartedAt,
  });

  while (stepCount < MAX_STEPS) {
    let assistantStreaming = false;

    const streamResult = await streamText({
      model: createLlmModel(provider, model, llms) as LanguageModel,
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

    const totalTokens = stepUsage.totalTokens ?? cumulativeUsage.totalTokens;
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

  await recorder.finishIteration({
    iterationId,
    passed: evaluation.passed,
    toolsCalled,
    usage,
    messages: messageHistory,
  });

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

  return evaluation;
};

type RunTestCaseParams = {
  test: TestCase;
  testIndex: number;
  llms: LlmsConfig;
  tools: ToolMap;
  recorder: RunRecorder;
};

const runTestCase = async ({
  test,
  testIndex,
  llms,
  tools,
  recorder,
}: RunTestCaseParams) => {
  const { runs, model, provider } = test;

  Logger.logTestGroupTitle(testIndex, test.title, provider, model);

  let passedRuns = 0;
  let failedRuns = 0;

  const testCaseId = await recorder.recordTestCase(test, testIndex);

  for (let runIndex = 0; runIndex < runs; runIndex++) {
    const evaluation = await runIteration({
      test,
      runIndex,
      totalRuns: runs,
      llms,
      tools,
      recorder,
      testCaseId,
    });

    if (evaluation.passed) {
      passedRuns++;
    } else {
      failedRuns++;
    }
  }
  return { passedRuns, failedRuns };
};

export const runEvals = async (
  tests: unknown,
  environment: unknown,
  llms: unknown,
  apiKey?: string,
) => {
  Logger.info("[runEvals] Starting eval suite with API key authentication");
  await ensureApiKeyIsValid(apiKey);

  const { validatedTests, validatedLlms, vercelTools, serverNames } =
    await prepareSuite(tests, environment, llms);

  Logger.info(
    `[runEvals] Suite prepared: ${validatedTests.length} tests, ${serverNames.length} servers`,
  );

  const suiteStartedAt = Date.now();
  const suiteConfig: SuiteConfig = {
    tests: validatedTests,
    environment: { servers: serverNames },
  };

  const recorder = createRunRecorder(apiKey, suiteConfig);
  await recorder.ensureSuite();

  let passedRuns = 0;
  let failedRuns = 0;

  for (let index = 0; index < validatedTests.length; index++) {
    const test = validatedTests[index];
    if (!test) {
      continue;
    }
    Logger.info(`[runEvals] Running test ${index + 1}/${validatedTests.length}: ${test.title}`);
    const { passedRuns: casePassed, failedRuns: caseFailed } =
      await runTestCase({
        test,
        testIndex: index + 1,
        llms: validatedLlms,
        tools: vercelTools,
        recorder,
      });
    passedRuns += casePassed;
    failedRuns += caseFailed;
  }
  hogClient.capture({
    distinctId: getUserId(),
    event: "evals suite complete",
    properties: {
      environment: process.env.ENVIRONMENT,
    },
  });
  Logger.suiteComplete({
    durationMs: Date.now() - suiteStartedAt,
    passed: passedRuns,
    failed: failedRuns,
  });
};

export const runEvalsWithAuth = async (
  tests: unknown,
  environment: unknown,
  llms: unknown,
  convexClient: ConvexHttpClient,
) => {
  Logger.info("[runEvalsWithAuth] Starting eval suite with session authentication");

  const { validatedTests, validatedLlms, vercelTools, serverNames } =
    await prepareSuite(tests, environment, llms);

  Logger.info(
    `[runEvalsWithAuth] Suite prepared: ${validatedTests.length} tests, ${serverNames.length} servers`,
  );

  const suiteStartedAt = Date.now();
  const suiteConfig: SuiteConfig = {
    tests: validatedTests,
    environment: { servers: serverNames },
  };

  const recorder = createRunRecorderWithAuth(convexClient, suiteConfig);
  await recorder.ensureSuite();

  let passedRuns = 0;
  let failedRuns = 0;

  for (let index = 0; index < validatedTests.length; index++) {
    const test = validatedTests[index];
    if (!test) {
      continue;
    }
    Logger.info(
      `[runEvalsWithAuth] Running test ${index + 1}/${validatedTests.length}: ${test.title}`,
    );
    const { passedRuns: casePassed, failedRuns: caseFailed } =
      await runTestCase({
        test,
        testIndex: index + 1,
        llms: validatedLlms,
        tools: vercelTools,
        recorder,
      });
    passedRuns += casePassed;
    failedRuns += caseFailed;
  }
  hogClient.capture({
    distinctId: getUserId(),
    event: "evals suite complete",
    properties: {
      environment: process.env.ENVIRONMENT,
    },
  });
  Logger.suiteComplete({
    durationMs: Date.now() - suiteStartedAt,
    passed: passedRuns,
    failed: failedRuns,
  });
};
