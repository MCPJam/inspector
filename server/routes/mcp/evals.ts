import { Hono } from "hono";
import { z } from "zod";
import { runEvalsWithAuth } from "../../../evals-cli/src/evals/runner";
import {
  transformServerConfigsToEnvironment,
  transformLLMConfigToLlmsConfig,
} from "../../utils/eval-transformer";
import { ConvexHttpClient } from "convex/browser";
import "../../types/hono";

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

    const { tests, serverIds, llmConfig, convexAuthToken, mcpjamApiKey } =
      validationResult.data as RunEvalsRequest;

    const clientManager = c.mcpJamClientManager;

    const environment = transformServerConfigsToEnvironment(
      serverIds,
      clientManager,
    );
    const llms = transformLLMConfigToLlmsConfig(llmConfig);

    // If convexAuthToken is provided, use session auth flow
    if (convexAuthToken) {
      console.log("[Hono:Evals] Using session auth flow");
      const convexUrl = process.env.CONVEX_URL;
      if (!convexUrl) {
        console.error("[Hono:Evals] CONVEX_URL is not set");
        throw new Error("CONVEX_URL is not set");
      }

      console.log(`[Hono:Evals] Creating ConvexHttpClient for ${convexUrl}`);
      const convexClient = new ConvexHttpClient(convexUrl);
      convexClient.setAuth(convexAuthToken);

      console.log(`[Hono:Evals] Starting eval suite with ${tests.length} tests`);
      runEvalsWithAuth(tests, environment, llms, convexClient).catch((error) => {
        console.error("[Hono:Evals] Error running evals with auth:", error);
      });
    } else if (mcpjamApiKey) {
      // Use API key flow (CLI behavior)
      console.log("[Hono:Evals] Using API key flow");
      runEvalsWithApiKey(tests, environment, llms, mcpjamApiKey).catch((error) => {
        console.error("[Hono:Evals] Error running evals:", error);
      });
    } else {
      console.error("[Hono:Evals] No auth method provided");
      return c.json(
        {
          error: "Either convexAuthToken or mcpjamApiKey must be provided",
        },
        400,
      );
    }

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

export default evals;
