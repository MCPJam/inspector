import { Hono } from "hono";
import { z } from "zod";
import { isAllowedRequestOrigin } from "../../middleware/origin-validation.js";
import { LocalRuntimePreparingError } from "../../utils/harness/local/readiness.js";
import { setupLocalStudyPreview } from "../../utils/harness/local/study-readiness.js";

const requestSchema = z
  .object({
    accepted: z.literal(true),
    scenarioId: z.string().min(1),
    accessVersion: z.number().int().nonnegative(),
    chatSessionId: z.string().min(1),
  })
  .strict();

// Mounted below the local harness authentication and server feature guards.
const localStudy = new Hono();
localStudy.post("/setup", async (c) => {
  if (!isAllowedRequestOrigin(c.req.header("origin"))) {
    return c.json({ error: "Origin not allowed" }, 403);
  }
  try {
    const parsed = requestSchema.safeParse(await c.req.json());
    if (!parsed.success)
      return c.json(
        { error: "Accept local execution for a current study conversation" },
        400,
      );
    const ready = await setupLocalStudyPreview({
      ...parsed.data,
      bearer: (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, ""),
    });
    const {
      grantToken,
      actingUserId: _actor,
      study: _study,
      localSessionId: _session,
      ...target
    } = ready.target;
    return c.json({
      state: "ready",
      token: grantToken,
      target: { ...target, harnessId: ready.harnessId },
      expiresAt: ready.expiresAt,
      workspaceDisplayRoot: ready.workspaceDisplayRoot,
      reservation: ready.reservation,
    });
  } catch (error) {
    if (error instanceof SyntaxError)
      return c.json({ error: "Invalid study setup request" }, 400);
    if (error instanceof LocalRuntimePreparingError)
      return c.json({ state: "installing" }, 202);
    return c.json(
      {
        error:
          error instanceof Error ? error.message : "Local study setup failed",
      },
      409,
    );
  }
});
export default localStudy;
