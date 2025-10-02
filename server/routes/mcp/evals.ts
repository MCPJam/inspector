import { Hono } from "hono";
import { z } from "zod";
import { runEvals } from "../../../evals-cli/src/evals/runner";
import {
  transformServerConfigsToEnvironment,
  transformLLMConfigToLlmsConfig,
} from "../../utils/eval-transformer";
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
  mcpjamApiKey: z.string().optional(),
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

    const { tests, serverIds, llmConfig, mcpjamApiKey } =
      validationResult.data as RunEvalsRequest;

    const clientManager = c.mcpJamClientManager;

    const environment = transformServerConfigsToEnvironment(
      serverIds,
      clientManager,
    );
    const llms = transformLLMConfigToLlmsConfig(llmConfig);

    runEvals(tests, environment, llms, mcpjamApiKey).catch((error) => {
      console.error("Error running evals:", error);
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

export default evals;
