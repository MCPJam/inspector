/**
 * Body-size limit for `/api/web/*`.
 *
 * The blanket cap is 1MB (hosted web APIs are JSON). The one exception is
 * **cloud skill folder uploads** (`/api/web/skills/upload-folder`), which are
 * multipart and bounded by the service-level caps in `cloud-skills.ts`. Without
 * a carve-out the 1MB middleware would reject any skill over 1MB BEFORE the
 * service caps (per-file 5MB / total 20MB) could ever run — making them dead
 * code and surfacing a generic middleware error instead of a specific 400.
 *
 * The carve-out is sized from `MAX_SKILL_TOTAL_BYTES` (+ headroom for multipart
 * boundaries/part headers) so the two can't drift.
 */
import { bodyLimit } from "hono/body-limit";
import type { Context, Next } from "hono";
import { MAX_SKILL_TOTAL_BYTES } from "../utils/computers/cloud-skills.js";

export const DEFAULT_WEB_BODY_LIMIT = 1024 * 1024; // 1MB

/** Skill upload: total-bytes cap plus 1MB headroom for multipart framing. */
export const SKILLS_UPLOAD_BODY_LIMIT = MAX_SKILL_TOTAL_BYTES + 1024 * 1024;

const SKILLS_UPLOAD_PATH = "/api/web/skills/upload-folder";

function limitForPath(path: string): number {
  return path === SKILLS_UPLOAD_PATH
    ? SKILLS_UPLOAD_BODY_LIMIT
    : DEFAULT_WEB_BODY_LIMIT;
}

/**
 * Per-request body limit for `/api/web/*`: 1MB everywhere except the skills
 * folder-upload path. Mount once with `app.use("/api/web/*", webBodyLimit())`.
 */
export function webBodyLimit() {
  return (c: Context, next: Next) => {
    const maxSize = limitForPath(c.req.path);
    const limitMb = Math.round(maxSize / 1024 / 1024);
    return bodyLimit({
      maxSize,
      onError: (ctx) =>
        ctx.json(
          {
            code: "VALIDATION_ERROR",
            message: `Request body exceeds ${limitMb}MB limit`,
          },
          400,
        ),
    })(c, next);
  };
}
