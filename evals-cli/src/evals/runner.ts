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
import { evaluateResults } from "./evaluator";

export const runEvals = async (
  tests: any,
  environment: any,
  llms: any,
  apiKey: string,
) => {
  await getUserIdFromApiKeyOrNull(apiKey);

  const mcpClientOptions =
    validateAndNormalizeMCPClientConfiguration(environment);
  const validatedTests = validateTestCase(tests);
  const validatedLlmApiKeys = validateLlms(llms);
  
  console.log("mcpClientOptions: ", mcpClientOptions);
  const mcpClient = new MCPClient(mcpClientOptions);

  for (const test of validatedTests) {
    const { runs, model, provider, advancedConfig, query } = test;
    const numberOfRuns = runs;
    const { system, temperature, toolChoice } = advancedConfig ?? {};

    for (let run = 0; run < numberOfRuns; run++) {
      const maxSteps = 20;
      let stepCount = 0;

      let messages: ModelMessage[] = [
        {
          role: "user",
          content: query,
        },
      ];
      let toolsCalled: string[] = [];

      let result = await generateText({
        model: createLlmModel(provider, model, validatedLlmApiKeys),
        system,
        temperature,
        tools: convertMastraToolsToVercelTools(await mcpClient.getTools()),
        toolChoice: toolChoice as ToolChoice<NoInfer<Record<string, Tool>>>,
        messages,
      });
      toolsCalled.push(...extractToolNamesAsArray(result.toolCalls));
      messages.push(...(result.response as any).messages);

      while (result.finishReason === "tool-calls" && stepCount < maxSteps) {
        stepCount++;
        result = await generateText({
          model: createLlmModel(provider, model, validatedLlmApiKeys),
          system,
          temperature,
          tools: convertMastraToolsToVercelTools(await mcpClient.getTools()),
          toolChoice: toolChoice as ToolChoice<NoInfer<Record<string, Tool>>>,
          messages,
        });
        toolsCalled.push(...extractToolNamesAsArray(result.toolCalls));
        messages.push(...(result.response as any).messages);
      }

      evaluateResults(messages, test.expectedToolCalls, toolsCalled);
    }
  }
};
