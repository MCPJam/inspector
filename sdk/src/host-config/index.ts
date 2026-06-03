/**
 * `@mcpjam/sdk/host-config` — public host configuration API.
 *
 * Build a host with the `Host` class:
 *
 * ```ts
 * import { Host } from "@mcpjam/sdk/host-config"; // or from "@mcpjam/sdk"
 * const host = new Host({ style: "mcpjam", model: "anthropic/claude-sonnet-4-6" })
 *   .setMcp({ protocolVersion: "2025-11-25" })
 *   .addServer("srv_abc");
 * const json = host.toJSON();
 * ```
 *
 * The internal canonicalizer/hash (and the storage-row vocabulary they use)
 * are deliberately not exported — `Host.toJSON()` is the public seam.
 * Content-addressed storage is a first-party SDK↔backend concern handled via
 * `@mcpjam/sdk/host-config/internal`; see `./types.ts`.
 */

export { Host } from "./host.js";
export type {
  HostInit,
  HostJson,
  HostMcp,
  HostServerOverride,
  HostConnectionDefaults,
  HostStyleId,
  McpProtocolVersion,
  ServerId,
  CspDomainSet,
  OpenAiAppsCapabilities,
  McpAppsCapabilities,
} from "./public-types.js";
