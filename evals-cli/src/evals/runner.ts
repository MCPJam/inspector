import { MCPClient } from "@mastra/mcp";
import { streamText, Tool, ToolChoice, ModelMessage } from "ai";
import { getUserIdFromApiKeyOrNull } from "../db/user";
import {
  convertMastraToolsToVercelTools,
  validateAndNormalizeMCPClientConfiguration,
  validateLlms,
  validateTestCase,
} from "../utils/validators";
import { createLlmModel, extractToolNamesAsArray } from "../utils/helpers";
import { Logger } from "../utils/logger";
import { evaluateResults } from "./evaluator";

const accumulateTokenCount = (
  current: number | undefined,
  increment: number | undefined,
): number | undefined => {
  if (typeof increment !== "number" || Number.isNaN(increment)) {
    return current;
  }

  return (current ?? 0) + increment;
};

export const runEvals = async (
  tests: any,
  environment: any,
  llms: any,
  apiKey?: string,
) => {
  // Only validate API key if provided
  if (apiKey) {
    await getUserIdFromApiKeyOrNull(apiKey);
  }

  const mcpClientOptions =
    validateAndNormalizeMCPClientConfiguration(environment);
  const validatedTests = validateTestCase(tests);
  const validatedLlmApiKeys = validateLlms(llms);

  const mcpClient = new MCPClient(mcpClientOptions);

  const availableTools = await mcpClient.getTools();
  const serverCount = Object.keys(mcpClientOptions.servers).length;
  const toolCount = Object.keys(availableTools).length;
  const serverNames = Object.keys(mcpClientOptions.servers);

  Logger.initiateTestMessage(
    serverCount,
    toolCount,
    serverNames,
    validatedTests.length,
  );

  const vercelTools = convertMastraToolsToVercelTools(availableTools);

  const suiteStartedAt = Date.now();
  let passedRuns = 0;
  let failedRuns = 0;

  let testNumber = 1;
  for (const test of validatedTests) {
    const { runs, model, provider, advancedConfig, query } = test;
    Logger.logTestGroupTitle(testNumber, test.title, provider, model);
    const numberOfRuns = runs;
    const { system, temperature, toolChoice } = advancedConfig ?? {};

    for (let run = 0; run < numberOfRuns; run++) {
      Logger.testRunStart({
        runNumber: run + 1,
        totalRuns: numberOfRuns,
        provider,
        model,
        temperature,
      });
      const runStartedAt = Date.now();
      const maxSteps = 20;
      let stepCount = 0;
      let inputTokensUsed: number | undefined;
      let outputTokensUsed: number | undefined;
      let totalTokensUsed: number | undefined;

      if (system) {
        Logger.conversation({
          messages: [{ role: "system", content: system }],
        });
      }

      const userMessage: ModelMessage = {
        role: "user",
        content: query,
      };

      Logger.conversation({ messages: [userMessage] });

      const messageHistory: ModelMessage[] = [userMessage];
      const toolsCalled: string[] = [];

      while (stepCount < maxSteps) {
        let assistantStreaming = false;

        const streamResult = await streamText({
          model: createLlmModel(provider, model, validatedLlmApiKeys),
          system,
          temperature,
          tools: vercelTools,
          toolChoice: toolChoice as ToolChoice<NoInfer<Record<string, Tool>>>,
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
                Logger.streamToolResult(
                  chunk.chunk.toolName,
                  chunk.chunk.output,
                );
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
          inputTokensUsed !== undefined ||
          outputTokensUsed !== undefined ||
          totalTokensUsed !== undefined
            ? {
                inputTokens: inputTokensUsed,
                outputTokens: outputTokensUsed,
                totalTokens: totalTokensUsed,
              }
            : undefined,
      });

      if (evaluation.passed) {
        passedRuns++;
      } else {
        failedRuns++;
      }
    }
    testNumber++;
  }

  Logger.suiteComplete({
    durationMs: Date.now() - suiteStartedAt,
    passed: passedRuns,
    failed: failedRuns,
  });
};
