/**
 * `@mcpjam/sdk/host-config` — portable HostConfig v2 core.
 *
 * The canonical source of truth for the host-config shape, canonicalizer, and
 * content hash. Hand-mirrored (not imported) by the Convex backend; kept in
 * lockstep via a golden-vector parity test. See `./types.ts` for the full
 * parity-discipline note.
 *
 * This barrel is browser-safe — it carries no `MCPClientManager`/`ToolSet`
 * dependencies. Manager-aware helpers (tool-visibility filtering, host
 * execution policy) live in sibling modules added in later stages and are
 * exported only from the Node entry, not `@mcpjam/sdk/browser`.
 */

export {
  HOST_CONFIG_SCHEMA_VERSION_V2,
  SEP_1865_PERMISSION_FEATURES,
} from "./types.js";
export type {
  HostConfigInputV2,
  CanonicalHostConfigV2,
  HostConfigConnectionDefaults,
  HostConfigMcpProfileV1,
  HostConfigStyle,
  HostStyleId,
  ServerId,
  CspDomainSet,
  OpenAiAppsCapabilities,
  McpAppsCapabilities,
  McpProtocolVersion,
} from "./types.js";

export { canonicalizeHostConfigV2 } from "./canonicalize.js";
export { sha256Hex, computeHostConfigHashV2 } from "./hash.js";
