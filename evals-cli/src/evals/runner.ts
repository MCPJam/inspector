import { MCPClient } from "@mastra/mcp";
import { generateText } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { getUserIdFromApiKeyOrNull } from "../db/user";
import {
  convertMastraToolsToVercelTools,
  validateAndNormalizeMCPClientConfiguration,
  validateLlms,
  validateTestCase,
} from "../utils/validators";
import { createLlmModel } from "../utils/helpers";

export const runEvals = async (
  tests: any,
  environment: any,
  llms:any,
  apiKey: string,
) => {
  await getUserIdFromApiKeyOrNull(apiKey);

  const mcpClientOptions =
    validateAndNormalizeMCPClientConfiguration(environment);
  const validatedTests = validateTestCase(tests);
  const validatedLlmApiKeys = validateLlms(llms);

  const mcpClient = new MCPClient(mcpClientOptions);
  const mastraTools = await mcpClient.getTools();
  const vercelAiSdkTools = convertMastraToolsToVercelTools(mastraTools);

  for (const test of validatedTests) {
    const numberOfRuns = test.runs;
    const llm = createLlmModel(test.provider, test.model, validatedLlmApiKeys);
    for (let run = 0; run <= numberOfRuns; run++) {
      const result = await generateText({
        model: llm,
        tools: vercelAiSdkTools,
        messages: [
          {
            role: "user",
            content: "Add 2 and 3",
          },
        ],
      });
      console.log(JSON.stringify(result, null, 2));
    }
  }
};
