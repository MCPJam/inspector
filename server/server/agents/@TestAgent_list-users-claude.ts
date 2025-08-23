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
  },
  "linear": {
    "url": "https://mcp.linear.app/mcp",
    "requestInit": {
      "headers": {
        "Authorization": "Bearer 553ad7de-32b5-4275-a303-ca9de7bfe5e4:9WZ3nqLjZVfi1CuS:A4OkdFcE87OrYqZidSI5GtjXoJMWmPaG"
      }
    },
    "oauth": {
      "access_token": "553ad7de-32b5-4275-a303-ca9de7bfe5e4:9WZ3nqLjZVfi1CuS:A4OkdFcE87OrYqZidSI5GtjXoJMWmPaG",
      "token_type": "bearer",
      "expires_in": 604800,
      "scope": "",
      "refresh_token": "553ad7de-32b5-4275-a303-ca9de7bfe5e4:9WZ3nqLjZVfi1CuS:oF5pRBvL8WmZmk4vbi15R5eWMBBuappp"
    }
  }
} as const;

function createModel() {
  const def = {"id":"claude-3-5-sonnet-latest","name":"Claude Sonnet 3.5","provider":"anthropic"} as any;
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
    name: "list users claude",
    instructions: "list users",
    model: createModel(),
    tools: undefined,
    defaultGenerateOptions: { toolChoice: "auto" }
  });
};
