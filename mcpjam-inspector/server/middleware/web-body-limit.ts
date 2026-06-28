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

/**
 * The carve-out applies ONLY to the real upload request shape — a multipart
 * POST to the upload path. Anything else hitting that exact path (a GET, a JSON
 * POST) keeps the default 1MB cap, so the larger limit can't be used to slip a
 * non-multipart oversized body past the blanket cap.
 */
function isSkillsFolderUpload(c: Context): boolean {
  if (c.req.path !== SKILLS_UPLOAD_PATH) return false;
  if (c.req.method !== "POST") return false;
  // Compare ONLY the media type, not a substring of the whole header: a
  // `Content-Type: application/json; x=multipart/form-data` must NOT match and
  // sneak past the 1MB cap.
  const mediaType = (c.req.header("content-type") ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  return mediaType === "multipart/form-data";
}

/**
 * Per-request body limit for `/api/web/*`: 1MB everywhere except a multipart
 * POST to the skills folder-upload path. Mount once with
 * `app.use("/api/web/*", webBodyLimit())`.
 */
export function webBodyLimit() {
  return (c: Context, next: Next) => {
    const maxSize = isSkillsFolderUpload(c)
      ? SKILLS_UPLOAD_BODY_LIMIT
      : DEFAULT_WEB_BODY_LIMIT;
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
