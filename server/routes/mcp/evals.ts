import { Hono } from "hono";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import {
  generateTestCases,
  type DiscoveredTool,
} from "../../services/eval-agent";
import { runEvalSuiteWithAiSdk } from "../../services/evals-runner";
import { startSuiteRunWithRecorder } from "../../services/evals/recorder";
import type { MCPClientManager } from "@/sdk";
import "../../types/hono";

// Helper to compute config revision (same as in Convex)
function normalizeForSignature(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeForSignature);
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => [key, normalizeForSignature(val)]);
    return Object.fromEntries(entries);
  }
  return value;
}

function computeConfigRevision(config: {
  tests: Array<Record<string, unknown>>;
  environment: Record<string, unknown>;
}): string {
  return JSON.stringify(normalizeForSignature(config));
}

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
      if (
        clientManager.getConnectionStatusByAttemptingPing(serverId) !==
        "connected"
      ) {
        return [] as DiscoveredTool[];
      }

      try {
        const { tools } = await clientManager.listTools(serverId);
        return tools.map((tool: any) => ({
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
  suiteId: z.string().optional(),
  suiteName: z.string().optional(),
  suiteDescription: z.string().optional(),
  tests: z.array(
    z.object({
      title: z.string(),
      query: z.string(),
      runs: z.number().int().positive(),
      model: z.string(),
      provider: z.string(),
      expectedToolCalls: z.array(
        z.object({
          toolName: z.string(),
          arguments: z.record(z.any()),
        })
      ),
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
  modelApiKeys: z.record(z.string()).optional(),
  convexAuthToken: z.string(),
  notes: z.string().optional(),
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
          details: validationResult.error.issues,
        },
        400,
      );
    }

    const {
      suiteId,
      suiteName,
      suiteDescription,
      tests,
      serverIds,
      modelApiKeys,
      convexAuthToken,
      notes,
    } =
      validationResult.data as RunEvalsRequest;

    if (!suiteId && (!suiteName || suiteName.trim().length === 0)) {
      return c.json(
        {
          error: "Provide suiteId or suiteName",
        },
        400,
      );
    }

    const clientManager = c.mcpClientManager;
    const resolvedServerIds = resolveServerIdsOrThrow(serverIds, clientManager);

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

    const suiteConfigPayload = {
      tests,
      environment: { servers: resolvedServerIds },
    };

    let resolvedSuiteId = suiteId ?? null;

    if (resolvedSuiteId) {
      // Compute revision of new config to compare with current
      const newConfigRevision = computeConfigRevision(suiteConfigPayload);

      // Get current suite data to access its configRevision
      // We'll fetch the suite details which includes the config
      const suiteOverview = await convexClient.query("evals:getSuiteOverview" as any, {});
      const currentSuite = suiteOverview?.find((entry: any) => entry.suite._id === resolvedSuiteId)?.suite;
      const currentConfigRevision = currentSuite?.configRevision || null;

      // Check if config actually changed by comparing revisions
      const configChanged = currentConfigRevision !== newConfigRevision;

      if (configChanged) {
        // Config changed: update suite (this will mark old runs as inactive)
        await convexClient.mutation(
          "evals:updateSuite" as any,
          {
            suiteId: resolvedSuiteId,
            name: suiteName,
            description: suiteDescription,
            config: suiteConfigPayload,
          },
        );
      } else {
        // Config unchanged: just update name/description
        // This keeps old runs active for trend continuity
        await convexClient.mutation(
          "evals:updateSuite" as any,
          {
            suiteId: resolvedSuiteId,
            name: suiteName,
            description: suiteDescription,
            // Don't pass config - preserves run history
          },
        );
      }
    } else {
      const createdSuite = await convexClient.mutation(
        "evals:createSuite" as any,
        {
          name: suiteName!,
          description: suiteDescription,
          config: suiteConfigPayload,
        },
      );

      if (!createdSuite?._id) {
        throw new Error("Failed to create suite");
      }

      resolvedSuiteId = createdSuite._id as string;
    }

    const {
      runId,
      config: runConfig,
      recorder,
    } = await startSuiteRunWithRecorder({
      convexClient,
      suiteId: resolvedSuiteId,
      notes,
    });

    try {
      await runEvalSuiteWithAiSdk({
        suiteId: resolvedSuiteId,
        runId,
        config: runConfig,
        modelApiKeys: modelApiKeys ?? undefined,
        convexClient,
        convexHttpUrl,
        convexAuthToken,
        mcpClientManager: clientManager,
        recorder,
      });

      return c.json({
        success: true,
        suiteId: resolvedSuiteId,
        runId,
        message: "Evals completed successfully. Check the Evals tab for results.",
      });
    } catch (evalError) {
      const errorMessage =
        evalError instanceof Error ? evalError.message : String(evalError);
      console.error("[Error running evals]:", errorMessage);
      return c.json(
        {
          error: errorMessage,
        },
        500,
      );
    }
  } catch (runError) {
    const errorMessage =
      runError instanceof Error ? runError.message : String(runError);
    console.error("[Error running evals]:", errorMessage);
    return c.json(
      {
        error: errorMessage,
      },
      500,
    );
  }
});

evals.post("/cancel", async (c) => {
  try {
    const body = await c.req.json();
    const { runId, convexAuthToken } = body;

    if (!runId) {
      return c.json({ error: "runId is required" }, 400);
    }

    if (!convexAuthToken) {
      return c.json({ error: "convexAuthToken is required" }, 401);
    }

    const convexUrl = process.env.CONVEX_URL;
    if (!convexUrl) {
      throw new Error("CONVEX_URL is not set");
    }

    const convexClient = new ConvexHttpClient(convexUrl);
    convexClient.setAuth(convexAuthToken);

    await convexClient.mutation("evals:cancelSuiteRun" as any, {
      runId,
    });

    return c.json({
      success: true,
      message: "Run cancelled successfully",
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("[Error cancelling run]:", errorMessage);

    // Check for specific error messages
    if (errorMessage.includes("Cannot cancel run")) {
      return c.json({ error: errorMessage }, 400);
    }
    if (errorMessage.includes("not found or unauthorized")) {
      return c.json({ error: errorMessage }, 404);
    }

    return c.json({ error: errorMessage }, 500);
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
          details: validationResult.error.issues,
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
