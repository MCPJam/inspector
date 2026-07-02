/**
 * Body-size limit for `/api/web/*`: a blanket 1MB (hosted web APIs are JSON,
 * and cloud-skill creates carry only a small inline SKILL.md body well under
 * the cap). Mount once with `app.use("/api/web/*", webBodyLimit())`.
 *
 * Carve-out: the computer file-upload route carries multipart blobs and
 * applies its own (higher) bodyLimit at its mount site, so it is exempt here.
 *
 * (An earlier multipart carve-out for skill *folder* uploads was removed when
 * skills moved to a Convex source of truth — there's no large multipart upload
 * on this surface in v1.)
 */
import { bodyLimit } from "hono/body-limit";
import type { Context, Next } from "hono";

export const DEFAULT_WEB_BODY_LIMIT = 1024 * 1024; // 1MB

// Audio transcription carries base64-encoded audio (~4/3 the raw size).
// Convex accepts up to 25MB of raw audio (≈34MB after base64), so cap a bit
// higher to leave room for envelope fields. Without this, /api/web/audio/*
// would be rejected by the generic 1MB JSON cap.
export const AUDIO_WEB_BODY_LIMIT = 40 * 1024 * 1024; // 40MB

export function webBodyLimit() {
  return (c: Context, next: Next) => {
    if (c.req.path === "/api/web/computers/upload") return next();
    if (c.req.path.startsWith("/api/web/audio/")) {
      return bodyLimit({
        maxSize: AUDIO_WEB_BODY_LIMIT,
        onError: (ctx) =>
          ctx.json(
            {
              code: "VALIDATION_ERROR",
              message: "Audio transcription body exceeds 40MB limit",
            },
            413,
          ),
      })(c, next);
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
