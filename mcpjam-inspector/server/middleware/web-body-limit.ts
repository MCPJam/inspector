/**
 * Body-size limit for `/api/web/*`: a blanket 1MB (hosted web APIs are JSON,
 * and cloud-skill creates carry only a small inline SKILL.md body well under
 * the cap). Mount once with `app.use("/api/web/*", webBodyLimit())`.
 *
 * Carve-outs: POST to the computer file-upload route carries multipart blobs
 * and applies its own higher bodyLimit at its mount site; audio transcription
 * carries larger JSON payloads with base64-encoded audio. The computer upload
 * carve-out is POST-only because the route's own cap is mounted on POST.
 *
 * Skill supporting files (v2) do NOT need a carve-out here: the blob bytes are
 * POSTed by the browser DIRECTLY to Convex `_storage` (via a minted upload URL),
 * never through `/api/web/*`. Only the small JSON `attach`/`list`/`read` control
 * messages transit this surface, all well under 1MB.
 */
import { bodyLimit } from "hono/body-limit";
import type { Context, Next } from "hono";

export const DEFAULT_WEB_BODY_LIMIT = 1024 * 1024; // 1MB

// Audio transcription carries base64-encoded audio (~4/3 the raw size).
// The Convex route caps the whole JSON body (base64 audio + envelope) at 25MB,
// so match that here — anything larger this proxy accepts only gets rejected
// downstream. Without this, /api/web/audio/* would be rejected by the generic
// 1MB JSON cap.
export const AUDIO_WEB_BODY_LIMIT = 25 * 1024 * 1024; // 25MB

export function webBodyLimit() {
  return (c: Context, next: Next) => {
    if (
      c.req.method === "POST" &&
      c.req.path === "/api/web/computers/upload"
    ) {
      return next();
    }
    if (c.req.path.startsWith("/api/web/audio/")) {
      return bodyLimit({
        maxSize: AUDIO_WEB_BODY_LIMIT,
        onError: (ctx) =>
          ctx.json(
            {
              code: "VALIDATION_ERROR",
              message: "Audio transcription body exceeds 25MB limit",
              error: "Audio transcription body exceeds 25MB limit",
            },
            413
          ),
      })(c, next);
    }
    return bodyLimit({
      maxSize: DEFAULT_WEB_BODY_LIMIT,
      onError: (ctx) =>
        ctx.json(
          {
            code: "VALIDATION_ERROR",
            message: "Request body exceeds 1MB limit",
            error: "Request body exceeds 1MB limit",
          },
          400
        ),
    })(c, next);
  };
}
