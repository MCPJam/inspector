/**
 * Body-size limit for `/api/web/*`: a blanket 1MB (hosted web APIs are JSON,
 * and cloud-skill creates carry only a small inline SKILL.md body well under
 * the cap). Mount once with `app.use("/api/web/*", webBodyLimit())`.
 *
 * (An earlier multipart carve-out for skill *folder* uploads was removed when
 * skills moved to a Convex source of truth — there's no large multipart upload
 * on this surface in v1.)
 */
import { bodyLimit } from "hono/body-limit";
import type { Context, Next } from "hono";

export const DEFAULT_WEB_BODY_LIMIT = 1024 * 1024; // 1MB

export function webBodyLimit() {
  return (c: Context, next: Next) =>
    bodyLimit({
      maxSize: DEFAULT_WEB_BODY_LIMIT,
      onError: (ctx) =>
        ctx.json(
          { code: "VALIDATION_ERROR", message: "Request body exceeds 1MB limit" },
          400,
        ),
    })(c, next);
}
