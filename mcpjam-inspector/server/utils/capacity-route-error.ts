import { ConvexError } from "convex/values";
import { ErrorCode, WebRouteError } from "../routes/web/errors.js";

/** Capacity refusals are retryable admission outcomes, not failed runs. */
export function asCapacityRouteError(error: unknown): WebRouteError | null {
  if (!(error instanceof ConvexError)) return null;
  const data = error.data;
  if (
    !data ||
    typeof data !== "object" ||
    !("kind" in data) ||
    data.kind !== "at_capacity"
  )
    return null;
  const message =
    "message" in data && typeof data.message === "string"
      ? data.message
      : "This installation is at capacity. Wait for running work to finish and try again.";
  return new WebRouteError(429, ErrorCode.RATE_LIMITED, message, {
    code: "at_capacity",
    ...("resource" in data && typeof data.resource === "string"
      ? { resource: data.resource }
      : {}),
    retryAfterMs: 1000,
  }).withHeaders({ "Retry-After": "1" });
}
