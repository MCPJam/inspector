import {
  generateText,
  type ModelMessage,
  type ToolSet,
  type Tool as AiTool,
  type ToolChoice,
} from "ai";
import {
  createRunRecorderWithAuth,
  type RunRecorder,
  type SuiteConfig,
  type UsageTotals,
} from "../../evals-cli/src/db/tests";
import { evaluateResults } from "../../evals-cli/src/evals/evaluator";
import type { MCPClientManager } from "@/sdk";
import { createLlmModel } from "../utils/chat-helpers";
import {
  getModelById,
  isMCPJamProvidedModel,
  type ModelDefinition,
  type ModelProvider,
} from "@/shared/types";
import zodToJsonSchema from "zod-to-json-schema";
import {
  executeToolCallsFromMessages,
  hasUnresolvedToolCalls,
} from "@/shared/http-tool-calls";
import type { ConvexHttpClient } from "convex/browser";

export type EvalTestCase = {
  title: string;
  query: string;
  runs: number;
  model: string;
  provider: string;
  expectedToolCalls: string[];
  judgeRequirement?: string;
  advancedConfig?: {
    system?: string;
    temperature?: number;
    toolChoice?: string;
  } & Record<string, unknown>;
};

export type RunEvalSuiteOptions = {
  tests: EvalTestCase[];
  serverIds: string[];
  modelApiKey?: string | null;
  convexClient: ConvexHttpClient;
  convexHttpUrl: string;
  convexAuthToken: string;
  mcpClientManager: MCPClientManager;
};

const MAX_STEPS = 20;

const extractToolNames = (toolCalls: Array<{ toolName?: string }> = []) => {
  return toolCalls
    .map((call) => call.toolName)
    .filter((name): name is string => Boolean(name));
};

type RunIterationBaseParams = {
  test: EvalTestCase;
  runIndex: number;
  tools: ToolSet;
  recorder: RunRecorder;
  testCaseId?: string;
};

type RunIterationAiSdkParams = RunIterationBaseParams & {
  modelDefinition: ModelDefinition;
  apiKey: string;
};

type RunIterationBackendParams = RunIterationBaseParams & {
  convexHttpUrl: string;
  convexAuthToken: string;
};

const buildModelDefinition = (test: EvalTestCase): ModelDefinition => {
  return (
    getModelById(test.model) ?? {
      id: test.model,
      name: test.title || String(test.model),
      provider: test.provider as ModelProvider,
    }
  );
};

const runIterationWithAiSdk = async ({
  test,
  runIndex,
  tools,
  recorder,
  testCaseId,
  modelDefinition,
  apiKey,
}: RunIterationAiSdkParams) => {
  const { advancedConfig, query, expectedToolCalls } = test;
  const { system, temperature, toolChoice } = advancedConfig ?? {};

  const runStartedAt = Date.now();
  const iterationId = await recorder.startIteration({
    testCaseId,
    iterationNumber: runIndex + 1,
    startedAt: runStartedAt,
  });

  const baseMessages: ModelMessage[] = [];
  if (system) {
    baseMessages.push({ role: "system", content: system });
  }
  baseMessages.push({ role: "user", content: query });

  try {
    const llmModel = createLlmModel(modelDefinition, apiKey ?? "");

    const result = await generateText({
      model: llmModel,
      messages: baseMessages,
      tools,
      ...(temperature == null ? {} : { temperature }),
      ...(toolChoice
        ? { toolChoice: toolChoice as ToolChoice<Record<string, AiTool>> }
        : {}),
    });

    const toolsCalled = extractToolNames((result.toolCalls ?? []) as any);
    const evaluation = evaluateResults(expectedToolCalls, toolsCalled);

    const usage: UsageTotals = {
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
      totalTokens: result.usage?.totalTokens,
    };

    const finalMessages =
      (result.response?.messages as ModelMessage[]) ?? baseMessages;

    await recorder.finishIteration({
      iterationId,
      passed: evaluation.passed,
      toolsCalled,
      usage,
      messages: finalMessages,
    });

    return evaluation;
  } catch (error) {
    console.error("[evals] iteration failed", error);
    await recorder.finishIteration({
      iterationId,
      passed: false,
      toolsCalled: [],
      usage: {
        inputTokens: undefined,
        outputTokens: undefined,
        totalTokens: undefined,
      },
      messages: baseMessages,
    });
    return evaluateResults(expectedToolCalls, []);
  }
};

const runIterationViaBackend = async ({
  test,
  runIndex,
  tools,
  recorder,
  testCaseId,
  convexHttpUrl,
  convexAuthToken,
}: RunIterationBackendParams) => {
  const { query, expectedToolCalls, advancedConfig } = test;
  const { system: systemPrompt, temperature } = advancedConfig ?? {};

  const messageHistory: ModelMessage[] = [
    {
      role: "user",
      content: query,
    },
  ];
  const toolsCalled: string[] = [];
  const runStartedAt = Date.now();
  const iterationId = await recorder.startIteration({
    testCaseId,
    iterationNumber: runIndex + 1,
    startedAt: runStartedAt,
  });

  const toolDefs = Object.entries(tools).map(([name, tool]) => {
    const schema = (tool as any)?.inputSchema;
    let serializedSchema: Record<string, unknown> | undefined;
    if (schema) {
      if (
        typeof schema === "object" &&
        schema !== null &&
        "jsonSchema" in (schema as Record<string, unknown>)
      ) {
        serializedSchema = (schema as any).jsonSchema as Record<
          string,
          unknown
        >;
      } else if (typeof schema === "object" && "safeParse" in (schema as any)) {
        try {
          serializedSchema = zodToJsonSchema(schema) as Record<string, unknown>;
        } catch {
          serializedSchema = undefined;
        }
      } else {
        serializedSchema = schema as Record<string, unknown>;
      }
    }

    return {
      name,
      description: (tool as any)?.description,
      inputSchema:
        serializedSchema ??
        ({
          type: "object",
          properties: {},
          additionalProperties: false,
        } as Record<string, unknown>),
    };
  });

  const authHeader = convexAuthToken
    ? { Authorization: `Bearer ${convexAuthToken}` }
    : ({} as Record<string, string>);

  let steps = 0;
  while (steps < MAX_STEPS) {
    try {
      const res = await fetch(`${convexHttpUrl}/stream`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authHeader ? { ...authHeader } : {}),
        },
        body: JSON.stringify({
          mode: "step",
          messages: JSON.stringify(messageHistory),
          model: String(test.model),
          ...(systemPrompt ? { systemPrompt } : {}),
          ...(temperature == null ? {} : { temperature }),
          tools: toolDefs,
        }),
      });

      if (!res.ok) {
        console.error("[evals] backend stream error", res.statusText);
        break;
      }

      const json: any = await res.json();
      if (!json?.ok || !Array.isArray(json.messages)) {
        console.error("[evals] invalid backend response payload");
        break;
      }

      for (const msg of json.messages as any[]) {
        if (msg?.role === "assistant" && Array.isArray(msg.content)) {
          for (const item of msg.content) {
            if (item?.type === "tool-call") {
              const name = item.toolName ?? item.name;
              if (name) {
                toolsCalled.push(name);
              }
              if (!item.toolCallId) {
                item.toolCallId = `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
              }
              if (item.input == null) {
                item.input = item.parameters ?? item.args ?? {};
              }
            }
          }
        }
        messageHistory.push(msg);
      }

      if (hasUnresolvedToolCalls(messageHistory as any)) {
        await executeToolCallsFromMessages(messageHistory, {
          tools: tools as any,
        });
      }

      steps += 1;

      const finishReason: string | undefined = json.finishReason;
      if (finishReason && finishReason !== "tool-calls") {
        break;
      }
    } catch (error) {
      console.error("[evals] backend fetch failed", error);
      break;
    }
  }

  const evaluation = evaluateResults(expectedToolCalls, toolsCalled);

  await recorder.finishIteration({
    iterationId,
    passed: evaluation.passed,
    toolsCalled,
    usage: {
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
    },
    messages: messageHistory,
  });

  return evaluation;
};

const runTestCase = async (params: {
  test: EvalTestCase;
  index: number;
  tools: ToolSet;
  recorder: RunRecorder;
  modelApiKey?: string | null;
  convexHttpUrl: string;
  convexAuthToken: string;
}) => {
  const {
    test,
    index,
    tools,
    recorder,
    modelApiKey,
    convexHttpUrl,
    convexAuthToken,
  } = params;
  const testCaseId = await recorder.recordTestCase(test, index + 1);
  const modelDefinition = buildModelDefinition(test);
  const isJamModel = isMCPJamProvidedModel(String(modelDefinition.id));

  for (let runIndex = 0; runIndex < test.runs; runIndex++) {
    if (isJamModel) {
      await runIterationViaBackend({
        test,
        runIndex,
        tools,
        recorder,
        testCaseId,
        convexHttpUrl,
        convexAuthToken,
      });
      continue;
    }

    if (!modelApiKey) {
      throw new Error(
        `Missing API key for provider ${modelDefinition.provider} while running evals`,
      );
    }

    await runIterationWithAiSdk({
      test,
      runIndex,
      tools,
      recorder,
      testCaseId,
      modelDefinition,
      apiKey: modelApiKey,
    });
  }
};

export const runEvalSuiteWithAiSdk = async ({
  tests,
  serverIds,
  modelApiKey,
  convexClient,
  convexHttpUrl,
  convexAuthToken,
  mcpClientManager,
}: RunEvalSuiteOptions) => {
  if (!tests.length) {
    throw new Error("No tests supplied for eval run");
  }

  const suiteConfig: SuiteConfig = {
    tests,
    environment: { servers: serverIds },
  };

  const recorder = createRunRecorderWithAuth(convexClient, suiteConfig);
  const tools = (await mcpClientManager.getToolsForAiSdk(serverIds)) as ToolSet;

  await recorder.ensureSuite();

  for (let i = 0; i < tests.length; i++) {
    const test = tests[i];
    await runTestCase({
      test,
      index: i,
      tools,
      recorder,
      modelApiKey,
      convexHttpUrl,
      convexAuthToken,
    });
  }
};
