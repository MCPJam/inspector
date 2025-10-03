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
import { hasUnresolvedToolCalls, executeToolCallsFromMessages } from "../../../shared/http-tool-calls";

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
  let stepCount = 0;

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

  while (stepCount < MAX_STEPS) {
    try {
      const res = await fetch(`${convexUrl}/streaming`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          tools: toolDefs,
          messages: JSON.stringify(messageHistory),
        }),
      });

      if (!res.ok) {
        throw new Error(`Backend request failed: ${res.statusText}`);
      }

      const data = await res.json();

      if (!data?.ok || !Array.isArray(data.messages)) {
        throw new Error("Invalid response from backend");
      }

      // Process response messages
      for (const msg of data.messages as ModelMessage[]) {
        messageHistory.push(msg);

        if ((msg as any).role === "assistant" && Array.isArray((msg as any).content)) {
          for (const c of (msg as any).content) {
            if (c?.type === "text" && typeof c.text === "string") {
              Logger.conversation({ messages: [{ role: "assistant", content: c.text }] });
            } else if (c?.type === "tool-call") {
              const toolName = c.toolName || c.name;
              toolsCalled.push(toolName);
              Logger.streamToolCall(toolName, c.input || c.parameters || c.args || {});
            }
          }
        }
      }

      // Execute unresolved tool calls locally
      const beforeLen = messageHistory.length;
      if (hasUnresolvedToolCalls(messageHistory as any)) {
        await executeToolCallsFromMessages(messageHistory as ModelMessage[], {
          tools: tools as any,
        });
        const newMsgs = messageHistory.slice(beforeLen);
        for (const m of newMsgs) {
          if ((m as any).role === "tool" && Array.isArray((m as any).content)) {
            for (const tc of (m as any).content) {
              if (tc.type === "tool-result") {
                const out = tc.output;
                const value =
                  out && typeof out === "object" && "value" in out
                    ? out.value
                    : out;
                Logger.streamToolResult(tc.toolName, value);
              }
            }
          }
        }
      } else {
        break;
      }

      stepCount++;
    } catch (error) {
      Logger.errorWithExit(
        `Backend execution error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
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

    const evaluation = usesBackend && convexUrl && authToken
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
