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

// Audio transcription carries base64-encoded audio (~4/3 the raw size), so it
// needs more than the generic 1MB JSON cap. It does NOT need the 25MB this was
// originally set to: that number came from matching the Convex route's own cap
// so we would not accept what the backend only rejects, which bounds redundant
// work rather than bounding SPEND. Transcription is billed per audio-minute, so
// the body size IS the per-request cost.
//
// Sized instead from the longest recording the product can produce. The client
// stops a recording at VOICE_GLOBAL_MAX_SECONDS = 180s
// (client/src/components/chat-v2/chat-input.tsx), so 180s of the largest
// accepted encoding is the worst legitimate payload:
//
//   webm/opus mono @64kbps (what MediaRecorder emits)  1.44MB -> ~1.9MB base64
//   m4a/AAC @128kbps (generous)                        2.88MB -> ~3.8MB base64
//   wav, 16-bit 16kHz mono (uncompressed — binding)    5.76MB -> ~7.7MB base64
//
// `wav` is in SUPPORTED_AUDIO_FORMATS, so it sets the floor. 10MB clears it
// with margin and cuts the ceiling an unauthenticated caller could reach by
// 2.5x (MJ-002). Resize from this table, not by taste.
export const AUDIO_WEB_BODY_LIMIT = 10 * 1024 * 1024; // 10MB

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
              message: "Audio transcription body exceeds 10MB limit",
              error: "Audio transcription body exceeds 10MB limit",
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
