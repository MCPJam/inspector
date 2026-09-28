/**
 * Body-size limit for `/api/v1/*`: a blanket 1MB, like `/api/web/*` — the
 * public API is JSON. Mount once per production entry with
 * `app.use("/api/v1/*", v1BodyLimit())`.
 *
 * Carve-out: POST to the eval-ingest artifacts route carries one artifact's
 * raw bytes (MJ-006) and enforces its own cap as it reads them
 * (`routes/v1/eval-ingest.ts`). POST-only, because that cap is on POST.
 */
import { bodyLimit } from "hono/body-limit";
import type { Context, Next } from "hono";

export const DEFAULT_V1_BODY_LIMIT = 1024 * 1024; // 1MB

const SELF_LIMITED_V1_UPLOAD =
  /^\/api\/v1\/projects\/[^/]+\/eval-ingest\/artifacts$/;

export function v1BodyLimit() {
  const jsonLimit = bodyLimit({
    maxSize: DEFAULT_V1_BODY_LIMIT,
    onError: (c) =>
      c.json(
        {
          code: "VALIDATION_ERROR",
          message: "Request body exceeds 1MB limit",
        },
        400,
      ),
  });
  return (c: Context, next: Next) => {
    if (c.req.method === "POST" && SELF_LIMITED_V1_UPLOAD.test(c.req.path)) {
      return next();
    }
    return jsonLimit(c, next);
  };
}
