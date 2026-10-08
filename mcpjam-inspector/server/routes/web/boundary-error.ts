import { translateStructuredConvexRefusal } from "../v1/convex-errors.js";
import { mapRuntimeError, type MapRuntimeErrorOptions } from "./errors.js";

export function mapWebBoundaryError(
  error: unknown,
  options?: MapRuntimeErrorOptions,
) {
  return mapRuntimeError(
    translateStructuredConvexRefusal(error) ?? error,
    options,
  );
}
