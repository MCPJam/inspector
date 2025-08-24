import { Agent } from "@mastra/core/agent";
import { MCPClient } from "@mastra/mcp";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOllama } from "ollama-ai-provider";

const servers = {
  "everything": {
    "command": "npx",
    "args": [
      "@modelcontextprotocol/server-everything"
    ],
    "env": {}
  }
} as const;

function createModel() {
  const def = {"id":"o4-mini","name":"O4 Mini","provider":"openai"} as any;
  if (!def) throw new Error("Model not provided by UI when generating test agent");
  switch (def.provider) {
    case "anthropic": return createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })(def.id);
    case "openai": return createOpenAI({ apiKey: process.env.OPENAI_API_KEY! })(def.id);
    case "deepseek": return createOpenAI({ apiKey: process.env.DEEPSEEK_API_KEY!, baseURL: "https://api.deepseek.com/v1" })(def.id);
    case "ollama": return createOllama({ baseURL: process.env.OLLAMA_BASE_URL || "http://localhost:11434" })(def.id, { simulateStreaming: true });
    default: throw new Error("Unsupported provider: " + def.provider);
  }
}

export const createTestAgent = async () => {
  const mcp = new MCPClient({ servers });
  const toolsets = await mcp.getToolsets();
  return new Agent({
    name: "list users open ai no linearfe",
    instructions: "list users",
    model: createModel(),
    tools: undefined,
    defaultGenerateOptions: { toolChoice: "auto" }
  });
};
