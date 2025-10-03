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
import { isMCPJamProvidedModel } from "../../../shared/types";
import { executeToolCallsFromMessages } from "../../../shared/http-tool-calls";
import {
  runBackendConversation,
  type BackendToolCallEvent,
  type BackendToolResultEvent,
} from "../../../shared/backend-conversation";

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
  validatedTests: TestCase[],
  mcpClientOptions: MCPClientOptions,
  validatedLlms: LlmsConfig,
) => {
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
    mcpClient,
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

type RunIterationViaBackendParams = RunIterationParams & {
  convexUrl: string;
  authToken: string;
};

const runIterationViaBackend = async ({
  test,
  runIndex,
  totalRuns,
  tools,
  recorder,
  testCaseId,
  convexUrl,
  authToken,
}: RunIterationViaBackendParams): Promise<EvaluationResult> => {
  const { advancedConfig, query } = test;
  const { system } = advancedConfig ?? {};

  Logger.testRunStart({
    runNumber: runIndex + 1,
    totalRuns,
    provider: test.provider,
    model: test.model,
    temperature: advancedConfig?.temperature,
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

  const runStartedAt = Date.now();
  const iterationId = await recorder.startIteration({
    testCaseId,
    iterationNumber: runIndex + 1,
    startedAt: runStartedAt,
  });

  // Convert tools to serializable format for backend
  const toolDefs = Object.entries(tools).map(([name, tool]) => ({
    name,
    description: tool?.description,
    inputSchema: tool?.inputSchema,
  }));

  try {
    await runBackendConversation({
      maxSteps: MAX_STEPS,
      messageHistory,
      toolDefinitions: toolDefs,
      fetchBackend: async (payload) => {
        try {
          const res = await fetch(`${convexUrl}/streaming`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
            },
            body: JSON.stringify(payload),
          });

          if (!res.ok) {
            console.error(`Backend request failed: ${res.statusText}`);
            return null;
          }

          const data = await res.json();

          if (!data?.ok || !Array.isArray(data.messages)) {
            console.error("Invalid response from backend");
            return null;
          }

          return data;
        } catch (error) {
          console.error(
            `Backend fetch error: ${error instanceof Error ? error.message : String(error)}`,
          );
          return null;
        }
      },
      executeToolCalls: async (messages) => {
        await executeToolCallsFromMessages(messages, {
          tools: tools as any,
        });
      },
      handlers: {
        onAssistantText: (text) => {
          Logger.conversation({
            messages: [{ role: "assistant", content: text }],
          });
        },
        onToolCall: (call: BackendToolCallEvent) => {
          toolsCalled.push(call.name);
          const parameters =
            call.params && typeof call.params === "object"
              ? (call.params as Record<string, unknown>)
              : {};
          Logger.streamToolCall(call.name, parameters);
        },
        onToolResult: (result: BackendToolResultEvent) => {
          Logger.streamToolResult(result.toolName ?? "", result.result);
        },
      },
    });
  } catch (error) {
    Logger.errorWithExit(
      `Backend execution error: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const evaluation = evaluateResults(test.expectedToolCalls, toolsCalled);

  const usage: UsageTotals = {
    inputTokens: undefined,
    outputTokens: undefined,
    totalTokens: undefined,
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
    usage: undefined,
  });

  return evaluation;
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
  convexUrl?: string;
  authToken?: string;
};

const runTestCase = async ({
  test,
  testIndex,
  llms,
  tools,
  recorder,
  convexUrl,
  authToken,
}: RunTestCaseParams) => {
  const { runs, model, provider } = test;

  Logger.logTestGroupTitle(testIndex, test.title, provider, model);

  let passedRuns = 0;
  let failedRuns = 0;

  const testCaseId = await recorder.recordTestCase(test, testIndex);

  for (let runIndex = 0; runIndex < runs; runIndex++) {
    // Branch based on whether this is an MCPJam-provided model
    const usesBackend = isMCPJamProvidedModel(provider as any);

    const evaluation =
      usesBackend && convexUrl && authToken
        ? await runIterationViaBackend({
            test,
            runIndex,
            totalRuns: runs,
            llms,
            tools,
            recorder,
            testCaseId,
            convexUrl,
            authToken,
          })
        : await runIteration({
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

// Shared core logic for running evals
async function runEvalSuiteCore(
  validatedTests: TestCase[],
  mcpClientOptions: MCPClientOptions,
  validatedLlms: LlmsConfig,
  recorder: RunRecorder,
  suiteStartedAt: number,
  convexUrl?: string,
  authToken?: string,
) {
  const { vercelTools, serverNames, mcpClient } = await prepareSuite(
    validatedTests,
    mcpClientOptions,
    validatedLlms,
  );

  Logger.info(
    `[Suite prepared: ${validatedTests.length} tests, ${serverNames.length} servers`,
  );

  await recorder.ensureSuite();

  let passedRuns = 0;
  let failedRuns = 0;

  try {
    for (let index = 0; index < validatedTests.length; index++) {
      const test = validatedTests[index];
      if (!test) {
        continue;
      }
      Logger.info(
        `[Running test ${index + 1}/${validatedTests.length}: ${test.title}`,
      );
      const { passedRuns: casePassed, failedRuns: caseFailed } =
        await runTestCase({
          test,
          testIndex: index + 1,
          llms: validatedLlms,
          tools: vercelTools,
          recorder,
          convexUrl,
          authToken,
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
  } finally {
    // Clean up the MCP client after all evals complete
    await mcpClient.disconnect();
  }
}

export const runEvalsWithApiKey = async (
  tests: unknown,
  environment: unknown,
  llms: unknown,
  apiKey?: string,
) => {
  const suiteStartedAt = Date.now();
  Logger.info("Starting eval suite with API key authentication");
  await ensureApiKeyIsValid(apiKey);

  // prepareSuite is called inside runEvalSuiteCore, so we need to prepare config here
  const mcpClientOptions = validateAndNormalizeMCPClientConfiguration(
    environment,
  ) as MCPClientOptions;
  const validatedTests = validateTestCase(tests) as TestCase[];
  const validatedLlms = validateLlms(llms) as LlmsConfig;

  const serverNames = Object.keys(mcpClientOptions.servers);

  const suiteConfig: SuiteConfig = {
    tests: validatedTests,
    environment: { servers: serverNames },
  };

  const recorder = createRunRecorder(apiKey, suiteConfig);

  await runEvalSuiteCore(
    validatedTests,
    mcpClientOptions,
    validatedLlms,
    recorder,
    suiteStartedAt,
  );
};

export const runEvalsWithAuth = async (
  tests: unknown,
  environment: unknown,
  llms: unknown,
  convexClient: ConvexHttpClient,
  convexUrl?: string,
  authToken?: string,
) => {
  const suiteStartedAt = Date.now();
  Logger.info("Starting eval suite with session authentication");

  // prepareSuite is called inside runEvalSuiteCore, so we need to prepare config here
  const mcpClientOptions = validateAndNormalizeMCPClientConfiguration(
    environment,
  ) as MCPClientOptions;
  const validatedTests = validateTestCase(tests) as TestCase[];
  const validatedLlms = validateLlms(llms) as LlmsConfig;

  const serverNames = Object.keys(mcpClientOptions.servers);

  const suiteConfig: SuiteConfig = {
    tests: validatedTests,
    environment: { servers: serverNames },
  };

  const recorder = createRunRecorderWithAuth(convexClient, suiteConfig);

  await runEvalSuiteCore(
    validatedTests,
    mcpClientOptions,
    validatedLlms,
    recorder,
    suiteStartedAt,
    convexUrl,
    authToken,
  );
};
