/**
 * Body-size limit for `/api/web/*`: a blanket 1MB (hosted web APIs are JSON,
 * and cloud-skill creates carry only a small inline SKILL.md body well under
 * the cap). Mount once with `app.use("/api/web/*", webBodyLimit())`.
 *
 * Carve-out: POST to the computer file-upload route carries multipart blobs
 * and applies its own (higher) bodyLimit at its mount site, so it is exempt
 * here. POST-only: the route's own cap is mounted on POST, so exempting other
 * methods on the path would leave them with no cap at all.
 *
 * Skill supporting files (v2) do NOT need a carve-out here: the blob bytes are
 * POSTed by the browser DIRECTLY to Convex `_storage` (via a minted upload URL),
 * never through `/api/web/*`. Only the small JSON `attach`/`list`/`read` control
 * messages transit this surface, all well under 1MB.
 */
import { bodyLimit } from "hono/body-limit";
import type { Context, Next } from "hono";

export const DEFAULT_WEB_BODY_LIMIT = 1024 * 1024; // 1MB

export function webBodyLimit() {
  return (c: Context, next: Next) => {
    if (
      c.req.method === "POST" &&
      c.req.path === "/api/web/computers/upload"
    ) {
      return next();
    }
    return bodyLimit({
      maxSize: DEFAULT_WEB_BODY_LIMIT,
      onError: (ctx) =>
        ctx.json(
          { code: "VALIDATION_ERROR", message: "Request body exceeds 1MB limit" },
          400,
        ),
    })(c, next);
  };
}
