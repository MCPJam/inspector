import { translateStructuredConvexRefusal } from "../v1/convex-errors.js";
import { mapRuntimeError } from "./errors.js";

export function mapWebBoundaryError(error: unknown) {
  return mapRuntimeError(translateStructuredConvexRefusal(error) ?? error);
}
