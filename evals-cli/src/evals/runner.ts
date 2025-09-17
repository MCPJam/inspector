import { MCPClient } from "@mastra/mcp";
import { generateText, Tool, ToolChoice, ModelMessage } from "ai";
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
  Logger.serverConnection(serverCount, toolCount);
  Logger.startTests(validatedTests.length);

  const vercelTools = convertMastraToolsToVercelTools(availableTools);

  const suiteStartedAt = Date.now();
  let passedRuns = 0;
  let failedRuns = 0;

  for (const test of validatedTests) {
    const { runs, model, provider, advancedConfig, query } = test;
    Logger.testTitle(test.title);
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
      const maxSteps = 5;
      let stepCount = 0;

      if (system) {
        Logger.conversation({
          messages: [{ role: "system", content: system }],
          indentLevel: 2,
        });
      }

      const userMessage: ModelMessage = {
        role: "user",
        content: query,
      };

      Logger.conversation({ messages: [userMessage], indentLevel: 2 });

      const messageHistory: ModelMessage[] = [userMessage];
      const toolsCalled: string[] = [];

      while (stepCount < maxSteps) {
        const result = await generateText({
          model: createLlmModel(provider, model, validatedLlmApiKeys),
          system,
          temperature,
          tools: vercelTools,
          toolChoice: toolChoice as ToolChoice<NoInfer<Record<string, Tool>>>,
          messages: messageHistory,
        });

        const toolNamesForStep = extractToolNamesAsArray(result.toolCalls);
        if (toolNamesForStep.length) {
          toolsCalled.push(...toolNamesForStep);
        }
        const responseMessages = (result.response?.messages ?? []) as ModelMessage[];
        if (responseMessages.length) {
          messageHistory.push(...responseMessages);
          Logger.conversation({
            messages: responseMessages,
            indentLevel: 2,
          });
        }

        stepCount++;

        if (result.finishReason !== "tool-calls") {
          break;
        }
      }

      const evaluation = evaluateResults(
        test.expectedToolCalls,
        toolsCalled,
      );

      Logger.toolSummary({
        expected: evaluation.expectedToolCalls,
        actual: evaluation.toolsCalled,
        missing: evaluation.missing,
        unexpected: evaluation.unexpected,
        passed: evaluation.passed,
        indentLevel: 2,
      });

      Logger.testRunResult({
        passed: evaluation.passed,
        durationMs: Date.now() - runStartedAt,
        indentLevel: 2,
      });

      if (evaluation.passed) {
        passedRuns++;
      } else {
        failedRuns++;
      }
    }
  }

  Logger.suiteComplete({
    durationMs: Date.now() - suiteStartedAt,
    passed: passedRuns,
    failed: failedRuns,
  });
};
