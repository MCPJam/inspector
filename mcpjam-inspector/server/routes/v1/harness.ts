/**
 * Public v1 harness surface: read-only metadata about the agent harnesses
 * MCPJam can run.
 *
 * `GET /harness/:harnessId/builtin-tools` returns the harness's NATIVE built-in
 * tools (Bash, Read, Edit, …). These execute inside the harness's sandbox via
 * its own agent loop — they are NOT callable through MCPJam — so the catalog is
 * display-only.
 *
 * `GET /harness/:harnessId/capabilities` returns what the harness can actually
 * be asked to do. It exists because those answers are no longer a property of
 * the harness NAME: Codex has two transports, and only one of them can pause
 * for tool approval. The client's static capability map
 * (`client/src/lib/harness-capabilities.ts`) still holds the fallback, but a
 * map cannot know which transport a given deployment enabled — so the host
 * editor asks, and grays the approval switch out only when the server says the
 * runtime really cannot pause.
 *
 * Both are static registry metadata (no project scope, no Convex), bearer-gated
 * by the v1 middleware.
 */
import { Hono } from "hono";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { getHarnessAdapter } from "../../utils/harness/registry.js";
import { requireVerifiedAuth } from "../../middleware/require-verified-auth.js";
import { v1PageJson, v1Resource } from "./envelope.js";

const harness = new Hono();

// GET /v1/harness/:harnessId/builtin-tools
//
// This route never calls Convex, so nothing downstream re-checks the bearer —
// see middleware/require-verified-auth.ts. Guests still pass (they are on the
// v1 guest allowlist for this exact path); what this rejects is a made-up
// bearer that `bearerAuthMiddleware` waved through as a presumed JWT.
harness.use("/harness/:harnessId/builtin-tools", requireVerifiedAuth());
harness.use("/harness/:harnessId/capabilities", requireVerifiedAuth());

/** Resolve the adapter or answer 404 — never a 500 for an unknown id. */
function readAdapter(harnessId: string) {
  try {
    return getHarnessAdapter(harnessId);
  } catch {
    throw new WebRouteError(
      404,
      ErrorCode.NOT_FOUND,
      `Unknown harness: ${harnessId}`,
    );
  }
}

harness.get("/harness/:harnessId/builtin-tools", async (c) => {
  const adapter = readAdapter(c.req.param("harnessId"));
  return v1PageJson(c, adapter.listBuiltinTools());
});

// GET /v1/harness/:harnessId/capabilities
harness.get("/harness/:harnessId/capabilities", async (c) => {
  const adapter = readAdapter(c.req.param("harnessId"));
  return v1Resource(c, {
    harnessId: adapter.id,
    // Absent for a harness with one transport; the client only needs it to
    // explain WHY a capability is or is not there.
    ...(adapter.transport ? { transport: adapter.transport } : {}),
    // The runtime's own built-ins (shell, patch, …).
    supportsNativeToolApproval: adapter.supportsNativeToolApproval,
    // Tools MCPJam runs in its own process on the runtime's behalf.
    supportsHostExecutedToolApproval: adapter.supportsHostExecutedToolApproval,
    // MCP tools the runtime's own client calls in-sandbox. Only meaningful
    // under `native` delivery — under `host-executed` the host-executed flag is
    // the one that governs, which is exactly the distinction that made a
    // hand-written client map go stale.
    supportsMcpToolApproval: adapter.supportsMcpToolApproval,
    mcpDelivery: adapter.mcpDelivery,
  });
});

export default harness;
