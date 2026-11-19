/**
 * `@mcpjam/sdk/variants`: server variants, in beta behind the
 * `variant-servers-enabled` flag. Pin a saved server's live `tools/list`
 * surface, validate description edits against it and hash the result, then
 * serve the variant through `createVariantFetch`, which passes every request
 * through to the base and rewrites only `tools/list`.
 *
 * Runtime-agnostic: WebCrypto and web streams only, no Node builtins.
 */

export {
  VARIANT_BASE_DRIFTED_RPC_CODE,
  VARIANT_ERROR_CODES,
  VariantError,
  variantErrorMessages,
} from "./errors.js";
export type { VariantErrorCode } from "./errors.js";
export {
  canonicalJson,
  computeContentHash,
  computeEditsHash,
  computeSurfaceHash,
  computeToolHash,
  sha256Hex,
} from "./hashes.js";
export {
  VARIANT_LIMITS,
  buildVariantDraft,
  pinVariantSurface,
} from "./draft.js";
export type { VariantToolsPage } from "./draft.js";
export { createVariantFetch } from "./fetch.js";
export type { CreateVariantFetchOptions } from "./fetch.js";
export type { VariantDriftRpcError } from "./overlay.js";
export type {
  VariantDefinition,
  VariantDiffEntry,
  VariantDraft,
  VariantEdit,
  VariantEditInput,
  VariantTool,
  VariantToolHash,
} from "./types.js";
