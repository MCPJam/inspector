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
// Be precise about what a byte cap can and cannot do here, because the obvious
// reading is wrong: it does NOT bound billable audio minutes. Bitrate is the
// caller's choice, so 10MB of base64 is ~16 minutes of 64kbps Opus but only 3
// minutes of 16kHz WAV. Bounding DURATION would mean decoding the payload, and
// the `audioDurationSeconds` field the route accepts is caller-supplied and
// unverified. The real spend ceiling is the backend's daily budget
// (`convex/usage/rateLimit.ts`: $0.20/day per guest, $1.00/day per IP hash);
// this is a coarse per-request bound in front of it.
//
// 10MB, sized against 180s payloads — the longest the first-party recorder can
// produce (VOICE_GLOBAL_MAX_SECONDS in client/src/components/chat-v2/
// chat-input.tsx), as base64:
//
//   webm/opus mono @64kbps (what MediaRecorder emits)   ~1.8MB   5x headroom
//   m4a/AAC @128kbps                                    ~3.7MB
//   wav, 16-bit 16kHz mono                              ~7.3MB   fits
//   wav, 16-bit 22.05kHz mono                          ~10.1MB   REJECTED
//   wav, 16-bit 44.1kHz stereo                         ~40.4MB   also >25MB
//
// The trade is deliberate: a non-browser caller posting three minutes of WAV
// above 16kHz gets a 413 where 25MB would have taken it. Nothing the product
// itself emits comes close to the cap, and the failure is a clean 413 rather
// than a truncated transcript. Resize from this table, not by taste.
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
