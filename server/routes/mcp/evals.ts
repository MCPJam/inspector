import { Hono } from "hono";
import { z } from "zod";
import { runEvalsWithAuth } from "../../../evals-cli/src/evals/runner";
import {
  transformServerConfigsToEnvironment,
  transformLLMConfigToLlmsConfig,
} from "../../utils/eval-transformer";
import { ConvexHttpClient } from "convex/browser";
import {
  generateTestCases,
  type DiscoveredTool,
} from "../../services/eval-agent";
import type { MCPClientManager } from "@/shared/mcp-client-manager";
import "../../types/hono";

function resolveServerIdsOrThrow(
  requestedIds: string[],
  clientManager: MCPClientManager,
): string[] {
  const available = clientManager.listServers();
  const resolved: string[] = [];

  for (const requestedId of requestedIds) {
    const match =
      available.find((id) => id === requestedId) ??
      available.find((id) => id.toLowerCase() === requestedId.toLowerCase());

    if (!match) {
      throw new Error(`Server '${requestedId}' not found`);
    }

    if (!resolved.includes(match)) {
      resolved.push(match);
    }
  }

  return resolved;
}

async function collectToolsForServers(
  clientManager: MCPClientManager,
  serverIds: string[],
): Promise<DiscoveredTool[]> {
  const perServerTools = await Promise.all(
    serverIds.map(async (serverId) => {
      if (clientManager.getConnectionStatus(serverId) !== "connected") {
        return [] as DiscoveredTool[];
      }

      try {
        const { tools } = await clientManager.listTools(serverId);
        return tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: (tool as { outputSchema?: unknown }).outputSchema,
          serverId,
        }));
      } catch (error) {
        console.warn(
          `[evals] Failed to list tools for server ${serverId}:`,
          error,
        );
        return [] as DiscoveredTool[];
      }
    }),
  );

  return perServerTools.flat();
}

const evals = new Hono();

const RunEvalsRequestSchema = z.object({
  tests: z.array(
    z.object({
      title: z.string(),
      query: z.string(),
      runs: z.number().int().positive(),
      model: z.string(),
      provider: z.string(),
      expectedToolCalls: z.array(z.string()),
      judgeRequirement: z.string().optional(),
      advancedConfig: z
        .object({
          system: z.string().optional(),
          temperature: z.number().optional(),
          toolChoice: z.string().optional(),
        })
        .passthrough()
        .optional(),
    }),
  ),
  serverIds: z.array(z.string()).min(1, "At least one server must be selected"),
  llmConfig: z.object({
    provider: z.string(),
    apiKey: z.string(),
  }),
  convexAuthToken: z.string(),
});

type RunEvalsRequest = z.infer<typeof RunEvalsRequestSchema>;

evals.post("/run", async (c) => {
  try {
    const body = await c.req.json();

    const validationResult = RunEvalsRequestSchema.safeParse(body);
    if (!validationResult.success) {
      return c.json(
        {
          error: "Invalid request body",
          details: validationResult.error.errors,
        },
        400,
      );
    }

    const { tests, serverIds, llmConfig, convexAuthToken } =
      validationResult.data as RunEvalsRequest;

    const clientManager = c.mcpClientManager;
    const resolvedServerIds = resolveServerIdsOrThrow(serverIds, clientManager);

    const environment = transformServerConfigsToEnvironment(
      resolvedServerIds,
      clientManager,
    );
    const modelId = tests.length > 0 ? tests[0].model : undefined;
    const llms = transformLLMConfigToLlmsConfig(llmConfig, modelId);

    const convexUrl = process.env.CONVEX_URL;
    if (!convexUrl) {
      throw new Error("CONVEX_URL is not set");
    }

    const convexHttpUrl = process.env.CONVEX_HTTP_URL;
    if (!convexHttpUrl) {
      throw new Error("CONVEX_HTTP_URL is not set");
    }

    const convexClient = new ConvexHttpClient(convexUrl);
    convexClient.setAuth(convexAuthToken);

    runEvalsWithAuth(
      tests,
      environment,
      llms,
      convexClient,
      convexHttpUrl,
      convexAuthToken,
    ).catch((error) => {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error("[Error running evals:", errorMessage);
    });

    return c.json({
      success: true,
      message: "Evals started successfully. Check the Evals tab for progress.",
    });
  } catch (error) {
    console.error("Error in /evals/run:", error);
    return c.json(
      {
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

const GenerateTestsRequestSchema = z.object({
  serverIds: z.array(z.string()).min(1, "At least one server must be selected"),
  convexAuthToken: z.string(),
});

type GenerateTestsRequest = z.infer<typeof GenerateTestsRequestSchema>;

evals.post("/generate-tests", async (c) => {
  try {
    const body = await c.req.json();

    const validationResult = GenerateTestsRequestSchema.safeParse(body);
    if (!validationResult.success) {
      return c.json(
        {
          error: "Invalid request body",
          details: validationResult.error.errors,
        },
        400,
      );
    }

    const { serverIds, convexAuthToken } =
      validationResult.data as GenerateTestsRequest;

    const clientManager = c.mcpClientManager;
    const resolvedServerIds = resolveServerIdsOrThrow(serverIds, clientManager);

    const filteredTools = await collectToolsForServers(
      clientManager,
      resolvedServerIds,
    );

    if (filteredTools.length === 0) {
      return c.json(
        {
          error: "No tools found for selected servers",
        },
        400,
      );
    }

    const convexHttpUrl = process.env.CONVEX_HTTP_URL;
    if (!convexHttpUrl) {
      throw new Error("CONVEX_HTTP_URL is not set");
    }

    // Generate test cases using the agent
    const testCases = await generateTestCases(
      filteredTools,
      convexHttpUrl,
      convexAuthToken,
    );

    return c.json({
      success: true,
      tests: testCases,
    });
  } catch (error) {
    console.error("Error in /evals/generate-tests:", error);
    return c.json(
      {
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

export default evals;
