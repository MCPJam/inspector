/**
 * Extract a user-facing message from a Convex mutation/query rejection.
 *
 * Convex `ConvexError` payloads land on `err.data` (a string, or a record
 * with `message`) — prefer that over `err.message`, which for an application
 * error is the redacted "Server Error"/Request-ID string. Extracted from
 * `SandboxImagesDrawer` so every Convex-backed management surface shares one
 * error-shaping path.
 */
export function convexErrMessage(err: unknown, fallback: string): string {
  if (err && typeof err === "object" && "data" in err) {
    const data = (err as { data: unknown }).data;
    if (typeof data === "string" && data.trim()) return data.slice(0, 400);
    if (data && typeof data === "object" && "message" in data) {
      const msg = (data as { message: unknown }).message;
      if (typeof msg === "string" && msg.trim()) return msg.slice(0, 400);
    }
  }
  if (err instanceof Error && err.message) {
    // Fallback: strip the noisy server prefix from a plain thrown message.
    return err.message.replace(/^\[.*?\]\s*/, "").slice(0, 400) || fallback;
  }
  return fallback;
}
