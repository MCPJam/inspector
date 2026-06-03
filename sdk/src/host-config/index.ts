/**
 * `@mcpjam/sdk/host-config` — public host configuration API.
 *
 * Build and fingerprint a host with the `Host` class:
 *
 * ```ts
 * import { Host } from "@mcpjam/sdk/host-config"; // or from "@mcpjam/sdk"
 * const host = new Host().setMcp({ protocolVersion: "2025-11-25" }).addServer("srv_abc");
 * const fp = await host.hash();
 * ```
 *
 * The internal canonicalizer/hash (and the storage-row vocabulary they use)
 * are deliberately not exported — `Host.toJSON()` / `Host.hash()` are the
 * public seam. The canonical output is hand-mirrored + golden-vector-parity
 * tested against the Convex backend; see `./types.ts`.
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
