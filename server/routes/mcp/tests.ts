import { Hono } from "hono";
import { writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";

const tests = new Hono();

// Generate a @TestAgent.ts file for a saved test with selected servers
tests.post("/generate", async (c) => {
  try {
    const body = await c.req.json();
    const test = body?.test;
    const servers = body?.servers as Record<string, any>;
    const model = body?.model as { id: string; provider: string } | undefined;

    if (!test?.id || !test?.prompt || !servers || Object.keys(servers).length === 0) {
      return c.json({ success: false, error: "Missing test, servers, or prompt" }, 400);
    }

    const safeName = String(test.title || test.id)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
    const filename = `@TestAgent_${safeName || test.id}.ts`;

    const fileContents = `import { Agent } from "@mastra/core/agent";
import { MCPClient } from "@mastra/mcp";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOllama } from "ollama-ai-provider";

const servers = ${JSON.stringify(servers, null, 2)} as const;

function createModel() {
  const def = ${JSON.stringify(model || null)} as any;
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
    name: ${JSON.stringify(test.title || "Test Agent")},
    instructions: ${JSON.stringify(test.prompt)},
    model: createModel(),
    tools: undefined,
    defaultGenerateOptions: { toolChoice: "auto" }
  });
};
`;

    const targetPath = join(process.cwd(), "server", "agents", filename);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, fileContents, "utf8");
    return c.json({ success: true, file: `server/agents/${filename}` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return c.json({ success: false, error: msg }, 500);
  }
});

export default tests;


