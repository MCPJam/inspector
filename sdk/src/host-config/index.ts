/**
 * `@mcpjam/sdk/host-config` — public host configuration API.
 *
 * Build a host with the `Host` class:
 *
 * ```ts
 * import { Host } from "@mcpjam/sdk/host-config"; // or from "@mcpjam/sdk"
 * const host = new Host({ style: "mcpjam", model: "anthropic/claude-sonnet-4-6" })
 *   .requireServer("srv_abc");
 * host.mcp.protocolVersion = "2025-11-25";
 * const json = host.toJSON();
 * ```
 *
 * The internal canonicalizer/hash (and the storage-row vocabulary they use)
 * are deliberately not exported — `Host.toJSON()` is the public seam.
 * Content-addressed storage is a first-party SDK↔backend concern handled via
 * `@mcpjam/sdk/host-config/internal`; see `./types.ts`.
 */

export {
  Host,
  isHostJson,
  snapshotHostSource,
  assertHostServersKnown,
  resolveKnownServerIds,
} from "./host.js";
export type { HostServerRegistry, HostSource } from "./host.js";
export { HostRuntime } from "./host-runtime.js";
export type {
  HostRuntimeDefaults,
  HostRuntimeManager,
} from "./host-runtime.js";
export type {
  HostInit,
  HostJson,
  HostMcp,
  HostComputer,
  HostServerOverride,
  HostConnectionDefaults,
  HostStyleId,
  McpProtocolVersion,
  McpProtocolVersionPin,
  ServerId,
  CspDomainSet,
  OpenAiAppsCapabilities,
  McpAppsCapabilities,
} from "./public-types.js";
