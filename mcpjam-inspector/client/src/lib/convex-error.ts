import { getUserErrorMessage } from "./user-error";

/** Resolve backend failures through the user-facing catalog, never backend prose. */
export function convexErrMessage(err: unknown, fallback: string): string {
  return getUserErrorMessage(err, fallback);
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
