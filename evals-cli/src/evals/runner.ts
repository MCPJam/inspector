import { MCPClient } from "@mastra/mcp";
import { generateText } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { getUserIdOrNull } from "../db/user";
import { validateAndNormalizeMCPClientConfiguration } from "../utils/mcp-helpers";
import { convertMastraToolsToVercelTools } from "../utils/mastra-to-vercel-tools";

export const runEvals = async (
  tests: any,
  environment: any,
  userId: string,
) => {
  await getUserIdOrNull(userId);

  const mcpClientOptions =
    validateAndNormalizeMCPClientConfiguration(environment);
  const mcpClient = new MCPClient(mcpClientOptions);

  const mastraTools = await mcpClient.getTools();
  const vercelAiSdkTools = convertMastraToolsToVercelTools(mastraTools);

  console.log(
    `Converted ${Object.keys(vercelAiSdkTools).length} Mastra MCP tool(s) to Vercel AI SDK tools.`,
  );
  const result = await generateText({
    model: createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY })(
      "anthropic/claude-sonnet-4",
    ),
    tools: vercelAiSdkTools,
    messages: [
      {
        role: "user",
        content: "Add 2 and 3",
      },
    ],
  });
  console.log(JSON.stringify(result, null, 2));
};
