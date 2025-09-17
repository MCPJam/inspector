import { MCPClient } from "@mastra/mcp";
import { getUserIdOrNull } from "../db/user";
import {
  MCPClientOptionsSchema,
  validateAndNormalizeMCPClientConfiguration,
} from "../utils/mcp-helpers";

export const runEvals = async (
  tests: any,
  environment: any,
  userId: string,
) => {
  console.log("Running evals");
  console.log(tests, environment, userId);
  const user = await getUserIdOrNull(userId);

  const mcpClientOptions =
    validateAndNormalizeMCPClientConfiguration(environment);
  const mcpClient = new MCPClient(mcpClientOptions);

  const tools = await mcpClient.getTools();
  console.log(tools);
  console.log(user);
};
