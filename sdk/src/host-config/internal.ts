/**
 * INTERNAL host-config entry — NOT part of the public API.
 *
 * Exposes the raw canonicalizer + hash + internal storage-row types for SDK
 * tooling (the parity-fixture generator) and SDK tests only. This module is
 * built to `dist/host-config/internal.js` but is intentionally absent from
 * `package.json#exports`, so it is not importable via the package name —
 * external consumers see only `Host` from `@mcpjam/sdk` / `./host-config`.
 *
 * Application code must use the `Host` class instead.
 */

export { canonicalizeHostConfigV2 } from "./canonicalize.js";
export { sha256Hex, computeHostConfigHashV2 } from "./hash.js";
export {
  HOST_CONFIG_SCHEMA_VERSION_V2,
  SEP_1865_PERMISSION_FEATURES,
} from "./types.js";
export type {
  HostConfigInputV2,
  CanonicalHostConfigV2,
  HostConfigMcpProfileV1,
  HostConfigConnectionDefaults,
} from "./types.js";
