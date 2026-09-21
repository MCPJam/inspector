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

/**
 * Whether a `useQuery` throw means the deployment does not serve the function
 * at all — a dark ship, or a browser outliving a rollback — rather than the
 * function failing. Only the DEV shapes are nameable: production redacts
 * every non-`ConvexError` message to "Server Error", so a caller that must
 * recognise a dark ship in production has to match on the function name in
 * the `[CONVEX Q(<name>)]` prefix instead (see `ServerUrlChangeHistory`).
 */
export function isConvexQueryUnavailable(error: Error): boolean {
  const message = typeof error?.message === "string" ? error.message : "";
  return (
    // The function is not deployed (dark ship, or a browser outliving a rollback).
    message.includes("Could not find public function") ||
    // No ConvexProvider above this tree.
    message.includes("Could not find Convex client")
  );
}
