import { SdkError } from "../../errors.js";

/**
 * The SDK ships each entry point as its own bundle, each with its own copy of
 * this class, so `instanceof` fails between them. The registered symbol does
 * not, which is what {@link isInspectorError} checks.
 */
const INSPECTOR_ERROR_BRAND = Symbol.for("mcpjam.inspectorError");

/**
 * Finding, starting, attaching to or authenticating with a local Inspector
 * failed. `details` carries the structured context a caller reports with the
 * message, such as the frontend URLs a mismatch is about.
 */
export class InspectorError extends SdkError {
  readonly [INSPECTOR_ERROR_BRAND] = true;
  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message, "INSPECTOR_ERROR");
    this.name = "InspectorError";
    this.details = details;
  }
}

export function isInspectorError(value: unknown): value is InspectorError {
  return (
    typeof value === "object" &&
    value !== null &&
    INSPECTOR_ERROR_BRAND in value
  );
}

/**
 * Named after the CLI's `operationalError`, which the engine threw before it
 * moved here; the CLI turns an {@link InspectorError} back into that.
 */
export function operationalError(
  message: string,
  details?: unknown
): InspectorError {
  return new InspectorError(message, details);
}
