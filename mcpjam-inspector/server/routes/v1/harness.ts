/**
 * Public v1 harness surface: read-only metadata about the agent harnesses
 * MCPJam can run (today: Claude Code).
 *
 * `GET /harness/:harnessId/builtin-tools` returns the harness's NATIVE built-in
 * tools (Bash, Read, Edit, …). These execute inside the harness's sandbox via
 * its own agent loop — they are NOT callable through MCPJam — so the catalog is
 * display-only. The data is static published-package metadata (no project
 * scope, no Convex), read straight from the harness registry. Bearer-gated by
 * the v1 middleware; guests are default-denied (not on the allowlist).
 */
import { Hono } from "hono";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { getHarnessAdapter } from "../../utils/harness/registry.js";
import { requireVerifiedAuth } from "../../middleware/require-verified-auth.js";
import { v1PageJson } from "./envelope.js";

const harness = new Hono();

// GET /v1/harness/:harnessId/builtin-tools
//
// This route never calls Convex, so nothing downstream re-checks the bearer —
// see middleware/require-verified-auth.ts. Guests still pass (they are on the
// v1 guest allowlist for this exact path); what this rejects is a made-up
// bearer that `bearerAuthMiddleware` waved through as a presumed JWT.
harness.use("/harness/:harnessId/builtin-tools", requireVerifiedAuth());

harness.get("/harness/:harnessId/builtin-tools", async (c) => {
  const harnessId = c.req.param("harnessId");
  let adapter;
  try {
    adapter = getHarnessAdapter(harnessId);
  } catch {
    throw new WebRouteError(
      404,
      ErrorCode.NOT_FOUND,
      `Unknown harness: ${harnessId}`,
    );
  }
  return v1PageJson(c, adapter.listBuiltinTools());
});

export default harness;
