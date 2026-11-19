/**
 * "Test on a past run" for code evaluators: run draft code against one
 * stored trial and return the outcome. Writes nothing.
 *
 * The trial is read with the caller's own Convex token, so the backend's
 * authorization decides whether they may see it. The code runs in the same
 * sandbox runner a real run uses, and is refused where there is none.
 */
import type { Context } from "hono";
import { z } from "zod";
import { buildIterationTranscript } from "@mcpjam/sdk/predicates";
import { createConvexClient } from "../../services/evals/route-helpers.js";
import { extractTranscriptEvidence } from "../../services/evals/transcript-evidence.js";
import { runTrialCodeEvaluators } from "../../services/evals/code-evaluators/run-iteration.js";
import { createCodeEvaluatorRunner } from "../../services/evals/code-evaluators/runner-registry.js";
import {
  readRequestJson,
  reportRouteFailure,
} from "../../utils/route-error-report.js";

const bodySchema = z.object({
  convexAuthToken: z.string().min(1),
  iterationId: z.string().min(1),
  source: z.string().min(1).max(20_000),
});

type StoredTrace = { messages?: unknown[]; spans?: unknown[] } | null;

export async function handleCodeEvaluatorPreview(c: Context) {
  let body: unknown;
  try {
    body = await readRequestJson(c);
  } catch {
    return c.json({ error: "The request body must be JSON" }, 400);
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "convexAuthToken, iterationId and source are required" }, 400);
  }
  const { convexAuthToken, iterationId, source } = parsed.data;
  const runner = createCodeEvaluatorRunner();
  try {
    const convex = createConvexClient(convexAuthToken);
    const [iteration, trace] = await Promise.all([
      convex.query("testSuites:getTestIteration" as never, { iterationId } as never) as Promise<{
        actualToolCalls?: Array<{ toolName: string; arguments: Record<string, unknown> }>;
      } | null>,
      convex.action("testSuites:getTestIterationBlob" as never, { iterationId } as never) as Promise<StoredTrace>,
    ]);
    if (!iteration) return c.json({ error: "Trial not found" }, 404);
    const evidence = extractTranscriptEvidence(trace as never);
    const transcript = buildIterationTranscript({
      ...(trace ? { trace: trace as never } : {}),
      toolCalls: iteration.actualToolCalls ?? [],
      toolResults: evidence.toolResults,
      resultsCaptured: evidence.resultsCaptured,
      toolCallTimings: evidence.toolCallTimings,
      timingsCaptured: evidence.timingsCaptured,
    });
    const [outcome] = await runTrialCodeEvaluators({
      evaluators: [{ id: "preview", label: "Preview", source, role: "advisory" }],
      run: transcript,
      runKey: `preview:${iterationId}`,
      runner,
    });
    return c.json({ ok: true, outcome });
  } catch (error) {
    reportRouteFailure("[Error previewing code evaluator]", error, {
      source: "mcp.evals.code-evaluator-preview",
      hop: "mcpjam_internal",
    });
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message.includes("unauthorized") ? "Trial not found" : "The preview could not run." }, 500);
  } finally {
    await runner?.close();
  }
}
