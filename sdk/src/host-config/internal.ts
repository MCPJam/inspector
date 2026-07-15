/**
 * `@mcpjam/sdk/host-config/internal` — LOW-LEVEL, FIRST-PARTY entry.
 *
 * Exposes the raw canonicalizer + hash + internal storage-row types
 * (`canonicalizeHostConfigV2`, `computeHostConfigHashV2`, `HostConfigInputV2`,
 * `CanonicalHostConfigV2`, …). This module is the single source of truth for
 * the canonical form: it is fully self-contained (zero external/Node-only
 * imports), so the MCPJam Convex backend imports it directly rather than
 * hand-mirroring the canonicalizer. There is exactly one canonicalizer shared
 * across the SDK and backend — no duplicated fixture, no parity ritual.
 *
 * NOT part of the stable public API and NOT semver-guaranteed. External SDK
 * consumers should use the `Host` builder from `@mcpjam/sdk` /
 * `@mcpjam/sdk/host-config` — that is the curated public surface (MCP
 * vocabulary, no storage-row names). This subpath is for first-party
 * consumers (the backend, the parity-fixture generator, SDK tests) that need
 * the low-level canonicalizer.
 */

export { canonicalizeHostConfigV2 } from "./canonicalize.js";
export { sha256Hex, computeHostConfigHashV2 } from "./hash.js";
export {
  HARNESS_IDS,
  HOST_CONFIG_SCHEMA_VERSION_V2,
  isHarness,
  SEP_1865_PERMISSION_FEATURES,
} from "./types.js";
export type { Harness } from "./types.js";
export {
  DEFAULT_TEMPERATURE_V2,
  resolveEffectiveMcpProtocolVersion,
} from "./defaults.js";
export type {
  HostConfigInputV2,
  CanonicalHostConfigV2,
  HostConfigComputer,
  HostConfigMcpProfileV1,
  HostConfigConnectionDefaults,
  CspDomainSet,
  McpProtocolVersion,
  McpToolResultImageRendering,
  McpToolResultImageRenderingPolicy,
  McpToolResultImageRenderPlacement,
  ModelVisibleMcpToolResults,
} from "./types.js";

// Stage 3: host-execution policy + visibility filter + OpenAI compat.
// Stays browser-safe — `tool-visibility.ts` is structurally typed
// (no `MCPClientManager` runtime import) and `app-only-tool.ts` is a pure
// leaf, so re-exporting them from this barrel does not drag runtime SDK
// or Vercel AI SDK code into the inspector client bundle.
export { isAppOnlyTool } from "./app-only-tool.js";
export {
  filterAppOnlyTools,
  applyVisibilityPolicyAndCountSignals,
} from "./tool-visibility.js";
export type { ToolMetadataSource } from "./tool-visibility.js";
export {
  extractHostExecutionPolicy,
  buildHostIterationMetadata,
  buildHostSnapshotMetadata,
  resolveMcpToolResultImageRendering,
} from "./host-policy.js";
export type {
  HostExecutionPolicy,
  ResolvedMcpToolResultImageRenderingPolicy,
  ToolExposureSignals,
} from "./host-policy.js";
export { hostConnectionProfile } from "./host-connection.js";
export type { HostConnectionProfile } from "./host-connection.js";
export {
  readOpenAiCompatOverride,
  compatPresetForHostStyle,
  resolveOpenAiCompatForHostConfig,
} from "./compat-runtime.js";

// Stage 5 (Step 1): SDK→backend eval ingestion wire normalizer. Strips
// runtime-manager identifiers (`serverIds`, `optionalServerIds`,
// `serverConnectionOverrides`) so the SDK eval reporter (Step 3) and the
// backend ingestion handler (Step 2) hash byte-identical wire shapes. Helper
// only — no reporter changes ship with Step 1.
export { normalizeSdkEvalHostConfigForWire } from "./sdk-evals-normalizer.js";
