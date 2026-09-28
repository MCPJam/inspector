/**
 * Read-only metadata about MCPJam's OWN built-in tools — the ones this server
 * executes on a turn's behalf, as opposed to a harness's native tools
 * (`harness.ts`) or an MCP server's.
 *
 * `GET /built-in-tools/browser/definitions` returns the six `browser_*` tools
 * exactly as the model is shown them: names, descriptions, JSON input schemas.
 * It exists because those definitions are BUILT AT TURN TIME from code
 * (`built-in-tools/browser.ts`) rather than stored anywhere a UI can read —
 * so the Tools pane, which lists what a host can do, and the Raw request
 * preview of a reopened chat, which has no live `request_payload` to show,
 * could only describe them by keeping a hand-written copy. A copy is exactly
 * what would drift: the schemas carry the coordinate space and the ref rules
 * the model is expected to follow.
 *
 * WHAT IT IS NOT: an execution surface. Nothing here can drive a browser, and
 * the answer is the same static text for every caller — it says what the tools
 * ARE, never whether this project has one attached, whether a browser is
 * running, or what page it is on. Those are project-scoped questions answered
 * by the panel routes.
 *
 * Static registry metadata, so no project scope and no Convex — bearer-gated by
 * the v1 middleware, like the harness catalog it sits beside.
 */
import { Hono } from "hono";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { describeBrowserTools } from "../../utils/built-in-tools/browser.js";
import { requireVerifiedAuth } from "../../middleware/require-verified-auth.js";
import { v1PageJson } from "./envelope.js";

const builtInTools = new Hono();

// Never calls Convex, so nothing downstream re-checks the bearer — the same
// reasoning as the harness catalog's. What this rejects is a made-up bearer
// that `bearerAuthMiddleware` waved through as a presumed JWT.
builtInTools.use(
  "/built-in-tools/:builtInToolId/definitions",
  requireVerifiedAuth(),
);

builtInTools.get("/built-in-tools/:builtInToolId/definitions", async (c) => {
  const id = c.req.param("builtInToolId");
  // ONE id today, and an explicit 404 for anything else rather than an empty
  // page: a caller that misspells `browser` must not read "this tool has no
  // definitions" as an answer about the tool it meant.
  if (id !== "browser") {
    throw new WebRouteError(
      404,
      ErrorCode.NOT_FOUND,
      `No definitions for built-in tool: ${id}`,
    );
  }
  // The engine changes ONE sentence — whose browser this is — and the pane
  // needs to say it right, because "the user's own, with their logins" and "a
  // disposable cloud box" are different promises about the same click. Hosted
  // is the default; a local caller asks for what it will actually get.
  const engine = c.req.query("engine") === "local" ? "local" : "hosted";
  return v1PageJson(c, describeBrowserTools(engine));
});

export default builtInTools;
