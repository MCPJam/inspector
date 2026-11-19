/**
 * The variant contract's error codes and the copy each one carries. The
 * backend hand-mirrors them, because Convex can't import the SDK. Each message
 * says what failed and what to do next.
 */

export const VARIANT_ERROR_CODES = [
  "VARIANT_FEATURE_NOT_VARIABLE",
  "VARIANT_INVALID_VALUE",
  "VARIANT_DUPLICATE_EDIT",
  "VARIANT_UNKNOWN_TARGET",
  "VARIANT_TOO_LARGE",
  "VARIANT_UNSUPPORTED_SERVER",
  "VARIANT_IMMUTABLE",
  "VARIANT_BASE_DRIFTED",
] as const;

export type VariantErrorCode = (typeof VARIANT_ERROR_CODES)[number];

/** The JSON-RPC error code a served variant answers `tools/list` with on drift. */
export const VARIANT_BASE_DRIFTED_RPC_CODE = -32090;

/** The message for each code, given the names it mentions. */
export const variantErrorMessages = {
  VARIANT_FEATURE_NOT_VARIABLE: (feature: string) =>
    `A variant can't change ${feature} yet. It can change: tools.description.`,
  VARIANT_INVALID_VALUE: (target: string) =>
    `The new description for ${target} must be 1 to 10,000 characters of text.`,
  VARIANT_DUPLICATE_EDIT: (target: string) =>
    `Two edits change the description of ${target}. Keep one.`,
  VARIANT_UNKNOWN_TARGET: (server: string, target: string) =>
    `${server} has no tool named ${target}. Check the name with list_server_tools.`,
  VARIANT_TOO_LARGE: () =>
    "A variant can hold at most 200 edits and 256 KB of edits. Remove some edits.",
  VARIANT_UNSUPPORTED_SERVER: () =>
    "Variants can only be made from an HTTP server that isn't already a variant.",
  VARIANT_IMMUTABLE: () =>
    "A variant server can't be changed. Create a new variant instead.",
  VARIANT_BASE_DRIFTED: (tools: readonly string[]) =>
    `The base server changed tools this variant edits: ${tools.join(", ")}. Create the variant again from the current server.`,
} satisfies Record<VariantErrorCode, (...names: never[]) => string>;

/**
 * A refused variant. `code` is one of the contract's codes, so a server can
 * answer with it directly (an HTTP 400 in `/api/v1`).
 */
export class VariantError extends Error {
  readonly code: VariantErrorCode;

  constructor(code: VariantErrorCode, message: string) {
    super(message);
    this.name = "VariantError";
    this.code = code;
  }
}
