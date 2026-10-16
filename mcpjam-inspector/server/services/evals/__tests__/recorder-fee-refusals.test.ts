import { afterEach, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import { Hono } from "hono";
import { v1OnError } from "../../../routes/v1/envelope.js";
import { logger } from "../../../utils/logger.js";
import { startSuiteRunWithRecorder } from "../recorder.js";

afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "preserves a refused suite setup (replay=%s)",
  async (replay) => {
    const message = "Add credits in Organization → Billing, then run it again.";
    const refusal = new ConvexError({
      code: "platform_fee_refused",
      reason: "insufficient_credits",
      message,
    });
    const client = new (await import("convex/browser")).ConvexHttpClient(
      "https://test.convex.cloud",
    );
    const mutation = vi
      .spyOn(client, "mutation")
      .mockResolvedValue({ runId: "run-1", testCases: [] });
    vi.spyOn(client, "action").mockRejectedValue(refusal);
    const log = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const app = new Hono();
    app.onError(v1OnError);
    app.post("/", async () => {
      await startSuiteRunWithRecorder({
        convexClient: client,
        suiteId: "suite-1",
        ...(replay
          ? { replayedFromRunId: "source-run", rerunOfRunId: "source-run" }
          : {}),
      });
      return Response.json({ ok: true });
    });
    const response = await app.request("/", { method: "POST" });
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({
      code: "PAYMENT_REQUIRED",
      message,
      details: { code: "platform_fee_refused", reason: "insufficient_credits" },
    });
    expect(mutation).toHaveBeenCalledWith(
      "testSuites:updateTestSuiteRun",
      expect.objectContaining({ status: "failed" }),
    );
    expect(log).not.toHaveBeenCalled();
  },
);
