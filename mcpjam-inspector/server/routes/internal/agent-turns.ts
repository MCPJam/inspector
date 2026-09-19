import { Hono } from "hono";
import { internalServiceAuthMiddleware } from "../../middleware/internal-service-auth.js";
import { getSelfFetch } from "../../utils/self-app.js";
import { reportRouteFailure } from "../../utils/route-error-report.js";

async function backend(path: string, body: unknown) {
  const origin = process.env.CONVEX_HTTP_URL;
  const token = process.env.INSPECTOR_SERVICE_TOKEN;
  if (!origin || !token)
    throw new Error("Durable agent worker is not configured.");
  const response = await fetch(`${origin}/internal/v1/agent-turns/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-inspector-service-token": token,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error(`Agent worker ${path} failed (${response.status}).`);
  return response.json();
}
export async function runDurableAgentPass() {
  const selfFetch = getSelfFetch();
  if (!selfFetch) throw new Error("Agent worker dispatch is unavailable.");
  for (let index = 0; index < 16; index++) {
    const { claim } = await backend("claim", {});
    if (!claim) return;
    const { job, token, bearer } = claim;
    try {
      const response = await selfFetch(
        new Request(
          `http://self.mcpjam.internal/api/v1/projects/${job.projectId}/agent`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${bearer}`,
              "x-inspector-service-token": process.env.INSPECTOR_SERVICE_TOKEN!,
              "x-mcpjam-agent-job": job._id,
              "x-mcpjam-agent-lease": token,
            },
            body: job.inputJson,
          },
        ),
      );
      const envelope = await response.json();
      const result = envelope.data ?? envelope;
      await backend("finish", {
        jobId: job._id,
        token,
        ...(response.ok
          ? { result, continue: result.durableContinuation === true }
          : { error: envelope.error?.message ?? "Agent step failed." }),
      });
    } catch (error) {
      // Leave an unknown outcome leased. Recovery resumes checkpointed tools
      // or parks an unknown provider invocation; it never blind-retries it.
      reportRouteFailure("Durable agent step interrupted", error, {
        source: "agent-turns.dispatch",
        hop: "mcpjam_internal",
      });
      return;
    }
  }
}
const router = new Hono();
router.use("*", internalServiceAuthMiddleware());
router.post("/dispatch", (c) => {
  void runDurableAgentPass().catch((error) =>
    reportRouteFailure("Durable agent dispatch failed", error, {
      source: "agent-turns.dispatch",
      hop: "mcpjam_internal",
    }),
  );
  return c.json({ accepted: true }, 202);
});
export default router;
